# Regional Hub macOS Manual Setup Steps

This document tracks manual CLI commands executed to enable macOS workstation creation in satellite regions (us-west-2). These need to be incorporated into the regional hub CloudFormation template or CDK stack.

## Date: 2026-02-03

## Region: us-west-2

---

## Placeholder Values

Throughout this document, replace the following placeholders with your deployment-specific values:

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `<ProductPrefix>` | PascalCase version of `productName` from `cdk.json` | If `productName` is `"Media Resource Manager"`, use `MediaResourceManager` |
| `<product-prefix>` | lowercase-hyphenated version of `productName` from `cdk.json` | If `productName` is `"Media Resource Manager"`, use `media-resource-manager` |
| `<YOUR_ACCOUNT_ID>` | Your AWS account ID | `123456789012` |
| `<YOUR_LICENSE_CONFIG_ID>` | License configuration ID returned after creation | `lic-abc123def456` |

---

## Multi-Region AMI Distribution (AUTOMATED)

**UPDATE**: EC2 Image Builder now handles multi-region AMI distribution automatically. When a pipeline builds an AMI, it will:

1. Build the AMI in the primary region (us-east-1)
2. Automatically distribute to all active satellite regions
3. For macOS AMIs, automatically associate the regional license configuration

This eliminates the need for manual AMI replication via `<product-prefix>-ami-replication-handler`.

The `imagebuilder-event-handler` Lambda now:
- Registers distributed AMIs in the `<product-prefix>-amis` DynamoDB table with region info
- Associates regional license configurations with macOS AMIs in each satellite region

---

## 1. License Manager Configuration

macOS dedicated hosts require a License Manager configuration for host-based licensing.

```bash
aws license-manager create-license-configuration \
  --region us-west-2 \
  --name "<ProductPrefix>-macOS-License" \
  --license-counting-type "Core" \
  --license-count 1000 \
  --license-rules "#allowedTenancy=EC2-DedicatedHost" \
  --description "License configuration for macOS dedicated hosts" \
  --tags Key=ManagedBy,Value=<ProductPrefix>
```

**Result:**
- ARN: `arn:aws:license-manager:us-west-2:<YOUR_ACCOUNT_ID>:license-configuration:<YOUR_LICENSE_CONFIG_ID>`

**IMPORTANT**: The license configuration MUST include:
- `--license-count 1000` (or appropriate number)
- `--license-rules "#allowedTenancy=EC2-DedicatedHost"`

Without these settings, AMIs cannot be launched into the Host Resource Group.

---

## 2. Host Resource Group

macOS dedicated hosts are managed via a Host Resource Group with auto-allocation enabled.

```bash
aws resource-groups create-group \
  --region us-west-2 \
  --name "<ProductPrefix>-Mac-Host-Resource-Group" \
  --description "Host Resource Group for macOS dedicated hosts" \
  --configuration '[
    {
      "Type": "AWS::EC2::HostManagement",
      "Parameters": [
        {"Name": "allowed-host-based-license-configurations", "Values": ["arn:aws:license-manager:us-west-2:<YOUR_ACCOUNT_ID>:license-configuration:<YOUR_LICENSE_CONFIG_ID>"]},
        {"Name": "allowed-host-families", "Values": ["mac2", "mac2-m2", "mac2-m2pro"]},
        {"Name": "auto-allocate-host", "Values": ["true"]},
        {"Name": "auto-release-host", "Values": ["false"]}
      ]
    },
    {
      "Type": "AWS::ResourceGroups::Generic",
      "Parameters": [
        {"Name": "allowed-resource-types", "Values": ["AWS::EC2::Host"]},
        {"Name": "deletion-protection", "Values": ["UNLESS_EMPTY"]}
      ]
    }
  ]' \
  --tags Key=ManagedBy,Value=<ProductPrefix>
```

**Result:**
- ARN: `arn:aws:resource-groups:us-west-2:<YOUR_ACCOUNT_ID>:group/<ProductPrefix>-Mac-Host-Resource-Group`

---

## 3. DynamoDB Regional Hub Record Updates

Added the Host Resource Group and License Configuration ARNs to the regional hub DynamoDB record:

```bash
aws dynamodb update-item \
  --table-name <product-prefix>-regional-hubs \
  --key '{"region": {"S": "us-west-2"}}' \
  --update-expression "SET hostResourceGroupArn = :hrg, licenseConfigurationArn = :lic" \
  --expression-attribute-values '{
    ":hrg": {"S": "arn:aws:resource-groups:us-west-2:<YOUR_ACCOUNT_ID>:group/<ProductPrefix>-Mac-Host-Resource-Group"},
    ":lic": {"S": "arn:aws:license-manager:us-west-2:<YOUR_ACCOUNT_ID>:license-configuration:<YOUR_LICENSE_CONFIG_ID>"}
  }'
```

---

## 4. AMI License Association (AUTOMATED)

**UPDATE**: This is now handled automatically by the `imagebuilder-event-handler` Lambda when AMIs are distributed to satellite regions.

For manual association (if needed):

```bash
aws license-manager update-license-specifications-for-resource \
  --region us-west-2 \
  --resource-arn arn:aws:ec2:us-west-2::image/ami-XXXXXXXXX \
  --add-license-specifications LicenseConfigurationArn=arn:aws:license-manager:us-west-2:<YOUR_ACCOUNT_ID>:license-configuration:<YOUR_LICENSE_CONFIG_ID>
```

---

## 5. Subnet IDs Update

Updated the regional hub record with all 3 private subnet IDs:

```bash
aws dynamodb update-item \
  --table-name <product-prefix>-regional-hubs \
  --key '{"region": {"S": "us-west-2"}}' \
  --update-expression "SET subnetIds = :sids" \
  --expression-attribute-values '{":sids": {"S": "subnet-XXXXX,subnet-YYYYY,subnet-ZZZZZ"}}'
```

---

## Required CloudFormation/CDK Updates

The regional hub template (`generate-regional-hub-template/index.js`) needs to be updated to create:

1. **AWS::LicenseManager::LicenseConfiguration** - For macOS host-based licensing
   - Must include `LicenseRules: ["#allowedTenancy=EC2-DedicatedHost"]`
   - Must include `LicenseCount: 1000`

2. **AWS::ResourceGroups::Group** - Host Resource Group with:
   - EC2::HostManagement configuration
   - Link to license configuration
   - allowed-host-families: mac2, mac2-m2, mac2-m2pro
   - auto-allocate-host: true
   - auto-release-host: false

3. **CloudFormation Outputs** to add:
   - `HostResourceGroupArn`
   - `LicenseConfigurationArn`

4. **UpdateStatusToAvailable state** in regional-hub-stack.ts needs to save:
   - `hostResourceGroupArn`
   - `licenseConfigurationArn`

---

## Current Status

- [x] License Configuration created manually (with correct settings)
- [x] Host Resource Group created manually
- [x] DynamoDB record updated with ARNs
- [x] Multi-region AMI distribution implemented in Image Builder
- [x] Automatic license association implemented in imagebuilder-event-handler
- [x] CloudFormation template updated to create License Configuration and Host Resource Group
- [x] CDK stack updated to save hostResourceGroupArn and licenseConfigurationArn to DynamoDB

---

## Issue: License Configuration Requirements

### Problem
When copying an AMI from us-east-1 to us-west-2, the AMI retains metadata about the source region's license configuration. This causes RunInstances to fail with:
```
One or more license configurations could not be associated with the AMI, either because they have not been shared with your account, or because they are in a different Region.
```

### Root Cause
AWS License Manager does not support cross-Region instance tracking. If you copy an AMI that has associated license configurations to a different Region, License Manager blocks all instance launches from the new AMI.

### Solution
1. Use EC2 Image Builder's native multi-region distribution instead of manual AMI copying
2. Image Builder creates fresh AMIs in each region without inherited license metadata
3. The `imagebuilder-event-handler` Lambda associates the correct regional license configuration after distribution

### Updated Resources in us-west-2
- License Config ARN: `arn:aws:license-manager:us-west-2:<YOUR_ACCOUNT_ID>:license-configuration:<YOUR_LICENSE_CONFIG_ID>`
- Host Resource Group: `<ProductPrefix>-Mac-Host-Resource-Group`
