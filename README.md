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

- **VPC Block Public Access (BPA)** — if enabled in `block-ingress` mode on the target
  account/region, inbound internet traffic to your VPC is blocked and the DCV Connection
  Gateway NLB will be unreachable, showing up client-side as "endpoint is unreachable" in
  the DCV Viewer. Some organizations enable this by default on newly created accounts as
  a preventive security guardrail, so a fresh account may already have BPA on.

  Check the setting:

  ```bash
  aws ec2 describe-vpc-block-public-access-options --region <region>
  ```

  If it reports `"InternetGatewayBlockMode": "block-ingress"`, add an exclusion for the
  MRM VPC (or, for tighter blast radius, only the public subnets hosting the DCV
  Connection Gateway NLB):

  ```bash
  # VPC-level (simplest — fine for test/dev accounts)
  aws ec2 create-vpc-block-public-access-exclusion \
    --vpc-id <mrm-vpc-id> \
    --internet-gateway-exclusion-mode allow-bidirectional \
    --region <region>

  # Subnet-level (recommended for prod — only the DCV public subnets)
  for SUBNET in <dcv-public-subnet-1> <dcv-public-subnet-2> <dcv-public-subnet-3>; do
    aws ec2 create-vpc-block-public-access-exclusion \
      --subnet-id $SUBNET \
      --internet-gateway-exclusion-mode allow-bidirectional \
      --region <region>
  done
  ```

  Exclusions are self-service — no ticket or approval needed provided the account owner
  can call the API (`ExclusionsAllowed: allowed`). Exclusions take effect within a couple
  of minutes.

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
   aws ssm get-parameter --name "/MediaResourceManager/Frontend/CloudFrontUrl" --query "Parameter.Value" --output text
   ```

2. **Set up authentication** based on your `UseCognitoAuth` setting:
   - **Cognito (recommended)**: See [Post-Deployment Setup](#post-deployment-setup) for Okta/Identity Center integration or native Cognito users
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
  --stack-name MRM-DeployPipeline \
  --capabilities CAPABILITY_NAMED_IAM
```

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
| `FrontendUrl` | *(empty)* | Custom URL for web console (e.g., `https://vdi.company.com`). Leave empty for auto-generated CloudFront URL. |
| `AdminEmails` | *(empty)* | Comma-separated emails to create as Cognito admin users on first deploy (e.g., `admin@company.com`). Each receives a welcome email with temp password. |
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

**3. Trigger deployment:**

Get the CodeBuild project name from the stack outputs:
```bash
aws cloudformation describe-stacks --stack-name MRM-DeployPipeline \
  --query "Stacks[0].Outputs[?OutputKey=='CodeBuildProjectName'].OutputValue" --output text
```

Then start a build:
```bash
aws codebuild start-build --project-name <project-name>
```

Or from the AWS Console: CodeBuild → find the project → Start build.

**4. Update configuration after initial deploy:**

Pipeline parameters seed the initial config. After the first build, config is stored in SSM under the PascalCase name derived from `ProductName` and is the source of truth for all subsequent builds. There are three ways to update configuration:

> **Upgrading from an earlier version?** If your pipeline stack was deployed before all parameters were available (e.g., `FrontendUrl`, `DcvDomainName`), update the stack with the latest template to expose them:
> ```bash
> aws cloudformation deploy \
>   --template-file scripts/deploy-pipeline.yaml \
>   --stack-name MRM-DeployPipeline \
>   --capabilities CAPABILITY_NAMED_IAM
> ```
> This adds the new parameters with safe defaults. Your existing SSM config is preserved. No rebuild needed unless you want to change values.

**Option A: Update the pipeline stack (recommended for persistent changes via console)**

Update the CloudFormation stack with new parameter values. This updates the CodeBuild project's environment variables, which are applied on the next build:

```bash
aws cloudformation deploy \
  --template-file scripts/deploy-pipeline.yaml \
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

### 2. Infrastructure Parameters (`parameters.json`)

```bash
cp parameters.example.json parameters.json
```

**Key Parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `VpcId` | *(empty)* | Existing VPC ID, or empty to create new |
| `VpcCidr` | `10.1.0.0/16` | CIDR for new VPC |
| `DomainName` | `studio.mrm.internal` | AD domain for workstation domain-joining |
| `UseCognitoAuth` | `true` | `true` for Cognito/SAML, `false` for LDAP |
| `AdminGroupName` | `MRM-Admins` | Admin group name |
| `HostnamePrefix` | `vdi-` | Workstation hostname prefix |
| `HostnameDigits` | `4` | Digits in hostname suffix (e.g., `vdi-0001`) |
| `DcvCertificateArn` | *(empty)* | ACM certificate ARN for custom DCV domain |
| `DcvDomainName` | *(empty)* | Custom domain for DCV connections |
| `IdentityCenterSyncGroups` | *(empty)* | Groups to sync from Identity Center |
| `FrontendUrl` | *(empty)* | Custom URL for web console |
| `AdminEmails` | *(empty)* | Comma-separated emails to create as Cognito admin users on first deploy. Each receives a welcome email with temp password. |
| `EnableBedrockFeatures` | `true` | Set to `false` to disable AI/Bedrock features. Useful for accounts with SCPs that restrict Bedrock access. |
| `MacBuildAvailabilityZone` | *(empty)* | AZ for macOS Image Builder builds (e.g., `us-east-1c`). Must match an AZ where mac dedicated hosts can be allocated. Leave empty to use the first private subnet's AZ. |
| `WafAllowedIps` | *(empty)* | Comma-separated CIDR ranges to whitelist for CloudFront access. When set, creates a WAF WebACL that blocks all traffic except from these IPs. Leave empty for no restriction. |
| `FrontendCertificateArn` | *(empty)* | ACM certificate ARN in `us-east-1` for the custom frontend domain. Required when `FrontendUrl` is set. |
| `SsoUserPoolArn` | *(empty)* | ARN of an external Cognito User Pool with pre-configured SSO/SAML. Imports the pool instead of creating one. See [External SSO User Pool](#external-sso-user-pool). |
| `SsoUserPoolClientId` | *(empty)* | Client ID of the external SSO User Pool. Required when `SsoUserPoolArn` is set. |
| `SsoUserPoolDomain` | *(empty)* | Domain URL of the external SSO User Pool. Required when `SsoUserPoolArn` is set. |

**Using an existing VPC:**

When you set `VpcId`, the deployment script automatically runs `scripts/analyze-vpc.sh` to:
- Inspect subnet layout
- Prompt for subnet selection (if multiple subnets per AZ)
- Save `PrivateSubnetIds`, `PublicSubnetIds`, `AvailabilityZones` to parameters.json
- Check NACLs for DCV UDP/QUIC compatibility

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
aws ssm get-parameter --name "/MediaResourceManager/Frontend/CloudFrontUrl" --query "Parameter.Value" --output text
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
```bash
USER_POOL_ID=$(aws ssm get-parameter --name "/MediaResourceManager/Auth/UserPoolId" --query "Parameter.Value" --output text)

# Create admin group
aws cognito-idp create-group --user-pool-id $USER_POOL_ID --group-name "MRM-Admins"

# Create user
aws cognito-idp admin-create-user --user-pool-id $USER_POOL_ID \
  --username "admin@example.com" \
  --user-attributes Name=email,Value=admin@example.com Name=email_verified,Value=true \
  --temporary-password "TempPass123!"

# Add to admin group
aws cognito-idp admin-add-user-to-group --user-pool-id $USER_POOL_ID \
  --username "admin@example.com" --group-name "MRM-Admins"
```

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

The application uses a **multi-stack architecture** with 18 specialized stacks:

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
npm install
cd frontend && npm install

# Frontend dev server with hot reload
cd frontend && npm run dev

# Run CDK tests
npm test

# CDK commands
cdk diff
cdk synth
cdk deploy
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
