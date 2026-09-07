# Customer AD Emulator

Test-support tool that stands up a Windows Server 2022 EC2 instance
configured as an Active Directory domain controller, used to test MRM's
non-Managed-AD code paths.

**This is not a customer-facing feature.** Real MRM customers already have
their own AD; this emulator simulates that for sandbox testing.

## When to use this

- **PR 3 of #27** — `AdMode=connector` (AWS AD Connector pointing at an
  existing customer AD)
- **Future PR 4 of #27** — `AdMode=external` (direct LDAP to an existing
  customer AD, no Directory Service at all)

Once either PR lands, you can point MRM's `parameters.json` at the emulator's
outputs and validate the end-to-end flow.

## What it creates

Deployed to the caller-supplied VPC + subnet:

- Single Windows Server 2022 m5.xlarge EC2 instance (4 vCPU / 16 GB RAM,
  matches AWS Managed AD Enterprise sizing — sized so `Install-ADDSForest`
  never hits CPU-credit or memory pressure)
- Security group with AD ports open FROM a caller-supplied SG (typically
  MRM's workstation SG)
- IAM role with `AmazonSSMManagedInstanceCore` for SSM Run Command
  orchestration during setup
- Four Secrets Manager secrets under `/MediaResourceManager/Testing/`:
  domain admin credentials, DSRM (Safe Mode) credentials, AD service
  account credentials, test user credentials
- An admin group in AD (default name `Studio-Admins-Test`) and a test user
  pre-populated as a member

## Prerequisites

- Python 3.9+
- `boto3` (see `requirements.txt`)
- AWS credentials for the target account (SSO session, named profile, or
  environment variables — anything the standard boto3 credential chain
  accepts)
- An existing VPC and private subnet (typically MRM's, in the same account)
- The MRM workstation security group ID (from the `MRM-Dcv-Infrastructure`
  stack outputs), so the emulator can allow that SG to reach it on AD ports

## Usage

Install dependencies:

```bash
cd scripts/customer-ad-emulator
python3 -m pip install -r requirements.txt
```

Create the emulator:

```bash
python3 emulator.py create \
  --vpc-id vpc-XXXXXXXX \
  --subnet-id subnet-XXXXXXXX \
  --allow-from-sg sg-XXXXXXXX \
  --domain-name customer.internal \
  --profile <your-aws-profile> \
  --region us-east-1
```

The script will:

1. Create a security group with AD ports (53, 88, 135, 389, 445, 464, 636,
   3268, 3269, 49152-65535) open from the caller-supplied MRM workstation SG
2. Create an IAM role with `AmazonSSMManagedInstanceCore`
3. Create four Secrets Manager secrets (see list above)
4. Launch a Windows Server 2022 m5.xlarge instance
5. Wait for the instance to boot and SSM agent to register (~5 min)
6. Send SSM commands to install the AD DS role and promote to first DC in a
   new forest (~15 min including reboot)
7. Wait for AD services to come up after the promotion reboot (~5 min)
8. Send SSM commands to create the admin group, service account, and test
   user
9. Print the outputs needed for MRM's `parameters.json`

Total wall-time: ~25-30 min.

Tear down when done:

```bash
python3 emulator.py teardown \
  --profile <your-aws-profile> \
  --region us-east-1
```

## Outputs

On successful create, the script prints something like:

```
=== Customer AD Emulator ready ===
DcIpAddress:                10.1.2.15
DomainName:                 customer.internal
ServiceAccountUsername:     MRMServiceAccount
ServiceAccountSecretArn:    arn:aws:secretsmanager:us-east-1:...:secret:...
AdminGroupName:             Studio-Admins-Test
TestUserUsername:           teststudio
TestUserSecretArn:          arn:aws:secretsmanager:us-east-1:...:secret:...
```

Once PR 3 of #27 lands, feed these into MRM's `parameters.json`:

```json
{"ParameterKey": "AdMode", "ParameterValue": "connector"},
{"ParameterKey": "AdDomainName", "ParameterValue": "customer.internal"},
{"ParameterKey": "AdDnsServerIps", "ParameterValue": "10.1.2.15"},
{"ParameterKey": "AdServiceAccountSecretArn", "ParameterValue": "arn:aws:..."},
{"ParameterKey": "AdAdminGroupNames", "ParameterValue": "Studio-Admins-Test"}
```

A fresh MRM deploy with those values will:

- Skip creating the AWS Managed AD in `IdentityConstruct`
- Create an AD Connector pointing at the emulator DC with its service account
- Domain-join Windows workstations against `customer.internal`
- Authenticate MRM web-console users via LDAP against the emulator DC

## Cost

- EC2 m5.xlarge Windows on-demand: ~$0.38/hour (US regions)
- EBS gp3 30 GB: negligible
- Secrets Manager: $0.40/month per secret × 4 = negligible
- SSM commands: free

When teardown runs, the instance is terminated and the hourly clock stops.

## Design notes

Why not CDK? CDK Custom Resources are awkward for the 20+ minute AD
promotion phase — they hit CFN timeouts and retry semantics get weird. A
plain Python script maps naturally to the imperative "create, wait,
configure, wait, extract" flow of AD DS setup.

Why not CloudFormation? Same reason — the long-running config phase
requires imperative orchestration that CFN doesn't do naturally.

Why not an SSM Automation Document? That would work well and is worth
considering if we ever want to make this reusable across accounts without a
Python runtime. For now, a script keeps everything in one file per operator.

## File layout

```
scripts/customer-ad-emulator/
├── emulator.py                    # main script: create / teardown
├── scripts/
│   ├── 01-install-ad-ds.ps1       # AD DS install + Install-ADDSForest
│   └── 02-create-users.ps1        # service account, admin group, test user
├── README.md                      # this file
└── requirements.txt               # boto3
```
