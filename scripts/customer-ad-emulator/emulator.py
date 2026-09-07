#!/usr/bin/env python3
"""
Customer AD Emulator — creates and tears down a Windows Server 2022 EC2
instance configured as an Active Directory domain controller. Test-only
fixture, used to validate MRM's non-Managed-AD code paths (see issue #27).

Not a shippable feature. Real MRM customers have their own AD; this
emulates that for sandbox testing.

Usage:
    python3 emulator.py create --vpc-id vpc-XXX --subnet-id subnet-XXX \\
        (--allow-from-sg sg-XXX | --allow-from-cidr 10.0.0.0/16) \\
        [--domain-name customer.internal]

    python3 emulator.py teardown

Reads AWS credentials from the standard boto3 credential chain (env vars,
~/.aws/config, EC2 metadata, etc.). Use --profile and --region to override.
"""

import argparse
import base64
import json
import secrets
import string
import sys
import time
from pathlib import Path

try:
    import boto3
    from botocore.exceptions import ClientError
except ImportError:
    print("boto3 is required. Install with: pip install -r requirements.txt", file=sys.stderr)
    sys.exit(1)

# ─── Constants ──────────────────────────────────────────────────────────

# Where to persist state between create/teardown runs. Ignored by git; each
# operator's state file is local to their workspace.
SCRIPT_DIR = Path(__file__).parent
STATE_FILE = SCRIPT_DIR / ".emulator-state.json"
POWERSHELL_DIR = SCRIPT_DIR / "scripts"

# Tag applied to every resource. Teardown uses this to double-check we don't
# accidentally touch resources we didn't create.
RESOURCE_TAG_KEY = "MRM-CustomerAdEmulator"
RESOURCE_TAG_VALUE = "true"

# Defaults. Overridable via CLI flags.
DEFAULT_DOMAIN_NAME = "customer.internal"
DEFAULT_NETBIOS_NAME = "CUSTOMER"
DEFAULT_ADMIN_GROUP_NAME = "Studio-Admins-Test"
DEFAULT_SERVICE_ACCOUNT_NAME = "MRMServiceAccount"
DEFAULT_TEST_USER_NAME = "teststudio"
DEFAULT_INSTANCE_TYPE = "t3.medium"

# AWS-published SSM parameter that always resolves to the latest Windows
# Server 2022 English Full Base AMI in the current region.
WINDOWS_2022_SSM_PARAM = "/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base"

# SSM Run Command document for PowerShell.
POWERSHELL_DOCUMENT = "AWS-RunPowerShellScript"

# Poll cadence and timeouts.
INSTANCE_STATE_POLL_INTERVAL_S = 15
INSTANCE_STATE_MAX_WAIT_S = 600            # 10 min for boot + SSM join
SSM_INVOCATION_POLL_INTERVAL_S = 20
SSM_INVOCATION_MAX_WAIT_S = 2400           # 40 min for AD DS promotion
REBOOT_WAIT_INITIAL_S = 60                 # give the reboot a head start
POST_REBOOT_MAX_WAIT_S = 900               # 15 min for AD services to be up

# Password policy for generated passwords (meets AD complexity requirements).
PASSWORD_LENGTH = 32
PASSWORD_ALPHABET = string.ascii_letters + string.digits + "!@#$%^&*"


# ─── Logging helpers ────────────────────────────────────────────────────

def log(msg: str) -> None:
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def log_ok(msg: str) -> None:
    log(f"  ✓ {msg}")


def log_err(msg: str) -> None:
    log(f"  ✗ {msg}")


# ─── State management ──────────────────────────────────────────────────

def load_state() -> dict:
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text())
    except (OSError, json.JSONDecodeError) as e:
        log_err(f"Failed to load state file {STATE_FILE}: {e}")
        return {}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2, default=str))


def clear_state() -> None:
    if STATE_FILE.exists():
        STATE_FILE.unlink()


# ─── AWS clients ───────────────────────────────────────────────────────

def build_clients(profile: str | None, region: str | None):
    session_kwargs = {}
    if profile:
        session_kwargs["profile_name"] = profile
    if region:
        session_kwargs["region_name"] = region
    session = boto3.Session(**session_kwargs)
    return {
        "ec2": session.client("ec2"),
        "ssm": session.client("ssm"),
        "iam": session.client("iam"),
        "secretsmanager": session.client("secretsmanager"),
        "sts": session.client("sts"),
    }


# ─── Password generation ───────────────────────────────────────────────

def generate_password() -> str:
    """Generate a random password meeting AD's complexity requirements."""
    while True:
        pw = "".join(secrets.choice(PASSWORD_ALPHABET) for _ in range(PASSWORD_LENGTH))
        # AD default complexity: at least 3 of the 4 character classes.
        classes = 0
        if any(c.isupper() for c in pw):
            classes += 1
        if any(c.islower() for c in pw):
            classes += 1
        if any(c.isdigit() for c in pw):
            classes += 1
        if any(c in "!@#$%^&*" for c in pw):
            classes += 1
        if classes >= 3:
            return pw


# ─── Create flow ───────────────────────────────────────────────────────

def create_secret(clients, name: str, description: str, username: str) -> tuple[str, str]:
    """Create a Secrets Manager secret with a generated password.

    Returns (secret_arn, password_plaintext).
    """
    password = generate_password()
    secret_string = json.dumps({"username": username, "password": password})
    try:
        resp = clients["secretsmanager"].create_secret(
            Name=name,
            Description=description,
            SecretString=secret_string,
            Tags=[{"Key": RESOURCE_TAG_KEY, "Value": RESOURCE_TAG_VALUE}],
        )
        log_ok(f"Created secret {name}")
        return resp["ARN"], password
    except clients["secretsmanager"].exceptions.ResourceExistsException:
        # Update instead
        arn = clients["secretsmanager"].describe_secret(SecretId=name)["ARN"]
        clients["secretsmanager"].update_secret(SecretId=arn, SecretString=secret_string)
        log_ok(f"Updated existing secret {name}")
        return arn, password


def create_security_group(clients, vpc_id: str, allow_from_sg: str | None,
                          allow_from_cidr: str | None) -> str:
    """Create the SG allowing AD ports from the caller-supplied source(s).

    At least one of allow_from_sg or allow_from_cidr must be provided. Both
    may be provided (rules are additive).
    """
    if not allow_from_sg and not allow_from_cidr:
        raise ValueError("Must provide at least one of allow_from_sg or allow_from_cidr")

    sg_name = "mrm-customer-ad-emulator-sg"
    sources_desc = []
    if allow_from_sg:
        sources_desc.append(f"sg {allow_from_sg}")
    if allow_from_cidr:
        sources_desc.append(f"cidr {allow_from_cidr}")

    resp = clients["ec2"].create_security_group(
        GroupName=sg_name,
        Description=f"AD ports open to {', '.join(sources_desc)} (test emulator)",
        VpcId=vpc_id,
        TagSpecifications=[{
            "ResourceType": "security-group",
            "Tags": [
                {"Key": "Name", "Value": sg_name},
                {"Key": RESOURCE_TAG_KEY, "Value": RESOURCE_TAG_VALUE},
            ],
        }],
    )
    sg_id = resp["GroupId"]
    log_ok(f"Created security group {sg_id}")

    # Standard AD ports for a Windows DC.
    ad_ports = [
        ("tcp", 53, 53, "DNS TCP"),
        ("udp", 53, 53, "DNS UDP"),
        ("tcp", 88, 88, "Kerberos TCP"),
        ("udp", 88, 88, "Kerberos UDP"),
        ("tcp", 135, 135, "RPC endpoint mapper"),
        ("tcp", 389, 389, "LDAP TCP"),
        ("udp", 389, 389, "LDAP UDP"),
        ("tcp", 445, 445, "SMB"),
        ("tcp", 464, 464, "Kerberos password change TCP"),
        ("udp", 464, 464, "Kerberos password change UDP"),
        ("tcp", 636, 636, "LDAPS"),
        ("tcp", 3268, 3268, "Global catalog LDAP"),
        ("tcp", 3269, 3269, "Global catalog LDAPS"),
        ("tcp", 49152, 65535, "RPC dynamic ports"),
    ]

    def build_rule(proto: str, from_p: int, to_p: int, desc: str) -> dict:
        rule = {"IpProtocol": proto, "FromPort": from_p, "ToPort": to_p}
        if allow_from_sg:
            rule["UserIdGroupPairs"] = [{"GroupId": allow_from_sg, "Description": desc}]
        if allow_from_cidr:
            rule["IpRanges"] = [{"CidrIp": allow_from_cidr, "Description": desc}]
        return rule

    permissions = [build_rule(proto, from_p, to_p, desc) for proto, from_p, to_p, desc in ad_ports]
    clients["ec2"].authorize_security_group_ingress(GroupId=sg_id, IpPermissions=permissions)
    log_ok(f"Authorized {len(permissions)} AD ports from {', '.join(sources_desc)}")
    return sg_id


def create_iam_role(clients) -> tuple[str, str]:
    """Create the IAM role + instance profile for the DC. Returns (role_name, instance_profile_name)."""
    role_name = "MRM-CustomerAdEmulator-Role"
    instance_profile_name = "MRM-CustomerAdEmulator-InstanceProfile"
    trust_policy = json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": {"Service": "ec2.amazonaws.com"},
            "Action": "sts:AssumeRole",
        }],
    })
    try:
        clients["iam"].create_role(
            RoleName=role_name,
            AssumeRolePolicyDocument=trust_policy,
            Description="Customer AD emulator DC - SSM managed instance access",
            Tags=[{"Key": RESOURCE_TAG_KEY, "Value": RESOURCE_TAG_VALUE}],
        )
        log_ok(f"Created IAM role {role_name}")
    except clients["iam"].exceptions.EntityAlreadyExistsException:
        log_ok(f"IAM role {role_name} already exists")

    clients["iam"].attach_role_policy(
        RoleName=role_name,
        PolicyArn="arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
    )
    log_ok("Attached AmazonSSMManagedInstanceCore")

    try:
        clients["iam"].create_instance_profile(InstanceProfileName=instance_profile_name)
        log_ok(f"Created instance profile {instance_profile_name}")
    except clients["iam"].exceptions.EntityAlreadyExistsException:
        log_ok(f"Instance profile {instance_profile_name} already exists")

    # add_role_to_instance_profile fails if role is already there — that's fine
    try:
        clients["iam"].add_role_to_instance_profile(
            InstanceProfileName=instance_profile_name,
            RoleName=role_name,
        )
        log_ok("Added role to instance profile")
    except clients["iam"].exceptions.LimitExceededException:
        log_ok("Role already attached to instance profile")

    # IAM propagation takes a moment. Sleep before EC2 uses this.
    log("Waiting 15s for IAM propagation")
    time.sleep(15)
    return role_name, instance_profile_name


def get_windows_ami(clients) -> str:
    """Resolve the latest Windows Server 2022 AMI via AWS SSM public parameter."""
    resp = clients["ssm"].get_parameter(Name=WINDOWS_2022_SSM_PARAM)
    ami_id = resp["Parameter"]["Value"]
    log_ok(f"Windows Server 2022 AMI: {ami_id}")
    return ami_id


def launch_instance(clients, ami_id: str, subnet_id: str, sg_id: str,
                    instance_profile_name: str, admin_password: str,
                    instance_type: str) -> str:
    """Launch the Windows DC instance. Returns the instance ID.

    userData sets the local Administrator password so the DSRM promotion can
    use the same account.
    """
    user_data = f"""<powershell>
$ErrorActionPreference = 'Stop'
Write-Host "=== emulator userdata: setting Administrator password ==="
$securePw = ConvertTo-SecureString '{admin_password}' -AsPlainText -Force
$admin = Get-LocalUser -Name 'Administrator'
$admin | Set-LocalUser -Password $securePw
Write-Host "=== emulator userdata: complete ==="
</powershell>
"""
    user_data_b64 = base64.b64encode(user_data.encode("utf-8")).decode("ascii")

    resp = clients["ec2"].run_instances(
        ImageId=ami_id,
        InstanceType=instance_type,
        MinCount=1,
        MaxCount=1,
        SubnetId=subnet_id,
        SecurityGroupIds=[sg_id],
        IamInstanceProfile={"Name": instance_profile_name},
        BlockDeviceMappings=[{
            "DeviceName": "/dev/sda1",
            "Ebs": {"VolumeSize": 50, "VolumeType": "gp3", "DeleteOnTermination": True},
        }],
        UserData=user_data_b64,
        TagSpecifications=[{
            "ResourceType": "instance",
            "Tags": [
                {"Key": "Name", "Value": "mrm-customer-ad-emulator"},
                {"Key": RESOURCE_TAG_KEY, "Value": RESOURCE_TAG_VALUE},
            ],
        }],
        MetadataOptions={
            "HttpTokens": "required",       # IMDSv2 only
            "HttpEndpoint": "enabled",
        },
    )
    instance_id = resp["Instances"][0]["InstanceId"]
    log_ok(f"Launched instance {instance_id}")
    return instance_id


def wait_for_ssm_ping(clients, instance_id: str, timeout_s: int = INSTANCE_STATE_MAX_WAIT_S) -> None:
    """Wait for the instance to appear in SSM as an Online managed instance."""
    log(f"Waiting for SSM agent to register (up to {timeout_s}s)...")
    elapsed = 0
    while elapsed < timeout_s:
        try:
            resp = clients["ssm"].describe_instance_information(
                Filters=[{"Key": "InstanceIds", "Values": [instance_id]}]
            )
            infos = resp.get("InstanceInformationList", [])
            if infos and infos[0].get("PingStatus") == "Online":
                log_ok(f"SSM ping online after {elapsed}s")
                return
        except ClientError:
            pass
        time.sleep(INSTANCE_STATE_POLL_INTERVAL_S)
        elapsed += INSTANCE_STATE_POLL_INTERVAL_S
        log(f"  still waiting... ({elapsed}s)")
    raise TimeoutError(f"SSM agent did not come online within {timeout_s}s")


def send_powershell_and_wait(clients, instance_id: str, script_body: str,
                             description: str, timeout_s: int = SSM_INVOCATION_MAX_WAIT_S) -> dict:
    """Send a PowerShell script via SSM and wait for completion.

    Returns the final invocation dict. Raises on failure or timeout.
    """
    log(f"Sending SSM command: {description}")
    resp = clients["ssm"].send_command(
        InstanceIds=[instance_id],
        DocumentName=POWERSHELL_DOCUMENT,
        Parameters={"commands": [script_body]},
        Comment=description,
        TimeoutSeconds=timeout_s,
    )
    command_id = resp["Command"]["CommandId"]
    log_ok(f"Command sent, id={command_id}")

    elapsed = 0
    while elapsed < timeout_s:
        time.sleep(SSM_INVOCATION_POLL_INTERVAL_S)
        elapsed += SSM_INVOCATION_POLL_INTERVAL_S
        try:
            inv = clients["ssm"].get_command_invocation(
                CommandId=command_id,
                InstanceId=instance_id,
            )
            status = inv.get("Status")
            log(f"  [{description}] status={status} elapsed={elapsed}s")
            if status in ("Success",):
                log_ok(f"Command completed successfully after {elapsed}s")
                return inv
            if status in ("Cancelled", "TimedOut", "Failed"):
                log_err(f"Command ended with status {status}")
                log_err(f"stdout: {inv.get('StandardOutputContent', '')[:2000]}")
                log_err(f"stderr: {inv.get('StandardErrorContent', '')[:2000]}")
                raise RuntimeError(f"SSM command {description} ended with status {status}")
        except clients["ssm"].exceptions.InvocationDoesNotExist:
            # Sometimes the invocation record is briefly not queryable after send
            continue
        except ClientError as e:
            log(f"  transient error querying invocation: {e}")
            continue
    raise TimeoutError(f"SSM command {description} did not complete within {timeout_s}s")


def wait_for_reboot_and_ssm_return(clients, instance_id: str) -> None:
    """After an AD promotion reboot, wait for the instance to come back online."""
    log(f"Waiting {REBOOT_WAIT_INITIAL_S}s for reboot to actually start...")
    time.sleep(REBOOT_WAIT_INITIAL_S)

    # Wait for SSM ping to be Online again. During reboot it'll flip to
    # ConnectionLost / Inactive briefly.
    log(f"Waiting for SSM agent to come back online (up to {POST_REBOOT_MAX_WAIT_S}s)...")
    elapsed = 0
    while elapsed < POST_REBOOT_MAX_WAIT_S:
        try:
            resp = clients["ssm"].describe_instance_information(
                Filters=[{"Key": "InstanceIds", "Values": [instance_id]}]
            )
            infos = resp.get("InstanceInformationList", [])
            if infos and infos[0].get("PingStatus") == "Online":
                # Also require the LastPingDateTime to be recent (within last
                # 2 min) — otherwise we might be reading a stale record from
                # before the reboot.
                last_ping = infos[0].get("LastPingDateTime")
                log(f"  Ping online, last_ping={last_ping}")
                # Simple check: assume ping is fresh if we've been waiting
                # long enough that any stale record would be gone.
                if elapsed > 60:
                    log_ok(f"SSM agent back online after {elapsed}s")
                    return
        except ClientError:
            pass
        time.sleep(INSTANCE_STATE_POLL_INTERVAL_S)
        elapsed += INSTANCE_STATE_POLL_INTERVAL_S
    raise TimeoutError(f"SSM agent did not come back within {POST_REBOOT_MAX_WAIT_S}s post-reboot")


def get_instance_private_ip(clients, instance_id: str) -> str:
    resp = clients["ec2"].describe_instances(InstanceIds=[instance_id])
    return resp["Reservations"][0]["Instances"][0]["PrivateIpAddress"]


def cmd_create(args) -> int:
    # Validate ingress source up front, before any AWS calls.
    if not args.allow_from_sg and not args.allow_from_cidr:
        log_err("Must provide at least one of --allow-from-sg or --allow-from-cidr")
        return 2

    clients = build_clients(args.profile, args.region)
    identity = clients["sts"].get_caller_identity()
    log(f"AWS account: {identity['Account']}, arn: {identity['Arn']}")

    # Refuse to run twice if state file exists (avoid orphan resources).
    if STATE_FILE.exists():
        log_err(f"State file {STATE_FILE} already exists. Run teardown first.")
        return 2

    # Load PowerShell scripts from disk (embedded into SSM commands later).
    install_ps = (POWERSHELL_DIR / "01-install-ad-ds.ps1").read_text()
    users_ps = (POWERSHELL_DIR / "02-create-users.ps1").read_text()

    state = {
        "domain_name": args.domain_name,
        "netbios_name": args.netbios_name,
        "admin_group_name": args.admin_group_name,
        "service_account_name": args.service_account_name,
        "test_user_name": args.test_user_name,
        "account_id": identity["Account"],
        "region": clients["ec2"].meta.region_name,
    }

    try:
        # ─── Secrets ─────────────────────────────────────────────────────
        log("=== Creating secrets ===")
        state["admin_secret_arn"], admin_password = create_secret(
            clients,
            "/MediaResourceManager/Testing/CustomerAdEmulatorDomainAdminCredentials",
            "Domain administrator credentials for the customer AD emulator DC (test)",
            "Administrator",
        )
        state["safemode_secret_arn"], safemode_password = create_secret(
            clients,
            "/MediaResourceManager/Testing/CustomerAdEmulatorSafeModeCredentials",
            "Directory Services Restore Mode credentials for the customer AD emulator DC (test)",
            "Administrator",
        )
        state["service_secret_arn"], service_password = create_secret(
            clients,
            "/MediaResourceManager/Testing/CustomerAdEmulatorServiceAccountCredentials",
            f"Service account credentials ({args.service_account_name}) for the customer AD emulator DC (test)",
            args.service_account_name,
        )
        state["test_user_secret_arn"], test_user_password = create_secret(
            clients,
            "/MediaResourceManager/Testing/CustomerAdEmulatorTestUserCredentials",
            f"Test user credentials ({args.test_user_name}) for the customer AD emulator DC (test)",
            args.test_user_name,
        )
        save_state(state)

        # ─── Security group ──────────────────────────────────────────────
        log("=== Creating security group ===")
        state["security_group_id"] = create_security_group(
            clients, args.vpc_id, args.allow_from_sg, args.allow_from_cidr
        )
        save_state(state)

        # ─── IAM role + instance profile ─────────────────────────────────
        log("=== Creating IAM role + instance profile ===")
        state["iam_role_name"], state["instance_profile_name"] = create_iam_role(clients)
        save_state(state)

        # ─── AMI ─────────────────────────────────────────────────────────
        log("=== Resolving Windows Server 2022 AMI ===")
        ami_id = get_windows_ami(clients)
        state["ami_id"] = ami_id
        save_state(state)

        # ─── Launch instance ─────────────────────────────────────────────
        log("=== Launching DC instance ===")
        state["instance_id"] = launch_instance(
            clients,
            ami_id=ami_id,
            subnet_id=args.subnet_id,
            sg_id=state["security_group_id"],
            instance_profile_name=state["instance_profile_name"],
            admin_password=admin_password,
            instance_type=args.instance_type,
        )
        save_state(state)

        # ─── Wait for SSM to be reachable ───────────────────────────────
        log("=== Waiting for instance to boot and register with SSM ===")
        wait_for_ssm_ping(clients, state["instance_id"])

        # Give the instance a moment past initial SSM registration.
        log("Sleeping 30s for full boot")
        time.sleep(30)

        # ─── Install AD DS and promote ─────────────────────────────────
        log("=== Installing AD DS and promoting to DC ===")
        install_wrapped = f'''
{install_ps}
'''
        # We invoke the PowerShell script text directly. It reboots on
        # completion, so we don't wait for full SUCCESS status — instead we
        # wait for the invocation to reach a terminal state (which for a
        # rebooting VM is often "Delayed" or a network error). We accept a
        # SUCCESS or a Delivery Timed Out and then wait for SSM to come back.
        #
        # Simpler: install_ps ends with an explicit Restart-Computer. SSM's
        # send_command will typically return Success once the script finishes
        # dispatching Restart-Computer. If it times out (because the reboot
        # kills the SSM agent mid-response), we accept that.
        try:
            send_powershell_and_wait(
                clients, state["instance_id"],
                script_body=(
                    f"$DomainName = '{args.domain_name}'; "
                    f"$NetbiosName = '{args.netbios_name}'; "
                    f"$SafeModePassword = '{safemode_password}'; "
                    f"{install_ps}"
                ),
                description="Install AD DS + Install-ADDSForest (reboots)",
                timeout_s=1800,  # 30 min
            )
        except (RuntimeError, TimeoutError) as e:
            # Reboot mid-command commonly shows as Delivery Timed Out. That's
            # expected. We'll verify success by waiting for SSM to come back.
            log(f"  Command reported error (this is typically the reboot mid-flight): {e}")

        # ─── Wait for reboot + AD services ─────────────────────────────
        log("=== Waiting for post-promotion reboot ===")
        wait_for_reboot_and_ssm_return(clients, state["instance_id"])

        # ─── Create users ──────────────────────────────────────────────
        log("=== Creating service account, admin group, test user ===")
        send_powershell_and_wait(
            clients, state["instance_id"],
            script_body=(
                f"$DomainName = '{args.domain_name}'; "
                f"$ServiceAccountName = '{args.service_account_name}'; "
                f"$ServiceAccountPassword = '{service_password}'; "
                f"$AdminGroupName = '{args.admin_group_name}'; "
                f"$TestUserName = '{args.test_user_name}'; "
                f"$TestUserPassword = '{test_user_password}'; "
                f"{users_ps}"
            ),
            description="Create service account, admin group, test user",
            timeout_s=600,  # 10 min
        )

        # ─── Outputs ───────────────────────────────────────────────────
        state["dc_ip_address"] = get_instance_private_ip(clients, state["instance_id"])
        save_state(state)

        print("")
        print("=== Customer AD Emulator ready ===")
        print(f"DcIpAddress:              {state['dc_ip_address']}")
        print(f"DomainName:               {state['domain_name']}")
        print(f"ServiceAccountUsername:   {state['service_account_name']}")
        print(f"ServiceAccountSecretArn:  {state['service_secret_arn']}")
        print(f"AdminGroupName:           {state['admin_group_name']}")
        print(f"TestUserUsername:         {state['test_user_name']}")
        print(f"TestUserSecretArn:        {state['test_user_secret_arn']}")
        print(f"InstanceId:               {state['instance_id']}")
        print("")
        print("State file: " + str(STATE_FILE))
        print("")
        print("Once PR 3 of #27 lands, add these to MRM's parameters.json:")
        print(f'  {{"ParameterKey": "AdMode", "ParameterValue": "connector"}},')
        print(f'  {{"ParameterKey": "AdDomainName", "ParameterValue": "{state["domain_name"]}"}},')
        print(f'  {{"ParameterKey": "AdDnsServerIps", "ParameterValue": "{state["dc_ip_address"]}"}},')
        print(f'  {{"ParameterKey": "AdServiceAccountSecretArn", "ParameterValue": "{state["service_secret_arn"]}"}},')
        print(f'  {{"ParameterKey": "AdAdminGroupNames", "ParameterValue": "{state["admin_group_name"]}"}}')
        return 0

    except Exception as e:
        log_err(f"Create flow failed: {e}")
        log("State file has been saved with partial state. Run teardown to clean up.")
        return 1


# ─── Teardown flow ─────────────────────────────────────────────────────

def cmd_teardown(args) -> int:
    clients = build_clients(args.profile, args.region)
    state = load_state()
    if not state:
        log_err("No state file — nothing to tear down (or run in a different workspace)")
        return 2

    identity = clients["sts"].get_caller_identity()
    if state.get("account_id") and state["account_id"] != identity["Account"]:
        log_err(f"State was created in account {state['account_id']}, but you are in {identity['Account']}. Aborting.")
        return 3

    log(f"Tearing down customer AD emulator in {identity['Account']} / {clients['ec2'].meta.region_name}")

    # ─── Terminate instance ───────────────────────────────────────────
    instance_id = state.get("instance_id")
    if instance_id:
        try:
            clients["ec2"].terminate_instances(InstanceIds=[instance_id])
            log_ok(f"Terminated {instance_id} (still shutting down)")
        except ClientError as e:
            log_err(f"terminate_instances({instance_id}): {e}")

        # Wait for full termination before deleting SG (SG can't be deleted
        # while attached to a running ENI).
        log("Waiting for instance to fully terminate (~2-3 min)...")
        try:
            waiter = clients["ec2"].get_waiter("instance_terminated")
            waiter.wait(InstanceIds=[instance_id], WaiterConfig={"Delay": 15, "MaxAttempts": 40})
            log_ok("Instance fully terminated")
        except ClientError as e:
            log_err(f"terminate waiter: {e}")

    # ─── Delete SG ─────────────────────────────────────────────────────
    sg_id = state.get("security_group_id")
    if sg_id:
        try:
            clients["ec2"].delete_security_group(GroupId=sg_id)
            log_ok(f"Deleted security group {sg_id}")
        except ClientError as e:
            log_err(f"delete_security_group({sg_id}): {e}")

    # ─── Detach + delete IAM role / instance profile ──────────────────
    ip_name = state.get("instance_profile_name")
    role_name = state.get("iam_role_name")
    if ip_name:
        try:
            if role_name:
                clients["iam"].remove_role_from_instance_profile(
                    InstanceProfileName=ip_name, RoleName=role_name
                )
                log_ok(f"Removed role from instance profile {ip_name}")
        except ClientError as e:
            log_err(f"remove_role_from_instance_profile: {e}")
        try:
            clients["iam"].delete_instance_profile(InstanceProfileName=ip_name)
            log_ok(f"Deleted instance profile {ip_name}")
        except ClientError as e:
            log_err(f"delete_instance_profile({ip_name}): {e}")
    if role_name:
        try:
            clients["iam"].detach_role_policy(
                RoleName=role_name,
                PolicyArn="arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
            )
            log_ok("Detached AmazonSSMManagedInstanceCore")
        except ClientError as e:
            log_err(f"detach_role_policy: {e}")
        try:
            clients["iam"].delete_role(RoleName=role_name)
            log_ok(f"Deleted IAM role {role_name}")
        except ClientError as e:
            log_err(f"delete_role({role_name}): {e}")

    # ─── Delete secrets ────────────────────────────────────────────────
    # Force-delete without recovery — this is a test fixture, we don't need
    # a 30-day recovery window.
    for key in ("admin_secret_arn", "safemode_secret_arn", "service_secret_arn", "test_user_secret_arn"):
        arn = state.get(key)
        if not arn:
            continue
        try:
            clients["secretsmanager"].delete_secret(
                SecretId=arn,
                ForceDeleteWithoutRecovery=True,
            )
            log_ok(f"Deleted secret {arn}")
        except ClientError as e:
            log_err(f"delete_secret({arn}): {e}")

    clear_state()
    log_ok("Teardown complete")
    return 0


# ─── CLI wiring ────────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.strip().split("\n\n")[0])
    p.add_argument("--profile", help="AWS profile name")
    p.add_argument("--region", help="AWS region (default: profile default)")

    sub = p.add_subparsers(dest="command", required=True)

    p_create = sub.add_parser("create", help="Create the emulator")
    p_create.add_argument("--vpc-id", required=True, help="Existing VPC ID (typically MRM's)")
    p_create.add_argument("--subnet-id", required=True, help="Private subnet in the VPC")
    p_create.add_argument("--allow-from-sg", default=None,
                          help="Security group ID to grant AD-port ingress from (typically MRM's workstation SG). "
                               "At least one of --allow-from-sg or --allow-from-cidr required.")
    p_create.add_argument("--allow-from-cidr", default=None,
                          help="CIDR block to grant AD-port ingress from (typically the MRM VPC CIDR, "
                               "e.g. 10.1.0.0/16). Broader than --allow-from-sg — use when the workstation "
                               "SG doesn't exist yet.")
    p_create.add_argument("--domain-name", default=DEFAULT_DOMAIN_NAME,
                          help=f"AD domain name (default: {DEFAULT_DOMAIN_NAME})")
    p_create.add_argument("--netbios-name", default=DEFAULT_NETBIOS_NAME,
                          help=f"NetBIOS domain name (default: {DEFAULT_NETBIOS_NAME})")
    p_create.add_argument("--admin-group-name", default=DEFAULT_ADMIN_GROUP_NAME,
                          help=f"AD admin group name (default: {DEFAULT_ADMIN_GROUP_NAME})")
    p_create.add_argument("--service-account-name", default=DEFAULT_SERVICE_ACCOUNT_NAME,
                          help=f"Service account username (default: {DEFAULT_SERVICE_ACCOUNT_NAME})")
    p_create.add_argument("--test-user-name", default=DEFAULT_TEST_USER_NAME,
                          help=f"Test user username (default: {DEFAULT_TEST_USER_NAME})")
    p_create.add_argument("--instance-type", default=DEFAULT_INSTANCE_TYPE,
                          help=f"EC2 instance type (default: {DEFAULT_INSTANCE_TYPE})")
    p_create.set_defaults(func=cmd_create)

    p_td = sub.add_parser("teardown", help="Delete all emulator resources")
    p_td.set_defaults(func=cmd_teardown)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
