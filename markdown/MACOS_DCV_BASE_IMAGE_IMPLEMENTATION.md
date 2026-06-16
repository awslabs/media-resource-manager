# macOS DCV-Ready Base Image Pipeline Implementation Guide

## Overview

This document tracks the implementation of a system-managed EC2 Image Builder pipeline that creates a "DCV-Ready" macOS AMI. This AMI has SIP disabled and screen recording permissions granted, making it ready for DCV remote desktop connections.

## Problem Statement

macOS on EC2 requires special configuration for DCV to work:

1. **System Integrity Protection (SIP)** must be disabled to modify the TCC database
2. **Screen Recording permission** must be granted to DCV Server via the TCC database
3. **DCV Server and Session Manager Agent** must be installed and configured

The SIP disable process takes 60-90 minutes and requires the AWS `CreateMacSystemIntegrityProtectionModificationTask` API. This cannot be done at workstation creation time - it must be baked into a golden AMI.

## Solution Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    macOS Image Hierarchy                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   AWS macOS AMI (from AWS SSM Parameter)                        │
│         │                                                       │
│         ▼                                                       │
│   ┌─────────────────────────────────────────┐                   │
│   │  "DCV-Ready Base" Pipeline (SYSTEM)     │  ◄── Protected    │
│   │  - Disables SIP (WaitForAction flow)    │      Cannot delete│
│   │  - Installs DCV Server                  │      Can edit     │
│   │  - Grants Screen Recording permission   │                   │
│   │  - Installs DCV Session Manager Agent   │                   │
│   └─────────────────────────────────────────┘                   │
│         │                                                       │
│         ▼ (outputs "DCV-Ready Base AMI")                        │
│                                                                 │
│   ┌─────────────────────────────────────────┐                   │
│   │  User Custom Pipelines                  │  ◄── User-created │
│   │  - Base image = DCV-Ready Base AMI      │      Full control │
│   │  - Add Xcode, DaVinci, etc.             │                   │
│   └─────────────────────────────────────────┘                   │
│         │                                                       │
│         ▼ (outputs custom golden AMIs)                          │
│                                                                 │
│   ┌─────────────────────────────────────────┐                   │
│   │  Workstation Creation                   │                   │
│   │  - Only allows pipeline-created AMIs    │                   │
│   │  - No raw AWS macOS AMIs                │                   │
│   └─────────────────────────────────────────┘                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Implementation Tasks

### Phase 1: CDK Stack for macOS Base Image Pipeline
- [ ] Create `lib/macos-base-image-stack.ts`
- [ ] Create custom Image Builder workflow with `WaitForAction` step
- [ ] Create Lambda function to handle SIP disable orchestration
- [ ] Create EventBridge rule to trigger Lambda on workflow pause
- [ ] Create Image Builder components for:
  - [ ] DCV Server installation
  - [ ] DCV Session Manager Agent installation  
  - [ ] TCC database modification (screen recording permission)
  - [ ] DCV configuration (`/etc/dcv/dcv.conf`)
- [ ] Create infrastructure configuration for Mac Dedicated Host
- [ ] Create distribution configuration
- [ ] Create image recipe
- [ ] Create image pipeline
- [ ] Store pipeline record in DynamoDB with `isSystemPipeline: true`

### Phase 2: Lambda for SIP Disable Orchestration
- [ ] Create `lambda/macos-sip-orchestrator/index.js`
- [ ] Handle EventBridge event from Image Builder `WaitForAction`
- [ ] Get instance ID from Image Builder
- [ ] Set ec2-user password and enable secure token
- [ ] Call `CreateMacSystemIntegrityProtectionModificationTask` API
- [ ] Poll for task completion (up to 90 minutes)
- [ ] Call `SendWorkflowStepAction` with `RESUME` when complete
- [ ] Handle errors and call `STOP` if SIP disable fails

### Phase 3: Modify image-manager.js
- [x] Add `isSystemPipeline` field to pipeline DynamoDB schema
- [x] Block deletion of pipelines where `isSystemPipeline: true`
- [x] Add `requiresPipeline` flag to raw macOS AMIs in `getImages()`
- [x] For macOS pipeline creation:
  - [x] Validate base image is DCV-Ready AMI or user golden image
  - [x] Reject raw AWS macOS AMIs as base

### Phase 4: Frontend Updates
- [x] Show "System" badge on system pipelines
- [x] Disable delete button for system pipelines
- [x] Show "Pipeline Required" badge on raw macOS AMIs in image table
- [x] Filter out raw macOS AMIs from workstation creation dropdown
- [ ] Show tooltip explaining why delete is disabled for system pipelines
- [ ] For macOS pipeline creation:
  - [ ] Filter base image dropdown to only show DCV-Ready + user golden images
  - [ ] Show info message about macOS base image requirement

### Phase 5: Testing & Documentation
- [ ] Test full pipeline execution
- [ ] Test user pipeline creation with DCV-Ready base
- [ ] Test workstation creation from user pipeline AMI
- [ ] Test DCV connection end-to-end
- [ ] Update user documentation

## Technical Details

### Image Builder Custom Workflow

The workflow uses `WaitForAction` to pause while SIP is being disabled:

```yaml
name: macOS-DCV-Ready-Build-Workflow
version: 1.0.0
phases:
  - name: build
    steps:
      - name: LaunchInstance
        action: LaunchInstance
        
      - name: WaitForSIPDisable
        action: WaitForAction
        inputs:
          # This pauses the workflow and sends EventBridge event
          # Lambda will call SendWorkflowStepAction to resume
          
      - name: ExecuteComponents
        action: ExecuteComponents
        # Runs after SIP is disabled:
        # - Install DCV Server
        # - Grant TCC permissions
        # - Configure DCV
        
      - name: CreateImage
        action: CreateImage
```

### TCC Database Modification

With SIP disabled, we can grant screen recording permission:

```bash
sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \
  "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version) \
   VALUES ('kTCCServiceScreenCapture', 'com.amazon.dcv.server', 0, 2, 4, 1);"
```

### DCV Configuration

The DCV config must be at `/etc/dcv/dcv.conf` (not `/Library/Application Support/NICE/dcv/`):

```toml
[license]
[log]
level = "debug"
[session-management]
create-session = false
[session-management/automatic-console-session]
[display]
enable-client-resize = true
[connectivity]
[security]
administrators = ["dcvsmagent"]
auth-token-verifier = "https://${SESSION_MANAGER_DNS}:8445/agent/validate-authentication-token"
no-tls-strict = true
[clipboard]
primary-selection-copy = true
primary-selection-paste = true
```

### Pipeline DynamoDB Schema Addition

```javascript
{
  pipelineId: { S: "system-macos-dcv-ready" },
  name: { S: "macOS DCV-Ready Base" },
  description: { S: "System pipeline that creates DCV-ready macOS AMIs with SIP disabled" },
  platform: { S: "macOS" },
  isSystemPipeline: { BOOL: true },  // NEW FIELD
  // ... other fields
}
```

## Current Status

### Completed
- [x] Identified root cause: SIP blocks TCC database modification
- [x] Confirmed DCV config path must be `/etc/dcv/dcv.conf`
- [x] Fixed CDK to use correct DCV config path
- [x] Tested SIP disable API on existing instance (task in progress)
- [x] Researched Image Builder `WaitForAction` workflow capability
- [x] Created `lib/macos-base-image-stack.ts` - CDK stack for system pipeline
- [x] Created `lambda/macos-sip-orchestrator/index.js` - Lambda for SIP orchestration
- [x] Created Image Builder components:
  - [x] Grant TCC Permission component
  - [x] Install DCV component
  - [x] Configure Auto-Login component
- [x] Created custom workflow with WaitForAction step
- [x] Created EventBridge rule to trigger SIP orchestrator
- [x] Integrated `macos-base-image-stack.ts` into main CDK app (`bin/production-resource-manager.ts`)
- [x] Added macOS base image validation in `createImagePipeline` (rejects raw AWS macOS AMIs)

### In Progress
- [ ] SIP disable task running on test instance `i-0f3192930fcd9012f`
  - Task ID: `macmodification-066326550f7626e91`
  - Started: 2026-01-29T07:23:21Z
  - Expected completion: ~90 minutes

### Next Steps
1. Wait for SIP disable to complete on test instance
2. Manually test TCC modification and DCV connection
3. Deploy CDK changes to create the macOS base image pipeline infrastructure
4. Run the system pipeline to create the first DCV-Ready AMI
5. Update frontend to show system pipeline badge and restrictions
6. Test end-to-end: create user pipeline from DCV-Ready base, create workstation, connect via DCV

## References

- [AWS DCV macOS Installation Guide](https://docs.aws.amazon.com/dcv/latest/adminguide/setting-up-installing-macosinstall.html)
- [EC2 Mac SIP Configuration](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/mac-sip-settings.html)
- [Image Builder WaitForAction](https://docs.aws.amazon.com/imagebuilder/latest/userguide/wfdoc-step-actions.html)
- [AWS DCV Samples - Mac Image Automation](https://github.com/aws-samples/dcv-samples/tree/main/cdk/dcv-mac-image-automation)

## Key Instance Information (Current Test)

- macOS workstation instance: `i-0f3192930fcd9012f`
- Session Manager broker instance: `i-02a1c0ccc804fbbb6`
- Connection Gateway endpoint: `dcv-nlb-41425c2bacf0816b.elb.us-east-1.amazonaws.com:8443`
- SIP Modification Task ID: `macmodification-066326550f7626e91`
