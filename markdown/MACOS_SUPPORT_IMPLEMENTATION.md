# macOS Workstation Support Implementation Guide

## Overview

This document tracks the implementation of macOS workstation support for the Media Resource Manager VDI solution.

## macOS Instance Types

| Instance Type | Chip | CPU Cores | GPU Cores | Memory | Notes |
|--------------|------|-----------|-----------|--------|-------|
| `mac1.metal` | Intel i7 | 6 | - | 32 GiB | x86, Coffee Lake |
| `mac2.metal` | Apple M1 | 8 | 8 | 16 GiB | ARM64 |
| `mac2-m1ultra.metal` | Apple M1 Ultra | 20 | 64 | 128 GiB | ARM64 |
| `mac2-m2.metal` | Apple M2 | 8 | 10 | 24 GiB | ARM64 |
| `mac2-m2pro.metal` | Apple M2 Pro | 12 | 19 | 32 GiB | ARM64 |
| `mac-m4.metal` | Apple M4 | 10 | 10 | 24 GiB | ARM64 |
| `mac-m4pro.metal` | Apple M4 Pro | 14 | 20 | 48 GiB | ARM64 |
| `mac-m4max.metal` | Apple M4 Max | 16 | 40 | 128 GiB | ARM64 |

**Important**: macOS instances require Dedicated Hosts with a 24-hour minimum allocation period.

## Key Differences from Windows/Linux

| Feature | Windows | Linux | macOS |
|---------|---------|-------|-------|
| Instance Types | Standard EC2 | Standard EC2 | Dedicated Host only (*.metal) |
| Billing | Per-instance | Per-instance | Per Dedicated Host (24hr min) |
| DCV Server Install | MSI installer | Package manager | PKG installer (requires SIP disabled for unattended) |
| Auto-login | Registry keys | GDM config | kcpassword + loginwindow plist |
| Default User | Administrator | ubuntu/rocky | ec2-user |
| SSM Agent | Pre-installed | May need install | Pre-installed on AWS AMIs |

## Implementation Phases

### Phase 1: Frontend Changes
- [x] Add `macOS` to platform dropdown in `ImageManagement.tsx`
- [x] Add macOS instance types to `WorkstationManagement.tsx`
- [x] Filter instance types based on selected AMI platform
- [x] Update AMI import to handle macOS platform detection
- [x] Add `macOS` to platform dropdown in `StorageManagement.tsx`
- [x] Add macOS AMI auto-discovery from SSM parameters in `image-manager.js`

### Phase 2: CDK Stack - macOS Workstation Creation
- [x] Create `workstation-creation-stack-macos.ts`
- [x] Create SSM Documents for macOS DCV configuration
- [x] Create SSM Documents for auto-login configuration
- [x] Implement Step Functions state machine
- [x] Add Dedicated Host allocation Lambda
- [x] Register stack in bin/production-resource-manager.ts
- [x] Update workstation-management-stack.ts with macOS state machine
- [x] Update workstation-manager.js Lambda for macOS platform

### Phase 3: Testing & Validation
- [ ] Deploy the macOS stack (`cdk deploy MRM-MacOSWorkstationCreation`)
- [ ] Import a macOS AMI into the Images table
- [ ] Test end-to-end workstation creation from the UI
- [ ] Verify DCV Session Manager Agent connects to broker
- [ ] Verify auto-login configuration works
- [ ] Test DCV session connection through Connection Gateway

### Next Steps
1. **Deploy**: Run `./deploy.sh` to deploy the new macOS stack
2. **Import AMI**: Add a macOS AMI to the Images table (e.g., `ami-0f8ce53a93ab42329` - macOS Tahoe)
3. **Test Creation**: Create a macOS workstation from the UI
4. **Monitor**: Watch the Step Functions execution for any issues
5. **Validate**: Connect to the workstation via DCV

---

## Technical Details

### macOS Auto-Login Configuration

macOS auto-login requires two components:

#### 1. `/etc/kcpassword` file
XOR-encoded password using a known key:
```
Key: 0x7D, 0x89, 0x52, 0x23, 0xD2, 0xBC, 0xDD, 0xEA, 0xA3, 0xB9, 0x1F (repeating)
```

#### 2. `com.apple.loginwindow` preference
```bash
defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser "username"
```

#### Complete Auto-Login Script
```bash
#!/bin/bash
USERNAME="$1"
PASSWORD="$2"

# Set user password using dscl
dscl . -passwd /Users/$USERNAME "$PASSWORD"

# Generate kcpassword (XOR encoded)
python3 << 'PYEOF' "$PASSWORD" > /etc/kcpassword
import sys
KEY = [0x7D, 0x89, 0x52, 0x23, 0xD2, 0xBC, 0xDD, 0xEA, 0xA3, 0xB9, 0x1F]
password = sys.argv[1].encode("utf-8")
padding = 12 - (len(password) % 12)
if padding == 12: padding = 0
padded = password + (b"\x00" * padding)
encoded = bytearray(b ^ KEY[i % len(KEY)] for i, b in enumerate(padded))
sys.stdout.buffer.write(bytes(encoded))
PYEOF

chmod 600 /etc/kcpassword
chown root:wheel /etc/kcpassword

# Set auto-login user
defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser "$USERNAME"
```

### macOS User Management

#### Set Password for Existing User
```bash
dscl . -passwd /Users/ec2-user "NewPassword123!"
```

#### Create New User
```bash
sysadminctl -addUser username -fullName "Full Name" -password "TempPass!" -admin
dscl . -passwd /Users/username "ActualPassword!"
```

### DCV Server Installation (macOS)

**Prerequisites**: System Integrity Protection (SIP) must be disabled for unattended installation.

#### Download and Install
```bash
# Download DCV Server
curl -O https://d1uj6qtbmh3dt5.cloudfront.net/nice-dcv-server-macos-arm64.dist.pkg

# Install (unattended)
sudo installer -pkg nice-dcv-server-*.pkg -target /
```

#### Post-Installation (requires GUI or pre-configuration)
- Privacy & Security > Accessibility: Allow DCV Server
- Privacy & Security > Screen Recording: Allow DCV Server

### DCV Session Manager Agent Installation (macOS)

```bash
# Download
curl -O https://d1uj6qtbmh3dt5.cloudfront.net/2025.0/SessionManagerAgents/nice-dcv-session-manager-agent-2025.0.888-macos-arm64.pkg

# Install
sudo installer -pkg nice-dcv-session-manager-agent-*.pkg -target /

# Configure agent
cat > /etc/dcv-session-manager-agent/agent.conf << EOF
version = '0.1'
[agent]
broker_host = '${SESSION_MANAGER_DNS}'
broker_port = 8445
tls_strict = false
broker_update_interval = 15
[log]
level = 'debug'
rotation = 'daily'
EOF

# Start agent
sudo launchctl load /Library/LaunchDaemons/com.amazon.dcv.session-manager.agent.plist
```

### DCV Server Configuration (macOS)

```bash
cat > /Library/Application\ Support/NICE/dcv/dcv.conf << EOF
[license]
[log]
level = "debug"
[session-management]
create-session = false
[session-management/automatic-console-session]
[display]
[connectivity]
[security]
administrators = ["dcvsmagent"]
auth-token-verifier = "https://${SESSION_MANAGER_DNS}:8445/agent/validate-authentication-token"
no-tls-strict = true
[clipboard]
primary-selection-copy = true
primary-selection-paste = true
EOF
```

---

## Test Instance

- **Instance ID**: `i-0a4a91a08194f31d5`
- **Instance Type**: `mac2-m2.metal`
- **AMI**: `ami-0f8ce53a93ab42329` (macOS Tahoe 26.2)
- **Private IP**: `172.21.131.46`
- **SSM Status**: Online

### Verified Working Commands
- ✅ `dscl . -passwd /Users/username "password"` - Set user password
- ✅ `sysadminctl -addUser` - Create new user
- ✅ `defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser` - Set auto-login user
- ✅ `/etc/kcpassword` generation via Python XOR script

---

## Progress Log

### 2026-01-29
- Created implementation guide
- Verified macOS auto-login is possible via kcpassword + loginwindow plist
- Tested user password setting via `dscl`
- Tested user creation via `sysadminctl`
- Identified macOS instance types available in us-east-1
- **Phase 1 Complete**: Frontend changes for macOS platform support
  - Added macOS to platform dropdowns in ImageManagement, StorageManagement
  - Added macOS instance types (mac2.metal, mac2-m2.metal, etc.) to WorkstationManagement
  - Instance types now filter based on selected AMI platform
- **Phase 2 Testing**: DCV installation on test macOS instance
  - DCV Server 2025.0 already installed on test instance
  - Installed DCV Session Manager Agent successfully
  - Configured agent.conf and dcv.conf
  - **Issue**: Test macOS instance is in different VPC than MRM infrastructure
  - Agent cannot reach Session Manager broker due to VPC isolation
- **Phase 2 Complete**: CDK Stack for macOS workstation creation
  - Created `workstation-creation-stack-macos.ts` with:
    - Dedicated Host allocation Lambda (finds existing or allocates new)
    - Instance creation Lambda (launches on Dedicated Host)
    - SSM Documents for DCV configuration and auto-login
    - Step Functions state machine with 2-phase workflow
  - Registered stack in `bin/production-resource-manager.ts`
  - Updated `workstation-management-stack.ts` with macOS state machine
  - Updated `workstation-manager.js` Lambda to route macOS to correct state machine

---

## Known Issues & Considerations

### VPC Connectivity
macOS workstations must be launched in the same VPC as the DCV Session Manager infrastructure, or have network connectivity (VPC peering, Transit Gateway) to reach the Session Manager broker on port 8445.

### Dedicated Host Requirement
macOS instances require Dedicated Hosts with a 24-hour minimum allocation period. The state machine handles this by:
1. Checking for available Dedicated Hosts with capacity for the requested instance type
2. Allocating a new Dedicated Host if none available (tries each AZ)
3. Launching the instance on the Dedicated Host with `Tenancy: 'host'`
4. Tagging the host for management tracking

**Cost Consideration**: Dedicated Hosts are billed for a minimum of 24 hours. The solution does not automatically release hosts - this should be managed separately based on usage patterns.

---

## References

- [Amazon EC2 Mac instances](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-mac-instances.html)
- [Installing DCV Server on macOS](https://docs.aws.amazon.com/dcv/latest/adminguide/setting-up-installing-macosinstall.html)
- [DCV Session Manager Agent Setup](https://docs.aws.amazon.com/dcv/latest/sm-admin/agent.html)
- [Configure SIP on EC2 Mac](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/mac-sip-settings.html)
