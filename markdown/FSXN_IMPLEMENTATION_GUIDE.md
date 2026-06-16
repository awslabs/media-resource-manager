# FSx for NetApp ONTAP (FSxN) Implementation Guide

## Overview

This document outlines the design and implementation plan for adding FSx for NetApp ONTAP support to the storage management feature. FSxN provides multi-protocol (NFS + SMB) shared storage ideal for video editing workflows with mixed Windows, Mac, and Linux workstations.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [FSxN Concepts](#fsxn-concepts)
3. [Design Decisions](#design-decisions)
4. [Phase 1: Initial Implementation](#phase-1-initial-implementation)
5. [Phase 2: Management Features](#phase-2-management-features)
6. [CloudFormation Template Design](#cloudformation-template-design)
7. [Frontend Form Design](#frontend-form-design)
8. [API Changes](#api-changes)
9. [Testing Plan](#testing-plan)
10. [Cost Considerations](#cost-considerations)

---

## Architecture Overview

### Current Storage Creation Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Frontend  │────►│ Create API  │────►│ Step Functions  │────►│ CloudFormation  │
│    Form     │     │   Lambda    │     │ State Machine   │     │     Stack       │
└─────────────┘     └─────────────┘     └─────────────────┘     └─────────────────┘
                           │                    │                        │
                           ▼                    ▼                        ▼
                    ┌─────────────┐     ┌─────────────────┐     ┌─────────────────┐
                    │  DynamoDB   │     │ Generate CFN    │     │  FSxN Resources │
                    │   Record    │     │ Template Lambda │     │ (FS + SVM + Vol)│
                    └─────────────┘     └─────────────────┘     └─────────────────┘
```

### FSxN Resource Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│                     FSxN File System                            │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    HA Pair 1                              │  │
│  │  ┌─────────────┐              ┌─────────────┐            │  │
│  │  │  Server 1   │◄────────────►│  Server 2   │            │  │
│  │  │  (Active)   │   Failover   │  (Standby)  │            │  │
│  │  └─────────────┘              └─────────────┘            │  │
│  └───────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              Storage Virtual Machine (SVM)                │  │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐                   │  │
│  │  │ Volume1 │  │ Volume2 │  │ Volume3 │  ...              │  │
│  │  │ (NFS)   │  │ (SMB)   │  │ (Mixed) │                   │  │
│  │  └─────────┘  └─────────┘  └─────────┘                   │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## FSxN Concepts

### File System
The top-level resource containing all storage infrastructure. Key properties:
- **Deployment Type**: SINGLE_AZ_2 (up to 12 HA pairs) or MULTI_AZ_1 (1 HA pair, cross-AZ failover)
- **SSD Storage Capacity**: Total raw storage pool (1,024 GiB - 192 TiB)
- **Throughput Capacity**: Network/disk performance tier

### HA Pairs (High-Availability Pairs)
Two file servers working together for redundancy and performance:
- Each HA pair provides a set amount of throughput
- More HA pairs = more aggregate throughput (parallel processing)
- SINGLE_AZ_2 supports 1-12 HA pairs; MULTI_AZ_1 supports only 1

| HA Pairs | Throughput @ 3072 MBps | Throughput @ 6144 MBps |
|----------|------------------------|------------------------|
| 1        | 3 GB/s                 | 6 GB/s                 |
| 2        | 6 GB/s                 | 12 GB/s                |
| 6        | 18 GB/s                | 36 GB/s                |
| 12       | 36 GB/s                | 72 GB/s                |

### Storage Virtual Machine (SVM)
An isolated virtual file server within the file system:
- Has its own network endpoints (NFS, SMB, iSCSI)
- Can be joined to Active Directory or run in Workgroup mode
- Contains volumes for actual data storage
- Multiple SVMs can exist per file system (team isolation)

### Volumes
Logical storage containers within an SVM:
- **FlexVol**: Standard volume (up to 300 TB)
- **FlexGroup**: Aggregated volume across HA pairs (recommended for video editing)
- Thin provisioned by default
- Support tiering to capacity pool storage

### Protocol Support

| Protocol | Use Case | Authentication |
|----------|----------|----------------|
| NFS v3/v4 | Linux, Mac | UNIX UID/GID |
| SMB 2.x/3.x | Windows | AD or Local Users |
| iSCSI | Block storage | CHAP |

---

## Design Decisions

### 1. State Machine Approach
**Decision**: Extend existing `storage-creation` state machine

**Rationale**:
- Same flow pattern (generate template → deploy → wait → update DynamoDB)
- Reduces infrastructure complexity
- Single state machine to maintain

**Implementation**:
- Add `storageType` to state machine input
- Branch in `generate-fsx-template` Lambda based on type

### 2. Active Directory Integration
**Decision**: Use Workgroup mode (no AD required)

**Rationale**:
- Most users will use Cognito authentication
- AD adds complexity and dependency
- Workgroup mode supports both NFS and SMB

**Implementation**:
- Create SVM without `ActiveDirectoryConfiguration`
- Use local ONTAP users for SMB access
- NFS works without any authentication setup

### 3. Deployment Type Default
**Decision**: Default to SINGLE_AZ_2

**Rationale**:
- Supports multiple HA pairs for throughput scaling
- Video editing requires high throughput
- Cross-AZ access still works (minor latency/cost)
- MULTI_AZ_1 limited to 1 HA pair

### 4. Volume Configuration
**Decision**: Create one FlexGroup volume with MIXED security style

**Rationale**:
- FlexGroup provides best performance for video editing
- MIXED security style works for both NFS and SMB
- Users can create additional volumes later (Phase 2)

### 5. Form Simplification
**Decision**: Provide Simple and Advanced modes

**Rationale**:
- Most users don't need to understand HA pairs
- Team size presets provide sensible defaults
- Power users can access advanced settings

---

## Phase 1: Initial Implementation

### Scope
- Create FSxN file systems via the storage management UI
- Support Simple and Advanced configuration modes
- Generate CloudFormation template with File System + SVM + Volume
- Display FSxN resources in storage list and details

### Components to Modify

#### 1. Frontend: `StorageManagement.tsx`
- Enable FSxN option in storage type dropdown
- Add FSxN-specific form fields
- Implement Simple/Advanced mode toggle

#### 2. Lambda: `generate-fsx-template/index.js`
- Add `generateFsxOntapTemplate()` function
- Handle FSxN-specific CloudFormation resources
- Return template with 3 resources (FileSystem, SVM, Volume)

#### 3. Lambda: `create-storage/index.js`
- Add `fsx-ontap` case to storage type handling
- Pass FSxN configuration to state machine
- Include `type` field in state machine input

#### 4. Lambda: `parse-stack-outputs/index.js` (NEW)
- Parse CloudFormation outputs by name (not index)
- Normalize outputs for different storage types
- Return consistent format for DynamoDB update

#### 5. State Machine: `storage-stack.ts`
- Add `ParseStackOutputs` state after `EvaluateStackStatus`
- Update `UpdateStatusToAvailable` to use parsed outputs
- Store all outputs as JSON in `parsedOutputs` field

#### 6. Lambda: `get-storage/index.js`
- Return FSxN-specific fields (svmId, volumeId, endpoints)

### Timeline Estimate
- Frontend form: 2-3 hours
- Template generator: 2-3 hours
- Integration & testing: 2-3 hours
- **Total: ~1 day**

---

## Phase 2: Management Features

### Scope
Post-creation management of FSxN resources via API calls (no CloudFormation).

### Features

#### Volume Management
| Feature | API | Priority |
|---------|-----|----------|
| List volumes | FSx DescribeVolumes | High |
| Create volume | FSx CreateVolume | High |
| Resize volume | FSx UpdateVolume | Medium |
| Delete volume | FSx DeleteVolume | Medium |
| Update tiering policy | FSx UpdateVolume | Low |

#### SVM Management
| Feature | API | Priority |
|---------|-----|----------|
| List SVMs | FSx DescribeStorageVirtualMachines | Medium |
| Create SVM | FSx CreateStorageVirtualMachine | Low |
| Manage local users | ONTAP REST API | Low |

#### File System Scaling
| Feature | API | Priority |
|---------|-----|----------|
| Increase storage | FSx UpdateFileSystem | Medium |
| Increase throughput | FSx UpdateFileSystem | Medium |
| View metrics | CloudWatch GetMetricData | High |

### Implementation Approach
- New Lambda functions for each operation
- New API Gateway endpoints
- Frontend detail page with management tabs

---

## CloudFormation Template Design

### Resources Created

```yaml
Resources:
  # 1. Security Group for FSxN
  FsxOntapSecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: FSxN access control
      VpcId: !Ref VpcId
      SecurityGroupIngress:
        # NFS
        - IpProtocol: tcp
          FromPort: 111
          ToPort: 111
          CidrIp: !Ref VpcCidr
        - IpProtocol: tcp
          FromPort: 2049
          ToPort: 2049
          CidrIp: !Ref VpcCidr
        - IpProtocol: tcp
          FromPort: 635
          ToPort: 635
          CidrIp: !Ref VpcCidr
        # SMB
        - IpProtocol: tcp
          FromPort: 445
          ToPort: 445
          CidrIp: !Ref VpcCidr
        - IpProtocol: tcp
          FromPort: 139
          ToPort: 139
          CidrIp: !Ref VpcCidr
        # ONTAP Management
        - IpProtocol: tcp
          FromPort: 443
          ToPort: 443
          CidrIp: !Ref VpcCidr

  # 2. FSxN File System
  FsxOntapFileSystem:
    Type: AWS::FSx::FileSystem
    Properties:
      FileSystemType: ONTAP
      StorageCapacity: !Ref StorageCapacity
      SubnetIds:
        - !Ref SubnetId
      SecurityGroupIds:
        - !Ref FsxOntapSecurityGroup
      OntapConfiguration:
        DeploymentType: !Ref DeploymentType
        ThroughputCapacityPerHAPair: !Ref ThroughputCapacity
        HAPairs: !Ref HAPairs
        PreferredSubnetId: !Ref SubnetId
        FsxAdminPassword: !Ref FsxAdminPassword
        AutomaticBackupRetentionDays: !Ref BackupRetention

  # 3. Storage Virtual Machine (SVM)
  FsxOntapSVM:
    Type: AWS::FSx::StorageVirtualMachine
    Properties:
      FileSystemId: !Ref FsxOntapFileSystem
      Name: !Sub "${StorageName}-svm"
      RootVolumeSecurityStyle: MIXED

  # 4. Initial Volume (FlexGroup)
  FsxOntapVolume:
    Type: AWS::FSx::Volume
    Properties:
      Name: !Sub "${StorageName}-vol1"
      VolumeType: ONTAP
      OntapConfiguration:
        StorageVirtualMachineId: !Ref FsxOntapSVM
        JunctionPath: /vol1
        SizeInMegabytes: !Ref VolumeSize
        SecurityStyle: MIXED
        StorageEfficiencyEnabled: true
        TieringPolicy:
          Name: AUTO
          CoolingPeriod: 31

Outputs:
  FileSystemId:
    Value: !Ref FsxOntapFileSystem
  FileSystemDnsName:
    Value: !GetAtt FsxOntapFileSystem.DNSName
  SvmId:
    Value: !Ref FsxOntapSVM
  VolumeId:
    Value: !Ref FsxOntapVolume
```

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| StorageName | String | - | Name for the storage resource |
| DeploymentType | String | SINGLE_AZ_2 | SINGLE_AZ_2 or MULTI_AZ_1 |
| HAPairs | Number | 1 | Number of HA pairs (1-12 for SINGLE_AZ_2) |
| ThroughputCapacity | Number | 1536 | MBps per HA pair |
| StorageCapacity | Number | 1024 | Total SSD storage in GiB |
| VolumeSize | Number | 1024000 | Initial volume size in MiB |
| BackupRetention | Number | 30 | Days to retain backups |
| FsxAdminPassword | String | - | ONTAP admin password |

---

## Frontend Form Design

### Simple Mode (Default)

```
┌─────────────────────────────────────────────────────────────┐
│  Create FSx for NetApp ONTAP Storage                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Name: [________________________]                           │
│                                                             │
│  Team Size:                                                 │
│  ○ Small (1-5 editors)      - 3 GB/s throughput            │
│  ● Medium (5-15 editors)    - 6 GB/s throughput            │
│  ○ Large (15-30 editors)    - 18 GB/s throughput           │
│  ○ Enterprise (30+ editors) - 36 GB/s throughput           │
│                                                             │
│  Storage Capacity: [____1024____] GiB                       │
│  (Minimum 1,024 GiB)                                        │
│                                                             │
│  Backup Retention: [____30____] days                        │
│                                                             │
│  FSxN Admin Password: [________________________]            │
│  (8-50 characters, for ONTAP CLI/API access)               │
│                                                             │
│  [▼ Show Advanced Settings]                                 │
│                                                             │
│                              [Cancel]  [Create]             │
└─────────────────────────────────────────────────────────────┘
```

### Team Size Presets

| Team Size | HA Pairs | Throughput/Pair | Total Throughput | Est. Streams |
|-----------|----------|-----------------|------------------|--------------|
| Small     | 1        | 3072 MBps       | 3 GB/s           | ~20          |
| Medium    | 2        | 3072 MBps       | 6 GB/s           | ~40          |
| Large     | 6        | 3072 MBps       | 18 GB/s          | ~120         |
| Enterprise| 6        | 6144 MBps       | 36 GB/s          | ~120+        |

### Advanced Mode (Expanded)

```
┌─────────────────────────────────────────────────────────────┐
│  [▲ Hide Advanced Settings]                                 │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Deployment Type:                                           │
│  ● Single-AZ (Gen 2) - Up to 12 HA pairs, max throughput   │
│  ○ Multi-AZ (Gen 1)  - Cross-AZ failover, 1 HA pair only   │
│                                                             │
│  HA Pairs: [____2____]                                      │
│  (1-12, each pair adds throughput capacity)                │
│                                                             │
│  Throughput per HA Pair:                                    │
│  ○ 1536 MBps (1.5 GB/s)                                    │
│  ● 3072 MBps (3 GB/s)                                      │
│  ○ 6144 MBps (6 GB/s)                                      │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│  Volume Settings                                            │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  Initial Volume Size: [____1000____] GiB                    │
│                                                             │
│  Security Style:                                            │
│  ● MIXED (NFS + SMB)                                       │
│  ○ UNIX (NFS only)                                         │
│  ○ NTFS (SMB only)                                         │
│                                                             │
│  Storage Efficiency: [✓] Enable compression & deduplication │
│                                                             │
│  Tiering Policy:                                            │
│  ● AUTO - Tier cold data after 31 days                     │
│  ○ SNAPSHOT_ONLY - Only tier snapshot data                 │
│  ○ ALL - Tier all data immediately                         │
│  ○ NONE - Keep all data on SSD                             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## API Changes

### Create Storage Request

```json
{
  "name": "video-editing-storage",
  "type": "fsx-ontap",
  "configuration": {
    // Simple mode (team size preset)
    "teamSize": "medium",
    
    // OR Advanced mode (manual settings)
    "deploymentType": "SINGLE_AZ_2",
    "haPairs": 2,
    "throughputCapacityPerHAPair": 3072,
    "storageCapacity": 2048,
    "volumeSize": 1500,
    "securityStyle": "MIXED",
    "storageEfficiencyEnabled": true,
    "tieringPolicy": "AUTO",
    "backupRetention": 30,
    "fsxAdminPassword": "<REPLACE_WITH_SECURE_PASSWORD>"
  }
}
```

### Storage Resource Response (DynamoDB)

```json
{
  "storageId": "uuid-here",
  "name": "video-editing-storage",
  "type": "fsx-ontap",
  "status": "available",
  "cloudFormationStackName": "MRM-Storage-uuid",
  "configuration": {
    "deploymentType": "SINGLE_AZ_2",
    "haPairs": 2,
    "throughputCapacity": 6144,
    "storageCapacity": 2048
  },
  // FSxN-specific fields
  "fsxFileSystemId": "fs-0123456789abcdef",
  "fsxDnsName": "fs-0123456789abcdef.fsx.us-east-1.amazonaws.com",
  "svmId": "svm-0123456789abcdef",
  "volumeId": "fsvol-0123456789abcdef",
  "managementEndpoint": "198.19.0.10",
  "nfsEndpoint": "svm-name.fs-id.fsx.region.amazonaws.com",
  "smbEndpoint": "svm-name.fs-id.fsx.region.amazonaws.com",
  "createdAt": "2024-01-15T10:30:00Z"
}
```

---

## Testing Plan

### Unit Tests
- [ ] Template generator produces valid CloudFormation JSON
- [ ] Team size presets calculate correct HA pairs/throughput
- [ ] Form validation (password requirements, capacity limits)

### Integration Tests
- [ ] Create FSxN via API → State machine executes → Stack created
- [ ] CloudFormation stack creates all 3 resources
- [ ] DynamoDB record updated with correct outputs
- [ ] Delete FSxN → Stack deleted → Record removed

### Manual Tests
- [ ] Mount volume via NFS from Linux workstation
- [ ] Mount volume via SMB from Windows workstation
- [ ] Verify throughput meets expectations
- [ ] Test cross-AZ access (if using SINGLE_AZ)

### Performance Tests
- [ ] Measure actual throughput vs. configured
- [ ] Test with multiple concurrent streams
- [ ] Verify tiering behavior

---

## Cost Considerations

### FSxN Pricing Components

| Component | Pricing (us-east-1) | Notes |
|-----------|---------------------|-------|
| SSD Storage | ~$0.125/GB-month | Primary storage tier |
| Capacity Pool | ~$0.0125/GB-month | Cold data tier (10x cheaper) |
| Throughput | ~$0.20/MBps-month | Per provisioned MBps |
| Backups | ~$0.05/GB-month | Incremental backups |

### Example Monthly Costs

| Configuration | SSD | Throughput | Est. Monthly |
|---------------|-----|------------|--------------|
| Small (1 HA, 3GB/s, 1TB) | $128 | $614 | ~$750 |
| Medium (2 HA, 6GB/s, 2TB) | $256 | $1,228 | ~$1,500 |
| Large (6 HA, 18GB/s, 5TB) | $640 | $3,686 | ~$4,300 |

### Cost Optimization Tips
1. **Enable tiering**: AUTO policy moves cold data to capacity pool (10x cheaper)
2. **Right-size throughput**: Start smaller, scale up as needed
3. **Use storage efficiency**: Deduplication can reduce storage 30-50%
4. **Monitor utilization**: Scale down if underutilized

---

## Security Considerations

### Network Security
- FSxN deployed in private subnets only
- Security group restricts access to VPC CIDR
- No public endpoints

### Authentication
- Workgroup mode (no AD dependency)
- Local ONTAP users for SMB access
- NFS uses UNIX permissions (UID/GID mapping)

### Encryption
- Encryption at rest (AWS KMS)
- Encryption in transit (SMB 3.x, NFS with TLS)

### Admin Access
- FSxN admin password stored securely
- ONTAP CLI/API access for advanced management
- Audit logging via CloudTrail

---

## Appendix A: FSxN Tuning for Video Editing

Based on Adobe Premiere Pro testing (see `FSXN_ADOBE_PREMIERE_BEST_PRACTICES.md`):

### Required Tuning (Post-Creation)
These optimizations should be applied after FSxN creation for video editing workloads:

```bash
# Connect to FSxN management endpoint
ssh fsxadmin@<management-endpoint>

# Set advanced privilege
set -privilege advanced

# 1. Disable min-readahead (improves streaming)
volume modify -volume <vol-name> -min-readahead false

# 2. Verify multichannel is enabled (should be default)
vserver cifs options show
# If not enabled:
vserver cifs options modify -vserver <svm-name> -is-multichannel-enabled true

# 3. Enable large MTU
vserver cifs options modify -vserver <svm-name> -is-large-mtu-enabled true
```

### Client-Side Configuration
- Enable jumbo frames on EC2 instances
- Use NFS nconnect option for Linux (up to 16 connections)
- Configure SMB multichannel on Windows

---

## Appendix B: Mounting FSxN Volumes

### Linux (NFS)
```bash
# Install NFS client
sudo apt-get install nfs-common

# Create mount point
sudo mkdir -p /mnt/fsxn

# Mount with nconnect for better performance
sudo mount -t nfs -o nconnect=16,rsize=262144,wsize=262144 \
  svm-name.fs-id.fsx.region.amazonaws.com:/vol1 /mnt/fsxn

# Add to /etc/fstab for persistence
svm-name.fs-id.fsx.region.amazonaws.com:/vol1 /mnt/fsxn nfs nconnect=16,rsize=262144,wsize=262144 0 0
```

### Windows (SMB)
```powershell
# Map network drive
net use Z: \\svm-name.fs-id.fsx.region.amazonaws.com\vol1 /user:localuser password

# Or via PowerShell
New-PSDrive -Name "Z" -PSProvider FileSystem -Root "\\svm-name.fs-id.fsx.region.amazonaws.com\vol1" -Persist
```

### macOS (NFS or SMB)
```bash
# NFS
sudo mount -t nfs -o resvport,rw svm-name.fs-id.fsx.region.amazonaws.com:/vol1 /Volumes/fsxn

# SMB (via Finder)
# Go > Connect to Server > smb://svm-name.fs-id.fsx.region.amazonaws.com/vol1
```

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2024-01-15 | Kiro | Initial design document |
