# Regional Storage Implementation Guide

## Overview

This document tracks the implementation of storage management for regional hubs, allowing FSx ONTAP file systems to be created in satellite regions alongside workstations.

## Goals

1. Allow FSx ONTAP storage creation in any region with an active regional hub
2. Restrict FSx Windows to primary region only (AD dependency)
3. Ensure storage can only be mounted to workstations in the same region
4. Maintain centralized orchestration from primary region

## Architecture Decision

**Approach:** Single `storage-cfn-worker` Lambda that handles cross-region CloudFormation operations (createStack, describeStacks, deleteStack) rather than deploying state machines to each region.

**Rationale:**
- Matches existing pattern used for regional hub creation
- Centralized logging, monitoring, error handling
- No additional infrastructure in regional hubs
- Easy to add new regions via IAM permissions

## Implementation Phases

### Phase 1: Infrastructure Changes ✅

#### 1.1 Create `storage-cfn-worker` Lambda ✅
**File:** `lambda/storage-cfn-worker/index.js`

```javascript
// Handles: createStack, describeStacks, deleteStack in any region
// Input: { action, region, stackName, templateBody?, parameters? }
// Uses CloudFormationClient({ region }) for cross-region calls
```

**Actions:**
- [x] Create new Lambda directory and handler
- [x] Support `createStack` action
- [x] Support `describeStacks` action  
- [x] Support `deleteStack` action
- [x] Add proper error handling and logging

#### 1.2 Update Storage Stack CDK ✅
**File:** `lib/storage-stack.ts`

**Changes:**
- [x] Add `storage-cfn-worker` Lambda function
- [x] Grant cross-region CloudFormation permissions
- [x] Grant cross-region FSx permissions
- [x] Grant cross-region EC2 permissions (security groups)
- [x] Grant cross-region Secrets Manager permissions
- [x] Grant cross-region SSM permissions
- [x] Update state machine to use Lambda for CloudFormation operations
- [x] Add region parameter passthrough in state machine

#### 1.3 Add Region GSI to Storage Table ✅
**File:** `lib/constructs/database-construct.ts`

```typescript
this.storageTable.addGlobalSecondaryIndex({
  indexName: 'region-index',
  partitionKey: { name: 'region', type: dynamodb.AttributeType.STRING },
});
```

---

### Phase 2: Storage Creation Flow ✅

#### 2.1 Update `create-storage` Lambda ✅
**File:** `lambda/create-storage/index.js`

**Changes:**
- [x] Accept optional `region` parameter in request body
- [x] Validate region is primary OR has active regional hub
- [x] For `fsx-windows`: Reject if region != primary (AD dependency)
- [x] For `fsx-ontap`: Allow any valid region
- [x] Pass region to state machine input
- [x] Store region in DynamoDB record

#### 2.2 Update `generate-fsx-template` Lambda ✅
**File:** `lambda/generate-fsx-template/index.js`

**Changes:**
- [x] Accept region parameter
- [x] For primary region: Use existing SSM parameter paths (dynamic CloudFormation references)
- [x] For regional hubs: Look up VPC/subnet info from DynamoDB regional hubs table
  - Uses `vpcId`, `vpcCidr`, `privateSubnet1Id`, `privateSubnet2Id` from hub record
  - Hardcodes these values directly in the CloudFormation template
- [x] Return region in template data for state machine

#### 2.3 Update Storage Creation State Machine ✅
**File:** `lib/storage-stack.ts` (state machine definition)

**Changes:**
- [x] Replace native `aws-sdk:cloudformation:createStack` with Lambda invocation
- [x] Replace native `aws-sdk:cloudformation:describeStacks` with Lambda invocation
- [x] Pass region through all states
- [x] Update DynamoDB updates to include region

---

### Phase 3: Regional Hub Network Parameters ✅

#### 3.1 Network Config from DynamoDB ✅
**File:** `lambda/generate-fsx-template/index.js`

The regional hub table already stores network configuration when the hub is created:
- `vpcId` - VPC ID in the regional hub
- `vpcCidr` - VPC CIDR block
- `privateSubnet1Id` - First private subnet ID
- `privateSubnet2Id` - Second private subnet ID
- `subnetIds` - Comma-separated list of all private subnet IDs

The `generate-fsx-template` Lambda now:
- [x] Looks up regional hub record from DynamoDB when region != primary
- [x] Uses hardcoded VPC/subnet values in CloudFormation template for regional hubs
- [x] Uses SSM dynamic references for primary region (existing behavior)

---

### Phase 4: Mount Region Validation ✅

#### 4.1 Update NFS Mount Manager ✅
**File:** `lambda/fsx-nfs-mount-manager/index.js`

**Changes:**
- [x] Get storage record and check region
- [x] Get workstation record and check region
- [x] If regions don't match, return error with clear message
- [x] Add region to mount status response

#### 4.2 Update SMB Mount Manager ✅
**File:** `lambda/fsx-smb-mount-manager/index.js`

**Changes:**
- [x] Same region validation as NFS mount manager
- [x] Clear error message for cross-region mount attempts

---

### Phase 5: Storage Deletion Flow ✅

#### 5.1 Update Storage Deletion State Machine ✅
**File:** `lib/storage-stack.ts` (deletion state machine)

**Changes:**
- [x] Use `storage-cfn-worker` Lambda for deleteStack
- [x] Use `storage-cfn-worker` Lambda for describeStacks (polling)
- [x] Pass region from storage record through deletion flow

#### 5.2 Update `delete-storage` Lambda ✅
**File:** `lambda/delete-storage/index.js`

**Changes:**
- [x] Retrieve storage record to get region
- [x] Pass region to deletion state machine
- [x] Use regional CloudFormation client for direct delete operations

---

### Phase 6: Frontend Updates ✅

#### 6.1 Update Storage Creation UI ✅
**File:** `frontend/src/pages/StorageManagement.tsx`

**Changes:**
- [x] Add region selector dropdown (primary + active regional hubs)
- [x] For FSx Windows: Region selector hidden (primary only)
- [x] For FSx ONTAP: Show region selector when regional hubs exist
- [x] Pass region to create API call

#### 6.2 Update Storage List UI ✅
**File:** `frontend/src/pages/StorageManagement.tsx`

**Changes:**
- [x] Add region column to storage table
- [x] Add region to column preferences
- [x] Show region in table (defaults to primary region for legacy storage)

#### 6.3 Update Workstation Storage Config UI ✅
**File:** `frontend/src/pages/WorkstationManagement.tsx`

**Changes:**
- [x] Filter storage list by workstation's region (already implemented in fetchAvailableStorage)
- [x] Show only storage resources in same region as workstation
- [x] Add info text explaining region restriction
- [x] Add warning alert when workstations from multiple regions are selected
- [x] Add region column to storage table in modal
- [x] Handle case where no storage exists in workstation's region with helpful message

---

### Phase 7: API Updates ⬜

#### 7.1 Update Storage List API ✅
**File:** `lambda/list-storage/index.js`

**Changes:**
- [x] Support optional `region` query parameter
- [x] Use region GSI for filtered queries
- [x] Return region in response (defaults to primary region for legacy storage)

#### 7.2 Update Workstation API ⬜ (Deferred to Frontend)
**File:** `lambda/workstation-api/index.js`

**Note:** Storage filtering by region is handled by the frontend calling `list-storage?region=<workstation-region>` rather than adding a new endpoint to workstation-api. This keeps the API simple and follows the existing pattern.

**Changes:**
- [ ] Frontend will call list-storage with region filter when configuring workstation storage
- [ ] Add region to storage response objects (already done in list-storage)

---

## Testing Checklist

### Unit Tests ⬜
- [ ] `storage-cfn-worker` Lambda handles all actions correctly
- [ ] `generate-fsx-template` generates correct regional SSM paths
- [ ] `create-storage` validates region correctly
- [ ] Mount managers reject cross-region mounts

### Integration Tests ⬜
- [ ] Create FSx ONTAP in primary region (existing flow still works)
- [ ] Create FSx ONTAP in regional hub
- [ ] Create FSx Windows in primary region (still works)
- [ ] Create FSx Windows in regional hub (should fail with clear error)
- [ ] Mount storage to workstation in same region (works)
- [ ] Mount storage to workstation in different region (fails with clear error)
- [ ] Delete storage in regional hub
- [ ] Storage list filters by region correctly

### Manual Testing ⬜
- [ ] UI shows region selector for FSx ONTAP
- [ ] UI hides region selector for FSx Windows
- [ ] Storage list shows region column
- [ ] Workstation mount config only shows same-region storage
- [ ] Error messages are clear and helpful

---

## Files Modified Summary

| File | Status | Description |
|------|--------|-------------|
| `lambda/storage-cfn-worker/index.js` | ✅ NEW | Cross-region CloudFormation operations |
| `lib/storage-stack.ts` | ✅ | Add Lambda, update state machines, cross-region permissions, pass regional hubs table to generate-fsx-template, configure-ontap-cifs regional routing |
| `lib/constructs/database-construct.ts` | ✅ | Add region GSI |
| `lambda/create-storage/index.js` | ✅ | Region parameter, validation |
| `lambda/configure-ontap-cifs/index.js` | ✅ | Regional routing support for satellite regions |
| `lib/regional-hub-stack.ts` | ✅ | Add configure-ontap-cifs to regional Lambda assets |
| `lambda/generate-regional-hub-template/index.js` | ✅ | Add regional configure-ontap-cifs Lambda to CloudFormation template |
| `lambda/generate-fsx-template/index.js` | ✅ | Regional network config from DynamoDB, hardcoded values for regional hubs |
| `lambda/generate-regional-hub-template/index.js` | ✅ | Network SSM parameters (no longer needed - using DynamoDB) |
| `lambda/fsx-nfs-mount-manager/index.js` | ✅ | Region validation |
| `lambda/fsx-smb-mount-manager/index.js` | ✅ | Region validation |
| `lambda/delete-storage/index.js` | ✅ | Pass region to state machine, regional CloudFormation client |
| `lambda/list-storage/index.js` | ✅ | Region filter support |
| `lambda/workstation-api/index.js` | N/A | Storage filtering handled by frontend calling list-storage with region filter |
| `frontend/src/pages/StorageManagement.tsx` | ✅ | Region selector, display |
| `frontend/src/pages/WorkstationManagement.tsx` | ✅ | Filter storage by workstation region |

---

## Constraints & Known Limitations

1. **FSx Windows restricted to primary region** - Requires AD integration which isn't available in regional hubs
2. **FSx ONTAP CIFS in regional hubs** - AD-joined CIFS shares won't work; NFS and local CIFS will work
3. **Mountpoint S3 is global** - Works from any region, no changes needed
4. **Cross-region latency** - State machine polling adds some latency for regional storage creation
5. **CIFS configuration in regional hubs** - The `configure-ontap-cifs` Lambda needs VPC access to SSH to the FSx ONTAP SVM. The primary region Lambda routes to a regional Lambda (`{acronym}-regional-configure-ontap-cifs`) deployed in the regional hub's VPC. This Lambda is automatically deployed when creating/updating regional hubs.

---

## Rollback Plan

If issues arise:
1. Remove region parameter from create-storage API (frontend will stop sending it)
2. State machine will default to primary region behavior
3. No data migration needed - region field is additive

---

## Progress Log

| Date | Phase | Status | Notes |
|------|-------|--------|-------|
| 2026-02-10 | 1.1 | ✅ | Created storage-cfn-worker Lambda |
| 2026-02-10 | 1.2 | ✅ | Updated storage-stack.ts with Lambda and permissions |
| 2026-02-10 | 2.1 | ✅ | Updated create-storage with region validation |
| 2026-02-10 | 2.2 | ✅ | Updated generate-fsx-template with regional SSM paths |
| 2026-02-10 | 2.3 | ✅ | State machine already uses storage-cfn-worker |
| 2026-02-10 | 3.1 | ✅ | Added SSM parameters to regional hub template |
| 2026-02-11 | 2.2 | ✅ | Refactored generate-fsx-template to use DynamoDB for regional hub network config |
| 2026-02-11 | 3.1 | ✅ | Updated to use DynamoDB instead of SSM for regional hub network info |
| 2026-02-11 | 4.1 | ✅ | Added region validation to NFS mount manager |
| 2026-02-11 | 4.2 | ✅ | Added region validation to SMB mount manager |
| 2026-02-11 | 5.1 | ✅ | Deletion state machine already uses storage-cfn-worker for cross-region ops |
| 2026-02-11 | 5.2 | ✅ | Updated delete-storage Lambda to pass region and use regional CFN client |
| 2026-02-11 | 1.3 | ✅ | Added region GSI to storage table |
| 2026-02-11 | 7.1 | ✅ | Added region filter support to list-storage Lambda |
| 2026-02-11 | 6.1 | ✅ | Added region selector to storage creation UI for FSx ONTAP |
| 2026-02-11 | 6.2 | ✅ | Added region column to storage table |
| 2026-02-11 | 6.3 | ✅ | Added region filtering and info to workstation storage config UI |
| | | | |

