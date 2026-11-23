# AWS Media Resource Manager

A comprehensive AWS-native workstation management solution that enables Media & Entertainment customers to deploy, manage, and access secure EC2-based creative workstations through a self-service web console with integrated Amazon DCV remote access.

[![Launch Stack](https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png)](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?templateURL=https://ws-assets-prod-iad-r-iad-ed304a55c2ca1aee.s3.us-east-1.amazonaws.com/cfc326cf-ee59-42bb-81d7-e73596e77a2f/deploy-pipeline.yaml&stackName=MRM-DeployPipeline)

## Table of Contents

- [Overview](#overview)
- [Cost](#cost)
- [Quick Start](#quick-start)
- [Deployment & Configuration](#deployment-options)
  - [Deployment Options](#deployment-options)
  - [Configuration](#configuration)
  - [Post-Deployment Setup](#post-deployment-setup)
  - [Authentication](#authentication)
- [Architecture & Features](#architecture-overview)
  - [Architecture Overview](#architecture-overview)
  - [Features](#features)
  - [API Endpoints](#api-endpoints)
  - [Database Schema](#database-schema)
- [Operations](#security)
  - [Security](#security)
  - [Monitoring and Logging](#monitoring-and-logging)
  - [Troubleshooting](#troubleshooting)
  - [Cost Optimization](#cost-optimization)
  - [AWS Service Quotas](#aws-service-quotas)
  - [Cleanup](#cleanup)
- [Development](#development)
  - [Project Structure](#project-structure)
- [FAQ, Known Issues, and Additional Considerations](#faq-known-issues-and-additional-considerations)
- [Revisions](#revisions)
- [Notices](#notices)
- [License](#license)
- [Authors](#authors)

---

## Overview

![AWS Media Resource Manager Architecture](images/MRM_Architecture_Diagram.png)

AWS Media Resource Manager solves the operational complexity of managing EC2-based creative workstations for Media & Entertainment workflows. It deploys a complete infrastructure stack including VPC networking, AWS Managed Active Directory, DynamoDB metadata storage, and Amazon DCV for remote desktop access. Administrators get a web console to create, assign, and monitor workstations while end users can start, stop, and connect to their assigned instances through DCV sessions.

The architecture eliminates manual workstation provisioning, reduces infrastructure management overhead, and provides secure remote access without requiring VPN connections. Key components include:

- **Automated provisioning**: Step Functions workflows handle EC2 instance creation, domain joining, DCV agent installation, and readiness verification
- **Self-service web console**: Administrators manage workstation lifecycle; users start/stop and connect via DCV
- **Dual authentication**: LDAP (AWS Managed AD) or Cognito SAML (Okta, IAM Identity Center, Entra ID)
- **Multi-platform support**: Windows, Linux (Ubuntu, Rocky), and macOS workstations
- **Cost optimization**: Auto-shutdown policies, auto-start schedules, and per-user workstation assignment
- **Multi-region**: Regional hub architecture for low-latency DCV connections across AWS regions
- **Storage integration**: FSx for NetApp ONTAP, FSx for Windows, and S3 mount management

The solution scales from individual artists to large production teams and integrates with existing AWS services while maintaining security through IAM roles, VPC isolation, KMS encryption, and WAF protection.

---

## Cost

You are responsible for the cost of the AWS services used while running this solution.

**Base infrastructure** (always running, no workstations active):

| Service | Purpose | Estimated Monthly Cost (USD) |
|---------|---------|------------------------------|
| NAT Gateways (×2-3) | Outbound internet for Lambda VPC functions | $65–$97 |
| AWS Managed Active Directory | Domain services, user authentication | $72.00 (Standard edition) |
| DCV Session Manager (m6g.large) | DCV session brokering | $67.00 |
| DCV Connection Gateway (c7g.large) | External DCV connections | $89.00 |
| Network Load Balancers (×2) | DCV traffic routing | $32.00 |
| CloudFront + S3 | Frontend hosting | $1.00 |
| DynamoDB | Workstation metadata (on-demand) | $1.00 |
| Cognito | User authentication (50 users) | $2.75 |
| KMS + Secrets Manager | Encryption keys, AD credentials | $2.00 |
| WAF | CloudFront protection | $7.00 |
| **TOTAL** | **Monthly base cost (2 AZs)** | **~$339.00** |

> **Note**: NAT Gateway count matches AZ count (configurable). Costs above use us-east-1 on-demand pricing as of June 2026. WAF IP allowlisting is optional but the WebACL is always deployed.

**Per-workstation costs** (variable, based on usage):

| Instance Type | Use Case | Cost/Hour (On-Demand) |
|---------------|----------|----------------------|
| g6.xlarge | Light editing, review | $0.98 |
| g6.2xlarge | Standard editing | $1.32 |
| g6.4xlarge | Heavy compositing, rendering | $2.00 |
| g6.8xlarge | Multi-app, large projects | $3.35 |

**Cost optimization features:**
- Auto-shutdown stops idle workstations after configurable timeout
- Auto-start schedules bring workstations online only during working hours
- Stopped instances incur only EBS storage costs (~$0.08/GB/month)

We recommend creating a **Budget through AWS Cost Explorer** to help manage costs. Prices are subject to change. For full details, refer to the pricing webpage for each AWS service used.

---

## Quick Start

**Recommended**: Deploy using the CloudFormation template. No local tools required.

### Prerequisites

Before deploying, check for account-level controls that can block the internet-facing
components MRM provisions (the DCV Connection Gateway NLB, the CloudFront frontend
distribution, and the API Gateway endpoint):

- **VPC Block Public Access (BPA)**: some organizations turn this on for new accounts.
  Check the setting:

  ```bash
  aws ec2 describe-vpc-block-public-access-options --region <region>
  ```

  If `InternetGatewayBlockMode` is `block-ingress` or `block-bidirectional`, read
  [Deploying in accounts with VPC Block Public Access](#deploying-in-accounts-with-vpc-block-public-access)
  before you deploy.

### One-Click Deployment (CloudFormation + CodeBuild)

1. Click the button below to launch the deployment pipeline:

   [![Launch Stack](https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png)](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?templateURL=https://ws-assets-prod-iad-r-iad-ed304a55c2ca1aee.s3.us-east-1.amazonaws.com/cfc326cf-ee59-42bb-81d7-e73596e77a2f/deploy-pipeline.yaml&stackName=MRM-DeployPipeline)

2. Fill in the parameters (VPC, domain name, authentication mode, admin email)
3. Check "I acknowledge that AWS CloudFormation might create IAM resources" and click **Create stack**
4. A CodeBuild project is created and automatically starts the deployment (~90 minutes)
5. When complete, find your application URL in the CodeBuild logs or SSM Parameter Store

> **Note**: The template clones this repository, installs dependencies, and runs `deploy.sh` automatically. Configuration is persisted in SSM Parameter Store so subsequent builds are idempotent.

### Local Deployment (for developers)

If you prefer to deploy from your local machine or need to customize the code:

```bash
# Clone the repository
git clone https://github.com/awslabs/media-resource-manager.git
cd media-resource-manager

# Create configuration files from examples
cp cdk.example.json cdk.json
cp parameters.example.json parameters.json
```

Optionally customize the product name in `cdk.json` (drives stack prefixes, SSM paths, and UI branding):

```json
{
  "context": {
    "productName": "My Studio Workstations"
  }
}
```

This generates stack names like `MSW-Infrastructure`, SSM paths like `/MyStudioWorkstations/...`, and shows "My Studio Workstations" in the web console header.

Edit `parameters.json` with your environment settings:

```json
[
  { "ParameterKey": "VpcId", "ParameterValue": "" },
  { "ParameterKey": "VpcCidr", "ParameterValue": "10.1.0.0/16" },
  { "ParameterKey": "DomainName", "ParameterValue": "studio.mrm.internal" },
  { "ParameterKey": "UseCognitoAuth", "ParameterValue": "true" },
  { "ParameterKey": "AdminGroupName", "ParameterValue": "MRM-Admins" }
]
```

Then deploy:

**Linux / macOS / WSL:**
```bash
./deploy.sh
```

**Windows (PowerShell):**
```powershell
.\deploy.ps1
```

Both scripts handle everything: dependencies, CDK bootstrap, build, and deployment of all stacks. Takes approximately 90 minutes on first deploy. Use `-y` flag to skip the confirmation prompt.

See [Configuration](#configuration) for all available parameters.

### Post-Deployment Access

After deployment:

1. **Get the frontend URL** from the deployment output or:
   ```bash
   aws ssm get-parameter --name "/MediaResourceManager/Frontend/Url" --query "Parameter.Value" --output text
   ```

2. **Set up authentication** based on your `UseCognitoAuth` setting:
   - **Cognito (recommended)**: Each address in `AdminEmails` gets an invite email with the frontend URL and a temporary password. If `AdminEmails` was empty, nobody can sign in yet: see [Native Cognito users](#2-authentication-setup) to add one, or set up Okta/Identity Center
   - **LDAP**: Retrieve ResourceAdmin credentials from Secrets Manager

3. **Create your first workstation** from the admin console

---

## Deployment Options

Choose the deployment method that fits your environment:

| Method | Best For | Prerequisites |
|--------|----------|---------------|
| [CloudFormation + CodeBuild](#quick-start) | **Recommended.** One-click, no local tools | AWS Console access |
| [Local Deployment](#local-deployment) | Development, full control | Node.js 20+, AWS CLI |
| [CloudShell Deployment](#cloudshell-deployment) | Quick setup, no local tools | AWS Console access |
| [CodeBuild Deployment](#codebuild-deployment) | CI/CD, team deployments | AWS account |

### Local Deployment

**Prerequisites:**
- AWS CLI configured with appropriate permissions
- Node.js 20+ and npm (LTS recommended)
- **Windows**: PowerShell 5.1+ (built-in). Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` if needed.
- **Linux/macOS**: bash
- AWS CDK CLI (`npm install -g aws-cdk`)
- Docker (for Lambda function bundling)

**Deploy:**
```bash
./deploy.sh
```

The deployment script automatically:
1. Installs all npm dependencies (CDK app and frontend)
2. Analyzes existing VPC (if `VpcId` is set) and prompts for subnet selection
3. Bootstraps CDK environment if needed
4. Builds the frontend and CDK application
5. Deploys all stacks in the correct order

**Manual deployment** (for individual stacks):
```bash
cdk deploy --all                    # Deploy all stacks
cdk deploy MRM-Infra               # Deploy specific stack
cdk deploy --all --require-approval never  # Auto-approve
```

### CloudShell Deployment

Deploy directly from AWS CloudShell. No local setup needed:

```bash
git clone <repository-url> media-resource-manager
cd media-resource-manager
./scripts/bootstrap-cloudshell.sh
```

The script walks through interactive configuration, saves settings to SSM Parameter Store, and runs deployment in a `tmux` session (survives CloudShell timeouts).

**If disconnected during deployment:**
```bash
tmux attach -t mrm-deploy
```

**Re-deploy later:**
```bash
./scripts/bootstrap-cloudshell.sh --redeploy
```

**Destroy all stacks:**
```bash
./scripts/bootstrap-cloudshell.sh --destroy
```

### CodeBuild Deployment

For CI/CD and repeatable one-click deployments. The CodeBuild project clones the repo, restores config from SSM, and runs `deploy.sh`.

**1. Deploy the pipeline:**

```bash
git clone https://github.com/awslabs/media-resource-manager.git
cd media-resource-manager

aws cloudformation deploy \
  --template-file scripts/deploy-pipeline.yaml \
  --s3-bucket <your-bucket> \
  --stack-name MRM-DeployPipeline \
  --capabilities CAPABILITY_NAMED_IAM
```

The template is larger than the 51,200 bytes CloudFormation accepts inline, so `--s3-bucket` is required: the CLI uploads the template to that bucket first. Use any bucket you own in the same Region, or create one with `aws s3 mb s3://<your-bucket>`.

The stack name you choose (e.g., `MRM-DeployPipeline`) is used to auto-generate AWS resource names (S3 bucket, IAM role, CodeBuild project). Use different stack names for multiple deployments in the same account.

**2. Available Parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `ProductName` | `Media Resource Manager` | Single source of truth for naming. Drives stack names, SSM paths, UI branding, and all derived conventions (see below). |
| `RepoUrl` | GitHub URL | Git repository URL (GitHub or CodeCommit HTTPS format) |
| `RepoType` | `github` | `github` or `codecommit` |
| `GitBranch` | `main` | Branch or tag to deploy. Use `main` for latest, or pin to a release tag (e.g., `v0.1.0`) for stability. |
| `GitHubTokenSecretName` | *(empty)* | Secrets Manager secret for private GitHub repos |
| `VpcId` | *(empty)* | Existing VPC ID, or empty to create new |
| `PrivateSubnetIds` | *(empty)* | Existing VPC only: comma-separated private subnet IDs, one per AZ, in the same order as `AvailabilityZones`. Required when the VPC has more than one private subnet in an AZ. See [Using an existing VPC](#using-an-existing-vpc). |
| `PublicSubnetIds` | *(empty)* | Existing VPC only: comma-separated public subnet IDs, one per AZ, in the same AZ order as `PrivateSubnetIds`. |
| `VpcCidr` | `10.1.0.0/16` | CIDR for new VPC |
| `DomainName` | `studio.mrm.internal` | Active Directory domain name |
| `UseCognitoAuth` | `true` | `true` for Cognito/SAML, `false` for LDAP |
| `AdminGroupName` | `MRM-Admins` | Admin group name |
| `HostnamePrefix` | `vdi-` | Workstation hostname prefix |
| `HostnameDigits` | `4` | Digits in hostname suffix (e.g., `vdi-0001`) |
| `AvailabilityZones` | *(empty)* | Comma-separated AZs (e.g., `us-east-1b,us-east-1c`). Leave empty to auto-select. |
| `PublicSubnetMask` | `28` | Subnet mask for public subnets |
| `PrivateSubnetMask` | `24` | Subnet mask for private subnets |
| `DcvCertificateArn` | *(empty)* | ACM certificate ARN for custom DCV domain |
| `DcvDomainName` | *(empty)* | Custom domain for DCV connections |
| `DcvBrowserPath` | `cloudfront` | How browser sessions reach the DCV Connection Gateway: `cloudfront` (a CloudFront distribution per gateway Region, trusted certificate, no domain needed) or `direct` (the gateway's TCP 8443). See [Gateway browser path](docs/GATEWAY_BROWSER_PATH.md). |
| `DcvHostedZoneId` | *(empty)* | Optional Route 53 hosted zone. With `cloudfront`, the hop from CloudFront to the origin load balancer uses HTTPS with a DNS-validated certificate. |
| `DcvAllowedClientCidrs` | *(empty)* | Comma-separated CIDR ranges allowed to reach the gateway's public ports (TCP 8443, UDP 8444), primary and hubs. Empty: open. |
| `DcvAllowedPrefixListIds` | *(empty)* | Up to 2 managed prefix list IDs allowed to reach the primary gateway's public ports. |
| `FrontendUrl` | *(empty)* | Custom URL for web console (e.g., `https://vdi.company.com`). Leave empty for auto-generated CloudFront URL. |
| `AdminEmails` | *(empty)* | Comma-separated emails to create as Cognito admin users (e.g., `admin@company.com`). Each receives a welcome email with the frontend URL and a temporary password. Addresses added later are created on the next deploy. With Cognito on and no SAML IdP, leave it empty only if you will [create users yourself](#2-authentication-setup): otherwise nobody can sign in. |
| `IdentityCenterSyncGroups` | *(empty)* | Identity Center group(s) to sync users from |
| `EnableBedrockFeatures` | `true` | Set to `false` to skip AI/Bedrock stacks and hide AI features in the frontend. Useful for accounts with SCPs that restrict Bedrock access. |
| `MacBuildAvailabilityZone` | *(empty)* | AZ for macOS Image Builder builds (e.g., `us-east-1c`). Must match an AZ where mac dedicated hosts can be allocated. Leave empty to use the first private subnet's AZ. |
| `WafAllowedIps` | *(empty)* | Comma-separated CIDR ranges to whitelist for CloudFront access (e.g., `203.0.113.0/24,198.51.100.0/24`). When set, a WAF WebACL blocks all traffic except from these IPs. Leave empty to allow all traffic (no WAF). |
| `FrontendCertificateArn` | *(empty)* | ARN of an ACM certificate in `us-east-1` for the custom frontend domain. Required when `FrontendUrl` is set to a custom domain. See [Custom Domain Setup](#3-configure-custom-domain-optional). |
| `SsoUserPoolArn` | *(empty)* | ARN of an external Cognito User Pool with pre-configured SSO/SAML (e.g., Entra ID). When set, the CDK app imports this pool instead of creating its own. See [External SSO User Pool](#external-sso-user-pool). |
| `SsoUserPoolClientId` | *(empty)* | Client ID of the external SSO User Pool. Required when `SsoUserPoolArn` is set. |
| `SsoUserPoolDomain` | *(empty)* | Domain URL of the external SSO User Pool (e.g., `https://my-app.auth.us-east-1.amazoncognito.com`). Required when `SsoUserPoolArn` is set. |

**How `ProductName` drives naming:**

The pipeline buildspec derives the same naming conventions as CDK:

| ProductName | PascalCase | Acronym | SSM Prefix | Stack Prefix |
|-------------|------------|---------|------------|--------------|
| `Media Resource Manager` | `MediaResourceManager` | `MRM` | `/MediaResourceManager/...` | `MRM-` |
| `Cloud Edit` | `CloudEdit` | `CE` | `/CloudEdit/...` | `CE-` |
| `Studio Workstations` | `StudioWorkstations` | `SW` | `/StudioWorkstations/...` | `SW-` |

**Example: GitHub with custom settings**
```bash
aws cloudformation deploy \
  --template-file scripts/deploy-pipeline.yaml \
  --s3-bucket <your-bucket> \
  --stack-name MRM-DeployPipeline \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    ProductName="Media Resource Manager" \
    VpcCidr=10.1.0.0/16 \
    AdminGroupName="MRM-Admins"
```

**Example: CodeCommit repository**
```bash
aws cloudformation deploy \
  --template-file scripts/deploy-pipeline.yaml \
  --s3-bucket <your-bucket> \
  --stack-name CE-DeployPipeline \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    ProductName="Cloud Edit" \
    RepoUrl=https://git-codecommit.us-east-1.amazonaws.com/v1/repos/my-repo \
    RepoType=codecommit \
    GitBranch=main \
    VpcCidr=10.2.0.0/16 \
    DomainName=studio.cloudedit.internal \
    AdminGroupName=CE-Admins
```

**3. Follow the first deployment:**

Creating the pipeline stack starts the first build automatically. Don't start another build while it runs: two builds deploying at once fail with errors such as `... is in CREATE_IN_PROGRESS state`.

Get the CodeBuild project name from the stack outputs:
```bash
aws cloudformation describe-stacks --stack-name MRM-DeployPipeline \
  --query "Stacks[0].Outputs[?OutputKey=='CodeBuildProjectName'].OutputValue" --output text
```

Check the build's status:
```bash
aws codebuild batch-get-builds \
  --ids "$(aws codebuild list-builds-for-project --project-name <project-name> --query 'ids[0]' --output text)" \
  --query 'builds[0].buildStatus' --output text
```

Or from the AWS Console: CodeBuild → find the project → Build history.

Start a build yourself only for later updates (step 4), once the previous build has finished:
```bash
aws codebuild start-build --project-name <project-name>
```

**4. Update configuration after initial deploy:**

Pipeline parameters seed the initial config. After the first build, config is stored in SSM under the PascalCase name derived from `ProductName` and is the source of truth for all subsequent builds. There are three ways to update configuration:

> **Upgrading from an earlier version?** If your pipeline stack was deployed before all parameters were available (e.g., `FrontendUrl`, `DcvDomainName`), update the stack with the latest template to expose them:
> ```bash
> aws cloudformation deploy \
>   --template-file scripts/deploy-pipeline.yaml \
>   --s3-bucket <your-bucket> \
>   --stack-name MRM-DeployPipeline \
>   --capabilities CAPABILITY_NAMED_IAM
> ```
> This adds the new parameters with safe defaults. Your existing SSM config is preserved. No rebuild needed unless you want to change values.

**Option A: Update the pipeline stack (recommended for persistent changes via console)**

Update the CloudFormation stack with new parameter values. This updates the CodeBuild project's environment variables, which are applied on the next build:

```bash
aws cloudformation deploy \
  --template-file scripts/deploy-pipeline.yaml \
  --s3-bucket <your-bucket> \
  --stack-name MRM-DeployPipeline \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    FrontendUrl="https://vdi.company.com" \
    AdminGroupName="NewAdmins"

# Then trigger a rebuild
aws codebuild start-build --project-name <project-name>
```

Or from the AWS Console: CloudFormation → select the pipeline stack → Update → Use current template → change parameter values → Update stack. Then start a new CodeBuild build.

Non-empty env var values that differ from the SSM-stored config are automatically applied and persisted on each build.

**Option B: Build-time overrides (recommended for ad-hoc or one-time changes)**

Override any parameter for a single build using `MRM_PARAM_OVERRIDES`. The change is applied, deployed, and saved to SSM. The change persists across future builds even though the override itself is one-time:

```bash
aws codebuild start-build --project-name <project-name> \
  --environment-variables-override \
    'name=MRM_PARAM_OVERRIDES,value={"FrontendUrl":"https://vdi.company.com"},type=PLAINTEXT'
```

You can override multiple parameters at once:
```bash
aws codebuild start-build --project-name <project-name> \
  --environment-variables-override \
    'name=MRM_PARAM_OVERRIDES,value={"FrontendUrl":"https://vdi.company.com","AdminGroupName":"NewAdmins"},type=PLAINTEXT'
```

From the AWS Console: CodeBuild → find the project → **Start build with overrides** → scroll to "Environment variables override" → add `MRM_PARAM_OVERRIDES` with the JSON value.

To clear a value back to empty (e.g., remove a custom FrontendUrl and revert to CloudFront):
```bash
aws codebuild start-build --project-name <project-name> \
  --environment-variables-override \
    'name=MRM_PARAM_OVERRIDES,value={"FrontendUrl":""},type=PLAINTEXT'
```

**Option C: Edit SSM directly**

For full control over the configuration JSON:

```bash
# For ProductName="Media Resource Manager", the SSM path is:
aws ssm get-parameter --name /MediaResourceManager/DeploymentConfig/parameters \
  --query Parameter.Value --output text > /tmp/params.json

# Edit the file
nano /tmp/params.json

# Upload and re-deploy
aws ssm put-parameter --name /MediaResourceManager/DeploymentConfig/parameters \
  --type String --value "$(cat /tmp/params.json)" --overwrite --tier Advanced

# Trigger rebuild (get project name from stack outputs)
aws codebuild start-build --project-name <project-name>
```

### CodeCommit Repository Setup (Optional)

If using AWS CodeCommit, you may need to set up IAM policies for developers who push code while a separate team handles deployments:

```bash
# For existing CodeCommit repo - creates IAM policies only
aws cloudformation deploy \
  --template-file scripts/codecommit-repo-setup.yaml \
  --stack-name mrm-codecommit-access \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    RepositoryName=media-resource-manager

# For new repo - creates repo + IAM policies
aws cloudformation deploy \
  --template-file scripts/codecommit-repo-setup.yaml \
  --stack-name mrm-codecommit-access \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    RepositoryName=media-resource-manager \
    CreateRepository=true
```

Attach the policy to external developer roles:
```bash
# Get policy ARN from stack outputs
POLICY_ARN=$(aws cloudformation describe-stacks --stack-name mrm-codecommit-access \
  --query "Stacks[0].Outputs[?OutputKey=='ExternalDeveloperPolicyArn'].OutputValue" --output text)

# Attach to role
aws iam attach-role-policy --role-name ExternalDeveloperRole --policy-arn $POLICY_ARN
```

The policies grant push access while protecting `main` and `deploy/*` branches from direct pushes.

---

## Configuration

### 1. Product Name Configuration (`cdk.json`)

```json
{
  "context": {
    "productName": "Media Resource Manager"
  }
}
```

`productName` is the single source of truth for all naming conventions. CDK (and the CodeBuild pipeline) derive everything from it:

- **PascalCase** (`MediaResourceManager`): SSM parameter paths, CloudFormation resource names
- **Acronym** (`MRM`): stack name prefixes (e.g., `MRM-Infrastructure`), DynamoDB table prefixes
- **kebab-case** (`media-resource-manager`): S3 bucket names, URLs
- **Display name**: frontend branding, UI headers

When using the [CodeBuild pipeline](#codebuild-deployment), set `ProductName` as a CloudFormation parameter, the buildspec writes it into `cdk.json` automatically.

#### Lambda log retention (`lambdaLogRetentionDays`)

Lambda creates each function's log group on its first run, and by default CloudWatch keeps those events forever. The `MRM-Log-Retention` stack sets a retention period on every Lambda log group in the deployment, including regional hubs, and creates log groups for functions that haven't run yet. Log groups that already have a retention period are left alone.

```json
{
  "context": {
    "productName": "Media Resource Manager",
    "lambdaLogRetentionDays": 365
  }
}
```

- Default: `365` days. Allowed values are the ones CloudWatch Logs accepts: 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653.
- `0` turns this off: the `MRM-Log-Retention` stack isn't created, and log retention is left as it is.
- You can also set `LambdaLogRetentionDays` in `parameters.json`. A value in `cdk.json` takes precedence.
- [CodeBuild deployments](#codebuild-deployment) use the default until the setting is in their saved config. To set it, start a build with the override `{"LambdaLogRetentionDays":"90"}` (Option B), and later builds keep it. Write the value as a string. A numeric `0` is ignored, so retention stays at 365 days.
- When retention is first applied, CloudWatch deletes events in those log groups that are older than the retention period.

### 2. Infrastructure Parameters (`parameters.json`)

```bash
cp parameters.example.json parameters.json
```

**Key Parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `VpcId` | *(empty)* | Existing VPC ID, or empty to create new |
| `PrivateSubnetIds` / `PublicSubnetIds` | *(empty)* | Existing VPC only: one subnet per AZ, comma-separated. See [Using an existing VPC](#using-an-existing-vpc). |
| `VpcCidr` | `10.1.0.0/16` | CIDR for new VPC |
| `DomainName` | `studio.mrm.internal` | AD domain for workstation domain-joining |
| `UseCognitoAuth` | `true` | `true` for Cognito/SAML, `false` for LDAP |
| `AdminGroupName` | `MRM-Admins` | Admin group name |
| `HostnamePrefix` | `vdi-` | Workstation hostname prefix |
| `HostnameDigits` | `4` | Digits in hostname suffix (e.g., `vdi-0001`) |
| `DcvCertificateArn` | *(empty)* | ACM certificate ARN for custom DCV domain |
| `DcvDomainName` | *(empty)* | Custom domain for DCV connections |
| `DcvBrowserPath` | `cloudfront` | How browser sessions reach the DCV Connection Gateway: `cloudfront` (a CloudFront distribution per gateway Region, trusted certificate, no domain needed) or `direct` (the gateway's TCP 8443). See [Gateway browser path](docs/GATEWAY_BROWSER_PATH.md). |
| `DcvHostedZoneId` | *(empty)* | Optional Route 53 hosted zone. With `cloudfront`, the hop from CloudFront to the origin load balancer uses HTTPS with a DNS-validated certificate. |
| `DcvAllowedClientCidrs` | *(empty)* | Comma-separated CIDR ranges allowed to reach the gateway's public ports (TCP 8443, UDP 8444), primary and hubs. Empty: open. |
| `DcvAllowedPrefixListIds` | *(empty)* | Up to 2 managed prefix list IDs allowed to reach the primary gateway's public ports. |
| `IdentityCenterSyncGroups` | *(empty)* | Groups to sync from Identity Center |
| `FrontendUrl` | *(empty)* | Custom URL for web console |
| `AdminEmails` | *(empty)* | Comma-separated emails to create as Cognito admin users. Each receives a welcome email with the frontend URL and a temporary password. Addresses added later are created on the next deploy. With Cognito on and no SAML IdP, leave it empty only if you will [create users yourself](#2-authentication-setup): otherwise nobody can sign in. |
| `EnableBedrockFeatures` | `true` | Set to `false` to disable AI/Bedrock features. Useful for accounts with SCPs that restrict Bedrock access. |
| `MacBuildAvailabilityZone` | *(empty)* | AZ for macOS Image Builder builds (e.g., `us-east-1c`). Must match an AZ where mac dedicated hosts can be allocated. Leave empty to use the first private subnet's AZ. |
| `WafAllowedIps` | *(empty)* | Comma-separated CIDR ranges to whitelist for CloudFront access. When set, creates a WAF WebACL that blocks all traffic except from these IPs. Leave empty for no restriction. |
| `FrontendCertificateArn` | *(empty)* | ACM certificate ARN in `us-east-1` for the custom frontend domain. Required when `FrontendUrl` is set. |
| `SsoUserPoolArn` | *(empty)* | ARN of an external Cognito User Pool with pre-configured SSO/SAML. Imports the pool instead of creating one. See [External SSO User Pool](#external-sso-user-pool). |
| `SsoUserPoolClientId` | *(empty)* | Client ID of the external SSO User Pool. Required when `SsoUserPoolArn` is set. |
| `SsoUserPoolDomain` | *(empty)* | Domain URL of the external SSO User Pool. Required when `SsoUserPoolArn` is set. |

#### Using an existing VPC

MRM uses one private subnet and one public subnet in each Availability Zone,
in at least 2 AZs. The private subnets need outbound internet access (a NAT
gateway, NAT instance or transit gateway).

When you set `VpcId`, the deployment script automatically runs `scripts/analyze-vpc.sh` to:
- Inspect subnet layout
- Check the subnets in `PrivateSubnetIds` and `PublicSubnetIds` when you set them: each must be in the VPC, one per AZ, in the order of `AvailabilityZones` (filled in from the subnets when empty)
- Prompt for subnet selection (if multiple subnets per AZ and you run `./deploy.sh` in a terminal)
- Save `PrivateSubnetIds`, `PublicSubnetIds`, `AvailabilityZones` and the private route tables to parameters.json
- Check NACLs for DCV UDP/QUIC compatibility

If the VPC has more than one private or public subnet in an AZ, choose them
yourself when there is no terminal (the deploy pipeline). On a first deploy
the analyzer stops with exit code 3 and lists each candidate subnet with the
target of its default route. Set the subnets in one of these ways:

- **Deploy pipeline:** update the pipeline stack and set its `PrivateSubnetIds`
  and `PublicSubnetIds` parameters, for example `subnet-aaa,subnet-bbb`.
- **One pipeline build:** start the build with
  `MRM_PARAM_OVERRIDES={"PrivateSubnetIds":"subnet-aaa,subnet-bbb","PublicSubnetIds":"subnet-ccc,subnet-ddd"}`.
- **Local deploy:** add `PrivateSubnetIds` and `PublicSubnetIds` to
  `parameters.json`, or run `./deploy.sh` in a terminal and pick them.

Choose the subnets before the first deploy and don't change or reorder them
later. AWS Managed Microsoft AD is created in the first two private subnets,
and changing them replaces the directory, which loses its users and breaks
every domain-joined workstation. The analyzer stops if `PrivateSubnetIds` or
`PublicSubnetIds` differs from, or is in a different order than, the subnets
an install is deployed on.

**Private subnets that route through a NAT instance.** Without
`PrivateSubnetIds`, CDK looks the VPC up and counts a subnet as private only
when its default route goes to a NAT gateway or a transit gateway. A subnet
whose default route goes to a NAT instance or a network interface counts as
isolated, and the synth stops with "found 0 private subnet(s)". Either set
`PrivateSubnetIds`, or tag those subnets so the lookup counts them as private:

```bash
aws ec2 create-tags --resources subnet-aaa subnet-bbb \
  --tags Key=aws-cdk:subnet-type,Value=Private
```

Tag your public subnets `Value=Public` the same way if the lookup misses them.

### Deploying in accounts with VPC Block Public Access

[VPC Block Public Access](https://docs.aws.amazon.com/vpc/latest/userguide/security-vpc-bpa.html) (BPA) in `block-ingress` mode blocks internet traffic through internet gateways, except traffic that leaves through a NAT gateway or an egress-only internet gateway. For MRM this means:

| Component | With ingress-only BPA and no exclusions |
|-----------|------------------------------------------|
| Workstations and Lambdas in private subnets, egress through a NAT gateway | Work |
| NAT instance (instead of a NAT gateway) | No internet access, so private subnets routed through it have none either |
| CloudFront VPC origin for browser sessions (`DcvBrowserPath=cloudfront`) | Can't be created: the `<ACRONYM>-Dcv-Infrastructure` stack fails and rolls back |
| Internet-facing Network Load Balancer of the DCV Connection Gateway | Deploys, but drops all inbound traffic, so native DCV clients can't connect |

In `block-bidirectional` mode, NAT gateway traffic is blocked too.

**Fix: subnet exclusions.** Deploy into an existing VPC (`VpcId`) that uses a NAT gateway, and create a bidirectional exclusion for four subnets before you deploy:

- the two private subnets in `PrivateSubnetIds`, where the internal load balancer behind the CloudFront VPC origin runs
- the two public subnets in `PublicSubnetIds`, where the gateway's Network Load Balancer runs

```bash
for SUBNET in <private-subnet-1> <private-subnet-2> <public-subnet-1> <public-subnet-2>; do
  aws ec2 create-vpc-block-public-access-exclusion \
    --subnet-id "$SUBNET" \
    --internet-gateway-exclusion-mode allow-bidirectional \
    --region <region>
done

# Wait until each exclusion is "create-complete"
aws ec2 describe-vpc-block-public-access-exclusions --region <region> --max-results 50 \
  --query 'VpcBlockPublicAccessExclusions[].[ResourceArn,State]' --output table
```

Creating exclusions needs `ExclusionsAllowed: allowed` in `describe-vpc-block-public-access-options`; an AWS Organizations declarative policy can turn it off. A VPC-level exclusion (`--vpc-id`) also works, but it opens every subnet in the VPC, so we don't recommend it.

**Limit who can reach the gateway.** The excluded public subnets accept internet traffic, so set `DcvAllowedClientCidrs` and/or `DcvAllowedPrefixListIds` (see [Infrastructure Parameters](#2-infrastructure-parameters-parametersjson)) to your users' address ranges. The Network Load Balancer keeps the client's source IP, so the gateway's security group applies these rules to each client.

**What we tested** (existing VPC, ingress-only BPA, the four exclusions above, the gateway limited to one client CIDR):

- Browser sessions through the CloudFront VPC origin
- The native DCV client over QUIC (UDP 8444) and over TCP 8443
- Linux and Windows workstation setup, with egress through the NAT gateway
- FSx for Windows File Server storage attached to a workstation in another Availability Zone

Regional hubs weren't tested with BPA.

**Upgrading an existing installation:**

- Starting with v1.5.0, browser sessions go through a CloudFront VPC origin by default (`DcvBrowserPath=cloudfront`), including installations that never set `DcvBrowserPath`. With BPA on, create the exclusions for the two `PrivateSubnetIds` subnets before you upgrade, or set `DcvBrowserPath=direct` to keep the previous browser path. Without them, the VPC origin can't be created and the `<ACRONYM>-Dcv-Infrastructure` update fails.
- If you deployed into an existing VPC with several private subnets per Availability Zone and passed `PrivateSubnetIds` and `PublicSubnetIds` through `MRM_PARAM_OVERRIDES`, set the same subnets, in the same order, as the pipeline stack's `PrivateSubnetIds` and `PublicSubnetIds` parameters. Changing them replaces the Managed Microsoft AD directory. With the same subnets, the upgrade replaces one resource: the DynamoDB gateway endpoint in `<ACRONYM>-Infrastructure`, which is now attached to the private subnets' route tables. The previous endpoint wasn't attached to any route table, so DynamoDB access isn't interrupted. Nothing else in the VPC changes: the directory, interface endpoints, load balancers, subnets and route tables stay as they are.
- After you update the pipeline stack, check that a build started. A stack update may not start one; if no build starts, start one yourself (`aws codebuild start-build --project-name <project-name>`).

**Planned improvements:** [#106](https://github.com/awslabs/media-resource-manager/issues/106) (an optional `CreateBpaExclusions` parameter that creates these exclusions, also in regional hubs) and [#107](https://github.com/awslabs/media-resource-manager/issues/107) (an internal-only gateway for users on VPN, Direct Connect or Transit Gateway, which works with BPA on and no exclusions).

### Hostname Customization

Workstations get unique hostnames using a configurable prefix and sequential numbering:

| Prefix | Digits | Hostname Range |
|--------|--------|----------------|
| `vdi-` | 3 | `vdi-001` to `vdi-999` |
| `studio-vdi-` | 4 | `studio-vdi-0001` to `studio-vdi-9999` |
| `ws-` | 5 | `ws-00001` to `ws-99999` |

Numbers are assigned atomically via DynamoDB to prevent collisions during concurrent creation.

---

## Post-Deployment Setup

### 1. Access the Application

Get the frontend URL:
```bash
aws ssm get-parameter --name "/MediaResourceManager/Frontend/Url" --query "Parameter.Value" --output text
```

### 2. Authentication Setup

#### Option A: Cognito/SAML (Recommended)

**With SAML Identity Provider:**
1. Configure your IdP: [Okta Setup Guide](docs/OKTA_SETUP_GUIDE.md) or [IAM Identity Center Guide](docs/IAM_IDENTITY_CENTER_SETUP_GUIDE.md)
2. Run setup script:
   ```bash
   ./scripts/setup-okta-saml.sh          # For Okta
   ./scripts/setup-identity-center-saml.sh  # For Identity Center
   ```
3. Enable Cognito auth:
   ```bash
   aws ssm put-parameter --name "/MediaResourceManager/Auth/UseCognitoAuth" --value "true" --overwrite
   ```

**With Native Cognito Users (no external IdP):**

Self sign-up is off, so a user can sign in only after an administrator creates them. The easiest way is to list the first administrators in `AdminEmails` before you deploy (see [Configuration](#configuration)). The deployment creates the `AdminGroupName` group, creates a user for each address, adds them to the group, and Cognito emails each one the frontend URL and a temporary password.

If you deployed with `AdminEmails` empty, the deployment warns that nobody can sign in. Either add addresses to `AdminEmails` and deploy again, or create a user yourself. The `MRM-Frontend` stack output `AdminOnboardingCommands` holds these commands with your User Pool ID filled in:
```bash
USER_POOL_ID=$(aws ssm get-parameter --name "/MediaResourceManager/Auth/UserPoolId" --query "Parameter.Value" --output text)

# Create the user. Cognito emails them the frontend URL and a temporary password.
aws cognito-idp admin-create-user --user-pool-id $USER_POOL_ID \
  --username "admin@example.com" \
  --user-attributes Name=email,Value=admin@example.com Name=email_verified,Value=true \
    Name=given_name,Value=Admin Name=family_name,Value=User \
  --desired-delivery-mediums EMAIL

# Make them an administrator (the group from AdminGroupName, MRM-Admins by default)
aws cognito-idp admin-add-user-to-group --user-pool-id $USER_POOL_ID \
  --username "admin@example.com" --group-name "MRM-Admins"
```

You can also create the user in the Amazon Cognito console (**User pools** > `MRM-UserPool` > **Users** > **Create user**, with **Send an email invitation**) and add them to the admin group there.

The `Identity/*` secrets in Secrets Manager are Active Directory accounts for workstations, not web UI logins.

#### Option B: LDAP Authentication

```bash
aws secretsmanager get-secret-value \
  --secret-id "/MediaResourceManager/Identity/ResourceAdminActiveDirectoryLoginCredentials" \
  --query SecretString --output text
```

Login with username `ResourceAdmin` and the retrieved password.

### 3. Configure Custom Domain (Optional)

**Web Console Custom Domain**

By default, the web console is served from a CloudFront URL (e.g., `d1234567890abc.cloudfront.net`). To use a custom domain like `vdi.company.com`:

**Step 1: Create an ACM certificate in us-east-1**

CloudFront requires certificates in `us-east-1` regardless of your deployment region.

```bash
# Request a certificate
aws acm request-certificate \
  --domain-name vdi.company.com \
  --validation-method DNS \
  --region us-east-1

# Note the CertificateArn from the output
```

Then validate the certificate by adding the CNAME record that ACM provides to your DNS. You can find the validation record in the ACM console or via:

```bash
aws acm describe-certificate \
  --certificate-arn <certificate-arn> \
  --region us-east-1 \
  --query "Certificate.DomainValidationOptions[0].ResourceRecord"
```

Wait for the certificate status to change to `ISSUED` (usually a few minutes after adding the DNS record).

**Step 2: Set parameters and deploy**

Set both `FrontendUrl` and `FrontendCertificateArn` in your configuration. CDK uses these to configure the CloudFront distribution with your custom domain alias and TLS certificate.

For local deployments, update `parameters.json`:
```json
{ "ParameterKey": "FrontendUrl", "ParameterValue": "https://vdi.company.com" },
{ "ParameterKey": "FrontendCertificateArn", "ParameterValue": "arn:aws:acm:us-east-1:123456789012:certificate/abc-123-def" }
```
Then run `./deploy.sh`.

For CodeBuild deployments:
```bash
aws codebuild start-build --project-name <project-name> \
  --environment-variables-override \
    'name=MRM_PARAM_OVERRIDES,value={"FrontendUrl":"https://vdi.company.com","FrontendCertificateArn":"arn:aws:acm:us-east-1:123456789012:certificate/abc-123-def"},type=PLAINTEXT'
```

Or update the pipeline stack parameters via CloudFormation console, then start a build.

**Step 3: Create a DNS record**

Point your custom domain to the CloudFront distribution:

```bash
# Get the CloudFront domain name
aws ssm get-parameter --name "/MediaResourceManager/Frontend/CloudFrontUrl" \
  --query "Parameter.Value" --output text
```

Create a CNAME record (or Route 53 alias record) pointing `vdi.company.com` to the CloudFront distribution domain (e.g., `d1234567890abc.cloudfront.net`).

> **Important:** Always set `FrontendUrl` and `FrontendCertificateArn` together. `FrontendUrl` updates CORS and Cognito callback URLs, while `FrontendCertificateArn` configures TLS on CloudFront. If you set a custom domain on CloudFront manually (outside of CDK), the next CDK deployment will remove it. CDK must own the configuration.

> **Removing a custom domain:** To revert to the default CloudFront URL, clear both parameters (set to empty strings) and redeploy.

**DCV Connection Gateway Custom Domain**

The DCV Connection Gateway uses TCP passthrough at the NLB. TLS is handled by the Gateway itself, not the load balancer. This means you need the actual certificate and private key PEM files (not just an ACM ARN). You can use Let's Encrypt, your corporate CA, or export from ACM if your account allows it.

For CodeBuild deployments, the buildspec automatically restores certificate files from Secrets Manager since `certs/` is gitignored and not available in fresh clones.

**Step 1: Store your certificate in Secrets Manager**

Use the helper script to generate or import a certificate:

```bash
# Option A: Generate a free certificate with Let's Encrypt
./scripts/setup-dcv-certificate.sh \
  --domain dcv.company.com \
  --email admin@company.com

# Option B: Import existing PEM files (e.g., from your CA or IT team)
./scripts/setup-dcv-certificate.sh \
  --cert /path/to/fullchain.pem \
  --key /path/to/privkey.pem

# Option C: Import from ACM export (encrypted private key)
./scripts/setup-dcv-certificate.sh \
  --cert /path/to/certificate.pem \
  --chain /path/to/certificate_chain.pem \
  --key /path/to/private_key.txt \
  --passphrase 'YOUR_PASSPHRASE'
```

The script validates the cert/key pair, stores them in Secrets Manager at `/{PascalCase}/DCV/CertificateFiles`, and prints next steps.

If you can't run the script, store the certificate manually:

```bash
# From any machine with the PEM files (laptop, CloudShell, etc.)
aws secretsmanager create-secret \
  --name /MediaResourceManager/DCV/CertificateFiles \
  --secret-string "$(jq -n \
    --arg cert "$(cat fullchain.pem)" \
    --arg key "$(cat privkey.pem)" \
    '{certificate: $cert, privateKey: $key}')"
```

Or via the Secrets Manager console: Store a new secret → Other type → add two plaintext key/value pairs: `certificate` (paste fullchain PEM content) and `privateKey` (paste private key PEM content).

**Step 2: Set DCV domain parameters and deploy**

You also need an ACM certificate for the same domain (this is used as a CDK reference only, not for TLS termination). If you don't provide one, CDK will try to create a new cert requiring DNS validation, which can hang the deployment.

```bash
aws codebuild start-build --project-name <project-name> \
  --environment-variables-override \
    'name=MRM_PARAM_OVERRIDES,value={"DcvDomainName":"dcv.company.com","DcvCertificateArn":"arn:aws:acm:..."},type=PLAINTEXT'
```

For local deployments, set `DcvDomainName`, `DcvCertificateArn`, `DcvCertificateFile`, and `DcvPrivateKeyFile` in `parameters.json` and run `./deploy.sh`.

The buildspec automatically pulls the cert from Secrets Manager, writes it to `certs/`, and deploys.

**Step 3: Create a DNS record and refresh the Gateway**

After deployment, create a CNAME record pointing your domain to the NLB:

```bash
# Get the NLB DNS name from SSM (replace MediaResourceManager with your PascalCase name)
aws ssm get-parameter \
  --name "/MediaResourceManager/DCV/Endpoint" \
  --query 'Parameter.Value' --output text
```

Create a CNAME record in your DNS provider pointing `dcv.company.com` to the NLB DNS name (the hostname portion of the endpoint URL, without `https://` or the port).

If this is an update to an existing deployment, refresh the Connection Gateway instances to pick up the new certificate:

```bash
# Find and terminate the Gateway instance. ASG will launch a new one with the cert
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:aws:autoscaling:groupName,Values=*ConnectionGateway*" \
            "Name=instance-state-name,Values=running" \
  --query "Reservations[0].Instances[0].InstanceId" --output text)
aws ec2 terminate-instances --instance-ids $INSTANCE_ID
```

To renew or update certificates later, update the Secrets Manager secret and trigger a new build.

---

## Authentication

### Dual Authentication Modes

- **LDAP Mode**: Direct integration with AWS Managed Active Directory
- **Cognito Mode**: Federated authentication via SAML 2.0 (Okta, IAM Identity Center, or external SSO User Pool)

Switch modes via SSM:
```bash
aws ssm put-parameter --name "/MediaResourceManager/Auth/UseCognitoAuth" --value "true" --overwrite
```

### SAML Identity Provider Integration

- [Okta Setup Guide](docs/OKTA_SETUP_GUIDE.md)
- [IAM Identity Center Setup Guide](docs/IAM_IDENTITY_CENTER_SETUP_GUIDE.md)
- [Microsoft Entra ID Setup Guide](docs/ENTRA_ID_SETUP_GUIDE.md)
- [Okta Technical Implementation Guide](docs/OKTA_SAML_INTEGRATION_GUIDE.md)

### External SSO User Pool

For organizations that manage their own Cognito User Pool with SAML/Entra ID integration (e.g., via a separate CloudFormation stack), the CDK app can import that pool instead of creating its own.

**When to use this:** Your identity team creates and manages a Cognito User Pool with SAML federation (e.g., Microsoft Entra ID) and hands you the pool details to integrate.

**What you need from the identity team:**
1. `UserPoolArn`: ARN of the Cognito User Pool
2. `UserPoolClientId`: App client ID configured for your application
3. `UserPoolDomain`: The Cognito domain URL (e.g., `https://my-app.auth.us-east-1.amazoncognito.com`)

**Configuration:**

Set these three parameters in `parameters.json`:
```json
{ "ParameterKey": "SsoUserPoolArn", "ParameterValue": "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_AbCdEfG" },
{ "ParameterKey": "SsoUserPoolClientId", "ParameterValue": "1a2b3c4d5e6f7g8h9i0j" },
{ "ParameterKey": "SsoUserPoolDomain", "ParameterValue": "https://my-app.auth.us-east-1.amazoncognito.com" }
```

**Behavior when external SSO is configured:**
- The CDK app imports the external User Pool instead of creating one
- No local Cognito groups or admin users are created (`AdminEmails` is ignored)
- The `AdminGroupName` parameter is still used at runtime to determine admin access from token claims
- The Identity Pool (for S3 access) is still created locally
- All Lambda functions and the frontend work unchanged. They they read auth config from the same SSM parameter paths

**Example with Entra ID (Azure AD):**

The identity team's workflow typically looks like:
1. They create a `entra-user-pool` CloudFormation stack with SAML integration
2. They configure AD groups that map to Cognito groups (e.g., `Admin`, `Editor`)
3. They test the SAML flow and claims mapping
4. They hand you the three values above

You then set `AdminGroupName` to match the admin group name in the token (e.g., `Admin`) and deploy.

---

## Architecture Overview

The application uses a **multi-stack architecture** with 19 specialized stacks:

**Core Infrastructure:**
- `MRM-Infrastructure`: Network, Identity (AD), Database, Security, ImageBuilder
- `MRM-Dcv-Infrastructure`: DCV Session Manager, Connection Gateway, NLB
- `MRM-Dcv-Cleanup`: Automated session cleanup
- `MRM-Dcv-StatusSync`: Connection status monitoring

**Workstation Provisioning:**
- `MRM-Workstation-Windows`: Windows provisioning workflow
- `MRM-Workstation-Linux`: Linux provisioning (Ubuntu, Rocky)
- `MRM-Workstation-MacOS`: macOS provisioning (Dedicated Host)
- `MRM-Workstation-Start`: Startup workflow
- `MRM-Image-MacOS`: macOS base image pipeline

**API & Frontend:**
- `MRM-Api`: API Gateway, Lambda functions
- `MRM-Storage`: FSx storage management
- `MRM-Events`: EventBridge rules
- `MRM-Frontend`: React app on S3/CloudFront

**Operations:**
- `MRM-Log-Retention`: Sets a retention period on Lambda log groups. Deploys last.

---

## Features

**📚 See the [User Guide](docs/USER_GUIDE.md) for detailed instructions.**

### For Administrators
- Create and manage workstations across Windows, Linux, and macOS
- Assign workstations to users and groups
- Monitor workstation status, DCV sessions, and usage
- Configure auto-shutdown and auto-start policies
- Manage user accounts, groups, and permissions
- **Image pipeline management**: Build custom AMIs using EC2 Image Builder with GPU drivers, DCV, and your software pre-installed
- **Shared storage management**: Create and mount FSx for NetApp ONTAP, FSx for Windows File Server, and S3 buckets onto workstations automatically
- **Data transfer**: Move data between storage locations using AWS DataSync with progress tracking
- **Software library**: Define and deploy software packages to workstations via install scripts
- **Multi-region hubs**: Deploy satellite DCV infrastructure in remote regions for lower-latency connections

### For Users
- View assigned workstations
- Start/stop workstations with real-time progress tracking
- Connect via DCV (native client or browser)
- Real-time status dashboard

---

## API Endpoints

### Workstations
- `GET /workstations` - List all
- `POST /workstations` - Create new
- `GET /workstations/{id}` - Get details
- `PUT /workstations/{id}` - Update
- `DELETE /workstations/{id}` - Delete
- `POST /workstations/start` - Start
- `POST /workstations/stop` - Stop

### Users
- `GET /users` - List all
- `POST /users` - Create
- `POST /users/sync` - Sync from Identity Center

### Images & Pipelines
- `GET /images` - List AMIs
- `POST /images/create-pipeline` - Create pipeline
- `GET /images/pipelines` - List pipelines

### Storage
- `GET /storage` - List FSx resources
- `POST /storage` - Create storage

### Authentication
- `POST /auth/ldap` - LDAP auth (returns JWT)
- `GET /auth/validate` - Validate token

---

## Database Schema

Tables use pattern `{acronym}-{table}` (e.g., `mrm-users`, `mrm-workstations`).

| Table | Primary Key | Description |
|-------|-------------|-------------|
| `{acronym}-users` | `userId` | User accounts |
| `{acronym}-workstations` | `instanceId` | EC2 workstations |
| `{acronym}-amis` | `amiId` | Available AMIs |
| `{acronym}-groups` | `groupId` | User groups |
| `{acronym}-storage` | `storageId` | FSx resources |
| `{acronym}-image-pipelines` | `pipelineId` | Image Builder pipelines |
| `{acronym}-software-library` | `softwareId` | Software catalog |
| `{acronym}-hostname-counter` | `counterId` | Hostname sequence |

---

## Security

- **VPC Isolation**: Private subnets for workstations
- **Security Groups**: Restrictive rules for necessary ports
- **DynamoDB Encryption**: At-rest encryption enabled
- **S3 Encryption**: Frontend assets encrypted
- **CloudFront HTTPS**: Enforced for web access
- **JWT Tokens**: 8-hour expiration
- **IAM Least Privilege**: Minimal required permissions

---

## Monitoring and Logging

- **CloudWatch Logs**: Lambda execution logs
- **DynamoDB Metrics**: Database performance
- **EC2 Monitoring**: Workstation health checks
- **API Gateway Logs**: Request/response logging
- **EventBridge Rules**: EC2 state changes, auto-shutdown

---

## Troubleshooting

### Common Issues

**DCV Connection Fails:**
- Check security group rules (ports 8443, 8445)
- Verify DCV services running on instances
- Confirm NLB health checks

**Workstation Creation Fails:**
- Verify AMI IDs for your region
- Check EC2 service limits
- Ensure IAM permissions

**Authentication Issues:**
- Verify AD configuration
- Check ResourceAdmin user in AD
- Confirm JWT token expiration

### Log Analysis
```bash
aws logs tail /aws/lambda/MRM-WorkstationFunction --follow
```

---

## Cost Optimization

- **Auto-shutdown**: Workstations stop when idle
- **Right-sizing**: Choose appropriate instance types
- **Reserved Instances / Savings Plans**: Consider for persistent workstations
- **Billing Alerts**: Set up cost monitoring

---

## AWS Service Quotas

### FSx for NetApp ONTAP

| Team Size | HA Pairs | Throughput Required |
|-----------|----------|---------------------|
| Small (1-5) | 1 | 3,072 MB/s |
| Medium (5-15) | 2 | 6,144 MB/s |
| Large (15-30) | 6 | 18,432 MB/s |

Default quota is 10,240 MB/s. Request increase for larger deployments.

### Other Quotas

| Service | Quota | Recommendation |
|---------|-------|----------------|
| EC2 | Running instances | Increase for workstation scaling |
| VPC | Elastic IPs | Increase for multiple NAT gateways |
| Lambda | Concurrent executions | 1,000 usually sufficient |

---

## Cleanup

To remove all Media Resource Manager resources:

```bash
./delete-stacks.sh
```

The script will:
1. Discover all stacks with the product prefix
2. Delete them in reverse dependency order
3. Clean up orphaned resources (SSM parameters, CloudWatch log groups, Image Builder resources)
4. Prompt before deleting the S3 media bucket (contains user data)

**Important:** The cleanup script auto-detects your region from `aws configure`. Ensure your AWS CLI is configured for the correct region before running.

Alternatively, delete stacks manually in reverse order:
```bash
cdk destroy MRM-Events
cdk destroy MRM-Frontend
cdk destroy MRM-Api
# ... continue in reverse deployment order
cdk destroy MRM-Infrastructure
```

> **Note:** The `CleanupConstruct` in the DCV Infrastructure stack automatically terminates all EC2 workstations and cleans up Lambda ENIs when that stack is deleted.

---

## Development

```bash
# Install dependencies
npm ci
for d in configure-ontap-cifs fsx-nfs-mount-manager jwt-authorizer volume-manager; do
  (cd "lambda/$d" && npm ci)   # Lambda deps the unit tests load
done
(cd frontend && npm ci)

# CDK and Lambda unit tests: build first, Jest loads the compiled lib/*.js
npm run build
npx jest

# Frontend checks and dev server with hot reload
cd frontend
npx tsc --noEmit -p .   # no new type errors
npx vite build
npx vitest run
npm run dev
cd ..

# CDK commands
npx cdk diff
npx cdk synth
npx cdk deploy
```

For more details, see the [Development Guide](docs/DEVELOPMENT.md).

---

## Project Structure

```
media-resource-manager/
├── bin/                    # CDK app entry point
├── lib/                    # CDK stacks and constructs
│   └── constructs/         # Reusable CDK constructs
├── lambda/                 # Lambda function code (JS/Python)
├── frontend/               # React frontend application
│   └── src/
│       ├── components/     # Reusable UI components
│       ├── pages/          # Page components
│       └── utils/          # API clients and utilities
├── layers/                 # Lambda layers (LDAP)
├── scripts/                # Deployment and utility scripts
├── ssm-documents/          # SSM document definitions
├── user-data/              # EC2 user data scripts
├── software-library/       # Software install definitions
├── docs/                   # User-facing documentation
├── deploy.sh               # One-command deployment script
├── delete-stacks.sh        # Stack cleanup script
└── parameters.example.json # Configuration template
```

---

## FAQ, Known Issues, and Additional Considerations

- **VPC requirements**: The solution requires at least 2 Availability Zones with private and public subnets. NAT Gateways are required for Lambda VPC functions to access AWS APIs.
- **DCV licensing**: Amazon DCV is included at no additional cost for EC2 instances. No separate license is required.
- **macOS workstations**: Require dedicated hosts (24-hour minimum allocation). See [macOS setup guide](docs/MACOS_SEQUOIA_SIP_DISABLE.md).
- **Multi-region**: Regional hubs can be deployed to satellite regions for lower-latency DCV connections. See [Multi-Region Deployment](docs/MULTI_REGION_DEPLOYMENT.md).
- For feedback, questions, or suggestions, please use the [GitHub Issues page](https://github.com/awslabs/media-resource-manager/issues).

---

## Revisions

- June 2026: Initial open source release v1.0.0

---

## Notices

Customers are responsible for making their own independent assessment of the information in this Guidance. This Guidance: (a) is for informational purposes only, (b) represents AWS current product offerings and practices, which are subject to change without notice, and (c) does not create any commitments or assurances from AWS and its affiliates, suppliers or licensors. AWS products or services are provided "as is" without warranties, representations, or conditions of any kind, whether express or implied. AWS responsibilities and liabilities to its customers are controlled by AWS agreements, and this Guidance is not part of, nor does it modify, any agreement between AWS and its customers.

---

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

---

## Authors

- Matt Wildes
- Joseph Giacobbe
- John Whitehead
