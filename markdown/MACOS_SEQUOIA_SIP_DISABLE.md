# macOS Sequoia SIP Disable Process for EC2 Image Builder

## Overview

This document describes the process for programmatically disabling System Integrity Protection (SIP) on macOS Sequoia (15.x) EC2 instances, specifically for use with EC2 Image Builder pipelines.

## The Problem

On macOS Sequoia, disabling SIP via the EC2 API requires:
1. A user with a **secure token** enabled
2. The correct **password** for that user

The challenge is that on a fresh EC2 Mac instance:
- `ec2-user` exists but has **no password** and **no secure token**
- You cannot grant a secure token without an existing token holder (chicken-and-egg problem)
- The `sysadminctl -secureTokenOn` command fails with "No existing unlock record"

## The Solution

The key insight (discovered from AWS's official `dcv-samples` repository) is that the secure token can be bootstrapped **at first boot** using user data, before any other operations occur.

### Step 1: Bootstrap Secure Token (User Data at Boot)

At instance boot time, run these commands in user data:

```bash
# Set password for ec2-user
EC2_USER_PASSWORD="<YOUR_PASSWORD_HERE>"
/usr/bin/dscl . -passwd /Users/ec2-user "$EC2_USER_PASSWORD"

# Bootstrap secure token - MUST run as ec2-user using sudo -su
sudo -su ec2-user sysadminctl -newPassword "$EC2_USER_PASSWORD" -oldPassword "$EC2_USER_PASSWORD"
```

**Critical details:**
- Use `sudo -su ec2-user` to run sysadminctl AS the ec2-user (not just `su ec2-user -c`)
- Use the SAME password for both `-newPassword` and `-oldPassword`
- Do NOT use special characters like `!` in the password (causes shell escaping issues)
- This ONLY works at first boot on a fresh instance

### Step 2: Call SIP Disable API (From Lambda)

After the secure token is bootstrapped, call the EC2 API to disable SIP:

```javascript
const macCredentials = JSON.stringify({
  internalDiskPassword: '',  // Empty for default aws-managed-user
  rootVolumeUsername: 'ec2-user',
  rootVolumepassword: '<YOUR_PASSWORD_HERE>'  // Note: lowercase 'p' is required!
});

await ec2.send(new CreateMacSystemIntegrityProtectionModificationTaskCommand({
  InstanceId: instanceId,
  MacSystemIntegrityProtectionStatus: 'disabled',
  MacCredentials: macCredentials
}));
```

**Critical details:**
- `rootVolumepassword` has a lowercase 'p' (this is the AWS API spec)
- `internalDiskPassword` should be empty string for default configuration
- The Lambda needs `ec2:CreateMacSystemIntegrityProtectionModificationTask` IAM permission

### Step 3: Wait for SIP Disable to Complete

The SIP disable process:
1. Reboots the instance into recovery mode
2. Modifies SIP settings
3. Reboots back to normal mode
4. Takes 30-90 minutes to complete

Poll the task status using:
```bash
aws ec2 describe-mac-modification-tasks --filters "Name=instance-id,Values=INSTANCE_ID"
```

Task states: `pending` → `in-progress` → `successful` (or `failed`)

## Image Builder Integration

For EC2 Image Builder, use `userDataOverride` in the infrastructure configuration to run the secure token bootstrap at instance launch:

```typescript
const infrastructureConfig = new imagebuilder.CfnInfrastructureConfiguration(this, 'Config', {
  // ... other settings ...
  additionalInstanceConfiguration: {
    userDataOverride: Buffer.from(`#!/bin/bash
EC2_USER_PASSWORD="<YOUR_PASSWORD_HERE>"
/usr/bin/dscl . -passwd /Users/ec2-user "$EC2_USER_PASSWORD"
sudo -su ec2-user sysadminctl -newPassword "$EC2_USER_PASSWORD" -oldPassword "$EC2_USER_PASSWORD"
`).toString('base64')
  }
});
```

Then use a custom workflow with `WaitForAction` step that triggers a Lambda to:
1. Call the SIP disable API
2. Store task info for polling
3. Resume the workflow when SIP disable completes

## What Does NOT Work

These approaches were tested and **do not work** on Sequoia:

1. **Creating a new admin user and having it grant itself a token:**
   ```bash
   # DOES NOT WORK
   sysadminctl -secureTokenOn newuser -password X -adminUser newuser -adminPassword X
   # Error: "No existing unlock record"
   ```

2. **Using sysadminctl after the instance has been running:**
   ```bash
   # DOES NOT WORK (after boot)
   sudo -su ec2-user sysadminctl -newPassword X -oldPassword X
   # Token remains DISABLED
   ```

3. **Running sysadminctl as ssm-user or root:**
   ```bash
   # DOES NOT WORK
   sysadminctl -newPassword X -oldPassword X
   # Operates on wrong user (ssm-user)
   ```

## Password Requirements

- **DO NOT** use special characters: `!`, `@`, `#`, `$`, `%`, `^`, `&`, `*`, etc.
- These cause shell escaping issues when passed through SSM or user data
- Use alphanumeric passwords only: `SipTestPass2026` ✓

## Verification Commands

Check secure token status:
```bash
sysadminctl -secureTokenStatus ec2-user
# Should show: "Secure token is ENABLED for user ec2-user"
```

Verify password works:
```bash
dscl /Local/Default -authonly ec2-user 'YourPassword'
# No output = success, error message = failure
```

Check SIP status:
```bash
csrutil status
# "System Integrity Protection status: disabled." after successful SIP disable
```

## References

- AWS DCV Samples: https://github.com/aws-samples/dcv-samples/tree/main/cdk/dcv-mac-image-automation
- AWS Blog: https://aws.amazon.com/blogs/aws/configure-system-integrity-protection-sip-on-amazon-ec2-mac-instances/
- AWS Docs: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/mac-sip-settings.html

## Tested On

- macOS Sequoia 15.7.3
- EC2 mac2.metal instances
- February 2026

## Implementation Status

The following changes have been made to implement this approach:

1. **`lib/macos-base-image-stack.ts`**: Added `userDataOverride` to the infrastructure configuration that bootstraps the secure token for `ec2-user` at first boot.

2. **`lambda/macos-sip-orchestrator/index.js`**: Simplified to:
   - Remove the `bootstrapSecureToken()` function (now handled by user data)
   - Use `ec2-user` credentials instead of creating a `sipadmin` user
   - Just verify the token is enabled and call the SIP disable API

3. **Workflow version bumped to 1.3.0** to reflect the behavior change.
