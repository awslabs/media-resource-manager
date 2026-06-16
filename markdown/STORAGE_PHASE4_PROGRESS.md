# Storage Management Phase 4: Storage Gateway Integration Progress

## Overview
Phase 4 implements AWS Storage Gateway File Gateway provisioning alongside the existing FSx Windows File System functionality, using a unified interface with dynamic form fields and shared Step Functions orchestration.

## Architecture: Unified State Machine with Choice States

**Benefits:**
- ✅ Single API endpoint for all storage types
- ✅ Shared Step Functions orchestration with branching logic
- ✅ Consistent status tracking and error handling
- ✅ Reusable infrastructure patterns
- ✅ Unified frontend experience

## Requirements & Implementation Steps

### ✅ Step 1: Update Frontend Modal for Dynamic Fields
- **Status**: COMPLETE ✅
- **Files Modified**:
  - `/frontend/src/pages/StorageManagement.tsx` ✅
- **Completed Requirements**:
  - ✅ Dynamic form fields based on Type selection
  - ✅ **FSx Windows**: Existing fields (SSD Storage, Throughput, Backup Retention)
  - ✅ **Storage Gateway**: New fields (Cache Volume Size, Deployment Subnet Type)
  - ✅ React state shows/hides fields based on selected type
  - ✅ Proper validation and form reset for both types
  - ✅ Consistent user experience with description field for both types

### ✅ Step 2: Examine MCS Storage Gateway Template
- **Status**: COMPLETE ✅
- **Reference Files Analyzed**:
  - `/home/ubuntu/mcs-storage-gateway/mcs-assets/storage-gateway.json` ✅
- **Key Findings**:
  - ✅ **Parameters**: `CacheVolumeSize` (50-16000 GB), `SubnetType` (public/private), `GatewayName`, `McsDeploymentId`
  - ✅ **Main Resources**: S3 Bucket, EC2 Instance (m5.xlarge), Security Group, IAM Roles, Step Functions
  - ✅ **SSM Parameter Mapping**: Uses `McsDeploymentId` prefix - need to replace with `ProductName`
  - ✅ **Network Integration**: VPC endpoints for private subnets, security group with specific ports
  - ✅ **Step Functions Orchestration**: Activation → Configuration → File Share Creation
  - ✅ **Lambda Functions**: Activation, Configuration, Cleanup, Orchestrator
  - ✅ **Outputs**: BucketName, InstanceId, GatewayId for tracking

### Key Template Structure Analysis:
```javascript
// Required SSM Parameters (to be updated with ProductName)
- /${ProductName}/Network/VpcId
- /${ProductName}/Network/PublicSubnet1/SubnetID  
- /${ProductName}/Network/PrivateSubnet1/SubnetID
- /${ProductName}/Network/VpcCidr

// Main Resources Created:
- AWS::S3::Bucket (for file storage)
- AWS::EC2::Instance (Storage Gateway appliance)
- AWS::EC2::SecurityGroup (ports 80, 443, 1026, 2049, etc.)
- AWS::IAM::Role (for Storage Gateway service)
- AWS::StepFunctions::StateMachine (orchestration)
- AWS::Lambda::Function (activation, configuration, cleanup)

// User Configuration Mapping:
- CacheVolumeSize → EBS volume size for cache
- SubnetType → public/private subnet selection
```

### 📋 Step 3: Create Storage Gateway Template Generator
- **Status**: PENDING
- **Files to Create/Modify**:
  - Rename `/lambda/generate-fsx-template/` to `/lambda/generate-storage-template/`
  - Update `index.js` to handle both FSx and Storage Gateway templates
- **Requirements**:
  - Generate CloudFormation templates based on storage type
  - Use ProductName Pascal Case for SSM parameter paths (not MCS Deployment ID)
  - Support Storage Gateway configuration parameters:
    - Cache Volume Size
    - Deployment Subnet Type (public/private)
  - Create S3 bucket for Storage Gateway (future: support BYOB)

### 📋 Step 4: Update Step Functions State Machine with Choice Logic
- **Status**: PENDING
- **Files to Modify**:
  - `/lib/storage-stack.ts` - Update StorageCreationStateMachine
- **Requirements**:
  - Add Choice state at beginning to route based on storage type
  - **FSx Path**: Use existing proven workflow
  - **Storage Gateway Path**: New workflow branch
  - Maintain same DynamoDB update patterns
  - Use same CloudFormation integration approach
  - Preserve error handling and retry logic

### 📋 Step 5: Update Lambda Functions for Multi-Type Support
- **Status**: PENDING
- **Files to Modify**:
  - `/lambda/create-storage/index.js` - Handle both types
  - Template generator function (renamed)
- **Requirements**:
  - Same API endpoint handles both FSx and Storage Gateway
  - Pass storage type to Step Functions
  - Validate configuration based on type
  - Maintain backward compatibility

### 📋 Step 6: Add Storage Gateway IAM Permissions
- **Status**: PENDING
- **Files to Modify**:
  - `/lib/storage-stack.ts` - Add Storage Gateway permissions
- **Requirements**:
  - Storage Gateway service permissions
  - S3 bucket creation and management
  - EC2 permissions for gateway deployment
  - VPC endpoint permissions if needed

### 📋 Step 7: Testing & Validation
- **Status**: PENDING
- **Tasks**:
  - Test FSx creation (ensure no regression)
  - Test Storage Gateway creation end-to-end
  - Verify 10-15 minute creation time for Storage Gateway
  - Test deletion for both types
  - Validate dynamic form field switching
  - Test error handling for both paths

## Configuration Flow: Storage Gateway

### 1. User Input (Frontend)
```javascript
// StorageManagement.tsx - Storage Gateway form
const formData = {
  name: "My Storage Gateway",
  type: "storage-gateway",
  description: "Storage gateway for file shares", // Same as FSx option
  configuration: {
    cacheVolumeSizeGB: 150,           // User selects cache size
    deploymentSubnetType: "private"   // User selects public/private
  }
};
```

### 2. Step Functions Choice State
```javascript
// Enhanced state machine with choice logic
{
  "ChooseStorageType": {
    "Type": "Choice",
    "Choices": [
      {
        "Variable": "$.type",
        "StringEquals": "fsx-windows",
        "Next": "UpdateStatusToValidating"  // Existing FSx path
      },
      {
        "Variable": "$.type", 
        "StringEquals": "storage-gateway",
        "Next": "UpdateStatusToValidatingGateway"  // New Gateway path
      }
    ],
    "Default": "UpdateStatusToFailed"
  }
}
```

### 3. Storage Gateway CloudFormation Parameters
```javascript
// Based on MCS template with ProductName SSM parameters
{
  "parameters": [
    { "ParameterKey": "CacheVolumeSizeGB", "ParameterValue": "150" },        // USER VALUE
    { "ParameterKey": "DeploymentSubnetType", "ParameterValue": "private" }, // USER VALUE
    { "ParameterKey": "ProductName", "ParameterValue": "Media Resource Manager" }  // SYSTEM VALUE
  ]
}
```

## Technical Notes

### Dynamic SSM Parameter Paths (Storage Gateway)
**IMPORTANT**: Use ProductName Pascal Case, NOT MCS Deployment ID references!

**Environment Variable**: Pass `PRODUCT_NAME` environment variable to template generator
- Source: `props.pascalCaseName` from CDK context (e.g., "MediaResourceManager")

**Dynamic Parameter Paths** (built at runtime):
- `/${PRODUCT_NAME}/Network/VpcId`
- `/${PRODUCT_NAME}/Network/PublicSubnet1/SubnetID` (for public deployment)
- `/${PRODUCT_NAME}/Network/PrivateSubnet1/SubnetID` (for private deployment)
- `/${PRODUCT_NAME}/Network/VpcCidr`

### Storage Gateway vs FSx Differences
- **Creation Time**: Storage Gateway ~10-15 minutes vs FSx ~30-45 minutes
- **Configuration**: Cache size + subnet type vs storage/throughput/backup
- **Resources**: S3 bucket + Gateway vs FSx file system + security group
- **Networking**: May need VPC endpoints vs direct AD integration

### State Machine Architecture Decision
**Single State Machine with Choice States** is the right approach because:
- ✅ **Unified API**: Same endpoint for all storage types
- ✅ **Shared Infrastructure**: Common DynamoDB updates, error handling
- ✅ **Consistent Patterns**: Same retry logic, status flow
- ✅ **Easier Maintenance**: Single state machine to manage
- ✅ **Future Scalability**: Easy to add more storage types

## Success Criteria for Phase 4
- ✅ Dynamic form fields change based on storage type selection
- ✅ Storage Gateway File Gateways can be created via UI
- ✅ CloudFormation stacks are properly managed for both types
- ✅ Status updates work correctly for both FSx and Storage Gateway
- ✅ Creation time is ~10-15 minutes for Storage Gateway
- ✅ Deletion works for both storage types
- ✅ No regression in existing FSx functionality
- ✅ Error handling works correctly for both paths

## Current Status Summary
- **Phase 1**: ✅ COMPLETE - Metadata CRUD operations
- **Phase 2**: ✅ COMPLETE - FSx Windows file system provisioning
- **Phase 3**: ✅ COMPLETE - FSx deletion functionality
- **Phase 4**: 🚧 STARTING - Storage Gateway integration with unified state machine
- **Next**: Begin with dynamic frontend form fields and MCS template analysis
