# Multi-Region Deployment Guide

This document outlines the architecture and implementation steps for deploying Media Resource Manager across multiple AWS regions, enabling workstation provisioning in regions closer to end users.

## Overview

Multi-region deployment allows you to:
- Provision workstations in regions geographically closer to users
- Reduce DCV streaming latency for better user experience
- Meet data residency requirements
- Provide regional redundancy

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           PRIMARY REGION (us-east-1)                            │
│                                                                                 │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────────┐   │
│  │  CloudFront │    │ API Gateway │    │   Lambda    │    │ Step Functions  │   │
│  │  + S3       │───▶│             │───▶│  Functions  │───▶│   Workflows     │   │
│  │  Frontend   │    │             │    │             │    │                 │   │
│  └─────────────┘    └─────────────┘    └──────┬──────┘    └─────────────────┘   │
│                                               │                                 │
│                                               ▼                                 │
│                     ┌─────────────────────────────────────────────────────┐     │
│                     │                    DynamoDB                         │     │
│                     │  ┌─────────────────────────────────────────────┐    │     │
│                     │  │ workstations table                          │    │     │
│                     │  │ { instanceId, region, vpcId, dcvEndpoint }  │    │     │
│                     │  └─────────────────────────────────────────────┘    │     │
│                     │  ┌─────────────────────────────────────────────┐    │     │
│                     │  │ regional-config table                       │    │     │
│                     │  │ { region, vpcId, subnetIds, sgId, dcvUrl }  │    │     │
│                     │  └─────────────────────────────────────────────┘    │     │
│                     └─────────────────────────────────────────────────────┘     │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                    DCV Infrastructure (for us-east-1 workstations)      │    │
│  │  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────┐  │    │
│  │  │ Session Manager │    │    Connection   │    │        NLB          │  │    │
│  │  │                 │◄──▶│     Gateway     │◄──▶│  dcv.us-east-1.com  │  │    │
│  │  └─────────────────┘    └─────────────────┘    └─────────────────────┘  │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                         VPC (us-east-1)                                 │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                      │    │
│  │  │ Workstation │  │ Workstation │  │ Workstation │                      │    │
│  │  │   (Win)     │  │   (Linux)   │  │   (macOS)   │                      │    │
│  │  └─────────────┘  └─────────────┘  └─────────────┘                      │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                    Lambda calls AWS APIs with region parameter
                                        │
         ┌──────────────────────────────┼──────────────────────────────┐
         │                              │                              │
         ▼                              ▼                              ▼
┌─────────────────────┐    ┌─────────────────────┐    ┌─────────────────────┐
│  SATELLITE REGION   │    │  SATELLITE REGION   │    │  SATELLITE REGION   │
│    (us-west-2)      │    │    (eu-west-1)      │    │   (ap-southeast-1)  │
│                     │    │                     │    │                     │
│ ┌─────────────────┐ │    │ ┌─────────────────┐ │    │ ┌─────────────────┐ │
│ │ DCV Session Mgr │ │    │ │ DCV Session Mgr │ │    │ │ DCV Session Mgr │ │
│ │ + Conn Gateway  │ │    │ │ + Conn Gateway  │ │    │ │ + Conn Gateway  │ │
│ │ + NLB           │ │    │ │ + NLB           │ │    │ │ + NLB           │ │
│ └─────────────────┘ │    │ └─────────────────┘ │    │ └─────────────────┘ │
│                     │    │                     │    │                     │
│ ┌─────────────────┐ │    │ ┌─────────────────┐ │    │ ┌─────────────────┐ │
│ │      VPC        │ │    │ │      VPC        │ │    │ │      VPC        │ │
│ │  Workstations   │ │    │ │  Workstations   │ │    │ │  Workstations   │ │
│ └─────────────────┘ │    │ └─────────────────┘ │    │ └─────────────────┘ │
└─────────────────────┘    └─────────────────────┘    └─────────────────────┘
```

## What Stays Centralized vs Regional

### Centralized (Primary Region Only)

| Component | Reason |
|-----------|--------|
| Frontend (CloudFront/S3) | Static content, globally distributed via CloudFront |
| API Gateway | Single API endpoint, Lambda handles regional routing |
| Lambda Functions | Can call AWS APIs in any region |
| Step Functions | Orchestrates Lambda, which operates cross-region |
| DynamoDB | Single source of truth (or Global Tables for HA) |
| Cognito/Auth | Authentication is region-agnostic |

### Regional (Per Satellite Region)

| Component | Reason |
|-----------|--------|
| DCV Session Manager | Must communicate with local EC2 instances |
| DCV Connection Gateway | Streaming traffic must be regional for low latency |
| Network Load Balancer | Entry point for DCV connections |
| VPC + Subnets | EC2 instances require regional networking |
| Security Groups | Regional resources |
| Launch Templates | Regional resources |
| AMIs | Must be copied to each region |

## Database Schema Changes

### Workstations Table

Add `region` field to track where each workstation is deployed:

```javascript
{
  instanceId: "i-0abc123def456",      // Partition key
  assignedUserId: "user-123",
  region: "us-west-2",                // NEW: Target region
  vpcId: "vpc-xxx",                   // Regional VPC
  subnetId: "subnet-xxx",             // Regional subnet
  securityGroupId: "sg-xxx",          // Regional security group
  dcvEndpoint: "dcv.us-west-2.company.com",  // Regional DCV gateway
  amiId: "ami-xxx",                   // Regional AMI
  instanceType: "g4dn.xlarge",
  status: "running",
  // ... other fields
}
```

### Regional Configuration Table (New)

Store per-region infrastructure details:

```javascript
{
  region: "us-west-2",                // Partition key
  enabled: true,
  displayName: "US West (Oregon)",
  vpcId: "vpc-xxx",
  subnetIds: ["subnet-a", "subnet-b"],
  securityGroupId: "sg-xxx",
  launchTemplateId: "lt-xxx",
  dcvSessionManagerEndpoint: "https://session-mgr.internal:8443",
  dcvConnectionGatewayEndpoint: "dcv.us-west-2.company.com",
  amis: {
    windows: "ami-win-xxx",
    linux: "ami-linux-xxx",
    macos: "ami-macos-xxx"
  }
}
```

## Implementation Steps

### Phase 1: Schema and API Updates

#### 1.1 Update DynamoDB Schema

Add `region` field to workstations table and create regional-config table:

```typescript
// lib/constructs/database-construct.ts

// Add regional config table
this.regionalConfigTable = new dynamodb.Table(this, 'RegionalConfigTable', {
  tableName: `${tablePrefix}-regional-config`,
  partitionKey: { name: 'region', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
});
```

#### 1.2 Update API to Accept Region Parameter

```typescript
// POST /workstations request body
{
  "amiId": "ami-xxx",
  "instanceType": "g4dn.xlarge",
  "assignedUserId": "user-123",
  "region": "us-west-2"  // NEW: Target region
}
```

#### 1.3 Update Lambda Functions for Cross-Region Calls

```javascript
// lambda/instance-create-windows/index.js

const { EC2Client, RunInstancesCommand } = require('@aws-sdk/client-ec2');
const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');

exports.handler = async (event) => {
  const { region, amiId, instanceType, assignedUserId } = event;
  
  // Get regional configuration
  const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION });
  const regionalConfig = await dynamodb.send(new GetItemCommand({
    TableName: process.env.REGIONAL_CONFIG_TABLE,
    Key: { region: { S: region } }
  }));
  
  const config = regionalConfig.Item;
  
  // Create EC2 client for TARGET region
  const ec2 = new EC2Client({ region: region });
  
  // Launch instance in target region
  const result = await ec2.send(new RunInstancesCommand({
    LaunchTemplate: { LaunchTemplateId: config.launchTemplateId.S },
    SubnetId: config.subnetIds.L[0].S,
    SecurityGroupIds: [config.securityGroupId.S],
    ImageId: amiId,
    InstanceType: instanceType,
    MinCount: 1,
    MaxCount: 1,
    TagSpecifications: [{
      ResourceType: 'instance',
      Tags: [
        { Key: 'AssignedUser', Value: assignedUserId },
        { Key: 'ManagedBy', Value: 'MediaResourceManager' }
      ]
    }]
  }));
  
  return {
    instanceId: result.Instances[0].InstanceId,
    region: region,
    // ... other fields
  };
};
```

#### 1.4 Update SSM Command Functions

```javascript
// lambda/ssm-readiness-check-windows/index.js

const { SSMClient, DescribeInstanceInformationCommand } = require('@aws-sdk/client-ssm');

exports.handler = async (event) => {
  const { instanceId, region } = event;
  
  // Create SSM client for target region
  const ssm = new SSMClient({ region: region });
  
  const result = await ssm.send(new DescribeInstanceInformationCommand({
    Filters: [{ Key: 'InstanceIds', Values: [instanceId] }]
  }));
  
  // ... rest of handler
};
```

### Phase 2: DCV Connection Routing

#### 2.1 Update DCV Session Manager Lambda

```javascript
// lambda/dcv-session-manager/index.py

import boto3
import os

def get_session_url(instance_id):
    # Get workstation details including region
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(os.environ['WORKSTATION_TABLE'])
    
    workstation = table.get_item(Key={'instanceId': instance_id})['Item']
    target_region = workstation['region']
    
    # Get regional DCV configuration
    config_table = dynamodb.Table(os.environ['REGIONAL_CONFIG_TABLE'])
    regional_config = config_table.get_item(Key={'region': target_region})['Item']
    
    # Get session token from regional Session Manager
    session_manager_endpoint = regional_config['dcvSessionManagerEndpoint']
    gateway_endpoint = regional_config['dcvConnectionGatewayEndpoint']
    
    # Call regional Session Manager to get token
    token = get_session_token(session_manager_endpoint, instance_id)
    
    # Return URL pointing to regional gateway
    return f"https://{gateway_endpoint}:8443/#session-token={token}"
```

#### 2.2 Frontend Region Display

Update the workstation list to show region:

```tsx
// frontend/src/pages/Workstations.tsx

<Table
  columnDefinitions={[
    { id: 'name', header: 'Name', cell: item => item.name },
    { id: 'region', header: 'Region', cell: item => (
      <Badge color={getRegionColor(item.region)}>
        {getRegionDisplayName(item.region)}
      </Badge>
    )},
    { id: 'status', header: 'Status', cell: item => item.status },
    // ... other columns
  ]}
/>
```

### Phase 3: Regional Infrastructure Stack

Create a separate CDK stack for satellite regions:

```typescript
// lib/regional-infrastructure-stack.ts

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

export interface RegionalInfrastructureStackProps extends cdk.StackProps {
  pascalCaseName: string;
  acronym: string;
  primaryRegion: string;
  vpcCidr?: string;
}

export class RegionalInfrastructureStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly dcvSecurityGroup: ec2.SecurityGroup;
  public readonly workstationSecurityGroup: ec2.SecurityGroup;
  public readonly connectionGatewayNlb: elbv2.NetworkLoadBalancer;

  constructor(scope: Construct, id: string, props: RegionalInfrastructureStackProps) {
    super(scope, id, props);

    // Create regional VPC
    this.vpc = new ec2.Vpc(this, 'RegionalVpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr || '10.2.0.0/16'),
      maxAzs: 2,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // Security groups
    this.workstationSecurityGroup = new ec2.SecurityGroup(this, 'WorkstationSG', {
      vpc: this.vpc,
      description: 'Security group for DCV workstations',
    });

    // Allow DCV traffic
    this.workstationSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(8443),
      'DCV HTTPS'
    );

    // DCV Connection Gateway and Session Manager
    // ... (similar to dcv-infrastructure-stack.ts)

    // Store regional config in primary region's DynamoDB
    // This would be done via a custom resource or separate process
  }
}
```

### Phase 4: Deployment Process

#### 4.1 Deploy Primary Region

```bash
# Deploy all stacks in primary region (us-east-1)
./deploy.sh
```

#### 4.2 Deploy Satellite Regions

```bash
# Deploy regional infrastructure to us-west-2
cdk deploy MRM-Regional-USWest2 \
  --context region=us-west-2 \
  --context primaryRegion=us-east-1

# Deploy regional infrastructure to eu-west-1
cdk deploy MRM-Regional-EUWest1 \
  --context region=eu-west-1 \
  --context primaryRegion=us-east-1
```

#### 4.3 Register Regional Configuration

After deploying satellite regions, register them in the primary region's DynamoDB:

```bash
# Register us-west-2 configuration
aws dynamodb put-item \
  --table-name mrm-regional-config \
  --item '{
    "region": {"S": "us-west-2"},
    "enabled": {"BOOL": true},
    "displayName": {"S": "US West (Oregon)"},
    "vpcId": {"S": "vpc-xxx"},
    "subnetIds": {"L": [{"S": "subnet-a"}, {"S": "subnet-b"}]},
    "securityGroupId": {"S": "sg-xxx"},
    "launchTemplateId": {"S": "lt-xxx"},
    "dcvSessionManagerEndpoint": {"S": "https://session-mgr.internal:8443"},
    "dcvConnectionGatewayEndpoint": {"S": "dcv.us-west-2.company.com"}
  }'
```

#### 4.4 Copy AMIs to Satellite Regions

```bash
# Copy Windows AMI to us-west-2
aws ec2 copy-image \
  --source-region us-east-1 \
  --source-image-id ami-xxx \
  --region us-west-2 \
  --name "MRM-Windows-DCV"

# Copy Linux AMI to us-west-2
aws ec2 copy-image \
  --source-region us-east-1 \
  --source-image-id ami-yyy \
  --region us-west-2 \
  --name "MRM-Linux-DCV"
```

## DNS Configuration

### Option 1: Per-Region Subdomains (Recommended)

```
dcv.us-east-1.company.com  → NLB in us-east-1
dcv.us-west-2.company.com  → NLB in us-west-2
dcv.eu-west-1.company.com  → NLB in eu-west-1
```

### Option 2: Single Domain with Route 53 Geolocation

Not recommended for DCV - the routing should be based on workstation location, not user location.

## IAM Considerations

Lambda functions need cross-region permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:RunInstances",
        "ec2:DescribeInstances",
        "ec2:TerminateInstances",
        "ec2:StartInstances",
        "ec2:StopInstances"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "aws:RequestedRegion": [
            "us-east-1",
            "us-west-2",
            "eu-west-1"
          ]
        }
      }
    },
    {
      "Effect": "Allow",
      "Action": [
        "ssm:SendCommand",
        "ssm:GetCommandInvocation",
        "ssm:DescribeInstanceInformation"
      ],
      "Resource": "*"
    }
  ]
}
```

## Cost Considerations

### Per Satellite Region

| Component | Instance Type | Estimated Monthly Cost |
|-----------|---------------|----------------------|
| DCV Session Manager | m6g.large (ARM) | ~$56 |
| DCV Connection Gateway | c7g.large (ARM) | ~$59 |
| Network Load Balancer | - | ~$20 + data |
| NAT Gateway | - | ~$45 + data |
| **Subtotal per region** | | **~$180/month + data transfer** |

**Note:** The application uses ARM-based Graviton instances (m6g, c7g) for better price-performance. These are ~20% cheaper than equivalent x86 instances.

### Data Transfer

- Cross-region API calls: Minimal (metadata only)
- DCV streaming: Stays within region (no cross-region charges)
- AMI copies: One-time cost per AMI per region

## Monitoring

### CloudWatch Metrics to Monitor

- Per-region workstation count
- Per-region DCV connection success rate
- Cross-region API latency
- Regional DCV gateway health

### Alarms

```bash
# Create alarm for regional gateway health
aws cloudwatch put-metric-alarm \
  --alarm-name "DCV-Gateway-USWest2-Health" \
  --metric-name "HealthyHostCount" \
  --namespace "AWS/NetworkELB" \
  --statistic "Average" \
  --period 60 \
  --threshold 1 \
  --comparison-operator "LessThanThreshold" \
  --dimensions Name=LoadBalancer,Value=net/dcv-gateway-uswest2/xxx \
  --evaluation-periods 2 \
  --alarm-actions arn:aws:sns:us-east-1:xxx:alerts
```

## Rollout Strategy

### Phase 1: Single Additional Region
1. Deploy satellite infrastructure to one region (e.g., us-west-2)
2. Update schema and Lambda functions
3. Test workstation creation and DCV connectivity
4. Monitor for issues

### Phase 2: Additional Regions
1. Deploy to additional regions as needed
2. Copy AMIs and register configurations
3. Update frontend region selector

### Phase 3: Optimization
1. Implement AMI replication automation
2. Add regional health dashboards
3. Consider DynamoDB Global Tables for HA

## Limitations

1. **Active Directory**: AWS Managed AD is regional. For domain-joined workstations across regions, you'd need AD in each region or use AD trusts.

2. **Step Functions**: State machine executions are regional. The central Step Functions can orchestrate cross-region Lambda calls, but execution history stays in the primary region.

3. **AMI Management**: AMIs must be copied to each region. Consider automating this with EventBridge rules on AMI creation.

4. **Latency**: Control plane operations (create, start, stop) go through the primary region. This adds ~50-100ms latency but doesn't affect DCV streaming.

## Future Enhancements

1. **Automatic Region Selection**: Suggest optimal region based on user location
2. **AMI Replication Pipeline**: Automatically copy new AMIs to all regions
3. **Regional Failover**: If a region's DCV infrastructure fails, redirect to nearest healthy region
4. **Cost Optimization**: Auto-scale DCV gateways based on regional demand


## Control Plane High Availability

The previous sections focused on multi-region workstation deployment with a single control plane. This section covers making the control plane itself highly available across regions.

### Architecture: Active-Active Control Plane

```
                                    ┌─────────────────────────┐
                                    │     Route 53 ARC        │
                                    │   (Application Recovery │
                                    │      Controller)        │
                                    └───────────┬─────────────┘
                                                │
                              Health checks + Routing control
                                                │
                    ┌───────────────────────────┼───────────────────────────┐
                    │                           │                           │
                    ▼                           ▼                           ▼
        ┌───────────────────┐       ┌───────────────────┐       ┌───────────────────┐
        │   us-east-1       │       │   us-west-2       │       │   eu-west-1       │
        │   (Primary)       │       │   (Secondary)     │       │   (Secondary)     │
        │                   │       │                   │       │                   │
        │ ┌───────────────┐ │       │ ┌───────────────┐ │       │ ┌───────────────┐ │
        │ │  CloudFront   │ │       │ │  CloudFront   │ │       │ │  CloudFront   │ │
        │ │  + S3 Bucket  │ │       │ │  + S3 Bucket  │ │       │ │  + S3 Bucket  │ │
        │ └───────────────┘ │       │ └───────────────┘ │       │ └───────────────┘ │
        │        │          │       │        │          │       │        │          │
        │        ▼          │       │        ▼          │       │        ▼          │
        │ ┌───────────────┐ │       │ ┌───────────────┐ │       │ ┌───────────────┐ │
        │ │ API Gateway   │ │       │ │ API Gateway   │ │       │ │ API Gateway   │ │
        │ │ + Lambda      │ │       │ │ + Lambda      │ │       │ │ + Lambda      │ │
        │ └───────────────┘ │       │ └───────────────┘ │       │ └───────────────┘ │
        │        │          │       │        │          │       │        │          │
        │        ▼          │       │        ▼          │       │        ▼          │
        │ ┌───────────────┐ │       │ ┌───────────────┐ │       │ ┌───────────────┐ │
        │ │  DynamoDB     │◄┼──────▶│ │  DynamoDB     │◄┼──────▶│ │  DynamoDB     │ │
        │ │ Global Table  │ │ Sync  │ │ Global Table  │ │ Sync  │ │ Global Table  │ │
        │ └───────────────┘ │       │ └───────────────┘ │       │ └───────────────┘ │
        │                   │       │                   │       │                   │
        │ ┌───────────────┐ │       │ ┌───────────────┐ │       │ ┌───────────────┐ │
        │ │ Cognito       │ │       │ │ Cognito       │ │       │ │ Cognito       │ │
        │ │ (Regional)    │ │       │ │ (Regional)    │ │       │ │ (Regional)    │ │
        │ └───────────────┘ │       │ └───────────────┘ │       │ └───────────────┘ │
        │                   │       │                   │       │                   │
        │ DCV Infra         │       │ DCV Infra         │       │ DCV Infra         │
        │ + Workstations    │       │ + Workstations    │       │ + Workstations    │
        └───────────────────┘       └───────────────────┘       └───────────────────┘
```

### Component-by-Component HA Strategy

#### 1. DynamoDB Global Tables

Convert all tables to Global Tables for automatic multi-region replication:

```typescript
// lib/constructs/database-construct.ts

import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

// Create table with Global Table replication
this.workstationTable = new dynamodb.Table(this, 'WorkstationsTable', {
  tableName: `${tablePrefix}-workstations`,
  partitionKey: { name: 'instanceId', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  replicationRegions: ['us-west-2', 'eu-west-1'],  // Replicate to these regions
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
});
```

**Considerations:**
- ~1 second replication lag (eventually consistent)
- Write conflicts resolved by "last writer wins" based on timestamp
- Additional cost: ~$0.725 per million write request units replicated

**Conflict Handling:**

For workstation status updates, use conditional writes to prevent conflicts:

```javascript
// Use conditional updates to prevent race conditions
await dynamodb.send(new UpdateItemCommand({
  TableName: 'workstations',
  Key: { instanceId: { S: instanceId } },
  UpdateExpression: 'SET #status = :newStatus, updatedAt = :now',
  ConditionExpression: 'updatedAt < :now',  // Only update if newer
  ExpressionAttributeNames: { '#status': 'status' },
  ExpressionAttributeValues: {
    ':newStatus': { S: 'running' },
    ':now': { S: new Date().toISOString() }
  }
}));
```

#### 2. S3 Cross-Region Replication

Replicate the frontend bucket to secondary regions:

```typescript
// lib/frontend-stack.ts

import * as s3 from 'aws-cdk-lib/aws-s3';

// Primary bucket
const primaryBucket = new s3.Bucket(this, 'WebsiteBucket', {
  bucketName: `${props.acronym.toLowerCase()}-frontend-${this.account}-${this.region}`,
  websiteIndexDocument: 'index.html',
  versioned: true,  // Required for replication
});

// Replication configuration (add via custom resource or console)
// Replicates to: s3://mrm-frontend-xxx-us-west-2
```

**Alternative: CloudFront with Origin Failover**

```typescript
// CloudFront with multiple origins and failover
const distribution = new cloudfront.Distribution(this, 'Distribution', {
  defaultBehavior: {
    origin: new origins.OriginGroup({
      primaryOrigin: new origins.S3Origin(primaryBucket),
      fallbackOrigin: new origins.S3Origin(secondaryBucket),
      fallbackStatusCodes: [500, 502, 503, 504],
    }),
  },
});
```

#### 3. API Gateway Multi-Region with Route 53

Deploy API Gateway in each region with Route 53 health checks:

```typescript
// Route 53 health check for API
const healthCheck = new route53.CfnHealthCheck(this, 'ApiHealthCheck', {
  healthCheckConfig: {
    type: 'HTTPS',
    fullyQualifiedDomainName: `api.${props.domainName}`,
    port: 443,
    resourcePath: '/health',
    requestInterval: 30,
    failureThreshold: 3,
  },
});

// Latency-based routing with health checks
new route53.ARecord(this, 'ApiRecord', {
  zone: hostedZone,
  recordName: 'api',
  target: route53.RecordTarget.fromAlias(
    new targets.ApiGateway(api)
  ),
  setIdentifier: 'us-east-1',
  region: 'us-east-1',
  healthCheck: healthCheck,
});
```

#### 4. Route 53 Application Recovery Controller (ARC)

For controlled failover with routing controls:

```typescript
// Route 53 ARC Cluster
const cluster = new route53recoverycontrol.CfnCluster(this, 'ArcCluster', {
  name: `${props.acronym}-recovery-cluster`,
});

// Control Panel
const controlPanel = new route53recoverycontrol.CfnControlPanel(this, 'ControlPanel', {
  name: `${props.acronym}-control-panel`,
  clusterArn: cluster.attrClusterArn,
});

// Routing Controls (one per region)
const usEast1Control = new route53recoverycontrol.CfnRoutingControl(this, 'UsEast1Control', {
  name: 'us-east-1-routing',
  clusterArn: cluster.attrClusterArn,
  controlPanelArn: controlPanel.attrControlPanelArn,
});

// Safety Rule - require at least one region active
const safetyRule = new route53recoverycontrol.CfnSafetyRule(this, 'AtLeastOneActive', {
  name: 'AtLeastOneRegionActive',
  controlPanelArn: controlPanel.attrControlPanelArn,
  assertionRule: {
    waitPeriodMs: 5000,
    assertedControls: [usEast1Control.attrRoutingControlArn, usWest2Control.attrRoutingControlArn],
  },
  ruleConfig: {
    type: 'ATLEAST',
    threshold: 1,
    inverted: false,
  },
});
```

**Manual Failover with ARC:**

```bash
# Disable us-east-1 (failover to us-west-2)
aws route53-recovery-cluster update-routing-control-state \
  --routing-control-arn arn:aws:route53-recovery-control::xxx:controlpanel/xxx/routingcontrol/us-east-1 \
  --routing-control-state Off \
  --safety-rules-to-override arn:aws:route53-recovery-control::xxx:controlpanel/xxx/safetyrule/xxx

# Re-enable us-east-1
aws route53-recovery-cluster update-routing-control-state \
  --routing-control-arn arn:aws:route53-recovery-control::xxx:controlpanel/xxx/routingcontrol/us-east-1 \
  --routing-control-state On
```

#### 5. Cognito Multi-Region

Cognito User Pools are regional and don't support native replication. Options:

**Option A: Regional User Pools with Shared IdP**

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ Cognito         │     │ Cognito         │     │ Cognito         │
│ us-east-1       │     │ us-west-2       │     │ eu-west-1       │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │   Shared SAML IdP       │
                    │   (Okta / Identity      │
                    │    Center)              │
                    └─────────────────────────┘
```

Each regional Cognito User Pool federates to the same SAML IdP. Users authenticate through the IdP, which works regardless of which regional Cognito they hit.

**Option B: JWT Validation Across Regions**

Store JWT signing keys in Secrets Manager with cross-region replication:

```typescript
// Replicate JWT secret to secondary regions
const jwtSecret = new secretsmanager.Secret(this, 'JwtSecret', {
  secretName: `/${props.pascalCaseName}/Auth/JwtSecret`,
  replicaRegions: [
    { region: 'us-west-2' },
    { region: 'eu-west-1' },
  ],
});
```

Lambda authorizers in any region can validate JWTs using the replicated secret.

#### 6. Step Functions

Step Functions are regional. Options for HA:

**Option A: Regional Step Functions with DynamoDB Coordination**

Deploy identical state machines in each region. Use DynamoDB to prevent duplicate executions:

```javascript
// Before starting execution, claim the work item
const claimed = await dynamodb.send(new UpdateItemCommand({
  TableName: 'workstations',
  Key: { instanceId: { S: instanceId } },
  UpdateExpression: 'SET processingRegion = :region, processingStarted = :now',
  ConditionExpression: 'attribute_not_exists(processingRegion) OR processingStarted < :stale',
  ExpressionAttributeValues: {
    ':region': { S: process.env.AWS_REGION },
    ':now': { S: new Date().toISOString() },
    ':stale': { S: new Date(Date.now() - 300000).toISOString() }  // 5 min stale
  }
}));
```

**Option B: Central Step Functions with Cross-Region Lambda**

Keep Step Functions in primary region only. If primary region fails, manually trigger workflows in secondary region.

### DNS Architecture

```
                         ┌─────────────────────────────────┐
                         │         Route 53                │
                         │                                 │
                         │  app.company.com                │
                         │  ├── Latency routing            │
                         │  │   + Health checks            │
                         │  │                              │
                         │  api.company.com                │
                         │  ├── Latency routing            │
                         │  │   + Health checks            │
                         │  │   + ARC routing controls     │
                         │  │                              │
                         │  dcv.us-east-1.company.com      │
                         │  dcv.us-west-2.company.com      │
                         │  dcv.eu-west-1.company.com      │
                         │  └── Regional (no failover)     │
                         └─────────────────────────────────┘
```

**Key Point:** DCV endpoints remain regional and don't failover. If us-east-1 DCV infrastructure fails, workstations in us-east-1 are inaccessible until recovered. The control plane failover ensures you can still manage workstations in other regions.

### Implementation Checklist

#### Phase 1: Data Layer HA

- [ ] Convert DynamoDB tables to Global Tables
- [ ] Enable S3 Cross-Region Replication for frontend bucket
- [ ] Replicate Secrets Manager secrets (JWT signing key)
- [ ] Test replication lag and conflict resolution

#### Phase 2: API Layer HA

- [ ] Deploy API Gateway + Lambda in secondary regions
- [ ] Configure Route 53 latency-based routing
- [ ] Add health check endpoints (`GET /health`)
- [ ] Test automatic failover

#### Phase 3: Frontend HA

- [ ] Deploy S3 buckets in secondary regions
- [ ] Configure CloudFront origin failover OR
- [ ] Configure Route 53 for frontend routing
- [ ] Update CORS for multi-region API endpoints

#### Phase 4: Authentication HA

- [ ] Deploy Cognito User Pools in secondary regions
- [ ] Configure same SAML IdP federation in each
- [ ] Test authentication in each region

#### Phase 5: Controlled Failover

- [ ] Set up Route 53 ARC cluster and control panel
- [ ] Create routing controls for each region
- [ ] Define safety rules
- [ ] Document and test failover procedures

### Cost Impact

| Component | Additional Monthly Cost |
|-----------|------------------------|
| DynamoDB Global Tables (3 regions) | ~$50-100 (depends on write volume) |
| S3 Cross-Region Replication | ~$5-10 (small frontend) |
| API Gateway (per region) | ~$3.50 per million requests |
| Lambda (per region) | Pay per invocation |
| Route 53 Health Checks | $0.50 per health check |
| Route 53 ARC | $2.50/hr per cluster (~$1,800/mo) |
| Secrets Manager Replication | $0.40 per secret per region |
| **Total Additional** | **~$100-200/mo** (without ARC) |
| **Total with ARC** | **~$1,900-2,000/mo** |

**Note:** Route 53 ARC is expensive ($1,800/mo). For many use cases, standard Route 53 health checks with latency routing provide sufficient HA at much lower cost.

### Recovery Time Objectives

| Failure Scenario | Without HA | With HA (Health Checks) | With HA (ARC) |
|-----------------|------------|------------------------|---------------|
| Single AZ failure | Automatic (multi-AZ) | Automatic | Automatic |
| Regional API failure | Manual intervention | ~60-90 seconds | ~30 seconds |
| Regional DynamoDB failure | Manual intervention | Automatic (Global Tables) | Automatic |
| Regional S3 failure | Manual intervention | ~60-90 seconds | ~30 seconds |
| Complete region failure | Hours | ~2-3 minutes | ~1 minute |

### Limitations

1. **DCV Streaming**: Cannot failover DCV connections. If a region's DCV infrastructure fails, workstations in that region are inaccessible until recovered.

2. **In-Flight Operations**: Step Function executions in a failed region won't automatically resume in another region. May need manual intervention.

3. **Cognito Sessions**: Users may need to re-authenticate when failing over to a different regional Cognito User Pool.

4. **Cost**: Full active-active with ARC is expensive. Consider active-passive for cost savings.

### Recommended Approach by Use Case

| Use Case | Recommendation |
|----------|---------------|
| Dev/Test | Single region, no HA |
| Production (cost-sensitive) | DynamoDB Global Tables + Route 53 health checks |
| Production (enterprise) | Full active-active with ARC |
| Compliance (data residency) | Regional deployments with no cross-region replication |


---

## Regional Hub Self-Service Architecture

This section describes a self-service approach for adding satellite regions through the Settings UI, using CloudFormation templates deployed via Step Functions - similar to the FSx storage provisioning pattern.

### Overview

Instead of hardcoding regions in `parameters.json` or requiring CDK deployments for each new region, administrators can add regions dynamically through the Settings page. This approach:

- Enables self-service region expansion without CLI/CDK access
- Tracks all regional deployments in DynamoDB for auditability
- Uses consistent CloudFormation templates for all regions
- Supports easy teardown by deleting the CloudFormation stack
- Scales to any number of regions as capacity needs change

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        PRIMARY REGION (us-east-1)                           │
│                                                                             │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────────┐  │
│  │  Settings Page  │───▶│  API Gateway    │───▶│  Regional Hub Manager   │  │
│  │  "Add Region"   │    │  POST /regions  │    │  State Machine          │  │
│  │  Form           │    │                 │    │                         │  │
│  └─────────────────┘    └─────────────────┘    └───────────┬─────────────┘  │
│                                                            │                │
│                                                            ▼                │
│                                               ┌─────────────────────────┐   │
│                                               │ Generate Regional Hub   │   │
│                                               │ CloudFormation Template │   │
│                                               └───────────┬─────────────┘   │
│                                                           │                 │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    DynamoDB: regional-hubs                          │    │
│  │  { region, status, vpcCidr, dcvEndpoint, stackName, ... }           │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                        │
                    CloudFormation CreateStack (cross-region via Lambda)
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      SATELLITE REGION (us-west-2)                           │
│                                                                             │
│  CloudFormation Stack: MRM-Regional-Hub-usw2                                │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Resources Created:                                                 │    │
│  │  • VPC + Subnets (public/private across specified AZs)              │    │
│  │  • NAT Gateway, Internet Gateway, Route Tables                      │    │
│  │  • DCV Session Manager ASG                                          │    │
│  │  • DCV Connection Gateway ASG                                       │    │
│  │  • Network Load Balancer                                            │    │
│  │  • Security Groups                                                  │    │
│  │  • Launch Templates                                                 │    │
│  │  • SSM Documents (for workstation configuration)                    │    │
│  │  • EventBridge Rule (AMI replication trigger)                       │    │
│  │  • SSM Parameters (regional config)                                 │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```


### Database Schema

#### Regional Hubs Table

A new DynamoDB table to track satellite region deployments:

```javascript
{
  region: "us-west-2",                              // Partition key
  status: "available",                              // creating | available | updating | deleting | failed
  displayName: "US West (Oregon)",
  
  // Network Configuration
  vpcId: "vpc-xxx",
  vpcCidr: "10.100.0.0/22",
  availabilityZones: ["usw2-az1", "usw2-az2", "usw2-az3"],
  publicSubnetIds: ["subnet-pub-a", "subnet-pub-b", "subnet-pub-c"],
  privateSubnetIds: ["subnet-priv-a", "subnet-priv-b", "subnet-priv-c"],
  
  // DCV Infrastructure
  dcvConnectionGatewayEndpoint: "dcv-usw2.portal.tegna.com",
  dcvSessionManagerEndpoint: "https://internal-nlb:8443",
  nlbDnsName: "xxx.elb.us-west-2.amazonaws.com",
  nlbArn: "arn:aws:elasticloadbalancing:us-west-2:xxx:loadbalancer/net/xxx",
  
  // Workstation Resources
  workstationSecurityGroupId: "sg-xxx",
  launchTemplateId: "lt-xxx",
  instanceProfileArn: "arn:aws:iam::xxx:instance-profile/xxx",
  
  // CloudFormation
  cloudFormationStackName: "MRM-Regional-Hub-usw2",
  cloudFormationStackId: "arn:aws:cloudformation:us-west-2:xxx:stack/xxx",
  
  // Platform Support
  enableWindows: true,
  enableLinux: true,
  enableMacOS: true,
  macOSHostResourceGroupArn: "arn:aws:resource-groups:us-west-2:xxx:group/xxx",
  
  // AMI Tracking
  amis: {
    windows: { amiId: "ami-win-xxx", lastCopied: "2026-02-02T..." },
    linux: { amiId: "ami-linux-xxx", lastCopied: "2026-02-02T..." },
    macos: { amiId: "ami-macos-xxx", lastCopied: "2026-02-02T..." }
  },
  
  // Metadata
  createdAt: "2026-02-02T20:00:00.000Z",
  updatedAt: "2026-02-02T20:30:00.000Z",
  createdBy: "admin@company.com",
  errorMessage: null
}
```


### Settings Page Form

#### Add Region Form Fields

```typescript
interface RegionalHubConfig {
  // Required Fields
  region: string;                    // AWS region code (e.g., "us-west-2")
  displayName: string;               // Human-readable name (e.g., "US West (Oregon)")
  vpcCidr: string;                   // VPC CIDR block (e.g., "10.100.0.0/22")
  availabilityZones: string[];       // Target AZs (e.g., ["usw2-az1", "usw2-az2", "usw2-az3"])
  
  // Network Configuration
  publicSubnetMask: number;          // Subnet mask for public subnets (default: 28)
  privateSubnetMask: number;         // Subnet mask for private subnets (default: 24)
  
  // DCV Configuration
  dcvDomainName?: string;            // Custom domain (e.g., "dcv-usw2.portal.tegna.com")
  dcvCertificateArn?: string;        // ACM certificate ARN in target region
  
  // Platform Support
  enableWindows: boolean;            // Deploy Windows workstation support
  enableLinux: boolean;              // Deploy Linux workstation support
  enableMacOS: boolean;              // Deploy macOS workstation support (requires Dedicated Hosts)
}
```

#### Form Validation Rules

1. **Region**: Must be a valid AWS region not already deployed
2. **VPC CIDR**: Must not overlap with primary region or other satellite regions
3. **Availability Zones**: Must be valid AZs in the target region with capacity for required instance types
4. **Subnet Masks**: Must fit within VPC CIDR with room for all AZs
5. **Certificate ARN**: If provided, must be a valid ACM certificate in the target region


### State Machine Design

#### Regional Hub Creation State Machine

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Regional Hub Creation State Machine                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────┐                                                    │
│  │ UpdateStatusTo      │                                                    │
│  │ Validating          │                                                    │
│  └──────────┬──────────┘                                                    │
│             │                                                               │
│             ▼                                                               │
│  ┌─────────────────────┐     ┌─────────────────────┐                        │
│  │ ValidateRegion      │────▶│ PrepareFailure      │──────┐                 │
│  │ Availability        │ err │ FromValidation      │      │                 │
│  └──────────┬──────────┘     └─────────────────────┘      │                 │
│             │ ok                                          │                 │
│             ▼                                             │                 │
│  ┌─────────────────────┐     ┌─────────────────────┐      │                 │
│  │ GenerateRegionalHub │────▶│ PrepareFailure      │──────┤                 │
│  │ Template (Lambda)   │ err │ FromTemplate        │      │                 │
│  └──────────┬──────────┘     └─────────────────────┘      │                 │
│             │ ok                                          │                 │
│             ▼                                             │                 │
│  ┌─────────────────────┐                                  │                 │
│  │ UploadTemplateTo    │                                  │                 │
│  │ S3 (for large       │                                  │                 │
│  │ templates)          │                                  │                 │
│  └──────────┬──────────┘                                  │                 │
│             │                                             │                 │
│             ▼                                             │                 │
│  ┌─────────────────────┐                                  │                 │
│  │ UpdateStatusTo      │                                  │                 │
│  │ Creating            │                                  │                 │
│  └──────────┬──────────┘                                  │                 │
│             │                                             │                 │
│             ▼                                             │                 │
│  ┌─────────────────────┐     ┌─────────────────────┐      │                 │
│  │ CreateCFNStack      │────▶│ PrepareFailure      │──────┤                 │
│  │ (Cross-Region       │ err │ FromCFN             │      │                 │
│  │  Lambda)            │     └─────────────────────┘      │                 │
│  └──────────┬──────────┘                                  │                 │
│             │ ok                                          │                 │
│             ▼                                             │                 │
│  ┌─────────────────────┐                                  │                 │
│  │ WaitForStack        │◀─────────────────────┐           │                 │
│  │ Creation (60s)      │                      │           │                 │
│  └──────────┬──────────┘                      │           │                 │
│             │                                 │           │                 │
│             ▼                                 │           │                 │
│  ┌─────────────────────┐                      │           │                 │
│  │ CheckStackStatus    │                      │           │                 │
│  │ (Cross-Region       │                      │           │                 │
│  │  Lambda)            │                      │           │                 │
│  └──────────┬──────────┘                      │           │                 │
│             │                                 │           │                 │
│             ▼                                 │           │                 │
│  ┌─────────────────────┐                      │           │                 │
│  │ EvaluateStack       │                      │           │                 │
│  │ Status              │                      │           │                 │
│  │ ┌─────────────────┐ │                      │           │                 │
│  │ │CREATE_COMPLETE  │─┼──────────────────────┼───────────┼──┐              │
│  │ │*_IN_PROGRESS    │─┼──────────────────────┘           │  │              │
│  │ │*_FAILED         │─┼─────────────────────────────────▶│  │              │
│  │ │ROLLBACK_*       │─┼─────────────────────────────────▶│  │              │
│  │ └─────────────────┘ │                                  │  │              │
│  └─────────────────────┘                                  │  │              │
│                                                           │  │              │
│             ┌─────────────────────────────────────────────┘  │              │
│             │                                                │              │
│             ▼                                                │              │
│  ┌─────────────────────┐                                     │              │
│  │ UpdateStatusTo      │                                     │              │
│  │ Failed              │                                     │              │
│  └──────────┬──────────┘                                     │              │
│             │                                                │              │
│             ▼                                                │              │
│         [END]                                                │              │
│                                                              │              │
│             ┌────────────────────────────────────────────────┘              │
│             │                                                               │
│             ▼                                                               │
│  ┌─────────────────────┐                                                    │
│  │ ExtractStackOutputs │                                                    │
│  │ (Cross-Region       │                                                    │
│  │  Lambda)            │                                                    │
│  └──────────┬──────────┘                                                    │
│             │                                                               │
│             ▼                                                               │
│  ┌─────────────────────┐                                                    │
│  │ StoreRegionalConfig │                                                    │
│  │ (Update DynamoDB    │                                                    │
│  │  with outputs)      │                                                    │
│  └──────────┬──────────┘                                                    │
│             │                                                               │
│             ▼                                                               │
│  ┌─────────────────────┐                                                    │
│  │ TriggerAMI          │                                                    │
│  │ Replication         │                                                    │
│  │ (Lambda)            │                                                    │
│  └──────────┬──────────┘                                                    │
│             │                                                               │
│             ▼                                                               │
│  ┌─────────────────────┐                                                    │
│  │ UpdateStatusTo      │                                                    │
│  │ Available           │                                                    │
│  └──────────┬──────────┘                                                    │
│             │                                                               │
│             ▼                                                               │
│         [END]                                                               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```


#### State Machine Definition (JSON)

```json
{
  "Comment": "Regional Hub Creation State Machine",
  "StartAt": "UpdateStatusToValidating",
  "States": {
    "UpdateStatusToValidating": {
      "Type": "Task",
      "Resource": "arn:aws:states:::dynamodb:updateItem",
      "Parameters": {
        "TableName": "${RegionalHubsTable}",
        "Key": { "region": { "S.$": "$.region" } },
        "UpdateExpression": "SET #status = :status, #updatedAt = :updatedAt",
        "ExpressionAttributeNames": { "#status": "status", "#updatedAt": "updatedAt" },
        "ExpressionAttributeValues": {
          ":status": { "S": "validating" },
          ":updatedAt": { "S.$": "$$.State.EnteredTime" }
        }
      },
      "ResultPath": null,
      "Next": "ValidateRegionAvailability"
    },
    "ValidateRegionAvailability": {
      "Type": "Task",
      "Resource": "${ValidateRegionFunctionArn}",
      "ResultPath": "$.validation",
      "Next": "GenerateRegionalHubTemplate",
      "Catch": [{ "ErrorEquals": ["States.ALL"], "Next": "PrepareFailure", "ResultPath": "$.error" }]
    },
    "GenerateRegionalHubTemplate": {
      "Type": "Task",
      "Resource": "${GenerateRegionalHubTemplateFunctionArn}",
      "ResultPath": "$.templateData",
      "Next": "UploadTemplateToS3",
      "Catch": [{ "ErrorEquals": ["States.ALL"], "Next": "PrepareFailure", "ResultPath": "$.error" }]
    },
    "UploadTemplateToS3": {
      "Type": "Task",
      "Resource": "${UploadTemplateToS3FunctionArn}",
      "ResultPath": "$.templateUrl",
      "Next": "UpdateStatusToCreating",
      "Catch": [{ "ErrorEquals": ["States.ALL"], "Next": "PrepareFailure", "ResultPath": "$.error" }]
    },
    "UpdateStatusToCreating": {
      "Type": "Task",
      "Resource": "arn:aws:states:::dynamodb:updateItem",
      "Parameters": {
        "TableName": "${RegionalHubsTable}",
        "Key": { "region": { "S.$": "$.region" } },
        "UpdateExpression": "SET #status = :status, cloudFormationStackName = :stackName, #updatedAt = :updatedAt",
        "ExpressionAttributeNames": { "#status": "status", "#updatedAt": "updatedAt" },
        "ExpressionAttributeValues": {
          ":status": { "S": "creating" },
          ":stackName": { "S.$": "$.templateData.stackName" },
          ":updatedAt": { "S.$": "$$.State.EnteredTime" }
        }
      },
      "ResultPath": null,
      "Next": "CreateCloudFormationStack"
    },
    "CreateCloudFormationStack": {
      "Type": "Task",
      "Resource": "${CreateCrossRegionStackFunctionArn}",
      "ResultPath": "$.stackId",
      "Next": "WaitForStackCreation",
      "Catch": [{ "ErrorEquals": ["States.ALL"], "Next": "PrepareFailure", "ResultPath": "$.error" }]
    },
    "WaitForStackCreation": {
      "Type": "Wait",
      "Seconds": 60,
      "Next": "CheckStackStatus"
    },
    "CheckStackStatus": {
      "Type": "Task",
      "Resource": "${CheckCrossRegionStackStatusFunctionArn}",
      "ResultPath": "$.stackStatus",
      "Next": "EvaluateStackStatus",
      "Catch": [{ "ErrorEquals": ["States.ALL"], "Next": "PrepareFailure", "ResultPath": "$.error" }]
    },
    "EvaluateStackStatus": {
      "Type": "Choice",
      "Choices": [
        { "Variable": "$.stackStatus.status", "StringEquals": "CREATE_COMPLETE", "Next": "ExtractStackOutputs" },
        { "Variable": "$.stackStatus.status", "StringMatches": "*_IN_PROGRESS", "Next": "WaitForStackCreation" },
        { "Variable": "$.stackStatus.status", "StringMatches": "*_FAILED", "Next": "PrepareFailure" },
        { "Variable": "$.stackStatus.status", "StringEquals": "ROLLBACK_COMPLETE", "Next": "PrepareFailure" }
      ],
      "Default": "PrepareFailure"
    },
    "ExtractStackOutputs": {
      "Type": "Task",
      "Resource": "${ExtractStackOutputsFunctionArn}",
      "ResultPath": "$.outputs",
      "Next": "StoreRegionalConfig"
    },
    "StoreRegionalConfig": {
      "Type": "Task",
      "Resource": "arn:aws:states:::dynamodb:updateItem",
      "Parameters": {
        "TableName": "${RegionalHubsTable}",
        "Key": { "region": { "S.$": "$.region" } },
        "UpdateExpression": "SET vpcId = :vpcId, nlbDnsName = :nlbDns, workstationSecurityGroupId = :sgId, launchTemplateId = :ltId, dcvSessionManagerEndpoint = :smEndpoint, #updatedAt = :updatedAt",
        "ExpressionAttributeNames": { "#updatedAt": "updatedAt" },
        "ExpressionAttributeValues": {
          ":vpcId": { "S.$": "$.outputs.vpcId" },
          ":nlbDns": { "S.$": "$.outputs.nlbDnsName" },
          ":sgId": { "S.$": "$.outputs.workstationSecurityGroupId" },
          ":ltId": { "S.$": "$.outputs.launchTemplateId" },
          ":smEndpoint": { "S.$": "$.outputs.sessionManagerEndpoint" },
          ":updatedAt": { "S.$": "$$.State.EnteredTime" }
        }
      },
      "ResultPath": null,
      "Next": "TriggerAMIReplication"
    },
    "TriggerAMIReplication": {
      "Type": "Task",
      "Resource": "${TriggerAMIReplicationFunctionArn}",
      "ResultPath": "$.amiReplication",
      "Next": "UpdateStatusToAvailable"
    },
    "UpdateStatusToAvailable": {
      "Type": "Task",
      "Resource": "arn:aws:states:::dynamodb:updateItem",
      "Parameters": {
        "TableName": "${RegionalHubsTable}",
        "Key": { "region": { "S.$": "$.region" } },
        "UpdateExpression": "SET #status = :status, #updatedAt = :updatedAt",
        "ExpressionAttributeNames": { "#status": "status", "#updatedAt": "updatedAt" },
        "ExpressionAttributeValues": {
          ":status": { "S": "available" },
          ":updatedAt": { "S.$": "$$.State.EnteredTime" }
        }
      },
      "End": true
    },
    "PrepareFailure": {
      "Type": "Pass",
      "Parameters": {
        "region.$": "$.region",
        "errorMessage.$": "States.Format('Error: {}', $.error.Cause)"
      },
      "Next": "UpdateStatusToFailed"
    },
    "UpdateStatusToFailed": {
      "Type": "Task",
      "Resource": "arn:aws:states:::dynamodb:updateItem",
      "Parameters": {
        "TableName": "${RegionalHubsTable}",
        "Key": { "region": { "S.$": "$.region" } },
        "UpdateExpression": "SET #status = :status, errorMessage = :error, #updatedAt = :updatedAt",
        "ExpressionAttributeNames": { "#status": "status", "#updatedAt": "updatedAt" },
        "ExpressionAttributeValues": {
          ":status": { "S": "failed" },
          ":error": { "S.$": "$.errorMessage" },
          ":updatedAt": { "S.$": "$$.State.EnteredTime" }
        }
      },
      "End": true
    }
  }
}
```


### Lambda Functions

#### 1. Validate Region Availability

Validates that the target region exists and specified AZs have capacity for required instance types.

```javascript
// lambda/validate-region/index.js
const { EC2Client, DescribeAvailabilityZonesCommand, DescribeInstanceTypeOfferingsCommand } = require('@aws-sdk/client-ec2');

exports.handler = async (event) => {
  const { region, availabilityZones, enableMacOS, enableWindows, enableLinux } = event;
  
  // Create EC2 client for target region
  const ec2 = new EC2Client({ region });
  
  // Validate AZs exist
  const azResult = await ec2.send(new DescribeAvailabilityZonesCommand({
    Filters: [{ Name: 'zone-id', Values: availabilityZones }]
  }));
  
  if (azResult.AvailabilityZones.length !== availabilityZones.length) {
    throw new Error(`Invalid availability zones for region ${region}`);
  }
  
  // Check instance type availability if macOS enabled
  if (enableMacOS) {
    const macResult = await ec2.send(new DescribeInstanceTypeOfferingsCommand({
      LocationType: 'availability-zone-id',
      Filters: [
        { Name: 'instance-type', Values: ['mac2-m2.metal', 'mac2.metal'] },
        { Name: 'location', Values: availabilityZones }
      ]
    }));
    
    if (macResult.InstanceTypeOfferings.length === 0) {
      throw new Error(`No Mac instance types available in specified AZs for ${region}`);
    }
  }
  
  return { valid: true, region, availabilityZones };
};
```

#### 2. Generate Regional Hub Template

Generates the CloudFormation template for the satellite region infrastructure.

```javascript
// lambda/generate-regional-hub-template/index.js

exports.handler = async (event) => {
  const { 
    region, displayName, vpcCidr, availabilityZones,
    publicSubnetMask, privateSubnetMask,
    dcvDomainName, dcvCertificateArn,
    enableWindows, enableLinux, enableMacOS
  } = event;
  
  const productName = process.env.PRODUCT_NAME;
  const acronym = process.env.ACRONYM;
  const stackName = `${acronym}-Regional-Hub-${region.replace(/-/g, '')}`;
  
  const template = generateTemplate({
    region, displayName, vpcCidr, availabilityZones,
    publicSubnetMask, privateSubnetMask,
    dcvDomainName, dcvCertificateArn,
    enableWindows, enableLinux, enableMacOS,
    productName, acronym
  });
  
  return {
    stackName,
    template: JSON.stringify(template),
    region
  };
};

function generateTemplate(config) {
  // Template structure - see "CloudFormation Template Structure" section below
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: `Regional Hub for ${config.displayName} - ${config.region}`,
    // ... full template
  };
}
```

#### 3. Cross-Region CloudFormation Operations

Since Step Functions SDK integrations don't support cross-region calls directly, Lambda functions handle CloudFormation operations in the target region.

```javascript
// lambda/create-cross-region-stack/index.js
const { CloudFormationClient, CreateStackCommand } = require('@aws-sdk/client-cloudformation');

exports.handler = async (event) => {
  const { region, stackName, templateUrl, parameters } = event;
  
  // Create CloudFormation client for TARGET region
  const cfn = new CloudFormationClient({ region });
  
  const result = await cfn.send(new CreateStackCommand({
    StackName: stackName,
    TemplateURL: templateUrl,  // S3 URL for large templates
    Parameters: parameters,
    Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
    Tags: [
      { Key: 'ManagedBy', Value: process.env.PRODUCT_NAME },
      { Key: 'Purpose', Value: 'Regional-Hub' }
    ]
  }));
  
  return { stackId: result.StackId };
};
```

```javascript
// lambda/check-cross-region-stack-status/index.js
const { CloudFormationClient, DescribeStacksCommand } = require('@aws-sdk/client-cloudformation');

exports.handler = async (event) => {
  const { region, stackName } = event.templateData;
  
  const cfn = new CloudFormationClient({ region });
  
  const result = await cfn.send(new DescribeStacksCommand({
    StackName: stackName
  }));
  
  const stack = result.Stacks[0];
  
  return {
    status: stack.StackStatus,
    statusReason: stack.StackStatusReason,
    outputs: stack.Outputs
  };
};
```

#### 4. AMI Replication Trigger

Copies AMIs from the primary region to the new satellite region.

```javascript
// lambda/trigger-ami-replication/index.js
const { EC2Client, CopyImageCommand } = require('@aws-sdk/client-ec2');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

exports.handler = async (event) => {
  const { region } = event;
  const sourceRegion = process.env.AWS_REGION;
  
  // Get all active AMIs from primary region
  const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const amis = await dynamodb.send(new ScanCommand({
    TableName: process.env.AMI_TABLE_NAME,
    FilterExpression: '#status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':status': 'available' }
  }));
  
  const ec2Target = new EC2Client({ region });
  const results = [];
  
  for (const ami of amis.Items) {
    try {
      const copyResult = await ec2Target.send(new CopyImageCommand({
        SourceRegion: sourceRegion,
        SourceImageId: ami.amiId,
        Name: `${ami.name}-${region}`,
        Description: `Copy of ${ami.amiId} from ${sourceRegion}`
      }));
      
      results.push({
        sourceAmiId: ami.amiId,
        targetAmiId: copyResult.ImageId,
        platform: ami.platform,
        status: 'copying'
      });
    } catch (error) {
      console.error(`Failed to copy AMI ${ami.amiId}:`, error);
      results.push({
        sourceAmiId: ami.amiId,
        error: error.message
      });
    }
  }
  
  return { region, amiCopies: results };
};
```


### CloudFormation Template Structure

The regional hub CloudFormation template creates all infrastructure needed for workstation deployment in the satellite region.

#### Template Resources

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Description: Regional Hub Infrastructure

Parameters:
  ProductName:
    Type: String
  Acronym:
    Type: String
  VpcCidr:
    Type: String
  AvailabilityZones:
    Type: CommaDelimitedList
  PublicSubnetMask:
    Type: Number
  PrivateSubnetMask:
    Type: Number
  DcvDomainName:
    Type: String
  DcvCertificateArn:
    Type: String
  EnableMacOS:
    Type: String
    AllowedValues: ['true', 'false']

Resources:
  # ============================================
  # NETWORKING
  # ============================================
  
  VPC:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: !Ref VpcCidr
      EnableDnsHostnames: true
      EnableDnsSupport: true
      Tags:
        - Key: Name
          Value: !Sub '${Acronym}-Regional-VPC'

  InternetGateway:
    Type: AWS::EC2::InternetGateway

  InternetGatewayAttachment:
    Type: AWS::EC2::VPCGatewayAttachment
    Properties:
      VpcId: !Ref VPC
      InternetGatewayId: !Ref InternetGateway

  # Public Subnets (one per AZ)
  PublicSubnet1:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref VPC
      AvailabilityZone: !Select [0, !Ref AvailabilityZones]
      CidrBlock: !Select [0, !Cidr [!Ref VpcCidr, 6, !Ref PublicSubnetMask]]
      MapPublicIpOnLaunch: true
      Tags:
        - Key: Name
          Value: !Sub '${Acronym}-Public-1'

  # Private Subnets (one per AZ)
  PrivateSubnet1:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref VPC
      AvailabilityZone: !Select [0, !Ref AvailabilityZones]
      CidrBlock: !Select [3, !Cidr [!Ref VpcCidr, 6, !Ref PrivateSubnetMask]]
      Tags:
        - Key: Name
          Value: !Sub '${Acronym}-Private-1'

  # NAT Gateway
  NatGatewayEIP:
    Type: AWS::EC2::EIP
    Properties:
      Domain: vpc

  NatGateway:
    Type: AWS::EC2::NatGateway
    Properties:
      AllocationId: !GetAtt NatGatewayEIP.AllocationId
      SubnetId: !Ref PublicSubnet1

  # Route Tables
  PublicRouteTable:
    Type: AWS::EC2::RouteTable
    Properties:
      VpcId: !Ref VPC

  PublicRoute:
    Type: AWS::EC2::Route
    Properties:
      RouteTableId: !Ref PublicRouteTable
      DestinationCidrBlock: 0.0.0.0/0
      GatewayId: !Ref InternetGateway

  PrivateRouteTable:
    Type: AWS::EC2::RouteTable
    Properties:
      VpcId: !Ref VPC

  PrivateRoute:
    Type: AWS::EC2::Route
    Properties:
      RouteTableId: !Ref PrivateRouteTable
      DestinationCidrBlock: 0.0.0.0/0
      NatGatewayId: !Ref NatGateway

  # ============================================
  # SECURITY GROUPS
  # ============================================

  SessionManagerSecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: DCV Session Manager Security Group
      VpcId: !Ref VPC
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 8443
          ToPort: 8447
          SourceSecurityGroupId: !Ref ConnectionGatewaySecurityGroup

  ConnectionGatewaySecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: DCV Connection Gateway Security Group
      VpcId: !Ref VPC
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 8443
          ToPort: 8443
          CidrIp: 0.0.0.0/0
        - IpProtocol: udp
          FromPort: 8443
          ToPort: 8443
          CidrIp: 0.0.0.0/0

  WorkstationSecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: DCV Workstation Security Group
      VpcId: !Ref VPC
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 8443
          ToPort: 8443
          SourceSecurityGroupId: !Ref ConnectionGatewaySecurityGroup

  # ============================================
  # DCV SESSION MANAGER
  # ============================================

  SessionManagerLaunchTemplate:
    Type: AWS::EC2::LaunchTemplate
    Properties:
      LaunchTemplateData:
        ImageId: !Sub '{{resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64}}'
        InstanceType: m6g.large
        SecurityGroupIds:
          - !Ref SessionManagerSecurityGroup
        UserData:
          Fn::Base64: !Sub |
            #!/bin/bash
            # Install DCV Session Manager
            # ... installation script

  SessionManagerASG:
    Type: AWS::AutoScaling::AutoScalingGroup
    Properties:
      LaunchTemplate:
        LaunchTemplateId: !Ref SessionManagerLaunchTemplate
        Version: !GetAtt SessionManagerLaunchTemplate.LatestVersionNumber
      MinSize: 1
      MaxSize: 2
      DesiredCapacity: 1
      VPCZoneIdentifier:
        - !Ref PrivateSubnet1

  # ============================================
  # DCV CONNECTION GATEWAY
  # ============================================

  ConnectionGatewayLaunchTemplate:
    Type: AWS::EC2::LaunchTemplate
    Properties:
      LaunchTemplateData:
        ImageId: !Sub '{{resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64}}'
        InstanceType: c7g.large
        SecurityGroupIds:
          - !Ref ConnectionGatewaySecurityGroup
        UserData:
          Fn::Base64: !Sub |
            #!/bin/bash
            # Install DCV Connection Gateway
            # ... installation script

  ConnectionGatewayASG:
    Type: AWS::AutoScaling::AutoScalingGroup
    Properties:
      LaunchTemplate:
        LaunchTemplateId: !Ref ConnectionGatewayLaunchTemplate
        Version: !GetAtt ConnectionGatewayLaunchTemplate.LatestVersionNumber
      MinSize: 1
      MaxSize: 3
      DesiredCapacity: 1
      VPCZoneIdentifier:
        - !Ref PublicSubnet1
      TargetGroupARNs:
        - !Ref ConnectionGatewayTargetGroup

  # ============================================
  # NETWORK LOAD BALANCER
  # ============================================

  NetworkLoadBalancer:
    Type: AWS::ElasticLoadBalancingV2::LoadBalancer
    Properties:
      Type: network
      Scheme: internet-facing
      Subnets:
        - !Ref PublicSubnet1

  ConnectionGatewayTargetGroup:
    Type: AWS::ElasticLoadBalancingV2::TargetGroup
    Properties:
      Port: 8443
      Protocol: TCP
      VpcId: !Ref VPC
      TargetType: instance

  NLBListener:
    Type: AWS::ElasticLoadBalancingV2::Listener
    Properties:
      LoadBalancerArn: !Ref NetworkLoadBalancer
      Port: 8443
      Protocol: TLS
      Certificates:
        - CertificateArn: !Ref DcvCertificateArn
      DefaultActions:
        - Type: forward
          TargetGroupArn: !Ref ConnectionGatewayTargetGroup

  # ============================================
  # SSM PARAMETERS (Regional Config)
  # ============================================

  VpcIdParameter:
    Type: AWS::SSM::Parameter
    Properties:
      Name: !Sub '/${ProductName}/Regional/${AWS::Region}/VpcId'
      Type: String
      Value: !Ref VPC

  WorkstationSGParameter:
    Type: AWS::SSM::Parameter
    Properties:
      Name: !Sub '/${ProductName}/Regional/${AWS::Region}/WorkstationSecurityGroupId'
      Type: String
      Value: !Ref WorkstationSecurityGroup

  SessionManagerEndpointParameter:
    Type: AWS::SSM::Parameter
    Properties:
      Name: !Sub '/${ProductName}/Regional/${AWS::Region}/SessionManagerEndpoint'
      Type: String
      Value: !Sub 'https://${SessionManagerNLB.DNSName}:8443'

  # ============================================
  # MACOS DEDICATED HOST (Conditional)
  # ============================================

  MacOSHostResourceGroup:
    Type: AWS::ResourceGroups::Group
    Condition: EnableMacOSCondition
    Properties:
      Name: !Sub '${Acronym}-MacOS-Hosts'
      Configuration:
        - Type: AWS::EC2::HostManagement
          Parameters:
            - Name: allowed-host-families
              Values: ['mac2']
            - Name: auto-allocate-host
              Values: ['true']
            - Name: auto-release-host
              Values: ['true']

Conditions:
  EnableMacOSCondition: !Equals [!Ref EnableMacOS, 'true']

Outputs:
  VpcId:
    Value: !Ref VPC
  WorkstationSecurityGroupId:
    Value: !Ref WorkstationSecurityGroup
  NLBDnsName:
    Value: !GetAtt NetworkLoadBalancer.DNSName
  SessionManagerEndpoint:
    Value: !Sub 'https://${SessionManagerNLB.DNSName}:8443'
  LaunchTemplateId:
    Value: !Ref WorkstationLaunchTemplate
```


### API Endpoints

#### POST /regions - Create Regional Hub

```javascript
// Request
POST /regions
{
  "region": "us-west-2",
  "displayName": "US West (Oregon)",
  "vpcCidr": "10.100.0.0/22",
  "availabilityZones": ["usw2-az1", "usw2-az2", "usw2-az3"],
  "publicSubnetMask": 28,
  "privateSubnetMask": 24,
  "dcvDomainName": "dcv-usw2.portal.tegna.com",
  "dcvCertificateArn": "arn:aws:acm:us-west-2:xxx:certificate/xxx",
  "enableWindows": true,
  "enableLinux": true,
  "enableMacOS": true
}

// Response
{
  "success": true,
  "data": {
    "region": "us-west-2",
    "status": "creating",
    "executionArn": "arn:aws:states:us-east-1:xxx:execution:xxx"
  }
}
```

#### GET /regions - List Regional Hubs

```javascript
// Response
{
  "success": true,
  "data": [
    {
      "region": "us-east-1",
      "displayName": "US East (N. Virginia)",
      "status": "available",
      "isPrimary": true,
      "dcvEndpoint": "dcv.portal.tegna.com"
    },
    {
      "region": "us-west-2",
      "displayName": "US West (Oregon)",
      "status": "available",
      "isPrimary": false,
      "dcvEndpoint": "dcv-usw2.portal.tegna.com",
      "workstationCount": 5
    }
  ]
}
```

#### GET /regions/{region} - Get Regional Hub Details

```javascript
// Response
{
  "success": true,
  "data": {
    "region": "us-west-2",
    "displayName": "US West (Oregon)",
    "status": "available",
    "vpcId": "vpc-xxx",
    "vpcCidr": "10.100.0.0/22",
    "availabilityZones": ["usw2-az1", "usw2-az2", "usw2-az3"],
    "dcvEndpoint": "dcv-usw2.portal.tegna.com",
    "nlbDnsName": "xxx.elb.us-west-2.amazonaws.com",
    "workstationSecurityGroupId": "sg-xxx",
    "amis": {
      "windows": { "amiId": "ami-xxx", "status": "available" },
      "linux": { "amiId": "ami-xxx", "status": "available" },
      "macos": { "amiId": "ami-xxx", "status": "copying" }
    },
    "workstationCount": 5,
    "createdAt": "2026-02-02T20:00:00.000Z"
  }
}
```

#### DELETE /regions/{region} - Delete Regional Hub

```javascript
// Response
{
  "success": true,
  "data": {
    "region": "us-west-2",
    "status": "deleting",
    "executionArn": "arn:aws:states:us-east-1:xxx:execution:xxx"
  }
}
```

### Frontend Integration

#### Workstation Creation - Region Selection

Update the workstation creation form to include region selection:

```tsx
// frontend/src/pages/Workstations.tsx

const [regions, setRegions] = useState<RegionalHub[]>([]);
const [selectedRegion, setSelectedRegion] = useState<string>('');

// Fetch available regions
useEffect(() => {
  const fetchRegions = async () => {
    const response = await api.get('/regions');
    const availableRegions = response.data.filter(r => r.status === 'available');
    setRegions(availableRegions);
    if (availableRegions.length > 0) {
      setSelectedRegion(availableRegions[0].region);
    }
  };
  fetchRegions();
}, []);

// In the form
<FormField label="Deployment Region">
  <Select
    selectedOption={{ value: selectedRegion, label: regions.find(r => r.region === selectedRegion)?.displayName }}
    options={regions.map(r => ({
      value: r.region,
      label: r.displayName,
      description: `${r.workstationCount || 0} workstations`
    }))}
    onChange={({ detail }) => setSelectedRegion(detail.selectedOption.value)}
  />
</FormField>
```

#### Settings Page - Regional Hub Management

```tsx
// frontend/src/pages/Settings.tsx - Regional Hubs Tab

<Tabs>
  <Tab label="Regional Hubs">
    <SpaceBetween size="l">
      <Header
        actions={
          <Button onClick={() => setShowAddRegionModal(true)}>
            Add Region
          </Button>
        }
      >
        Regional Hubs
      </Header>
      
      <Table
        items={regionalHubs}
        columnDefinitions={[
          { id: 'region', header: 'Region', cell: item => item.region },
          { id: 'displayName', header: 'Name', cell: item => item.displayName },
          { id: 'status', header: 'Status', cell: item => (
            <StatusIndicator type={getStatusType(item.status)}>
              {item.status}
            </StatusIndicator>
          )},
          { id: 'dcvEndpoint', header: 'DCV Endpoint', cell: item => item.dcvEndpoint },
          { id: 'workstations', header: 'Workstations', cell: item => item.workstationCount || 0 },
          { id: 'actions', header: 'Actions', cell: item => (
            <Button 
              disabled={item.isPrimary || item.workstationCount > 0}
              onClick={() => handleDeleteRegion(item.region)}
            >
              Delete
            </Button>
          )}
        ]}
      />
    </SpaceBetween>
  </Tab>
</Tabs>
```


### AMI Replication Automation

#### EventBridge Rule for Automatic AMI Replication

When a new AMI is created in the primary region, automatically copy it to all satellite regions.

```javascript
// lambda/ami-replication-handler/index.js
const { EC2Client, CopyImageCommand } = require('@aws-sdk/client-ec2');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

exports.handler = async (event) => {
  console.log('AMI Replication Event:', JSON.stringify(event, null, 2));
  
  const { amiId, name, platform } = event.detail;
  const sourceRegion = process.env.AWS_REGION;
  
  // Get all available satellite regions
  const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const regions = await dynamodb.send(new ScanCommand({
    TableName: process.env.REGIONAL_HUBS_TABLE,
    FilterExpression: '#status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':status': 'available' }
  }));
  
  const results = [];
  
  for (const region of regions.Items) {
    if (region.region === sourceRegion) continue; // Skip primary region
    
    try {
      const ec2 = new EC2Client({ region: region.region });
      const copyResult = await ec2.send(new CopyImageCommand({
        SourceRegion: sourceRegion,
        SourceImageId: amiId,
        Name: `${name}-${region.region}`,
        Description: `Replicated from ${sourceRegion}`
      }));
      
      // Update regional hub with new AMI
      await dynamodb.send(new UpdateCommand({
        TableName: process.env.REGIONAL_HUBS_TABLE,
        Key: { region: region.region },
        UpdateExpression: 'SET amis.#platform = :ami',
        ExpressionAttributeNames: { '#platform': platform },
        ExpressionAttributeValues: {
          ':ami': {
            amiId: copyResult.ImageId,
            sourceAmiId: amiId,
            status: 'copying',
            lastCopied: new Date().toISOString()
          }
        }
      }));
      
      results.push({ region: region.region, targetAmiId: copyResult.ImageId, status: 'copying' });
    } catch (error) {
      console.error(`Failed to copy AMI to ${region.region}:`, error);
      results.push({ region: region.region, error: error.message });
    }
  }
  
  return { sourceAmiId: amiId, replications: results };
};
```

#### EventBridge Rule Definition

```typescript
// In regional-hub-stack.ts

// EventBridge rule to trigger AMI replication when new AMI is registered
const amiReplicationRule = new events.Rule(this, 'AMIReplicationRule', {
  ruleName: `${props.acronym}-AMI-Replication`,
  eventPattern: {
    source: ['custom.mrm'],
    detailType: ['AMI Created']
  },
  targets: [new targets.LambdaFunction(amiReplicationHandler)]
});
```

### Regional Hub Deletion State Machine

```json
{
  "Comment": "Regional Hub Deletion State Machine",
  "StartAt": "ValidateDeletion",
  "States": {
    "ValidateDeletion": {
      "Type": "Task",
      "Resource": "${ValidateDeletionFunctionArn}",
      "Comment": "Check no workstations exist in region",
      "ResultPath": "$.validation",
      "Next": "UpdateStatusToDeleting",
      "Catch": [{ "ErrorEquals": ["States.ALL"], "Next": "DeletionFailed", "ResultPath": "$.error" }]
    },
    "UpdateStatusToDeleting": {
      "Type": "Task",
      "Resource": "arn:aws:states:::dynamodb:updateItem",
      "Parameters": {
        "TableName": "${RegionalHubsTable}",
        "Key": { "region": { "S.$": "$.region" } },
        "UpdateExpression": "SET #status = :status",
        "ExpressionAttributeNames": { "#status": "status" },
        "ExpressionAttributeValues": { ":status": { "S": "deleting" } }
      },
      "ResultPath": null,
      "Next": "DeleteCloudFormationStack"
    },
    "DeleteCloudFormationStack": {
      "Type": "Task",
      "Resource": "${DeleteCrossRegionStackFunctionArn}",
      "ResultPath": null,
      "Next": "WaitForStackDeletion"
    },
    "WaitForStackDeletion": {
      "Type": "Wait",
      "Seconds": 60,
      "Next": "CheckStackDeletionStatus"
    },
    "CheckStackDeletionStatus": {
      "Type": "Task",
      "Resource": "${CheckCrossRegionStackStatusFunctionArn}",
      "ResultPath": "$.stackStatus",
      "Next": "EvaluateDeletionStatus",
      "Catch": [
        {
          "ErrorEquals": ["CloudFormation.ValidationException"],
          "Comment": "Stack doesn't exist = deletion complete",
          "Next": "DeleteDynamoDBRecord"
        }
      ]
    },
    "EvaluateDeletionStatus": {
      "Type": "Choice",
      "Choices": [
        { "Variable": "$.stackStatus.status", "StringEquals": "DELETE_COMPLETE", "Next": "DeleteDynamoDBRecord" },
        { "Variable": "$.stackStatus.status", "StringMatches": "*_IN_PROGRESS", "Next": "WaitForStackDeletion" },
        { "Variable": "$.stackStatus.status", "StringMatches": "*_FAILED", "Next": "DeletionFailed" }
      ],
      "Default": "DeletionFailed"
    },
    "DeleteDynamoDBRecord": {
      "Type": "Task",
      "Resource": "arn:aws:states:::dynamodb:deleteItem",
      "Parameters": {
        "TableName": "${RegionalHubsTable}",
        "Key": { "region": { "S.$": "$.region" } }
      },
      "End": true
    },
    "DeletionFailed": {
      "Type": "Task",
      "Resource": "arn:aws:states:::dynamodb:updateItem",
      "Parameters": {
        "TableName": "${RegionalHubsTable}",
        "Key": { "region": { "S.$": "$.region" } },
        "UpdateExpression": "SET #status = :status, errorMessage = :error",
        "ExpressionAttributeNames": { "#status": "status" },
        "ExpressionAttributeValues": {
          ":status": { "S": "delete-failed" },
          ":error": { "S.$": "$.error.Cause" }
        }
      },
      "End": true
    }
  }
}
```


### Implementation Checklist

#### Phase 1: Database & API Foundation (3-4 days)

- [ ] Create `regional-hubs` DynamoDB table in database-construct.ts
- [ ] Add regional hub API endpoints to api-stack.ts:
  - [ ] POST /regions - Create regional hub
  - [ ] GET /regions - List regional hubs
  - [ ] GET /regions/{region} - Get regional hub details
  - [ ] DELETE /regions/{region} - Delete regional hub
- [ ] Create Lambda functions:
  - [ ] `create-regional-hub` - Initiates creation
  - [ ] `list-regional-hubs` - Lists all hubs
  - [ ] `get-regional-hub` - Gets hub details
  - [ ] `delete-regional-hub` - Initiates deletion

#### Phase 2: Template Generation (2-3 days)

- [ ] Create `generate-regional-hub-template` Lambda
- [ ] Define CloudFormation template structure:
  - [ ] VPC and networking resources
  - [ ] DCV Session Manager ASG
  - [ ] DCV Connection Gateway ASG
  - [ ] Network Load Balancer
  - [ ] Security Groups
  - [ ] SSM Parameters
  - [ ] macOS Host Resource Group (conditional)
- [ ] Create `upload-template-to-s3` Lambda for large templates

#### Phase 3: Cross-Region Operations (2-3 days)

- [ ] Create `validate-region` Lambda
- [ ] Create `create-cross-region-stack` Lambda
- [ ] Create `check-cross-region-stack-status` Lambda
- [ ] Create `extract-stack-outputs` Lambda
- [ ] Create `delete-cross-region-stack` Lambda
- [ ] Configure IAM permissions for cross-region operations

#### Phase 4: State Machines (2-3 days)

- [ ] Create Regional Hub Creation State Machine
- [ ] Create Regional Hub Deletion State Machine
- [ ] Add state machine permissions
- [ ] Test state machine execution

#### Phase 5: AMI Replication (1-2 days)

- [ ] Create `trigger-ami-replication` Lambda
- [ ] Create `ami-replication-handler` Lambda
- [ ] Create EventBridge rule for AMI creation events
- [ ] Test AMI replication flow

#### Phase 6: Frontend Integration (2-3 days)

- [ ] Add "Regional Hubs" tab to Settings page
- [ ] Create "Add Region" modal form
- [ ] Add region selector to workstation creation form
- [ ] Display region in workstation list
- [ ] Add regional hub status indicators

#### Phase 7: Workstation Updates (2-3 days)

- [ ] Update workstation-api to accept region parameter
- [ ] Update workstation creation state machines for cross-region
- [ ] Update DCV session manager Lambda for regional routing
- [ ] Update workstation table schema with region field

#### Phase 8: Testing & Documentation (3-5 days)

- [ ] Test regional hub creation end-to-end
- [ ] Test workstation creation in satellite region
- [ ] Test DCV connectivity to satellite region
- [ ] Test AMI replication
- [ ] Test regional hub deletion
- [ ] Update user documentation

### Estimated Total Effort

| Phase | Effort |
|-------|--------|
| Phase 1: Database & API | 3-4 days |
| Phase 2: Template Generation | 2-3 days |
| Phase 3: Cross-Region Operations | 2-3 days |
| Phase 4: State Machines | 2-3 days |
| Phase 5: AMI Replication | 1-2 days |
| Phase 6: Frontend Integration | 2-3 days |
| Phase 7: Workstation Updates | 2-3 days |
| Phase 8: Testing & Documentation | 3-5 days |
| **Total** | **~3-4 weeks** |

### Cost Considerations

#### Per Satellite Region (Monthly)

| Component | Instance Type | Estimated Cost |
|-----------|---------------|----------------|
| DCV Session Manager | m6g.large (ARM) | ~$56 |
| DCV Connection Gateway | c7g.large (ARM) | ~$59 |
| Network Load Balancer | - | ~$20 + data |
| NAT Gateway | - | ~$45 + data |
| **Subtotal** | | **~$180/month** |

#### One-Time Costs

- AMI copies: ~$0.01/GB per region
- CloudFormation stack creation: Free
- S3 template storage: Negligible

### Security Considerations

1. **Cross-Region IAM**: Lambda functions need permissions to call CloudFormation, EC2, and SSM APIs in target regions
2. **VPC CIDR Planning**: Ensure no overlap between regional VPCs if VPC peering is needed later
3. **Certificate Management**: ACM certificates must be created in each target region
4. **Secrets Replication**: Consider replicating secrets (JWT signing key, AD credentials) to satellite regions

### Limitations

1. **Template Size**: CloudFormation templates > 51,200 bytes must be uploaded to S3
2. **Stack Creation Time**: Regional hub creation takes 15-30 minutes
3. **AMI Copy Time**: Large AMIs may take 30+ minutes to copy across regions
4. **macOS Dedicated Hosts**: 24-hour minimum allocation period applies per region
