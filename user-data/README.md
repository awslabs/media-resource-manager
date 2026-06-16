# User Data Scripts

This directory contains EC2 user data scripts for installing and configuring DCV infrastructure components.

## Scripts

### session-manager-install.sh
Installs and configures DCV Session Manager broker.

**Environment Variables:**
- `PRODUCT_NAME` - Product name for SSM parameter paths (default: TegnaFleetCommand)
- `DYNAMODB_TABLE_PREFIX` - Prefix for DynamoDB tables (default: dcv-session-manager-)

**What it does:**
1. Detects OS type (Amazon Linux, CentOS, RHEL, Ubuntu)
2. Downloads DCV Session Manager from AWS CloudFront
3. Configures DynamoDB persistence
4. Registers an API client
5. Stores credentials in SSM Parameter Store

### connection-gateway-install.sh
Installs and configures DCV Connection Gateway.

**Environment Variables:**
- `PRODUCT_NAME` - Product name for SSM parameter paths (default: TegnaFleetCommand)
- `TLS_SECRET_NAME` - (Optional) Secrets Manager secret name for custom TLS certificate

**What it does:**
1. Detects OS type
2. Downloads DCV Connection Gateway from AWS CloudFront
3. Waits for Session Manager broker to be available
4. Configures connection to broker
5. Optionally configures custom TLS certificate

## Usage

These scripts are used by:
- `lib/dcv-infrastructure-stack.ts` - Primary region DCV infrastructure
- `lambda/generate-regional-hub-template/index.js` - Regional hub CloudFormation templates

### In CDK (TypeScript)
```typescript
import * as fs from 'fs';
import * as path from 'path';

const userDataScript = fs.readFileSync(
  path.join(__dirname, '../user-data/session-manager-install.sh'),
  'utf8'
);

// Replace environment variables
const processedScript = userDataScript
  .replace(/\${PRODUCT_NAME:-[^}]*}/g, props.pascalCaseName)
  .replace(/\${DYNAMODB_TABLE_PREFIX:-[^}]*}/g, 'dcv-session-manager-');

userData.addCommands(processedScript);
```

### In CloudFormation (via generate-regional-hub-template)
The scripts are read and embedded in the CloudFormation template's UserData property.

## Updating Scripts

When updating these scripts:
1. Test changes in a non-production environment first
2. Update both primary region CDK stack and regional hub template generator
3. For regional hubs, trigger a stack update to deploy new user data
4. New instances will use the updated scripts; existing instances need to be replaced

## AWS CloudFront URLs

DCV packages are downloaded from AWS's official CloudFront distribution:
- Base URL: `https://d1uj6qtbmh3dt5.cloudfront.net`
- GPG Key: `https://d1uj6qtbmh3dt5.cloudfront.net/NICE-GPG-KEY`

This is AWS's official distribution and is stable/reliable.
