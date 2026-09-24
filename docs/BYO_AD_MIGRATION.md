# Bring-Your-Own Active Directory (BYO-AD)

MRM ships with two Active Directory provisioning modes:

| `AdMode` | What it does |
|---|---|
| `managed` (default) | MRM creates a new AWS Managed Microsoft AD inside the MRM VPC and provisions its own service accounts. Byte-identical to the pre-PR-3 behavior. |
| `connector` | MRM creates an AWS AD Connector that proxies to an Active Directory you already own and reach from the MRM VPC. MRM does not create users in your directory. |

This document covers connector mode: prerequisites, fresh deployment, migrating an existing managed-mode deployment, and rollback. Related: [issue #27](https://github.com/awslabs/media-resource-manager/issues/27).

---

## When to use connector mode

Choose `connector` when at least one of these is true:

- You already run an on-premises or hybrid Active Directory and want workstations, users, and access to live in that directory.
- Your account has an SCP or organizational policy that forbids creating a new AWS Managed Microsoft AD.
- You need workstations to join a domain that other services in your org already trust.

If none of those apply, stay on `managed`. It is simpler and MRM manages the directory lifecycle for you.

---

## Prerequisites (connector mode)

Before deploying with `AdMode=connector`, you must have all of the following in place:

1. **A reachable Active Directory.** From the MRM VPC's private subnets, the standard AD ports must reach your domain controllers: TCP/UDP 389 (LDAP), TCP 636 (LDAPS, if used), TCP 3268/3269 (Global Catalog), TCP 88 (Kerberos), TCP/UDP 53 (DNS), TCP 445 (SMB), TCP 135 (RPC endpoint mapper), TCP 464 (Kerberos password change), TCP 49152-65535 (RPC dynamic ports), and — **critical for FSx for Windows** — **TCP 9389 (Active Directory Web Services)**. FSx uses ADWS for post-join configuration and will time out with a generic "unable to create a file system within the specified Microsoft Active Directory" error if 9389 is blocked, even though LDAP/Kerberos succeed. If your AD is on-prem, this typically means Direct Connect or Site-to-Site VPN into the MRM VPC. If your AD is in another AWS account, VPC peering or Transit Gateway.
2. **1-4 domain controller DNS IPs** reachable from the MRM VPC. Note the IPs — you will pass them as `AdDnsServerIps`.
3. **A service account in your AD.** AD Connector authenticates against your directory using this account for every operation MRM performs. The account needs standard "join computer to domain" privileges. The account must be a member of the built-in **Domain Users** group and have delegation to create computer objects in the OU where workstations will land. See [Delegate connect privileges for AD Connector](https://docs.aws.amazon.com/directoryservice/latest/admin-guide/prereq_connector.html) in the AWS docs for the specific delegation.
4. **A Secrets Manager secret** in the same AWS account and region as the MRM deployment, storing the service account credentials as JSON:
   ```json
   {"username": "MRMServiceAccount", "password": "<pw>"}
   ```
   Note the full ARN — you will pass it as `AdServiceAccountSecretArn`.
5. **An admin group in your AD** whose members should get MRM admin privilege. Note the group name (comma-separated for multiple) — you will set it as `AdminGroupName` (the existing MRM parameter, not a new one). MRM matches this against each authenticated user's group memberships (case-insensitive, comma-separated support).

---

## Fresh deployment in connector mode

Standing up MRM against an existing AD from scratch is the simplest case.

1. Confirm the [Prerequisites](#prerequisites-connector-mode) are met.
2. Deploy the `MRM-DeployPipeline` CloudFormation stack from `scripts/deploy-pipeline.yaml`. Under **Optional: Bring-your-own AD (AdMode=connector)**, set:
   - `AdMode` = `connector`
   - `AdDomainName` = the FQDN of your AD (e.g. `corp.example.com`)
   - `AdDnsServerIps` = comma-separated DC IPs (e.g. `10.0.5.10,10.0.6.10`)
   - `AdServiceAccountSecretArn` = the full ARN of the Secrets Manager secret from step 4 of prerequisites
   - `AdConnectorSize` = `Small` (up to 500 users) or `Large` (up to 5,000). Leave blank for `Small`.
   - `AdNetbiosName` = optional, defaults to the first label of `AdDomainName`
   - `AdConnectorDescription` = optional; parentheses are not allowed by Directory Service
3. Under **Required: Active Directory**, set `AdminGroupName` to a group that already exists in your AD (e.g. `MRM-Admins`). Comma-separated if you want multiple.
4. Set `UseCognitoAuth` to `false` if you want the LDAP login form. (Connector mode also works with Cognito federation, but the typical case is LDAP.)
5. Deploy the pipeline stack, then start a build of the `MRM-DeployPipeline-build` CodeBuild project. The build runs `deploy.sh` which synthesizes and deploys every MRM stack against your directory.

On success, an AD Connector directory shows up in Directory Service (Stage `Active`, Type `ADConnector`), and workstations you create in MRM domain-join `AdDomainName`.

---

## Migrating an existing managed-mode deployment to connector mode

**This is a directory replacement, not an in-place swap.** CloudFormation deletes the AWS Managed Microsoft AD and creates a fresh AD Connector, so anything currently bound to the managed AD becomes orphaned.

### What breaks

- **Every existing Windows workstation.** Workstations are joined to the managed AD's domain and will no longer authenticate after the swap. They stay online but users cannot sign in through the workstation. Plan on rebuilding them.
- **Every FSx Windows filesystem** joined to the managed AD. SMB shares will stop resolving. Plan on recreating them.
- **Every user account MRM created in the managed AD.** Users must exist in your directory before they can sign in through the new connector.

### Migration procedure

1. **Prepare your own AD side of the world.** Complete every step in [Prerequisites](#prerequisites-connector-mode). Create the Secrets Manager secret, verify network reachability, and make sure the admin group and any per-user accounts you need already exist in your AD. Test the service account by binding LDAP from any host in the MRM VPC before you touch the deployment.
2. **Communicate a maintenance window** to users. Signed-in DCV sessions will drop when workstations are rebuilt and reboots occur, and the environment will not accept new sign-ins for the duration of the redeploy (~30 minutes).
3. **List work that will need to be rebuilt.** Note the workstation names, tags, and any FSx filesystems you will need to recreate. MRM does not migrate them for you.
4. **Update the pipeline stack.** In CloudFormation, update the `MRM-DeployPipeline` stack, changing `AdMode` from `managed` to `connector` and setting the required AD parameters described in [Fresh deployment in connector mode](#fresh-deployment-in-connector-mode). Do not apply anything else yet — the stack update only changes the pipeline parameters, not the running MRM stacks.
5. **Start a build** of `MRM-DeployPipeline-build`. The buildspec regenerates `parameters.json` with the new values and runs `deploy.sh`. CloudFormation:
   - Deletes `IdentityManagedAD` and its associated resources.
   - Creates `IdentityAdConnectorResource` pointing at your directory.
   - Rewrites the `/Identity/ActiveDirectoryDomainName`, `/Identity/ActiveDirectoryServerIP1`, and `/Identity/ActiveDirectoryServerIP2` SSM parameters to your values so downstream stacks (workstations, FSx, LDAP-auth Lambda) pick up the new directory automatically.
6. **Recreate workstations.** Terminate the orphaned workstations from the MRM UI and create fresh ones. New workstations join `AdDomainName` and their computer objects appear in your AD's Computers container (or wherever you delegated the service account to create them).
7. **Recreate FSx Windows filesystems** if you use them. New filesystems will join `AdDomainName` using the same service account credentials as the connector.
8. **Sign in and verify.** Sign in to the MRM frontend using an account that exists in your AD and belongs to `AdminGroupName`. Confirm you land as admin. Confirm you can domain-join a workstation, and confirm you can mount an FSx filesystem to it.

### Rollback

Rollback is the same procedure in reverse: change `AdMode` back to `managed` and redeploy. It destroys the AD Connector and reprovisions a fresh AWS Managed Microsoft AD, which again orphans everything. The AWS Managed AD gets a fresh domain and fresh service accounts — the pre-migration domain and users cannot be restored from CloudFormation.

Because of the impact on both directions, treat this as a one-way change unless you have a specific reason to revert.

---

## Reference

- `parameters.example.json` — canonical schema for all seven `Ad*` parameters
- `scripts/deploy-pipeline.yaml` — where the parameters surface as CloudFormation inputs
- `lib/constructs/identity-construct.ts` — where MRM branches on `AdMode`
- `lambda/ad-connector-provisioner/` — the Custom Resource Lambda that calls `ds:ConnectDirectory`
