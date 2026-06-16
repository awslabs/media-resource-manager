# AWS Media Resource Manager

A comprehensive Amazon CDK application for managing EC2 workstations with Amazon DCV (NICE Desktop Cloud Visualization). This solution provides a web-based console for administrators to create and manage virtual workstations, and for users to access their assigned workstations through DCV.

[![Launch Stack](https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png)](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?templateURL=https://ws-assets-prod-iad-r-iad-ed304a55c2ca1aee.s3.us-east-1.amazonaws.com/cfc326cf-ee59-42bb-81d7-e73596e77a2f/deploy-pipeline.yaml&stackName=MRM-DeployPipeline)

## Table of Contents

- [Quick Start](#quick-start)
- [Deployment Options](#deployment-options)
  - [Local Deployment](#local-deployment)
  - [CloudShell Deployment](#cloudshell-deployment)
  - [CodeBuild Deployment](#codebuild-deployment)
  - [CodeCommit Setup](#codecommit-repository-setup-optional)
- [Configuration](#configuration)
  - [Product Name](#1-product-name-configuration-cdkjson)
  - [Infrastructure Parameters](#2-infrastructure-parameters-parametersjson)
  - [Hostname Customization](#hostname-customization)
- [Post-Deployment Setup](#post-deployment-setup)
- [Authentication](#authentication)
  - [Dual Authentication Modes](#dual-authentication-modes)
  - [SAML Identity Provider Integration](#saml-identity-provider-integration)
  - [External SSO User Pool](#external-sso-user-pool)
- [Architecture Overview](#architecture-overview)
- [Features](#features)
- [API Endpoints](#api-endpoints)
- [Database Schema](#database-schema)
- [Security](#security)
- [Monitoring and Logging](#monitoring-and-logging)
- [Troubleshooting](#troubleshooting)
- [Cost Optimization](#cost-optimization)
- [AWS Service Quotas](#aws-service-quotas)
- [Cleanup](#cleanup)
- [Development](#development)
- [License](#license)

---

## Quick Start

Get up and running in 3 steps:

### 1. Configure

```bash
# Clone the repository
git clone <repository-url>
cd media-resource-manager

# Create your configuration file from the example
cp parameters.example.json parameters.json
```

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

Key parameters:
- **VpcId**: Leave empty to create a new VPC, or specify an existing VPC ID
- **DomainName**: Active Directory domain for workstation domain-joining
- **UseCognitoAuth**: `"true"` for Cognito/SAML auth, `"false"` for LDAP
- **AdminGroupName**: Group name for admin access

See [Configuration](#configuration) for all available parameters.

### 2. Deploy

```bash
./deploy.sh
```

The script handles everything: dependencies, CDK bootstrap, build, and deployment of all 13 stacks. Takes ~30-45 minutes on first deploy.

Use `./deploy.sh -y` to skip the confirmation prompt.

### 3. Access

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
| [Local Deployment](#local-deployment) | Development, full control | Node.js 18+, AWS CLI, Docker |
| [CloudShell Deployment](#cloudshell-deployment) | Quick setup, no local tools | AWS Console access |
| [CodeBuild Deployment](#codebuild-deployment) | CI/CD, team deployments | AWS account |

### Local Deployment

**Prerequisites:**
- AWS CLI configured with appropriate permissions
- Node.js 18+ and npm
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
5. Deploys all 13 stacks in the correct order

**Manual deployment** (for individual stacks):
```bash
cdk deploy --all                    # Deploy all stacks
cdk deploy MRM-Infra               # Deploy specific stack
cdk deploy --all --require-approval never  # Auto-approve
```

### CloudShell Deployment

Deploy directly from AWS CloudShell — no local setup needed:

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
git clone <repository-url>
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
> This adds the new parameters with safe defaults. Your existing SSM config is preserved — no rebuild needed unless you want to change values.

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

Override any parameter for a single build using `MRM_PARAM_OVERRIDES`. The change is applied, deployed, and saved to SSM — so it persists across future builds even though the override itself is one-time:

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

- **PascalCase** (`MediaResourceManager`) — SSM parameter paths, CloudFormation resource names
- **Acronym** (`MRM`) — stack name prefixes (e.g., `MRM-Infrastructure`), DynamoDB table prefixes
- **kebab-case** (`media-resource-manager`) — S3 bucket names, URLs
- **Display name** — frontend branding, UI headers

When using the [CodeBuild pipeline](#codebuild-deployment), set `ProductName` as a CloudFormation parameter — the buildspec writes it into `cdk.json` automatically.

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
| `tegna-vdi-` | 4 | `tegna-vdi-0001` to `tegna-vdi-9999` |
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
1. Configure your IdP: [Okta Setup Guide](markdown/OKTA_SETUP_GUIDE.md) or [IAM Identity Center Guide](markdown/IAM_IDENTITY_CENTER_SETUP_GUIDE.md)
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

> **Important:** Always set `FrontendUrl` and `FrontendCertificateArn` together. `FrontendUrl` updates CORS and Cognito callback URLs, while `FrontendCertificateArn` configures TLS on CloudFront. If you set a custom domain on CloudFront manually (outside of CDK), the next CDK deployment will remove it — CDK must own the configuration.

> **Removing a custom domain:** To revert to the default CloudFront URL, clear both parameters (set to empty strings) and redeploy.

**DCV Connection Gateway Custom Domain**

The DCV Connection Gateway uses TCP passthrough at the NLB — TLS is handled by the Gateway itself, not the load balancer. This means you need the actual certificate and private key PEM files (not just an ACM ARN). You can use Let's Encrypt, your corporate CA, or export from ACM if your account allows it.

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

You also need an ACM certificate for the same domain — this is used as a CDK reference only (not for TLS termination). If you don't provide one, CDK will try to create a new cert requiring DNS validation, which can hang the deployment.

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
# Find and terminate the Gateway instance — ASG will launch a new one with the cert
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

- [Okta Setup Guide](markdown/OKTA_SETUP_GUIDE.md)
- [IAM Identity Center Setup Guide](markdown/IAM_IDENTITY_CENTER_SETUP_GUIDE.md)
- [Microsoft Entra ID Setup Guide](markdown/ENTRA_ID_SETUP_GUIDE.md)
- [Okta Technical Implementation Guide](markdown/OKTA_SAML_INTEGRATION_GUIDE.md)

### External SSO User Pool

For organizations that manage their own Cognito User Pool with SAML/Entra ID integration (e.g., via a separate CloudFormation stack), the CDK app can import that pool instead of creating its own.

**When to use this:** Your identity team creates and manages a Cognito User Pool with SAML federation (e.g., Microsoft Entra ID) and hands you the pool details to integrate.

**What you need from the identity team:**
1. `UserPoolArn` — ARN of the Cognito User Pool
2. `UserPoolClientId` — App client ID configured for your application
3. `UserPoolDomain` — The Cognito domain URL (e.g., `https://my-app.auth.us-east-1.amazoncognito.com`)

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
- All Lambda functions and the frontend work unchanged — they read auth config from the same SSM parameter paths

**Example with Entra ID (Azure AD):**

The identity team's workflow typically looks like:
1. They create a `entra-user-pool` CloudFormation stack with SAML integration
2. They configure AD groups that map to Cognito groups (e.g., `Admin`, `Editor`)
3. They test the SAML flow and claims mapping
4. They hand you the three values above

You then set `AdminGroupName` to match the admin group name in the token (e.g., `Admin`) and deploy.

---

## Architecture Overview

The application uses a **multi-stack architecture** with 13 specialized stacks:

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

**📚 See the [User Guide](markdown/USER_GUIDE.md) for detailed instructions.**

### For Administrators
- Create workstations from approved AMI list
- Assign workstations to users
- Monitor workstation status and usage
- Manage user accounts and permissions
- Configure auto-shutdown policies
- Monitor DCV session activity

### For Users
- View assigned workstations
- Start/stop workstations
- Connect via DCV (client or browser)
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
- **Spot Instances**: Consider for development
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

```bash
./delete-stacks.sh
```

Or manually:
```bash
cdk destroy MRM-Events
cdk destroy MRM-Frontend
cdk destroy MRM-Api
# ... continue in reverse deployment order
cdk destroy MRM-Infrastructure
```

**Note:** Terminate all EC2 instances before destroying stacks.

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

### Versioning

This project uses [semantic versioning](https://semver.org/). The version in the root `package.json` is the single source of truth — the frontend version is synced automatically.

```bash
# Bump version (updates both package.json files, commits, and tags)
./scripts/release.sh patch    # 0.1.0 -> 0.1.1 (bug fixes)
./scripts/release.sh minor    # 0.1.0 -> 0.2.0 (new features)
./scripts/release.sh major    # 0.1.0 -> 1.0.0 (breaking changes)
./scripts/release.sh 0.3.0    # explicit version

# Push the release
git push origin main --tags
```

For CodeBuild deployments, customers can pin to a specific release by setting `GitBranch` to a tag (e.g., `v0.1.0`) instead of `main`.

---

## License

MIT License - see LICENSE file.

## Acknowledgments

- AWS DCV samples and best practices
- CloudScape Design System
- AWS Well-Architected Framework
- AWS CDK best practices
