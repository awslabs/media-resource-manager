# Regional Hub Implementation Guide

This document tracks the implementation progress for the self-service regional hub feature, which allows administrators to dynamically add satellite regions through the UI.

## Overview

The regional hub feature enables:
- Self-service region expansion without CLI/CDK access
- Dynamic CloudFormation deployment to satellite regions
- Automatic AMI replication across regions
- Region selection when creating workstations

See [MULTI_REGION_DEPLOYMENT.md](./MULTI_REGION_DEPLOYMENT.md) for the full architecture design.

---

## Implementation Phases

### Phase 1: Database & Backend Foundation ✅ COMPLETE

**Completed: February 3, 2026**

#### Files Created

| File | Description |
|------|-------------|
| `lambda/list-regional-hubs/index.js` | Lists all regional hubs including primary region with workstation counts |
| `lambda/get-regional-hub/index.js` | Gets details for a specific regional hub |
| `lambda/create-regional-hub/index.js` | Creates new regional hub record with validation |
| `lambda/delete-regional-hub/index.js` | Deletes regional hub with workstation safeguards |

#### Files Modified

| File | Changes |
|------|---------|
| `lib/constructs/database-construct.ts` | Added `regionalHubsTable` DynamoDB table with status GSI |
| `lib/api-stack.ts` | Added 4 Lambda functions and API endpoints for regional hub CRUD |
| `bin/media-resource-manager.ts` | Passed `regionalHubsTable` to ApiStack |
| `lib/infrastructure-stack.ts` | Added output for regional hubs table name |

#### API Endpoints Created

| Method | Path | Description |
|--------|------|-------------|
| GET | `/regions` | List all regional hubs (includes primary) |
| POST | `/regions` | Create a new regional hub |
| GET | `/regions/{region}` | Get regional hub details |
| DELETE | `/regions/{region}` | Delete a regional hub |

#### DynamoDB Table Schema

```javascript
{
  region: "us-west-2",                    // Partition key
  status: "available",                    // GSI: status-index
  displayName: "US West (Oregon)",
  vpcCidr: "10.100.0.0/22",
  availabilityZones: ["usw2-az1", "usw2-az2", "usw2-az3"],
  publicSubnetMask: 28,
  privateSubnetMask: 24,
  dcvDomainName: "dcv-usw2.portal.tegna.com",
  dcvCertificateArn: "arn:aws:acm:...",
  enableWindows: true,
  enableLinux: true,
  enableMacOS: false,
  // Populated after CloudFormation deployment:
  vpcId: "vpc-xxx",
  cloudFormationStackName: "MRM-Regional-Hub-usw2",
  nlbDnsName: "xxx.elb.us-west-2.amazonaws.com",
  workstationSecurityGroupId: "sg-xxx",
  launchTemplateId: "lt-xxx",
  dcvSessionManagerEndpoint: "https://...:8443",
  createdAt: "2026-02-03T...",
  updatedAt: "2026-02-03T...",
  createdBy: "admin@company.com"
}
```

#### Validation Implemented

- Region must be valid AWS region (not primary region)
- Region must not already exist as a hub
- Availability zones must exist and be available in target region
- VPC CIDR must be valid format (x.x.x.x/16-28)
- Cannot delete region with active workstations

---

### Phase 2: Regional Hub Stack & State Machines ✅ COMPLETE

**Completed: February 3, 2026**

#### Files Created

| File | Description |
|------|-------------|
| `lib/regional-hub-stack.ts` | CDK stack with state machines and template generation Lambda |
| `lambda/generate-regional-hub-template/index.js` | Generates CloudFormation template for satellite region infrastructure |

#### Files Modified

| File | Changes |
|------|---------|
| `bin/media-resource-manager.ts` | Added RegionalHubStack instantiation and NAG suppressions |
| `lib/api-stack.ts` | Added SSM and Step Functions permissions to create/delete Lambda functions |
| `lambda/create-regional-hub/index.js` | Added SSM lookup for state machine ARN |
| `lambda/delete-regional-hub/index.js` | Added SSM lookup for state machine ARN |

#### State Machines Created

| State Machine | Description |
|---------------|-------------|
| `{acronym}-regional-hub-creation` | Deploys CloudFormation stack to satellite region |
| `{acronym}-regional-hub-deletion` | Deletes CloudFormation stack from satellite region |

#### State Machine: Regional Hub Creation Flow

```
1. UpdateStatusToValidating
2. GenerateCloudFormationTemplate (Lambda)
3. UpdateStatusToCreating
4. CreateCloudFormationStack (cross-region)
5. WaitForStackCreation (poll every 60s)
6. CheckStackStatus
7. EvaluateStackStatus (Choice)
8. ExtractStackOutputs
9. UpdateStatusToAvailable
```

#### State Machine: Regional Hub Deletion Flow

```
1. UpdateStatusToDeleting
2. DeleteCloudFormationStack (cross-region)
3. WaitForStackDeletion (poll every 60s)
4. CheckStackDeletionStatus
5. EvaluateStackDeletionStatus (Choice)
6. DeleteDynamoDBRecord
```

#### CloudFormation Template Resources

The generated template creates:
- VPC with public/private subnets
- Internet Gateway + NAT Gateway
- Route Tables
- Workstation Security Group
- DCV Infrastructure Security Group
- Network Load Balancer for DCV
- Target Group for DCV
- Workstation Launch Template
- SSM Parameters for regional configuration

#### SSM Parameters Created

| Parameter | Description |
|-----------|-------------|
| `/{ProductName}/RegionalHub/CreationStateMachineArn` | ARN of creation state machine |
| `/{ProductName}/RegionalHub/DeletionStateMachineArn` | ARN of deletion state machine |
| `/{ProductName}/Regional/{Region}/VpcId` | VPC ID in satellite region |
| `/{ProductName}/Regional/{Region}/PrivateSubnetIds` | Private subnet IDs |
| `/{ProductName}/Regional/{Region}/PublicSubnetIds` | Public subnet IDs |
| `/{ProductName}/Regional/{Region}/WorkstationSecurityGroupId` | Security group ID |
| `/{ProductName}/Regional/{Region}/LaunchTemplateId` | Launch template ID |
| `/{ProductName}/Regional/{Region}/NlbDnsName` | NLB DNS name |

---

### Phase 3: CloudFormation Template ✅ COMPLETE

**Completed: February 3, 2026**

The CloudFormation template is generated dynamically by the `generate-regional-hub-template` Lambda function (created in Phase 2). This template deploys a complete DCV infrastructure stack to satellite regions.

#### Template Resources Implemented

**VPC Infrastructure**
| Resource | Type | Description |
|----------|------|-------------|
| VPC | AWS::EC2::VPC | Regional VPC with DNS support |
| InternetGateway | AWS::EC2::InternetGateway | Internet access for public subnets |
| PublicSubnet1/2 | AWS::EC2::Subnet | Public subnets for NAT/NLB |
| PrivateSubnet1/2 | AWS::EC2::Subnet | Private subnets for workstations |
| NatGateway | AWS::EC2::NatGateway | Outbound internet for private subnets |
| PublicRouteTable | AWS::EC2::RouteTable | Routes for public subnets |
| PrivateRouteTable | AWS::EC2::RouteTable | Routes for private subnets |

**Security Groups**
| Resource | Type | Description |
|----------|------|-------------|
| SessionManagerSecurityGroup | AWS::EC2::SecurityGroup | SG for DCV Session Manager (ports 8443, 8445, 8447) |
| ConnectionGatewaySecurityGroup | AWS::EC2::SecurityGroup | SG for DCV Connection Gateway (TCP 8443, UDP 8443/8444, health 8989) |
| WorkstationSecurityGroup | AWS::EC2::SecurityGroup | SG for workstations (DCV ports + SMB 445) |
| CleanupLambdaSecurityGroup | AWS::EC2::SecurityGroup | SG for cleanup Lambda functions |

**DCV Session Manager (Internal)**
| Resource | Type | Description |
|----------|------|-------------|
| SessionManagerRole | AWS::IAM::Role | IAM role with DynamoDB, SSM, CloudWatch access |
| SessionManagerInstanceProfile | AWS::IAM::InstanceProfile | Instance profile for Session Manager |
| SessionManagerLaunchTemplate | AWS::EC2::LaunchTemplate | m6g.large ARM instance with user data |
| SessionManagerASG | AWS::AutoScaling::AutoScalingGroup | ASG (min 1, max 3) in private subnets |
| SessionManagerNLB | AWS::ElasticLoadBalancingV2::LoadBalancer | Internal NLB for Session Manager |
| SessionManagerAgentTargetGroup | AWS::ElasticLoadBalancingV2::TargetGroup | Port 8445 (Agent to Broker) |
| SessionManagerApiTargetGroup | AWS::ElasticLoadBalancingV2::TargetGroup | Port 8443 (CLI to Broker API) |
| SessionManagerResolverTargetGroup | AWS::ElasticLoadBalancingV2::TargetGroup | Port 8447 (Gateway to Broker resolver) |

**DCV Connection Gateway (Public)**
| Resource | Type | Description |
|----------|------|-------------|
| ConnectionGatewayRole | AWS::IAM::Role | IAM role with SSM, Secrets Manager access |
| ConnectionGatewayInstanceProfile | AWS::IAM::InstanceProfile | Instance profile for Connection Gateway |
| ConnectionGatewayLaunchTemplate | AWS::EC2::LaunchTemplate | c7g.large ARM instance with user data |
| ConnectionGatewayASG | AWS::AutoScaling::AutoScalingGroup | ASG (min 1, max 3) in private subnets |
| ConnectionGatewayNLB | AWS::ElasticLoadBalancingV2::LoadBalancer | Internet-facing NLB for client connections |
| ConnectionGatewayTcpTargetGroup | AWS::ElasticLoadBalancingV2::TargetGroup | Port 8443 TCP |
| ConnectionGatewayUdpTargetGroup | AWS::ElasticLoadBalancingV2::TargetGroup | Port 8444 UDP (QUIC) |

**Workstation Infrastructure**
| Resource | Type | Description |
|----------|------|-------------|
| WorkstationRole | AWS::IAM::Role | IAM role with SSM, CloudWatch, DCV license access |
| WorkstationInstanceProfile | AWS::IAM::InstanceProfile | Instance profile for workstations |
| WorkstationLaunchTemplate | AWS::EC2::LaunchTemplate | Launch template for workstations |

**NLB Access Logging**
| Resource | Type | Description |
|----------|------|-------------|
| NlbAccessLogsBucket | AWS::S3::Bucket | S3 bucket for NLB access logs (90-day retention) |
| NlbAccessLogsBucketPolicy | AWS::S3::BucketPolicy | Policy for log delivery service |

**Regional Cleanup Infrastructure**
| Resource | Type | Description |
|----------|------|-------------|
| CleanupLambdaRole | AWS::IAM::Role | IAM role for cleanup Lambdas |
| DcvSessionCleanupFunction | AWS::Lambda::Function | Cleans up DCV sessions on stop/terminate |
| DcvServerCleanupFunction | AWS::Lambda::Function | Removes DCV server registration on terminate |
| SessionCleanupRule | AWS::Events::Rule | EventBridge rule for stop/terminate events |
| ServerCleanupRule | AWS::Events::Rule | EventBridge rule for terminate events |

**EC2 State Handler**
| Resource | Type | Description |
|----------|------|-------------|
| Ec2StateHandlerRole | AWS::IAM::Role | IAM role for EC2 state handler |
| Ec2StateHandlerFunction | AWS::Lambda::Function | Updates DynamoDB on EC2 state changes |
| Ec2StateChangeRule | AWS::Events::Rule | EventBridge rule for all EC2 state changes |

**DCV Status Sync**
| Resource | Type | Description |
|----------|------|-------------|
| DcvStatusSyncRole | AWS::IAM::Role | IAM role for status sync Lambda |
| DcvStatusSyncFunction | AWS::Lambda::Function | Polls Session Manager for connection status |
| DcvStatusSyncRule | AWS::Events::Rule | EventBridge rule (every 5 minutes) |

**Manual Cleanup**
| Resource | Type | Description |
|----------|------|-------------|
| ManualCleanupRole | AWS::IAM::Role | IAM role for manual cleanup Lambda |
| ManualCleanupFunction | AWS::Lambda::Function | API-callable for stale server/session cleanup |

**SSM Parameters**
| Resource | Type | Description |
|----------|------|-------------|
| VpcIdParameter | AWS::SSM::Parameter | VPC ID |
| PrivateSubnetsParameter | AWS::SSM::Parameter | Private subnet IDs |
| PublicSubnetsParameter | AWS::SSM::Parameter | Public subnet IDs |
| SecurityGroupParameter | AWS::SSM::Parameter | Workstation security group ID |
| LaunchTemplateParameter | AWS::SSM::Parameter | Workstation launch template ID |
| SessionManagerEndpointParameter | AWS::SSM::Parameter | Session Manager NLB DNS |
| ConnectionGatewayEndpointParameter | AWS::SSM::Parameter | Connection Gateway endpoint |

#### Template Outputs

| Output | Description |
|--------|-------------|
| VpcId | VPC ID for workstation creation |
| PrivateSubnet1Id/2Id | Private subnet IDs |
| WorkstationSecurityGroupId | Security group for workstations |
| LaunchTemplateId | Launch template for workstations |
| SessionManagerEndpoint | DCV Session Manager NLB DNS |
| ConnectionGatewayEndpoint | DCV Connection Gateway endpoint (custom domain or NLB DNS) |
| SessionManagerASGName | Session Manager ASG name |
| ConnectionGatewayASGName | Connection Gateway ASG name |
| DcvStatusSyncFunctionArn | DCV Status Sync Lambda ARN |
| ManualCleanupFunctionArn | Manual Cleanup Lambda ARN (API-callable) |

#### User Data Scripts

**Session Manager User Data**
- Installs DCV Session Manager from CloudFront distribution
- Configures DynamoDB persistence with regional table prefix
- Registers API client with retry logic (3 attempts)
- Stores credentials in SSM Parameter Store
- Configures CloudWatch logging
- Uses IMDSv2 for metadata retrieval

**Connection Gateway User Data**
- Installs DCV Connection Gateway from CloudFront distribution
- Configures resolver to point to Session Manager NLB
- Enables health check on port 8989
- Configures QUIC on port 8444 for UDP streaming
- Supports custom TLS certificates from Secrets Manager
- Converts private key to PKCS#8 format (required by DCV Gateway)

---

### Phase 4: AMI Replication ✅ COMPLETE

**Completed: February 3, 2026**

#### Files Created

| File | Description |
|------|-------------|
| `lambda/ami-replication-handler/index.js` | Handles AMI replication to satellite regions |

#### Files Modified

| File | Changes |
|------|---------|
| `lib/regional-hub-stack.ts` | Added AMI replication Lambda and EventBridge rule |

#### AMI Replication Flow

1. New AMI created in primary region (via Image Builder or manual)
2. EC2 emits "EC2 AMI State Change" event when AMI becomes available
3. EventBridge rule triggers `ami-replication-handler` Lambda
4. Lambda checks if AMI is managed by this application (via `ManagedBy` tag)
5. Lambda queries `regional-hubs` table for all `available` satellite regions
6. Lambda initiates `CopyImage` to each satellite region (encrypted)
7. Lambda updates `regional-hubs` table with AMI mapping (source -> target)
8. Lambda updates `amis` table with replication status

#### DynamoDB Updates

**regional-hubs table** - New `amis` field:
```javascript
{
  region: "us-west-2",
  // ... other fields
  amis: {
    "ami-source123": {
      targetAmiId: "ami-target456",
      amiType: "windows",
      amiName: "MRM-Windows-DCV-2026-02",
      replicatedAt: "2026-02-03T...",
      status: "pending" // or "available" once copy completes
    }
  }
}
```

**amis table** - New `replication` field:
```javascript
{
  amiId: "ami-source123",
  // ... other fields
  replication: {
    "us-west-2": {
      targetAmiId: "ami-target456",
      status: "pending",
      replicatedAt: "2026-02-03T..."
    },
    "eu-west-1": {
      targetAmiId: "ami-target789",
      status: "pending",
      replicatedAt: "2026-02-03T..."
    }
  }
}
```

#### EventBridge Rule

| Property | Value |
|----------|-------|
| Name | `{acronym}-ami-replication-trigger` |
| Source | `aws.ec2` |
| Detail Type | `EC2 AMI State Change` |
| Detail | `{ "state": ["available"] }` |

#### Note on AMI Copy Status

AMI copies are asynchronous. The Lambda initiates the copy and records `status: "pending"`. A future enhancement could add:
- EventBridge rule for AMI copy completion events
- Lambda to update status to "available" when copy completes
- Polling mechanism to check copy status

---

### Phase 5: Frontend - Regions Page ✅ COMPLETE

**Completed: February 3, 2026**

#### Files Created

| File | Description |
|------|-------------|
| `frontend/src/pages/RegionManagement.tsx` | Main Regions management page with table, create modal, and details panel |

#### Files Modified

| File | Changes |
|------|---------|
| `frontend/src/components/Navigation.tsx` | Added "Regions" link to admin navigation |
| `frontend/src/App.tsx` | Added route for `/regions` page |

#### UI Features Implemented

| Feature | Description |
|---------|-------------|
| Regional Hubs Table | Lists all regions with status, workstation count, platforms |
| Add Region Modal | Form to create new regional hub with validation |
| Delete Confirmation | Modal with warning before deleting regional hubs |
| Region Details Panel | Tabbed view showing overview, infrastructure, and AMIs |
| Status Badges | Color-coded badges for region status (Available, Creating, Failed, etc.) |
| Platform Badges | Shows enabled platforms (Windows, Linux, macOS) |

#### Form Fields (Add Region)

| Field | Type | Description |
|-------|------|-------------|
| Region | Select | Dropdown of available AWS regions |
| Display Name | Input | Auto-populated from region, editable |
| VPC CIDR | Input | CIDR block for regional VPC |
| Availability Zones | Input | Comma-separated AZ IDs |
| Public Subnet Mask | Number | Default: 28 |
| Private Subnet Mask | Number | Default: 24 |
| DCV Domain Name | Input | Optional custom domain |
| DCV Certificate ARN | Input | Optional ACM certificate |
| Enable Windows | Checkbox | Default: true |
| Enable Linux | Checkbox | Default: true |
| Enable macOS | Checkbox | Default: false |

#### Region Details Tabs

| Tab | Content |
|-----|---------|
| Overview | Region, display name, status, workstation count, VPC info, timestamps |
| Infrastructure | NLB DNS, security group, launch template, DCV endpoints, AZs |
| AMIs | Table of replicated AMIs with source/target IDs and status |

---

### Phase 6: Workstation Integration ✅ COMPLETE

**Completed: February 3, 2026**

#### Files Modified

| File | Changes |
|------|---------|
| `lambda/workstation-manager/index.js` | Added `region` parameter support, regional hub lookup, AMI mapping |
| `lambda/instance-create-windows/index.js` | Added cross-region EC2 client, regional config support |
| `lambda/instance-create-linux/index.js` | Added cross-region EC2 client, regional config support |
| `lambda/instance-create-macos/index.js` | Added cross-region EC2/ResourceGroups/LicenseManager clients, regional config support |
| `frontend/src/pages/WorkstationManagement.tsx` | Added region selector in create modal, region column in table |
| `lib/api-stack.ts` | Added `REGIONAL_HUBS_TABLE_NAME` env var and table permissions |

#### Workstation Creation Flow (with Region)

1. User selects region in create workstation modal (if satellite regions exist)
2. Frontend sends `region` parameter in POST /workstations
3. `workstation-manager` Lambda:
   - Looks up regional config from `regional-hubs` table
   - Validates hub status is `available`
   - Checks if AMI is replicated to target region
   - Passes regional config (VPC, subnets, launch template, regional AMI) to state machine
4. `instance-create-windows` Lambda:
   - Creates EC2 client for target region
   - Uses regional launch template and subnets
   - Uses replicated AMI ID if available
   - Tags instance with region
5. Workstation record stored with `region` field

#### Frontend Changes

| Feature | Description |
|---------|-------------|
| Region Selector | Dropdown in create modal (only shown if satellite regions exist) |
| Region Column | New column in workstations table showing region |
| Regional Hubs Fetch | Fetches available regions on page load |

#### Regional Config Passed to State Machine

```javascript
{
  region: "us-west-2",
  regionalConfig: {
    vpcId: "vpc-xxx",
    subnetIds: ["subnet-xxx", "subnet-yyy"],
    securityGroupId: "sg-xxx",
    launchTemplateId: "lt-xxx",
    regionalAmiId: "ami-regional-xxx"
  }
}
```

#### Notes

- Primary region workstations continue to work as before (no `region` parameter needed)
- Region selector only appears when satellite regions are available
- AMI replication status is checked before allowing workstation creation
- Cross-region EC2 operations use region-specific clients

---

### Phase 7: Cross-Region Operations ✅ COMPLETE

**Completed: February 3, 2026**

#### Files Modified

| File | Changes |
|------|---------|
| `lambda/hostname-set-linux/index.js` | Added `getSSMClient(region)` helper for cross-region SSM commands |
| `lambda/hostname-set-macos/index.js` | Added `getSSMClient(region)` helper for cross-region SSM commands |
| `lambda/hostname-set-windows/index.js` | Already updated in Phase 6 |
| `lambda/ssm-command-check-linux/index.js` | Added `getSSMClient(region)` helper for cross-region command status |
| `lambda/ssm-command-check-macos/index.js` | Added `getSSMClient(region)` helper for cross-region command status |
| `lambda/ssm-command-check-windows/index.py` | Added `get_ssm_client(region)` helper for cross-region command status |
| `lambda/autologin-configure/index.js` | Added `getSSMClient(region)` helper for cross-region SSM commands |
| `lambda/autologin-configure-linux/index.js` | Added `getSSMClient(region)` helper for cross-region SSM commands |
| `lambda/autologin-configure-macos/index.js` | Added `getSSMClient(region)` helper for cross-region SSM commands |
| `lambda/dcv-readiness-check-windows/index.py` | Added `get_dcv_endpoints(region)` for regional DCV Session Manager lookup |
| `lambda/dcv-readiness-check-linux/index.py` | Added `get_dcv_endpoints(region)` for regional DCV Session Manager lookup |
| `lambda/dcv-readiness-check-macos/index.py` | Added `get_dcv_endpoints(region)` for regional DCV Session Manager lookup |
| `lambda/workstation-manager/index.js` | Updated `deleteWorkstation` and `stopWorkstation` to use region-specific EC2 client |
| `lambda/dcv-session-manager/index.py` | Added regional gateway routing for DCV connections |

#### Cross-Region Pattern

All Lambdas that interact with EC2 or SSM now follow this pattern:

**JavaScript (SSM)**:
```javascript
function getSSMClient(region) {
    if (region && region !== process.env.AWS_REGION) {
        return new SSMClient({ region });
    }
    return new SSMClient();
}
```

**JavaScript (EC2)**:
```javascript
const ec2 = region && region !== process.env.AWS_REGION 
    ? new EC2Client({ region }) 
    : ec2Client;
```

**Python (SSM)**:
```python
def get_ssm_client(region=None):
    if region and region != os.environ.get('AWS_REGION'):
        return boto3.client('ssm', region_name=region)
    return boto3.client('ssm')
```

#### DCV Session Manager Regional Routing

The `dcv-session-manager` Lambda now:
1. Looks up workstation region from DynamoDB
2. If satellite region, fetches regional hub config for connection gateway endpoint
3. Constructs DCV URL using regional connection gateway instead of primary

```python
def get_regional_dcv_endpoints(region):
    """Get DCV endpoints for a satellite region from regional hub config."""
    if not region or region == os.environ.get('AWS_REGION'):
        return None  # Use primary region endpoints
    
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(os.environ.get('REGIONAL_HUBS_TABLE_NAME', 'regional-hubs'))
    response = table.get_item(Key={'region': region})
    
    if 'Item' in response:
        hub = response['Item']
        return {
            'session_manager_endpoint': hub.get('sessionManagerEndpoint'),
            'connection_gateway_endpoint': hub.get('connectionGatewayEndpoint'),
            'client_id': hub.get('dcvClientId'),
            'client_password': hub.get('dcvClientPassword')
        }
    return None
```

#### DCV Readiness Check Regional Support

The DCV readiness check Lambdas now:
1. Accept `region` parameter from state machine
2. Look up regional DCV Session Manager endpoint from regional hub config
3. Connect to regional Session Manager to verify DCV server registration

---

### Phase 8: Testing & Documentation ⏳ IN PROGRESS

#### Completed Tasks

- [x] Regional hub creation state machine
- [x] Regional hub deletion state machine
- [x] CloudFormation template with full DCV infrastructure
- [x] DCV Session Manager ASG with auto-registration
- [x] DCV Connection Gateway ASG with QUIC support
- [x] Regional cleanup Lambdas (session + server cleanup)
- [x] EC2 state handler for DynamoDB updates
- [x] DCV Status Sync Lambda (polls every 5 minutes)
- [x] Manual Cleanup Lambda (API-callable)
- [x] Cross-region Lambda operations (Phase 7)
- [x] Implementation documentation updated

#### Remaining Tasks

- [ ] Deploy and test regional hub creation end-to-end
- [ ] Test workstation creation in satellite region
- [ ] Test DCV connectivity to satellite region
- [ ] Test AMI replication
- [ ] Test regional hub deletion
- [ ] Add API endpoint for manual cleanup Lambda invocation
- [ ] Update user documentation

---

## Architecture Summary

### Components by Location

**Primary Region (Centralized)**
| Component | Description |
|-----------|-------------|
| DynamoDB Tables | workstation-instances, regional-hubs, amis |
| API Gateway | All REST endpoints |
| Cognito | Authentication |
| CloudFront + S3 | Frontend hosting |
| Step Functions | Workstation creation, regional hub management |
| Auto-Shutdown Lambda | Cross-region EC2 client for all regions |
| Image Builder | AMI creation (replicated to satellite regions) |
| macOS SIP Lambdas | Image Builder pipeline support |

**Satellite Regions (Per Regional Hub)**
| Component | Description |
|-----------|-------------|
| VPC | Regional network infrastructure |
| DCV Session Manager | ASG with internal NLB |
| DCV Connection Gateway | ASG with public NLB |
| Workstation Infrastructure | Security group, launch template, IAM role |
| DCV Session Cleanup Lambda | EventBridge-triggered on stop/terminate |
| DCV Server Cleanup Lambda | EventBridge-triggered on terminate |
| EC2 State Handler Lambda | Updates DynamoDB in primary region |
| DCV Status Sync Lambda | Polls Session Manager every 5 minutes |
| Manual Cleanup Lambda | API-callable for stale cleanup |
| EventBridge Rules | EC2 state changes, scheduled sync |

### Data Flow

```
User Request → CloudFront → API Gateway (Primary Region)
                                ↓
                         Lambda Functions
                                ↓
                    ┌──────────────────────┐
                    │   DynamoDB Tables    │
                    │   (Primary Region)   │
                    └──────────────────────┘
                                ↑
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
   EC2 State Handler    DCV Status Sync         Cleanup Lambdas
   (Satellite Region)   (Satellite Region)      (Satellite Region)
        │                       │                       │
        └───────────────────────┼───────────────────────┘
                                ↓
                    ┌──────────────────────┐
                    │  DCV Session Manager │
                    │  (Satellite Region)  │
                    └──────────────────────┘
```

---

## Deployment Notes

### Prerequisites

Before deploying regional hub changes:
1. Ensure primary region infrastructure is fully deployed
2. Have ACM certificates ready in target regions (if using custom domains)
3. Verify target region AZ capacity for required instance types

### Deployment Order

1. Deploy Infrastructure stack (creates `regional-hubs` table)
2. Deploy API stack (creates regional hub Lambda functions)
3. Deploy Regional Hub stack (creates state machines) - Phase 2
4. Deploy Frontend (includes Regions page) - Phase 5

### Testing Checklist

- [ ] List regions shows primary region
- [ ] Create regional hub validates inputs
- [ ] Create regional hub deploys CloudFormation (Phase 2)
- [ ] Regional hub status updates correctly
- [ ] Delete regional hub removes infrastructure
- [ ] Workstation creation works in satellite region (Phase 6)
- [ ] DCV connection works to satellite region (Phase 6)

---

## Cost Estimates

### Per Satellite Region (Monthly)

| Component | Instance Type | Estimated Cost |
|-----------|---------------|----------------|
| DCV Session Manager | m6g.large (ARM) | ~$56 |
| DCV Connection Gateway | c7g.large (ARM) | ~$59 |
| Session Manager NLB (Internal) | - | ~$20 + data |
| Connection Gateway NLB (Public) | - | ~$20 + data |
| NAT Gateway | - | ~$45 + data |
| Lambda Functions (5 regional) | - | ~$5 (minimal invocations) |
| S3 (NLB access logs) | - | ~$2 |
| **Subtotal** | | **~$207/month** |

### One-Time Costs

- AMI copies: ~$0.01/GB per region
- CloudFormation stack creation: Free
- S3 template storage: Negligible

### Lambda Functions in Regional Hub

| Function | Trigger | Estimated Invocations/Month |
|----------|---------|----------------------------|
| DCV Session Cleanup | EC2 stop/terminate | ~100-500 |
| DCV Server Cleanup | EC2 terminate | ~50-200 |
| EC2 State Handler | All EC2 state changes | ~500-2000 |
| DCV Status Sync | Every 5 minutes | ~8,640 |
| Manual Cleanup | API calls | ~10-50 |

---

## References

- [MULTI_REGION_DEPLOYMENT.md](./MULTI_REGION_DEPLOYMENT.md) - Full architecture design
- [STORAGE_FEATURE_DESIGN.md](./STORAGE_FEATURE_DESIGN.md) - Similar CloudFormation pattern used for FSx

---

## Regional Lambda Functions Detail

### DCV Session Cleanup Lambda

**Purpose**: Cleans up DCV sessions when EC2 instances are stopped or terminated.

**Trigger**: EventBridge rule on EC2 state changes (stopped, terminated)

**Flow**:
1. Receives EC2 state change event
2. Gets Session Manager credentials from SSM
3. Authenticates with Session Manager API (OAuth2)
4. Finds sessions associated with the instance IP
5. Deletes sessions via Session Manager API
6. Updates DynamoDB in primary region

### DCV Server Cleanup Lambda

**Purpose**: Removes DCV server registration when EC2 instances are terminated.

**Trigger**: EventBridge rule on EC2 terminate events

**Flow**:
1. Receives EC2 terminate event
2. Gets Session Manager credentials from SSM
3. Authenticates with Session Manager API
4. Finds server registration for the instance
5. Cleans up any remaining sessions on the server
6. Removes server from Session Manager
7. Updates DynamoDB in primary region

### EC2 State Handler Lambda

**Purpose**: Updates workstation status in DynamoDB when EC2 state changes.

**Trigger**: EventBridge rule on all EC2 state changes

**Flow**:
1. Receives EC2 state change event
2. Connects to DynamoDB in primary region
3. Updates workstation record with new state
4. Handles special cases (terminated removes session data)

### DCV Status Sync Lambda

**Purpose**: Polls Session Manager for connection status and syncs to DynamoDB.

**Trigger**: EventBridge scheduled rule (every 5 minutes)

**Flow**:
1. Gets Session Manager credentials from SSM
2. Authenticates with Session Manager API
3. Retrieves all servers and sessions
4. Scans DynamoDB for workstations in this region
5. Updates connection status (connectionCount, sessionState, lastDisconnectionTime)

**Fields Updated**:
- `connectionCount`: Number of active connections
- `sessionState`: DCV session state (READY, CREATING, etc.)
- `dcvSessionId`: DCV session ID
- `lastDisconnectionTime`: When user last disconnected

### Manual Cleanup Lambda

**Purpose**: API-callable function for cleaning up stale servers/sessions.

**Trigger**: API call (via Lambda invoke)

**Actions Supported**:
- `cleanup-stale`: Remove servers for terminated instances
- `cleanup-session`: Remove specific session by ID
- `list`: List all servers and sessions

**Use Cases**:
- Admin cleanup of orphaned DCV registrations
- Troubleshooting stale session issues
- Manual intervention when automated cleanup fails
