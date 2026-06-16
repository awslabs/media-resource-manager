// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand, CreateBucketCommand, PutBucketEncryptionCommand, PutPublicAccessBlockCommand } = require('@aws-sdk/client-s3');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
const fs = require('fs');
const path = require('path');

// Import SSM document content for regional deployment
// These are symlinked from ssm-documents/ folder
const windowsDcvInstallContent = require('./ssm-documents/windows-dcv-install');
const windowsDisableCtrlAltDelContent = require('./ssm-documents/windows-disable-ctrl-alt-del');
const windowsSetupFsxSchedulerContent = require('./ssm-documents/windows-setup-fsx-scheduler');
const windowsAutoLoginConfigureContent = require('./ssm-documents/windows-autologin-configure');
const linuxPhase1BaseInstallContent = require('./ssm-documents/linux-phase1-base-install');
const linuxPhase2GpuSetupContent = require('./ssm-documents/linux-phase2-gpu-setup');
const linuxPhase3StartServicesContent = require('./ssm-documents/linux-phase3-start-services');
const macosPhase1ConfigureDcvContent = require('./ssm-documents/macos-phase1-configure-dcv');
const macosPhase2AutoLoginContent = require('./ssm-documents/macos-phase2-auto-login');

// Load user data scripts from files (symlinked from user-data/ folder)
const sessionManagerInstallScript = fs.readFileSync(path.join(__dirname, 'user-data/session-manager-install.sh'), 'utf8');
const connectionGatewayInstallScript = fs.readFileSync(path.join(__dirname, 'user-data/connection-gateway-install.sh'), 'utf8');

const s3 = new S3Client({});
const ssm = new SSMClient({});
const sts = new STSClient({});

/**
 * Sanitize AWS resource names to meet length constraints
 * @param {string} name - The proposed resource name
 * @param {number} maxLength - Maximum allowed length (default 32 for NLB/TG)
 * @param {string} suffix - Required suffix to preserve (e.g., '-nlb', '-tg')
 * @returns {string} - Sanitized name within length limit
 */
function sanitizeResourceName(name, maxLength = 32, suffix = '') {
  if (name.length <= maxLength) {
    return name;
  }
  
  // If there's a suffix to preserve, truncate the prefix part
  if (suffix && name.endsWith(suffix)) {
    const prefixMaxLength = maxLength - suffix.length;
    const prefix = name.slice(0, -suffix.length);
    return prefix.slice(0, prefixMaxLength) + suffix;
  }
  
  // Otherwise just truncate
  return name.slice(0, maxLength);
}

/**
 * Generate a safe NLB name (max 32 characters)
 * @param {string} acronym - Product acronym (e.g., 'acem')
 * @param {string} purpose - NLB purpose (e.g., 'session-mgr', 'conn-gw')
 * @returns {string} - Safe NLB name
 */
function generateNlbName(acronym, purpose) {
  const name = `${acronym.toLowerCase()}-reg-${purpose}-nlb`;
  return sanitizeResourceName(name, 32, '-nlb');
}

/**
 * Generate a safe Target Group name (max 32 characters)
 * @param {string} acronym - Product acronym (e.g., 'acem')
 * @param {string} purpose - Target group purpose (e.g., 'sm-agent', 'cg-tcp')
 * @returns {string} - Safe target group name
 */
function generateTargetGroupName(acronym, purpose) {
  const name = `${acronym.toLowerCase()}-reg-${purpose}-tg`;
  return sanitizeResourceName(name, 32, '-tg');
}

// Cache account ID to avoid repeated STS calls
let cachedAccountId = null;
async function getAccountId() {
  if (!cachedAccountId) {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    cachedAccountId = identity.Account;
  }
  return cachedAccountId;
}

// Copy Lambda assets from source bucket (us-east-1) to target region bucket
// Returns the regional bucket name and keys for each Lambda
async function copyLambdaAssetsToRegion(lambdaAssets, targetRegion, acronym, accountId) {
  const regionalBucketName = `${acronym.toLowerCase()}-lambda-assets-${accountId}-${targetRegion}`;
  const regionalS3 = new S3Client({ region: targetRegion });
  
  // Ensure regional bucket exists
  try {
    await regionalS3.send(new HeadBucketCommand({ Bucket: regionalBucketName }));
    console.log(`Regional bucket ${regionalBucketName} already exists`);
  } catch (error) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      console.log(`Creating regional bucket ${regionalBucketName}`);
      
      // Create bucket (LocationConstraint not needed for us-east-1)
      const createParams = { Bucket: regionalBucketName };
      if (targetRegion !== 'us-east-1') {
        createParams.CreateBucketConfiguration = { LocationConstraint: targetRegion };
      }
      await regionalS3.send(new CreateBucketCommand(createParams));
      
      // Enable encryption
      await regionalS3.send(new PutBucketEncryptionCommand({
        Bucket: regionalBucketName,
        ServerSideEncryptionConfiguration: {
          Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }]
        }
      }));
      
      // Block public access
      await regionalS3.send(new PutPublicAccessBlockCommand({
        Bucket: regionalBucketName,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true
        }
      }));
      
      console.log(`Created and configured regional bucket ${regionalBucketName}`);
    } else {
      throw error;
    }
  }
  
  // Copy each Lambda asset to the regional bucket
  const regionalAssets = {};
  for (const [name, asset] of Object.entries(lambdaAssets)) {
    if (!asset.bucket || !asset.key) {
      console.log(`Skipping ${name} - no bucket/key configured`);
      continue;
    }
    
    try {
      // Read from source bucket (us-east-1)
      const getResponse = await s3.send(new GetObjectCommand({
        Bucket: asset.bucket,
        Key: asset.key
      }));
      
      // Convert stream to buffer
      const chunks = [];
      for await (const chunk of getResponse.Body) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      
      // Write to regional bucket
      const regionalKey = `lambda/${name}/${asset.key.split('/').pop()}`;
      await regionalS3.send(new PutObjectCommand({
        Bucket: regionalBucketName,
        Key: regionalKey,
        Body: body,
        ContentType: 'application/zip'
      }));
      
      regionalAssets[name] = {
        bucket: regionalBucketName,
        key: regionalKey
      };
      
      console.log(`Copied ${name} to ${regionalBucketName}/${regionalKey}`);
    } catch (error) {
      console.error('Failed to copy', name + ':', error);
      throw error;
    }
  }
  
  return regionalAssets;
}

// Get Lambda asset S3 locations from environment variables
function getLambdaAssetLocations() {
  return {
    dcvSessionManager: {
      bucket: process.env.LAMBDA_ASSET_DCV_SESSION_MANAGER_BUCKET,
      key: process.env.LAMBDA_ASSET_DCV_SESSION_MANAGER_KEY,
    },
    dcvReadinessCheckWindows: {
      bucket: process.env.LAMBDA_ASSET_DCV_READINESS_CHECK_WINDOWS_BUCKET,
      key: process.env.LAMBDA_ASSET_DCV_READINESS_CHECK_WINDOWS_KEY,
    },
    dcvReadinessCheckLinux: {
      bucket: process.env.LAMBDA_ASSET_DCV_READINESS_CHECK_LINUX_BUCKET,
      key: process.env.LAMBDA_ASSET_DCV_READINESS_CHECK_LINUX_KEY,
    },
    dcvReadinessCheckMacos: {
      bucket: process.env.LAMBDA_ASSET_DCV_READINESS_CHECK_MACOS_BUCKET,
      key: process.env.LAMBDA_ASSET_DCV_READINESS_CHECK_MACOS_KEY,
    },
    dcvSessionCleanup: {
      bucket: process.env.LAMBDA_ASSET_DCV_SESSION_CLEANUP_BUCKET,
      key: process.env.LAMBDA_ASSET_DCV_SESSION_CLEANUP_KEY,
    },
    configureOntapCifs: {
      bucket: process.env.LAMBDA_ASSET_CONFIGURE_ONTAP_CIFS_BUCKET,
      key: process.env.LAMBDA_ASSET_CONFIGURE_ONTAP_CIFS_KEY,
    },
  };
}

exports.handler = async (event) => {
  console.log('GenerateRegionalHubTemplate event:', JSON.stringify(event, null, 2));
  
  const {
    region,
    displayName,
    vpcCidr,
    availabilityZones,
    publicSubnetMask = 28,
    privateSubnetMask = 24,
    dcvDomainName,
    // Note: dcvCertificateArn is no longer used - TLS cert is replicated from primary region
    enableWindows = true,
    enableLinux = true,
    enableMacOS = false
  } = event;
  
  const productName = process.env.PRODUCT_NAME;
  const acronym = process.env.ACRONYM;
  const templateBucket = process.env.TEMPLATE_BUCKET_NAME;
  const primaryRegion = process.env.PRIMARY_REGION;
  const workstationTableName = process.env.WORKSTATION_TABLE_NAME || 'workstation-instances';
  const dynamoDbKmsKeyArn = process.env.DYNAMODB_KMS_KEY_ARN || '';
  const sourceLambdaAssets = getLambdaAssetLocations();
  
  // Get account ID from STS
  const accountId = await getAccountId();
  
  // Copy Lambda assets to target region (Lambda requires code bucket in same region)
  console.log(`Copying Lambda assets to target region ${region}...`);
  const lambdaAssets = await copyLambdaAssetsToRegion(sourceLambdaAssets, region, acronym, accountId);
  console.log('Regional Lambda assets:', JSON.stringify(lambdaAssets, null, 2));
  
  // Generate stack name
  const regionCode = region.replace(/-/g, '');
  const stackName = `${acronym}-Regional-Hub-${regionCode}`;
  
  // Generate CloudFormation template
  const template = generateCloudFormationTemplate({
    productName,
    acronym,
    region,
    displayName,
    vpcCidr,
    availabilityZones,
    publicSubnetMask,
    privateSubnetMask,
    dcvDomainName,
    enableWindows,
    enableLinux,
    enableMacOS,
    primaryRegion,
    lambdaAssets
  });
  
  // Upload template to S3
  const templateKey = `templates/${region}/${stackName}-${Date.now()}.json`;
  
  await s3.send(new PutObjectCommand({
    Bucket: templateBucket,
    Key: templateKey,
    Body: JSON.stringify(template, null, 2),
    ContentType: 'application/json'
  }));
  
  const templateUrl = `https://${templateBucket}.s3.amazonaws.com/${templateKey}`;
  
  // Generate CloudFormation parameters
  const parameters = [
    { ParameterKey: 'ProductName', ParameterValue: productName },
    { ParameterKey: 'Acronym', ParameterValue: acronym },
    { ParameterKey: 'VpcCidr', ParameterValue: vpcCidr },
    { ParameterKey: 'AvailabilityZones', ParameterValue: availabilityZones.join(',') },
    { ParameterKey: 'PublicSubnetMask', ParameterValue: String(publicSubnetMask) },
    { ParameterKey: 'PrivateSubnetMask', ParameterValue: String(privateSubnetMask) },
    { ParameterKey: 'PrimaryRegion', ParameterValue: primaryRegion },
    { ParameterKey: 'WorkstationTableName', ParameterValue: workstationTableName }
  ];
  
  // Add KMS key ARN if configured (for cross-region DynamoDB access)
  if (dynamoDbKmsKeyArn) {
    parameters.push({ ParameterKey: 'DynamoDbKmsKeyArn', ParameterValue: dynamoDbKmsKeyArn });
  }
  
  if (dcvDomainName) {
    parameters.push({ ParameterKey: 'DcvDomainName', ParameterValue: dcvDomainName });
  }
  // Note: dcvCertificateArn is no longer used - TLS cert is replicated from primary region's Secrets Manager
  
  return {
    stackName,
    templateUrl,
    templateKey,
    parameters,
    region
  };
};

function generateCloudFormationTemplate(config) {
  const {
    productName,
    acronym,
    region,
    displayName,
    vpcCidr,
    availabilityZones,
    dcvDomainName,
    primaryRegion,
    enableWindows,
    enableLinux,
    enableMacOS,
    lambdaAssets
  } = config;
  
  // Lowercase acronym for S3 bucket names (S3 doesn't allow uppercase)
  const acronymLower = acronym.toLowerCase();
  
  // Determine TLS secret name - if dcvDomainName is provided, use the primary region's TLS cert secret
  // The wildcard cert in primary region covers all regional hub domain names
  const tlsSecretName = dcvDomainName ? `/${productName}/DCV/ConnectionGateway/TlsCertificate` : '';
  
  // Get the number of AZs from the input
  const azCount = availabilityZones ? availabilityZones.length : 2;
  
  // Calculate subnet CIDRs from VPC CIDR
  // Similar to how CDK does it - calculate at generation time, not CloudFormation time
  const subnetCidrs = calculateSubnetCidrs(vpcCidr, config.publicSubnetMask || 28, config.privateSubnetMask || 24, azCount);
  
  // Generate subnet resources dynamically based on AZ count
  const subnetResources = generateSubnetResources(subnetCidrs, azCount);
  
  // Generate subnet reference arrays for NLBs, ASGs, Lambdas, etc.
  const publicSubnetRefs = getSubnetRefs('Public', azCount);
  const privateSubnetRefs = getSubnetRefs('Private', azCount);
  
  const template = {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `${productName} Regional Hub Infrastructure for ${displayName} (${region}) - includes VPC, DCV Session Manager, and Connection Gateway`,
    
    Parameters: {
      ProductName: {
        Type: 'String',
        Description: 'Product name for resource naming'
      },
      Acronym: {
        Type: 'String',
        Description: 'Acronym for resource naming'
      },
      VpcCidr: {
        Type: 'String',
        Description: 'VPC CIDR block'
      },
      AvailabilityZones: {
        Type: 'CommaDelimitedList',
        Description: 'List of availability zone IDs'
      },
      PublicSubnetMask: {
        Type: 'Number',
        Description: 'Subnet mask for public subnets',
        Default: 28
      },
      PrivateSubnetMask: {
        Type: 'Number',
        Description: 'Subnet mask for private subnets',
        Default: 24
      },
      PrimaryRegion: {
        Type: 'String',
        Description: 'Primary region for cross-region references'
      },
      WorkstationTableName: {
        Type: 'String',
        Description: 'Name of the workstation DynamoDB table in primary region',
        Default: 'workstation-instances'
      },
      DynamoDbKmsKeyArn: {
        Type: 'String',
        Description: 'ARN of the KMS key used to encrypt DynamoDB tables in primary region (optional)',
        Default: ''
      },
      DcvDomainName: {
        Type: 'String',
        Description: 'Custom domain name for DCV gateway (optional). TLS cert is replicated from primary region.',
        Default: ''
      }
    },
    
    Conditions: {
      HasCustomDomain: { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'DcvDomainName' }, ''] }] },
      HasKmsKey: { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'DynamoDbKmsKeyArn' }, ''] }] }
    },
    
    Resources: {
      // ==================== VPC INFRASTRUCTURE ====================
      VPC: {
        Type: 'AWS::EC2::VPC',
        Properties: {
          CidrBlock: { Ref: 'VpcCidr' },
          EnableDnsHostnames: true,
          EnableDnsSupport: true,
          Tags: [
            { Key: 'Name', Value: { 'Fn::Sub': '${ProductName}-Regional-VPC' } },
            { Key: 'ManagedBy', Value: { Ref: 'ProductName' } }
          ]
        }
      },
      
      InternetGateway: {
        Type: 'AWS::EC2::InternetGateway',
        Properties: {
          Tags: [{ Key: 'Name', Value: { 'Fn::Sub': '${ProductName}-Regional-IGW' } }]
        }
      },
      
      InternetGatewayAttachment: {
        Type: 'AWS::EC2::VPCGatewayAttachment',
        Properties: {
          VpcId: { Ref: 'VPC' },
          InternetGatewayId: { Ref: 'InternetGateway' }
        }
      },
      
      // Dynamic subnet resources are spread in below
      ...subnetResources,
      
      NatGatewayEIP: {
        Type: 'AWS::EC2::EIP',
        DependsOn: 'InternetGatewayAttachment',
        Properties: {
          Domain: 'vpc',
          Tags: [{ Key: 'Name', Value: { 'Fn::Sub': '${ProductName}-Regional-NAT-EIP' } }]
        }
      },
      
      NatGateway: {
        Type: 'AWS::EC2::NatGateway',
        Properties: {
          AllocationId: { 'Fn::GetAtt': ['NatGatewayEIP', 'AllocationId'] },
          SubnetId: { Ref: 'PublicSubnet1' },
          Tags: [{ Key: 'Name', Value: { 'Fn::Sub': '${ProductName}-Regional-NAT' } }]
        }
      },
      
      PublicRouteTable: {
        Type: 'AWS::EC2::RouteTable',
        Properties: {
          VpcId: { Ref: 'VPC' },
          Tags: [{ Key: 'Name', Value: { 'Fn::Sub': '${ProductName}-Regional-Public-RT' } }]
        }
      },
      
      PublicRoute: {
        Type: 'AWS::EC2::Route',
        DependsOn: 'InternetGatewayAttachment',
        Properties: {
          RouteTableId: { Ref: 'PublicRouteTable' },
          DestinationCidrBlock: '0.0.0.0/0',
          GatewayId: { Ref: 'InternetGateway' }
        }
      },
      
      PrivateRouteTable: {
        Type: 'AWS::EC2::RouteTable',
        Properties: {
          VpcId: { Ref: 'VPC' },
          Tags: [{ Key: 'Name', Value: { 'Fn::Sub': '${ProductName}-Regional-Private-RT' } }]
        }
      },
      
      PrivateRoute: {
        Type: 'AWS::EC2::Route',
        Properties: {
          RouteTableId: { Ref: 'PrivateRouteTable' },
          DestinationCidrBlock: '0.0.0.0/0',
          NatGatewayId: { Ref: 'NatGateway' }
        }
      },

      // ==================== SECURITY GROUPS ====================
      SessionManagerSecurityGroup: {
        Type: 'AWS::EC2::SecurityGroup',
        Properties: {
          GroupName: { 'Fn::Sub': '${ProductName}-Regional-SessionManager-SG' },
          GroupDescription: 'Security group for DCV Session Manager',
          VpcId: { Ref: 'VPC' },
          SecurityGroupIngress: [
            { IpProtocol: 'tcp', FromPort: 8443, ToPort: 8443, CidrIp: '0.0.0.0/0', Description: 'CLI to Broker API' },
            { IpProtocol: 'tcp', FromPort: 8445, ToPort: 8445, CidrIp: '0.0.0.0/0', Description: 'Agent to Broker' },
            { IpProtocol: 'tcp', FromPort: 8447, ToPort: 8447, CidrIp: { Ref: 'VpcCidr' }, Description: 'Gateway to Broker resolver' }
          ],
          Tags: [{ Key: 'Name', Value: { 'Fn::Sub': '${ProductName}-Regional-SessionManager-SG' } }]
        }
      },
      
      SessionManagerSGSelfIngress: {
        Type: 'AWS::EC2::SecurityGroupIngress',
        Properties: {
          GroupId: { Ref: 'SessionManagerSecurityGroup' },
          IpProtocol: '-1',
          SourceSecurityGroupId: { Ref: 'SessionManagerSecurityGroup' },
          Description: 'Broker to Broker communication'
        }
      },
      
      SessionManagerSGFromGateway: {
        Type: 'AWS::EC2::SecurityGroupIngress',
        Properties: {
          GroupId: { Ref: 'SessionManagerSecurityGroup' },
          IpProtocol: 'tcp',
          FromPort: 8447,
          ToPort: 8447,
          SourceSecurityGroupId: { Ref: 'ConnectionGatewaySecurityGroup' },
          Description: 'Gateway to Broker resolver communication'
        }
      },
      
      ConnectionGatewaySecurityGroup: {
        Type: 'AWS::EC2::SecurityGroup',
        Properties: {
          GroupName: { 'Fn::Sub': '${ProductName}-Regional-ConnectionGateway-SG' },
          GroupDescription: 'Security group for DCV Connection Gateway',
          VpcId: { Ref: 'VPC' },
          SecurityGroupIngress: [
            { IpProtocol: 'tcp', FromPort: 8443, ToPort: 8443, CidrIp: '0.0.0.0/0', Description: 'DCV TCP from internet' },
            { IpProtocol: 'udp', FromPort: 8443, ToPort: 8443, CidrIp: '0.0.0.0/0', Description: 'DCV UDP from internet' },
            { IpProtocol: 'udp', FromPort: 8444, ToPort: 8444, CidrIp: '0.0.0.0/0', Description: 'DCV QUIC from internet' },
            { IpProtocol: 'tcp', FromPort: 8989, ToPort: 8989, CidrIp: '0.0.0.0/0', Description: 'Health check' }
          ],
          Tags: [{ Key: 'Name', Value: { 'Fn::Sub': '${ProductName}-Regional-ConnectionGateway-SG' } }]
        }
      },
      
      WorkstationSecurityGroup: {
        Type: 'AWS::EC2::SecurityGroup',
        Properties: {
          GroupName: { 'Fn::Sub': '${ProductName}-Regional-Workstation-SG' },
          GroupDescription: 'Security group for DCV workstations',
          VpcId: { Ref: 'VPC' },
          SecurityGroupIngress: [
            { IpProtocol: 'tcp', FromPort: 8443, ToPort: 8443, CidrIp: { Ref: 'VpcCidr' }, Description: 'DCV TCP from VPC' },
            { IpProtocol: 'udp', FromPort: 8443, ToPort: 8443, CidrIp: { Ref: 'VpcCidr' }, Description: 'DCV UDP from VPC' },
            { IpProtocol: 'udp', FromPort: 8444, ToPort: 8444, CidrIp: { Ref: 'VpcCidr' }, Description: 'DCV QUIC from VPC' },
            { IpProtocol: 'tcp', FromPort: 445, ToPort: 445, CidrIp: { Ref: 'VpcCidr' }, Description: 'SMB for FSx' }
          ],
          Tags: [{ Key: 'Name', Value: { 'Fn::Sub': '${ProductName}-Regional-Workstation-SG' } }]
        }
      },
      
      WorkstationSGFromGateway: {
        Type: 'AWS::EC2::SecurityGroupIngress',
        Properties: {
          GroupId: { Ref: 'WorkstationSecurityGroup' },
          IpProtocol: 'tcp',
          FromPort: 8443,
          ToPort: 8443,
          SourceSecurityGroupId: { Ref: 'ConnectionGatewaySecurityGroup' },
          Description: 'DCV TCP from Connection Gateway'
        }
      },
      
      WorkstationSGFromGatewayUdp8443: {
        Type: 'AWS::EC2::SecurityGroupIngress',
        Properties: {
          GroupId: { Ref: 'WorkstationSecurityGroup' },
          IpProtocol: 'udp',
          FromPort: 8443,
          ToPort: 8443,
          SourceSecurityGroupId: { Ref: 'ConnectionGatewaySecurityGroup' },
          Description: 'DCV UDP from Connection Gateway'
        }
      },
      
      WorkstationSGFromGatewayUdp8444: {
        Type: 'AWS::EC2::SecurityGroupIngress',
        Properties: {
          GroupId: { Ref: 'WorkstationSecurityGroup' },
          IpProtocol: 'udp',
          FromPort: 8444,
          ToPort: 8444,
          SourceSecurityGroupId: { Ref: 'ConnectionGatewaySecurityGroup' },
          Description: 'DCV QUIC from Connection Gateway'
        }
      },
      
      // ==================== VPC ENDPOINTS (SSM) ====================
      // SSM VPC endpoints ensure workstation SSM agent traffic stays within the VPC
      // and is not intercepted by any system-level proxy configuration
      
      SSMEndpointSecurityGroup: {
        Type: 'AWS::EC2::SecurityGroup',
        Properties: {
          GroupName: { 'Fn::Sub': '${ProductName}-Regional-SSM-Endpoints-SG' },
          GroupDescription: 'Security group for SSM VPC endpoints',
          VpcId: { Ref: 'VPC' },
          SecurityGroupIngress: [
            { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: { Ref: 'VpcCidr' }, Description: 'HTTPS from VPC' }
          ],
          Tags: [{ Key: 'Name', Value: { 'Fn::Sub': '${ProductName}-Regional-SSM-Endpoints-SG' } }]
        }
      },

      SSMEndpoint: {
        Type: 'AWS::EC2::VPCEndpoint',
        Properties: {
          VpcId: { Ref: 'VPC' },
          VpcEndpointType: 'Interface',
          ServiceName: { 'Fn::Sub': 'com.amazonaws.${AWS::Region}.ssm' },
          SubnetIds: privateSubnetRefs,
          SecurityGroupIds: [{ Ref: 'SSMEndpointSecurityGroup' }],
          PrivateDnsEnabled: true
        }
      },

      SSMMessagesEndpoint: {
        Type: 'AWS::EC2::VPCEndpoint',
        Properties: {
          VpcId: { Ref: 'VPC' },
          VpcEndpointType: 'Interface',
          ServiceName: { 'Fn::Sub': 'com.amazonaws.${AWS::Region}.ssmmessages' },
          SubnetIds: privateSubnetRefs,
          SecurityGroupIds: [{ Ref: 'SSMEndpointSecurityGroup' }],
          PrivateDnsEnabled: true
        }
      },

      EC2MessagesEndpoint: {
        Type: 'AWS::EC2::VPCEndpoint',
        Properties: {
          VpcId: { Ref: 'VPC' },
          VpcEndpointType: 'Interface',
          ServiceName: { 'Fn::Sub': 'com.amazonaws.${AWS::Region}.ec2messages' },
          SubnetIds: privateSubnetRefs,
          SecurityGroupIds: [{ Ref: 'SSMEndpointSecurityGroup' }],
          PrivateDnsEnabled: true
        }
      },

      // ==================== IAM ROLES ====================
      SessionManagerRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: { 'Fn::Sub': '${ProductName}-Regional-SessionManager-Role' },
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }]
          },
          ManagedPolicyArns: ['arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore'],
          Policies: [
            {
              PolicyName: 'DynamoDBAccess',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [{
                  Effect: 'Allow',
                  Action: ['dynamodb:*'],
                  Resource: { 'Fn::Sub': 'arn:aws:dynamodb:${AWS::Region}:${AWS::AccountId}:*' }
                }]
              }
            },
            {
              PolicyName: 'SSMParameterAccess',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: ['ssm:PutParameter', 'ssm:GetParameter', 'ssm:DescribeParameters'],
                    Resource: { 'Fn::Sub': 'arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/${ProductName}/*' }
                  },
                  {
                    // Allow access to dcv-broker-* parameters used by AWS DCV sample scripts
                    Effect: 'Allow',
                    Action: ['ssm:PutParameter', 'ssm:GetParameter', 'ssm:DescribeParameters'],
                    Resource: { 'Fn::Sub': 'arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/dcv-broker-*' }
                  }
                ]
              }
            },
            {
              PolicyName: 'CloudWatchLogs',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [{
                  Effect: 'Allow',
                  Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
                  Resource: { 'Fn::Sub': `arn:aws:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/ec2/${acronym.toLowerCase()}-dcv-*` }
                }]
              }
            }
          ]
        }
      },
      
      SessionManagerInstanceProfile: {
        Type: 'AWS::IAM::InstanceProfile',
        Properties: {
          InstanceProfileName: { 'Fn::Sub': '${ProductName}-Regional-SessionManager-Profile' },
          Roles: [{ Ref: 'SessionManagerRole' }]
        }
      },
      
      ConnectionGatewayRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: { 'Fn::Sub': '${ProductName}-Regional-ConnectionGateway-Role' },
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }]
          },
          ManagedPolicyArns: ['arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore'],
          Policies: [
            {
              PolicyName: 'SSMParameterAccess',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [{
                  Effect: 'Allow',
                  Action: ['ssm:GetParameter', 'ssm:DescribeParameters'],
                  Resource: { 'Fn::Sub': 'arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/${ProductName}/*' }
                }]
              }
            },
            {
              PolicyName: 'SecretsManagerAccess',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [{
                  Effect: 'Allow',
                  Action: ['secretsmanager:GetSecretValue'],
                  Resource: { 'Fn::Sub': 'arn:aws:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:/${ProductName}/DCV/ConnectionGateway/*' }
                }]
              }
            }
          ]
        }
      },
      
      ConnectionGatewayInstanceProfile: {
        Type: 'AWS::IAM::InstanceProfile',
        Properties: {
          InstanceProfileName: { 'Fn::Sub': '${ProductName}-Regional-ConnectionGateway-Profile' },
          Roles: [{ Ref: 'ConnectionGatewayRole' }]
        }
      },
      
      WorkstationRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: { 'Fn::Sub': '${ProductName}-Regional-Workstation-Role' },
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }]
          },
          ManagedPolicyArns: [
            'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
            'arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy'
          ],
          Policies: [
            {
              PolicyName: 'SSMParameterAccess',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    // Access regional SSM parameters
                    Effect: 'Allow',
                    Action: ['ssm:GetParameter', 'ssm:GetParameters'],
                    Resource: { 'Fn::Sub': 'arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/${ProductName}/*' }
                  },
                  {
                    // Access primary region SSM parameters (for auto-login secret ARN lookup)
                    Effect: 'Allow',
                    Action: ['ssm:GetParameter', 'ssm:GetParameters'],
                    Resource: { 'Fn::Sub': `arn:aws:ssm:${primaryRegion}:\${AWS::AccountId}:parameter/\${ProductName}/*` }
                  }
                ]
              }
            },
            {
              PolicyName: 'DCVLicenseAccess',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [{
                  Effect: 'Allow',
                  Action: ['s3:GetObject'],
                  Resource: { 'Fn::Sub': 'arn:aws:s3:::dcv-license.${AWS::Region}/*' }
                }]
              }
            },
            {
              // Access to admin password secret in primary region for auto-login configuration
              PolicyName: 'SecretsManagerAccess',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [{
                  Effect: 'Allow',
                  Action: ['secretsmanager:GetSecretValue'],
                  Resource: { 'Fn::Sub': `arn:aws:secretsmanager:${primaryRegion}:\${AWS::AccountId}:secret:/\${ProductName}/Workstation/*` }
                }]
              }
            }
          ]
        }
      },
      
      WorkstationInstanceProfile: {
        Type: 'AWS::IAM::InstanceProfile',
        Properties: {
          InstanceProfileName: { 'Fn::Sub': '${ProductName}-Regional-Workstation-Profile' },
          Roles: [{ Ref: 'WorkstationRole' }]
        }
      },

      // ==================== TLS CERTIFICATE REPLICATION (if configured) ====================
      ...(tlsSecretName ? {
        TlsCertReplicatorRole: {
          Type: 'AWS::IAM::Role',
          Properties: {
            RoleName: { 'Fn::Sub': '${ProductName}-Regional-TlsCertReplicator-Role' },
            AssumeRolePolicyDocument: {
              Version: '2012-10-17',
              Statement: [{
                Effect: 'Allow',
                Principal: { Service: 'lambda.amazonaws.com' },
                Action: 'sts:AssumeRole'
              }]
            },
            ManagedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
            Policies: [{
              PolicyName: 'SecretsManagerAccess',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    // Read from primary region
                    Effect: 'Allow',
                    Action: ['secretsmanager:GetSecretValue'],
                    Resource: { 'Fn::Sub': `arn:aws:secretsmanager:${primaryRegion}:\${AWS::AccountId}:secret:/\${ProductName}/DCV/ConnectionGateway/*` }
                  },
                  {
                    // Write to regional hub region
                    Effect: 'Allow',
                    Action: ['secretsmanager:CreateSecret', 'secretsmanager:UpdateSecret', 'secretsmanager:PutSecretValue', 'secretsmanager:DeleteSecret', 'secretsmanager:DescribeSecret', 'secretsmanager:TagResource'],
                    Resource: { 'Fn::Sub': 'arn:aws:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:/${ProductName}/DCV/ConnectionGateway/*' }
                  }
                ]
              }
            }]
          }
        },

        TlsCertReplicatorFunction: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            FunctionName: { 'Fn::Sub': '${ProductName}-Regional-TlsCertReplicator' },
            Runtime: 'nodejs22.x',
            Handler: 'index.handler',
            Role: { 'Fn::GetAtt': ['TlsCertReplicatorRole', 'Arn'] },
            Timeout: 60,
            Environment: {
              Variables: {
                SOURCE_REGION: primaryRegion,
                SOURCE_SECRET_NAME: tlsSecretName
              }
            },
            Code: {
              ZipFile: generateTlsCertReplicatorLambdaCode()
            }
          }
        },

        TlsCertReplication: {
          Type: 'Custom::TlsCertReplication',
          Properties: {
            ServiceToken: { 'Fn::GetAtt': ['TlsCertReplicatorFunction', 'Arn'] },
            TargetSecretName: { 'Fn::Sub': `/${productName}/DCV/ConnectionGateway/TlsCertificate` }
          }
        }
      } : {}),

      // ==================== NLB ACCESS LOGS BUCKET ====================
      // Custom Resource to empty the bucket before deletion
      EmptyBucketRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: { 'Fn::Sub': '${ProductName}-Regional-EmptyBucket-Role' },
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [{
              Effect: 'Allow',
              Principal: { Service: 'lambda.amazonaws.com' },
              Action: 'sts:AssumeRole'
            }]
          },
          ManagedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
          Policies: [{
            PolicyName: 'S3DeleteAccess',
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [{
                Effect: 'Allow',
                Action: ['s3:DeleteObject', 's3:DeleteObjectVersion', 's3:ListBucket', 's3:ListBucketVersions'],
                Resource: [
                  { 'Fn::Sub': `arn:aws:s3:::${acronymLower}-regional-nlb-logs-\${AWS::AccountId}-\${AWS::Region}` },
                  { 'Fn::Sub': `arn:aws:s3:::${acronymLower}-regional-nlb-logs-\${AWS::AccountId}-\${AWS::Region}/*` }
                ]
              }]
            }
          }]
        }
      },

      EmptyBucketFunction: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: { 'Fn::Sub': '${ProductName}-Regional-EmptyBucket' },
          Runtime: 'nodejs22.x',
          Handler: 'index.handler',
          Role: { 'Fn::GetAtt': ['EmptyBucketRole', 'Arn'] },
          Timeout: 300,
          Code: {
            ZipFile: generateEmptyBucketLambdaCode()
          }
        }
      },

      EmptyBucketOnDelete: {
        Type: 'Custom::EmptyBucket',
        Properties: {
          ServiceToken: { 'Fn::GetAtt': ['EmptyBucketFunction', 'Arn'] },
          BucketName: { Ref: 'NlbAccessLogsBucket' }
        }
      },

      NlbAccessLogsBucket: {
        Type: 'AWS::S3::Bucket',
        DependsOn: 'EmptyBucketFunction',
        Properties: {
          BucketName: { 'Fn::Sub': `${acronymLower}-regional-nlb-logs-\${AWS::AccountId}-\${AWS::Region}` },
          BucketEncryption: {
            ServerSideEncryptionConfiguration: [{
              ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }
            }]
          },
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true
          },
          VersioningConfiguration: { Status: 'Enabled' },
          LifecycleConfiguration: {
            Rules: [{
              Id: 'DeleteOldLogs',
              Status: 'Enabled',
              ExpirationInDays: 90,
              NoncurrentVersionExpiration: { NoncurrentDays: 30 }
            }]
          },
          Tags: [{ Key: 'Name', Value: { 'Fn::Sub': '${ProductName}-Regional-NLB-Logs' } }]
        }
      },
      
      NlbAccessLogsBucketPolicy: {
        Type: 'AWS::S3::BucketPolicy',
        Properties: {
          Bucket: { Ref: 'NlbAccessLogsBucket' },
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'EnforceSSL',
                Effect: 'Deny',
                Principal: '*',
                Action: 's3:*',
                Resource: [
                  { 'Fn::GetAtt': ['NlbAccessLogsBucket', 'Arn'] },
                  { 'Fn::Sub': '${NlbAccessLogsBucket.Arn}/*' }
                ],
                Condition: { Bool: { 'aws:SecureTransport': 'false' } }
              },
              {
                Sid: 'AWSLogDeliveryWrite',
                Effect: 'Allow',
                Principal: { Service: 'delivery.logs.amazonaws.com' },
                Action: 's3:PutObject',
                Resource: { 'Fn::Sub': '${NlbAccessLogsBucket.Arn}/*' },
                Condition: { StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control' } }
              },
              {
                Sid: 'AWSLogDeliveryAclCheck',
                Effect: 'Allow',
                Principal: { Service: 'delivery.logs.amazonaws.com' },
                Action: 's3:GetBucketAcl',
                Resource: { 'Fn::GetAtt': ['NlbAccessLogsBucket', 'Arn'] }
              }
            ]
          }
        }
      },

      // ==================== SESSION MANAGER NLB (Internal) ====================
      SessionManagerNLB: {
        Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
        DependsOn: 'NlbAccessLogsBucketPolicy',
        Properties: {
          Name: generateNlbName(acronymLower, 'session-mgr'),
          Type: 'network',
          Scheme: 'internal',
          Subnets: privateSubnetRefs,
          LoadBalancerAttributes: [
            { Key: 'load_balancing.cross_zone.enabled', Value: 'true' },
            { Key: 'access_logs.s3.enabled', Value: 'true' },
            { Key: 'access_logs.s3.bucket', Value: { Ref: 'NlbAccessLogsBucket' } },
            { Key: 'access_logs.s3.prefix', Value: 'session-manager-nlb' }
          ],
          Tags: [{ Key: 'Name', Value: { 'Fn::Sub': '${ProductName}-Regional-SessionManager-NLB' } }]
        }
      },
      
      SessionManagerAgentTargetGroup: {
        Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        Properties: {
          Name: generateTargetGroupName(acronymLower, 'sm-agent'),
          Port: 8445,
          Protocol: 'TCP',
          VpcId: { Ref: 'VPC' },
          TargetType: 'instance',
          HealthCheckEnabled: true,
          HealthCheckProtocol: 'TCP',
          HealthCheckPort: '8445'
        }
      },
      
      SessionManagerApiTargetGroup: {
        Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        Properties: {
          Name: generateTargetGroupName(acronymLower, 'sm-api'),
          Port: 8443,
          Protocol: 'TCP',
          VpcId: { Ref: 'VPC' },
          TargetType: 'instance',
          HealthCheckEnabled: true,
          HealthCheckProtocol: 'TCP',
          HealthCheckPort: '8443'
        }
      },
      
      SessionManagerResolverTargetGroup: {
        Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        Properties: {
          Name: generateTargetGroupName(acronymLower, 'sm-resolver'),
          Port: 8447,
          Protocol: 'TCP',
          VpcId: { Ref: 'VPC' },
          TargetType: 'instance',
          HealthCheckEnabled: true,
          HealthCheckProtocol: 'TCP',
          HealthCheckPort: '8447'
        }
      },
      
      SessionManagerAgentListener: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: 'SessionManagerNLB' },
          Port: 8445,
          Protocol: 'TCP',
          DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: 'SessionManagerAgentTargetGroup' } }]
        }
      },
      
      SessionManagerApiListener: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: 'SessionManagerNLB' },
          Port: 8443,
          Protocol: 'TCP',
          DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: 'SessionManagerApiTargetGroup' } }]
        }
      },
      
      SessionManagerResolverListener: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: 'SessionManagerNLB' },
          Port: 8447,
          Protocol: 'TCP',
          DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: 'SessionManagerResolverTargetGroup' } }]
        }
      },
      
      // ==================== CONNECTION GATEWAY NLB (Public) ====================
      ConnectionGatewayNLB: {
        Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
        DependsOn: 'NlbAccessLogsBucketPolicy',
        Properties: {
          Name: generateNlbName(acronymLower, 'conn-gw'),
          Type: 'network',
          Scheme: 'internet-facing',
          Subnets: publicSubnetRefs,
          LoadBalancerAttributes: [
            { Key: 'load_balancing.cross_zone.enabled', Value: 'true' },
            { Key: 'access_logs.s3.enabled', Value: 'true' },
            { Key: 'access_logs.s3.bucket', Value: { Ref: 'NlbAccessLogsBucket' } },
            { Key: 'access_logs.s3.prefix', Value: 'connection-gateway-nlb' }
          ],
          Tags: [{ Key: 'Name', Value: { 'Fn::Sub': '${ProductName}-Regional-ConnectionGateway-NLB' } }]
        }
      },
      
      ConnectionGatewayTcpTargetGroup: {
        Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        Properties: {
          Name: generateTargetGroupName(acronymLower, 'cg-tcp'),
          Port: 8443,
          Protocol: 'TCP',
          VpcId: { Ref: 'VPC' },
          TargetType: 'instance',
          HealthCheckEnabled: true,
          HealthCheckProtocol: 'TCP',
          HealthCheckPort: '8989'
        }
      },
      
      ConnectionGatewayUdpTargetGroup: {
        Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        Properties: {
          Name: generateTargetGroupName(acronymLower, 'cg-udp'),
          Port: 8444,
          Protocol: 'UDP',
          VpcId: { Ref: 'VPC' },
          TargetType: 'instance',
          HealthCheckEnabled: true,
          HealthCheckProtocol: 'TCP',
          HealthCheckPort: '8989'
        }
      },
      
      ConnectionGatewayTcpListener: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: 'ConnectionGatewayNLB' },
          Port: 8443,
          Protocol: 'TCP',
          DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: 'ConnectionGatewayTcpTargetGroup' } }]
        }
      },
      
      ConnectionGatewayUdpListener: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: 'ConnectionGatewayNLB' },
          Port: 8444,
          Protocol: 'UDP',
          DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: 'ConnectionGatewayUdpTargetGroup' } }]
        }
      },

      // ==================== SESSION MANAGER LAUNCH TEMPLATE & ASG ====================
      SessionManagerLaunchTemplate: {
        Type: 'AWS::EC2::LaunchTemplate',
        Properties: {
          LaunchTemplateName: { 'Fn::Sub': '${ProductName}-Regional-SessionManager-LT' },
          LaunchTemplateData: {
            InstanceType: 'm6g.large',
            ImageId: { 'Fn::Sub': '{{resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64}}' },
            IamInstanceProfile: { Arn: { 'Fn::GetAtt': ['SessionManagerInstanceProfile', 'Arn'] } },
            SecurityGroupIds: [{ Ref: 'SessionManagerSecurityGroup' }],
            MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 2 },
            UserData: { 'Fn::Base64': generateSessionManagerUserData(productName, acronym) },
            TagSpecifications: [{
              ResourceType: 'instance',
              Tags: [
                { Key: 'Name', Value: { 'Fn::Sub': '${ProductName}-Regional-SessionManager' } },
                { Key: 'ManagedBy', Value: { Ref: 'ProductName' } }
              ]
            }]
          }
        }
      },
      
      SessionManagerASG: {
        Type: 'AWS::AutoScaling::AutoScalingGroup',
        DependsOn: ['NatGateway', 'PrivateRoute'],
        Properties: {
          AutoScalingGroupName: { 'Fn::Sub': '${ProductName}-Regional-SessionManager-ASG' },
          LaunchTemplate: {
            LaunchTemplateId: { Ref: 'SessionManagerLaunchTemplate' },
            Version: { 'Fn::GetAtt': ['SessionManagerLaunchTemplate', 'LatestVersionNumber'] }
          },
          MinSize: 1,
          MaxSize: 1,
          DesiredCapacity: 1,
          VPCZoneIdentifier: privateSubnetRefs,
          TargetGroupARNs: [
            { Ref: 'SessionManagerAgentTargetGroup' },
            { Ref: 'SessionManagerApiTargetGroup' },
            { Ref: 'SessionManagerResolverTargetGroup' }
          ],
          HealthCheckType: 'EC2',
          HealthCheckGracePeriod: 600,
          Tags: [{ Key: 'Name', Value: { 'Fn::Sub': '${ProductName}-Regional-SessionManager' }, PropagateAtLaunch: true }]
        }
      },
      
      // ==================== CONNECTION GATEWAY LAUNCH TEMPLATE & ASG ====================
      ConnectionGatewayLaunchTemplate: {
        Type: 'AWS::EC2::LaunchTemplate',
        DependsOn: 'SessionManagerEndpointParameter',
        Properties: {
          LaunchTemplateName: { 'Fn::Sub': '${ProductName}-Regional-ConnectionGateway-LT' },
          LaunchTemplateData: {
            InstanceType: 'c7g.large',
            ImageId: { 'Fn::Sub': '{{resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64}}' },
            IamInstanceProfile: { Arn: { 'Fn::GetAtt': ['ConnectionGatewayInstanceProfile', 'Arn'] } },
            SecurityGroupIds: [{ Ref: 'ConnectionGatewaySecurityGroup' }],
            MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 2 },
            UserData: { 'Fn::Base64': generateConnectionGatewayUserData(productName, tlsSecretName) },
            TagSpecifications: [{
              ResourceType: 'instance',
              Tags: [
                { Key: 'Name', Value: { 'Fn::Sub': '${ProductName}-Regional-ConnectionGateway' } },
                { Key: 'ManagedBy', Value: { Ref: 'ProductName' } }
              ]
            }]
          }
        }
      },
      
      ConnectionGatewayASG: {
        Type: 'AWS::AutoScaling::AutoScalingGroup',
        DependsOn: ['SessionManagerASG', 'NatGateway', 'PrivateRoute'],
        Properties: {
          AutoScalingGroupName: { 'Fn::Sub': '${ProductName}-Regional-ConnectionGateway-ASG' },
          LaunchTemplate: {
            LaunchTemplateId: { Ref: 'ConnectionGatewayLaunchTemplate' },
            Version: { 'Fn::GetAtt': ['ConnectionGatewayLaunchTemplate', 'LatestVersionNumber'] }
          },
          MinSize: 1,
          MaxSize: 3,
          DesiredCapacity: 1,
          VPCZoneIdentifier: privateSubnetRefs,
          TargetGroupARNs: [
            { Ref: 'ConnectionGatewayTcpTargetGroup' },
            { Ref: 'ConnectionGatewayUdpTargetGroup' }
          ],
          HealthCheckType: 'EC2',
          HealthCheckGracePeriod: 300,
          Tags: [{ Key: 'Name', Value: { 'Fn::Sub': '${ProductName}-Regional-ConnectionGateway' }, PropagateAtLaunch: true }]
        }
      },
      
      // ==================== WORKSTATION LAUNCH TEMPLATE ====================
      WorkstationLaunchTemplate: {
        Type: 'AWS::EC2::LaunchTemplate',
        Properties: {
          LaunchTemplateName: { 'Fn::Sub': '${ProductName}-Regional-Workstation-LT' },
          LaunchTemplateData: {
            IamInstanceProfile: { Arn: { 'Fn::GetAtt': ['WorkstationInstanceProfile', 'Arn'] } },
            SecurityGroupIds: [{ Ref: 'WorkstationSecurityGroup' }],
            MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 2 },
            TagSpecifications: [
              {
                ResourceType: 'instance',
                Tags: [
                  { Key: 'ManagedBy', Value: { Ref: 'ProductName' } },
                  { Key: 'Region', Value: { Ref: 'AWS::Region' } }
                ]
              },
              {
                ResourceType: 'volume',
                Tags: [{ Key: 'ManagedBy', Value: { Ref: 'ProductName' } }]
              }
            ]
          }
        }
      },

      // ==================== SSM PARAMETERS ====================
      VpcIdParameter: {
        Type: 'AWS::SSM::Parameter',
        Properties: {
          Name: { 'Fn::Sub': '/${ProductName}/Regional/${AWS::Region}/VpcId' },
          Type: 'String',
          Value: { Ref: 'VPC' }
        }
      },
      
      PrivateSubnetsParameter: {
        Type: 'AWS::SSM::Parameter',
        Properties: {
          Name: { 'Fn::Sub': '/${ProductName}/Regional/${AWS::Region}/PrivateSubnetIds' },
          Type: 'StringList',
          Value: { 'Fn::Join': [',', privateSubnetRefs] }
        }
      },
      
      PublicSubnetsParameter: {
        Type: 'AWS::SSM::Parameter',
        Properties: {
          Name: { 'Fn::Sub': '/${ProductName}/Regional/${AWS::Region}/PublicSubnetIds' },
          Type: 'StringList',
          Value: { 'Fn::Join': [',', publicSubnetRefs] }
        }
      },
      
      SecurityGroupParameter: {
        Type: 'AWS::SSM::Parameter',
        Properties: {
          Name: { 'Fn::Sub': '/${ProductName}/Regional/${AWS::Region}/WorkstationSecurityGroupId' },
          Type: 'String',
          Value: { Ref: 'WorkstationSecurityGroup' }
        }
      },
      
      LaunchTemplateParameter: {
        Type: 'AWS::SSM::Parameter',
        Properties: {
          Name: { 'Fn::Sub': '/${ProductName}/Regional/${AWS::Region}/LaunchTemplateId' },
          Type: 'String',
          Value: { Ref: 'WorkstationLaunchTemplate' }
        }
      },
      
      SessionManagerEndpointParameter: {
        Type: 'AWS::SSM::Parameter',
        Properties: {
          Name: { 'Fn::Sub': '/${ProductName}/DCV/SessionManager/Endpoint' },
          Type: 'String',
          Value: { 'Fn::GetAtt': ['SessionManagerNLB', 'DNSName'] },
          Description: 'DCV Session Manager NLB endpoint for this region'
        }
      },
      
      ConnectionGatewayEndpointParameter: {
        Type: 'AWS::SSM::Parameter',
        Properties: {
          Name: { 'Fn::Sub': '/${ProductName}/DCV/ConnectionGateway/Endpoint' },
          Type: 'String',
          Value: {
            'Fn::If': [
              'HasCustomDomain',
              { Ref: 'DcvDomainName' },
              { 'Fn::GetAtt': ['ConnectionGatewayNLB', 'DNSName'] }
            ]
          },
          Description: 'DCV Connection Gateway endpoint for client connections'
        }
      },

      // ==================== REGIONAL CLEANUP INFRASTRUCTURE ====================
      // Lambda execution role for cleanup functions
      CleanupLambdaRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: { 'Fn::Sub': '${ProductName}-Regional-Cleanup-Role' },
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }]
          },
          ManagedPolicyArns: [
            'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole'
          ],
          Policies: [
            {
              PolicyName: 'CleanupPermissions',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: ['ssm:GetParameter'],
                    Resource: { 'Fn::Sub': 'arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/${ProductName}/*' }
                  },
                  {
                    Effect: 'Allow',
                    Action: ['ec2:DescribeInstances'],
                    Resource: '*'
                  },
                  {
                    Effect: 'Allow',
                    Action: ['dynamodb:UpdateItem', 'dynamodb:GetItem'],
                    Resource: { 'Fn::Sub': 'arn:aws:dynamodb:${PrimaryRegion}:${AWS::AccountId}:table/*workstation*' }
                  },
                  {
                    Effect: 'Allow',
                    Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
                    Resource: { 'Fn::Sub': 'arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/*' }
                  }
                ]
              }
            }
          ]
        }
      },

      // Security group for cleanup Lambdas (needs to reach Session Manager)
      CleanupLambdaSecurityGroup: {
        Type: 'AWS::EC2::SecurityGroup',
        Properties: {
          GroupName: { 'Fn::Sub': '${ProductName}-Regional-Cleanup-Lambda-SG' },
          GroupDescription: 'Security group for regional cleanup Lambda functions',
          VpcId: { Ref: 'VPC' },
          SecurityGroupEgress: [
            { IpProtocol: '-1', CidrIp: '0.0.0.0/0', Description: 'Allow all outbound' }
          ],
          Tags: [{ Key: 'Name', Value: { 'Fn::Sub': '${ProductName}-Regional-Cleanup-Lambda-SG' } }]
        }
      },

      // Allow cleanup Lambda to reach Session Manager
      SessionManagerSGFromCleanupLambda: {
        Type: 'AWS::EC2::SecurityGroupIngress',
        Properties: {
          GroupId: { Ref: 'SessionManagerSecurityGroup' },
          IpProtocol: 'tcp',
          FromPort: 8443,
          ToPort: 8443,
          SourceSecurityGroupId: { Ref: 'CleanupLambdaSecurityGroup' },
          Description: 'Cleanup Lambda to Session Manager API'
        }
      },

      // DCV Session Cleanup Lambda (triggered on stop/terminate)
      DcvSessionCleanupFunction: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${acronymLower}-regional-dcv-session-cleanup`,
          Runtime: 'python3.12',
          Handler: 'index.lambda_handler',
          Role: { 'Fn::GetAtt': ['CleanupLambdaRole', 'Arn'] },
          Timeout: 180,
          ReservedConcurrentExecutions: 10,
          VpcConfig: {
            SubnetIds: privateSubnetRefs,
            SecurityGroupIds: [{ Ref: 'CleanupLambdaSecurityGroup' }]
          },
          Environment: {
            Variables: {
              PASCAL_CASE_NAME: { Ref: 'ProductName' },
              PRIMARY_REGION: { Ref: 'PrimaryRegion' },
              WORKSTATION_TABLE_NAME: { Ref: 'WorkstationTableName' }
            }
          },
          Code: {
            ZipFile: { 'Fn::Sub': generateSessionCleanupLambdaCode() }
          }
        }
      },

      // DCV Server Cleanup Lambda (triggered on terminate only)
      DcvServerCleanupFunction: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${acronymLower}-regional-dcv-server-cleanup`,
          Runtime: 'python3.12',
          Handler: 'index.lambda_handler',
          Role: { 'Fn::GetAtt': ['CleanupLambdaRole', 'Arn'] },
          Timeout: 300,
          ReservedConcurrentExecutions: 5,
          VpcConfig: {
            SubnetIds: privateSubnetRefs,
            SecurityGroupIds: [{ Ref: 'CleanupLambdaSecurityGroup' }]
          },
          Environment: {
            Variables: {
              PASCAL_CASE_NAME: { Ref: 'ProductName' },
              PRIMARY_REGION: { Ref: 'PrimaryRegion' },
              WORKSTATION_TABLE_NAME: { Ref: 'WorkstationTableName' }
            }
          },
          Code: {
            ZipFile: { 'Fn::Sub': generateServerCleanupLambdaCode() }
          }
        }
      },

      // EventBridge rule for session cleanup (stop/terminate)
      SessionCleanupRule: {
        Type: 'AWS::Events::Rule',
        Properties: {
          Name: { 'Fn::Sub': '${Acronym}-regional-dcv-session-cleanup' },
          Description: 'Triggers DCV session cleanup when EC2 instances are stopped or terminated',
          EventPattern: {
            source: ['aws.ec2'],
            'detail-type': ['EC2 Instance State-change Notification'],
            detail: {
              state: ['stopped', 'terminated']
            }
          },
          State: 'ENABLED',
          Targets: [{
            Id: 'SessionCleanupTarget',
            Arn: { 'Fn::GetAtt': ['DcvSessionCleanupFunction', 'Arn'] }
          }]
        }
      },

      // EventBridge rule for server cleanup (terminate only)
      ServerCleanupRule: {
        Type: 'AWS::Events::Rule',
        Properties: {
          Name: { 'Fn::Sub': '${Acronym}-regional-dcv-server-cleanup' },
          Description: 'Triggers DCV server cleanup when EC2 instances are terminated',
          EventPattern: {
            source: ['aws.ec2'],
            'detail-type': ['EC2 Instance State-change Notification'],
            detail: {
              state: ['terminated']
            }
          },
          State: 'ENABLED',
          Targets: [{
            Id: 'ServerCleanupTarget',
            Arn: { 'Fn::GetAtt': ['DcvServerCleanupFunction', 'Arn'] }
          }]
        }
      },

      // Lambda permission for EventBridge to invoke session cleanup
      SessionCleanupPermission: {
        Type: 'AWS::Lambda::Permission',
        Properties: {
          FunctionName: { Ref: 'DcvSessionCleanupFunction' },
          Action: 'lambda:InvokeFunction',
          Principal: 'events.amazonaws.com',
          SourceArn: { 'Fn::GetAtt': ['SessionCleanupRule', 'Arn'] }
        }
      },

      // Lambda permission for EventBridge to invoke server cleanup
      ServerCleanupPermission: {
        Type: 'AWS::Lambda::Permission',
        Properties: {
          FunctionName: { Ref: 'DcvServerCleanupFunction' },
          Action: 'lambda:InvokeFunction',
          Principal: 'events.amazonaws.com',
          SourceArn: { 'Fn::GetAtt': ['ServerCleanupRule', 'Arn'] }
        }
      },

      // ==================== EC2 STATE HANDLER (Updates DynamoDB) ====================
      // Lambda execution role for EC2 state handler
      Ec2StateHandlerRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: { 'Fn::Sub': '${ProductName}-Regional-EC2StateHandler-Role' },
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }]
          },
          ManagedPolicyArns: [
            'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
          ],
          Policies: [
            {
              PolicyName: 'DynamoDBAccess',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: ['dynamodb:UpdateItem', 'dynamodb:GetItem'],
                    Resource: { 'Fn::Sub': 'arn:aws:dynamodb:${PrimaryRegion}:${AWS::AccountId}:table/*workstation*' }
                  },
                  {
                    'Fn::If': [
                      'HasKmsKey',
                      {
                        Effect: 'Allow',
                        Action: ['kms:Decrypt', 'kms:GenerateDataKey'],
                        Resource: { Ref: 'DynamoDbKmsKeyArn' }
                      },
                      { Ref: 'AWS::NoValue' }
                    ]
                  }
                ]
              }
            }
          ]
        }
      },

      // EC2 State Handler Lambda (updates DynamoDB in primary region)
      Ec2StateHandlerFunction: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${acronymLower}-regional-ec2-state-handler`,
          Runtime: 'nodejs22.x',
          Handler: 'index.handler',
          Role: { 'Fn::GetAtt': ['Ec2StateHandlerRole', 'Arn'] },
          Timeout: 120,
          ReservedConcurrentExecutions: 10,
          Environment: {
            Variables: {
              PRIMARY_REGION: { Ref: 'PrimaryRegion' },
              WORKSTATION_TABLE_NAME: { Ref: 'WorkstationTableName' }
            }
          },
          Code: {
            ZipFile: { 'Fn::Sub': generateEc2StateHandlerCode() }
          }
        }
      },

      // EventBridge rule for EC2 state changes (all states)
      Ec2StateChangeRule: {
        Type: 'AWS::Events::Rule',
        Properties: {
          Name: { 'Fn::Sub': '${Acronym}-regional-ec2-state-change' },
          Description: 'Captures EC2 state changes to update workstation status in DynamoDB',
          EventPattern: {
            source: ['aws.ec2'],
            'detail-type': ['EC2 Instance State-change Notification'],
            detail: {
              state: ['pending', 'running', 'shutting-down', 'terminated', 'stopping', 'stopped']
            }
          },
          State: 'ENABLED',
          Targets: [{
            Id: 'Ec2StateHandlerTarget',
            Arn: { 'Fn::GetAtt': ['Ec2StateHandlerFunction', 'Arn'] }
          }]
        }
      },

      // Lambda permission for EventBridge to invoke EC2 state handler
      Ec2StateHandlerPermission: {
        Type: 'AWS::Lambda::Permission',
        Properties: {
          FunctionName: { Ref: 'Ec2StateHandlerFunction' },
          Action: 'lambda:InvokeFunction',
          Principal: 'events.amazonaws.com',
          SourceArn: { 'Fn::GetAtt': ['Ec2StateChangeRule', 'Arn'] }
        }
      },

      // ==================== DCV STATUS SYNC (Polls Session Manager for connection status) ====================
      // Lambda execution role for DCV status sync
      DcvStatusSyncRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: { 'Fn::Sub': '${ProductName}-Regional-DcvStatusSync-Role' },
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }]
          },
          ManagedPolicyArns: [
            'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole'
          ],
          Policies: [
            {
              PolicyName: 'StatusSyncPermissions',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: ['ssm:GetParameter'],
                    Resource: { 'Fn::Sub': 'arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/${ProductName}/*' }
                  },
                  {
                    Effect: 'Allow',
                    Action: ['ec2:DescribeInstances'],
                    Resource: '*'
                  },
                  {
                    Effect: 'Allow',
                    Action: ['dynamodb:UpdateItem', 'dynamodb:Scan'],
                    Resource: { 'Fn::Sub': 'arn:aws:dynamodb:${PrimaryRegion}:${AWS::AccountId}:table/*workstation*' }
                  },
                  {
                    Effect: 'Allow',
                    Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
                    Resource: { 'Fn::Sub': 'arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/*' }
                  },
                  {
                    'Fn::If': [
                      'HasKmsKey',
                      {
                        Effect: 'Allow',
                        Action: ['kms:Decrypt', 'kms:GenerateDataKey'],
                        Resource: { Ref: 'DynamoDbKmsKeyArn' }
                      },
                      { Ref: 'AWS::NoValue' }
                    ]
                  }
                ]
              }
            }
          ]
        }
      },

      // DCV Status Sync Lambda (polls Session Manager API every 5 minutes)
      DcvStatusSyncFunction: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${acronymLower}-regional-dcv-status-sync`,
          Runtime: 'python3.12',
          Handler: 'index.lambda_handler',
          Role: { 'Fn::GetAtt': ['DcvStatusSyncRole', 'Arn'] },
          Timeout: 300,
          ReservedConcurrentExecutions: 5,
          VpcConfig: {
            SubnetIds: privateSubnetRefs,
            SecurityGroupIds: [{ Ref: 'CleanupLambdaSecurityGroup' }]
          },
          Environment: {
            Variables: {
              PASCAL_CASE_NAME: { Ref: 'ProductName' },
              PRIMARY_REGION: { Ref: 'PrimaryRegion' },
              CURRENT_REGION: { Ref: 'AWS::Region' },
              WORKSTATION_TABLE_NAME: { Ref: 'WorkstationTableName' }
            }
          },
          Code: {
            ZipFile: { 'Fn::Sub': generateDcvStatusSyncCode() }
          }
        }
      },

      // EventBridge rule for DCV status sync (every 5 minutes)
      DcvStatusSyncRule: {
        Type: 'AWS::Events::Rule',
        Properties: {
          Name: { 'Fn::Sub': '${Acronym}-regional-dcv-status-sync' },
          Description: 'Syncs DCV connection status from Session Manager to DynamoDB every 5 minutes',
          ScheduleExpression: 'rate(5 minutes)',
          State: 'ENABLED',
          Targets: [{
            Id: 'DcvStatusSyncTarget',
            Arn: { 'Fn::GetAtt': ['DcvStatusSyncFunction', 'Arn'] }
          }]
        }
      },

      // Lambda permission for EventBridge to invoke DCV status sync
      DcvStatusSyncPermission: {
        Type: 'AWS::Lambda::Permission',
        Properties: {
          FunctionName: { Ref: 'DcvStatusSyncFunction' },
          Action: 'lambda:InvokeFunction',
          Principal: 'events.amazonaws.com',
          SourceArn: { 'Fn::GetAtt': ['DcvStatusSyncRule', 'Arn'] }
        }
      },

      // ==================== MANUAL DCV CLEANUP (API-callable for stale server cleanup) ====================
      // Lambda execution role for manual cleanup
      ManualCleanupRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: { 'Fn::Sub': '${ProductName}-Regional-ManualCleanup-Role' },
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }]
          },
          ManagedPolicyArns: [
            'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole'
          ],
          Policies: [
            {
              PolicyName: 'ManualCleanupPermissions',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: ['ssm:GetParameter'],
                    Resource: { 'Fn::Sub': 'arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/${ProductName}/*' }
                  },
                  {
                    Effect: 'Allow',
                    Action: ['ec2:DescribeInstances'],
                    Resource: '*'
                  },
                  {
                    Effect: 'Allow',
                    Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
                    Resource: { 'Fn::Sub': 'arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/*' }
                  }
                ]
              }
            }
          ]
        }
      },

      // Manual DCV Cleanup Lambda (API-callable for cleaning up stale servers/sessions)
      ManualCleanupFunction: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${acronymLower}-regional-dcv-manual-cleanup`,
          Runtime: 'python3.12',
          Handler: 'index.lambda_handler',
          Role: { 'Fn::GetAtt': ['ManualCleanupRole', 'Arn'] },
          Timeout: 600,
          ReservedConcurrentExecutions: 5,
          VpcConfig: {
            SubnetIds: privateSubnetRefs,
            SecurityGroupIds: [{ Ref: 'CleanupLambdaSecurityGroup' }]
          },
          Environment: {
            Variables: {
              PASCAL_CASE_NAME: { Ref: 'ProductName' },
              PRIMARY_REGION: { Ref: 'PrimaryRegion' },
              CURRENT_REGION: { Ref: 'AWS::Region' },
              WORKSTATION_TABLE_NAME: { Ref: 'WorkstationTableName' }
            }
          },
          Code: {
            ZipFile: { 'Fn::Sub': generateManualCleanupCode() }
          }
        }
      },

      // ==================== SSM DOCUMENTS FOR WORKSTATION PROVISIONING ====================
      // Windows SSM Documents (only when enableWindows is true)
      ...(enableWindows ? {
        WindowsDcvInstallDocument: {
          Type: 'AWS::SSM::Document',
          Properties: {
            Name: { 'Fn::Sub': '${ProductName}-Windows-DCV-Install' },
            DocumentType: 'Command',
            DocumentFormat: 'JSON',
            Content: windowsDcvInstallContent
          }
        },
        WindowsDisableCtrlAltDelDocument: {
          Type: 'AWS::SSM::Document',
          Properties: {
            Name: { 'Fn::Sub': '${ProductName}-Windows-DisableCtrlAltDel' },
            DocumentType: 'Command',
            DocumentFormat: 'JSON',
            Content: windowsDisableCtrlAltDelContent
          }
        },
        WindowsSetupFsxSchedulerDocument: {
          Type: 'AWS::SSM::Document',
          Properties: {
            Name: { 'Fn::Sub': '${ProductName}-Windows-SetupFsxScheduler' },
            DocumentType: 'Command',
            DocumentFormat: 'JSON',
            Content: windowsSetupFsxSchedulerContent
          }
        },
        WindowsAutoLoginConfigureDocument: {
          Type: 'AWS::SSM::Document',
          Properties: {
            Name: { 'Fn::Sub': '${ProductName}-Windows-AutoLoginConfigure' },
            DocumentType: 'Command',
            DocumentFormat: 'JSON',
            Content: windowsAutoLoginConfigureContent
          }
        }
      } : {}),

      // Linux SSM Documents (only when enableLinux is true)
      ...(enableLinux ? {
        LinuxPhase1BaseInstallDocument: {
          Type: 'AWS::SSM::Document',
          Properties: {
            Name: { 'Fn::Sub': '${ProductName}-Linux-Phase1-BaseInstall' },
            DocumentType: 'Command',
            DocumentFormat: 'JSON',
            Content: linuxPhase1BaseInstallContent
          }
        },
        LinuxPhase2GpuSetupDocument: {
          Type: 'AWS::SSM::Document',
          Properties: {
            Name: { 'Fn::Sub': '${ProductName}-Linux-Phase2-GpuSetup' },
            DocumentType: 'Command',
            DocumentFormat: 'JSON',
            Content: linuxPhase2GpuSetupContent
          }
        },
        LinuxPhase3StartServicesDocument: {
          Type: 'AWS::SSM::Document',
          Properties: {
            Name: { 'Fn::Sub': '${ProductName}-Linux-Phase3-StartServices' },
            DocumentType: 'Command',
            DocumentFormat: 'JSON',
            Content: linuxPhase3StartServicesContent
          }
        }
      } : {}),

      // macOS SSM Documents (only when enableMacOS is true)
      // V2: Updated config paths to correct macOS locations
      ...(enableMacOS ? {
        MacOSPhase1ConfigureDcvDocumentV2: {
          Type: 'AWS::SSM::Document',
          Properties: {
            Name: { 'Fn::Sub': '${ProductName}-MacOS-Phase1-ConfigureDCV-V2' },
            DocumentType: 'Command',
            DocumentFormat: 'JSON',
            Content: macosPhase1ConfigureDcvContent
          }
        },
        MacOSPhase2AutoLoginDocument: {
          Type: 'AWS::SSM::Document',
          Properties: {
            Name: { 'Fn::Sub': '${ProductName}-MacOS-Phase2-AutoLogin' },
            DocumentType: 'Command',
            DocumentFormat: 'JSON',
            Content: macosPhase2AutoLoginContent
          }
        }
      } : {}),

      // ==================== DCV LAMBDAS (S3-based code for VPC access to Session Manager) ====================
      // These Lambdas need to run in the regional hub VPC to access the DCV Session Manager API
      ...generateDcvLambdaResources(acronymLower, privateSubnetRefs, lambdaAssets, enableWindows, enableLinux, enableMacOS),

      // ==================== MACOS DEDICATED HOST RESOURCES ====================
      // Only created when enableMacOS is true
      ...(enableMacOS ? generateMacOSResources(productName, acronymLower) : {}),

      // ==================== SSM PARAMETERS FOR NETWORK CONFIGURATION ====================
      // These parameters allow storage resources to be created in this regional hub
      // by providing the same SSM parameter structure as the primary region
      NetworkVpcIdParameter: {
        Type: 'AWS::SSM::Parameter',
        Properties: {
          Name: { 'Fn::Sub': '/${ProductName}/RegionalHub/${AWS::Region}/Network/VpcId' },
          Type: 'String',
          Value: { Ref: 'VPC' },
          Description: 'Regional Hub VPC ID'
        }
      },
      NetworkVpcCidrParameter: {
        Type: 'AWS::SSM::Parameter',
        Properties: {
          Name: { 'Fn::Sub': '/${ProductName}/RegionalHub/${AWS::Region}/Network/VpcCidr' },
          Type: 'String',
          Value: { Ref: 'VpcCidr' },
          Description: 'Regional Hub VPC CIDR block'
        }
      },
      NetworkPrivateSubnet1Parameter: {
        Type: 'AWS::SSM::Parameter',
        Properties: {
          Name: { 'Fn::Sub': '/${ProductName}/RegionalHub/${AWS::Region}/Network/PrivateSubnet1/SubnetID' },
          Type: 'String',
          Value: { Ref: 'PrivateSubnet1' },
          Description: 'Regional Hub Private Subnet 1 ID'
        }
      },
      NetworkPrivateSubnet2Parameter: {
        Type: 'AWS::SSM::Parameter',
        Properties: {
          Name: { 'Fn::Sub': '/${ProductName}/RegionalHub/${AWS::Region}/Network/PrivateSubnet2/SubnetID' },
          Type: 'String',
          Value: { Ref: 'PrivateSubnet2' },
          Description: 'Regional Hub Private Subnet 2 ID'
        }
      },
      // Add third subnet parameter if we have 3 AZs
      ...(azCount >= 3 ? {
        NetworkPrivateSubnet3Parameter: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: { 'Fn::Sub': '/${ProductName}/RegionalHub/${AWS::Region}/Network/PrivateSubnet3/SubnetID' },
            Type: 'String',
            Value: { Ref: 'PrivateSubnet3' },
            Description: 'Regional Hub Private Subnet 3 ID'
          }
        }
      } : {}),

      // ==================== DATASYNC LOG GROUP ====================
      // CloudWatch log group for DataSync task logging in this regional hub
      DataSyncLogGroup: {
        Type: 'AWS::Logs::LogGroup',
        Properties: {
          LogGroupName: { 'Fn::Sub': '/aws/datasync/${Acronym}' },
          RetentionInDays: 30
        }
      },
      // Resource policy to allow DataSync to write to the log group
      DataSyncLogGroupPolicy: {
        Type: 'AWS::Logs::ResourcePolicy',
        Properties: {
          PolicyName: { 'Fn::Sub': '${Acronym}-datasync-log-policy' },
          PolicyDocument: {
            'Fn::Sub': JSON.stringify({
              Version: '2012-10-17',
              Statement: [{
                Effect: 'Allow',
                Principal: { Service: 'datasync.amazonaws.com' },
                Action: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:PutLogEventsBatch'],
                Resource: 'arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/datasync/${Acronym}:*',
                Condition: {
                  ArnLike: { 'aws:SourceArn': 'arn:aws:datasync:${AWS::Region}:${AWS::AccountId}:task/*' },
                  StringEquals: { 'aws:SourceAccount': '${AWS::AccountId}' }
                }
              }]
            })
          }
        }
      },
      // SSM Parameter to store the log group ARN for Lambda lookup
      DataSyncLogGroupArnParameter: {
        Type: 'AWS::SSM::Parameter',
        Properties: {
          Name: { 'Fn::Sub': '/${ProductName}/RegionalHub/${AWS::Region}/DataSync/LogGroupArn' },
          Type: 'String',
          Value: { 'Fn::GetAtt': ['DataSyncLogGroup', 'Arn'] },
          Description: 'DataSync CloudWatch Log Group ARN for this regional hub'
        }
      }
    },
    
    Outputs: {
      VpcId: {
        Description: 'VPC ID',
        Value: { Ref: 'VPC' }
      },
      PrivateSubnet1Id: {
        Description: 'Private Subnet 1 ID',
        Value: { Ref: 'PrivateSubnet1' }
      },
      PrivateSubnet2Id: {
        Description: 'Private Subnet 2 ID',
        Value: { Ref: 'PrivateSubnet2' }
      },
      PrivateSubnetIds: {
        Description: 'Comma-separated list of all private subnet IDs',
        Value: { 'Fn::Join': [',', privateSubnetRefs] }
      },
      WorkstationSecurityGroupId: {
        Description: 'Workstation Security Group ID',
        Value: { Ref: 'WorkstationSecurityGroup' }
      },
      LaunchTemplateId: {
        Description: 'Workstation Launch Template ID',
        Value: { Ref: 'WorkstationLaunchTemplate' }
      },
      SessionManagerEndpoint: {
        Description: 'DCV Session Manager NLB DNS',
        Value: { 'Fn::GetAtt': ['SessionManagerNLB', 'DNSName'] }
      },
      ConnectionGatewayEndpoint: {
        Description: 'DCV Connection Gateway endpoint',
        Value: {
          'Fn::If': [
            'HasCustomDomain',
            { Ref: 'DcvDomainName' },
            { 'Fn::GetAtt': ['ConnectionGatewayNLB', 'DNSName'] }
          ]
        }
      },
      SessionManagerASGName: {
        Description: 'Session Manager ASG Name',
        Value: { Ref: 'SessionManagerASG' }
      },
      ConnectionGatewayASGName: {
        Description: 'Connection Gateway ASG Name',
        Value: { Ref: 'ConnectionGatewayASG' }
      },
      DcvStatusSyncFunctionArn: {
        Description: 'DCV Status Sync Lambda ARN',
        Value: { 'Fn::GetAtt': ['DcvStatusSyncFunction', 'Arn'] }
      },
      ManualCleanupFunctionArn: {
        Description: 'Manual DCV Cleanup Lambda ARN (API-callable)',
        Value: { 'Fn::GetAtt': ['ManualCleanupFunction', 'Arn'] }
      },
      // macOS outputs (only present when enableMacOS is true)
      ...(enableMacOS ? {
        HostResourceGroupArn: {
          Description: 'ARN of the Mac Host Resource Group for automatic host allocation',
          Value: { 'Fn::GetAtt': ['MacHostResourceGroup', 'Arn'] }
        },
        LicenseConfigurationArn: {
          Description: 'ARN of the License Configuration for macOS Dedicated Hosts',
          Value: { 'Fn::GetAtt': ['MacOSLicenseConfiguration', 'LicenseConfigurationArn'] }
        }
      } : {}),
      // Workstation instance profile name (needed for macOS which doesn't use launch template)
      WorkstationInstanceProfileName: {
        Description: 'Name of the Workstation Instance Profile',
        Value: { 'Fn::Sub': '${ProductName}-Regional-Workstation-Profile' }
      },
      // DCV Lambda outputs (for cross-region invocation from primary region state machines)
      ...(lambdaAssets.dcvSessionManager && lambdaAssets.dcvSessionManager.bucket ? {
        DcvSessionManagerFunctionArn: {
          Description: 'Regional DCV Session Manager Lambda ARN',
          Value: { 'Fn::GetAtt': ['DcvSessionManagerFunction', 'Arn'] }
        }
      } : {}),
      ...(lambdaAssets.dcvSessionCleanup && lambdaAssets.dcvSessionCleanup.bucket ? {
        DcvSessionCleanupFunctionArn: {
          Description: 'Regional DCV Session Cleanup Lambda ARN',
          Value: { 'Fn::GetAtt': ['DcvSessionCleanupFunction', 'Arn'] }
        }
      } : {}),
      ...(enableWindows && lambdaAssets.dcvReadinessCheckWindows && lambdaAssets.dcvReadinessCheckWindows.bucket ? {
        DcvReadinessCheckWindowsFunctionArn: {
          Description: 'Regional DCV Readiness Check Windows Lambda ARN',
          Value: { 'Fn::GetAtt': ['DcvReadinessCheckWindowsFunction', 'Arn'] }
        }
      } : {}),
      ...(enableLinux && lambdaAssets.dcvReadinessCheckLinux && lambdaAssets.dcvReadinessCheckLinux.bucket ? {
        DcvReadinessCheckLinuxFunctionArn: {
          Description: 'Regional DCV Readiness Check Linux Lambda ARN',
          Value: { 'Fn::GetAtt': ['DcvReadinessCheckLinuxFunction', 'Arn'] }
        }
      } : {}),
      ...(enableMacOS && lambdaAssets.dcvReadinessCheckMacos && lambdaAssets.dcvReadinessCheckMacos.bucket ? {
        DcvReadinessCheckMacosFunctionArn: {
          Description: 'Regional DCV Readiness Check macOS Lambda ARN',
          Value: { 'Fn::GetAtt': ['DcvReadinessCheckMacosFunction', 'Arn'] }
        }
      } : {})
    }
  };
  
  return template;
}

// Generate Session Manager user data script from external file
function generateSessionManagerUserData(productName, acronym, dynamoDbTablePrefix = 'dcv-sm-regional-') {
  // Prepend environment variable exports before the script (matches dcv-infrastructure-stack.ts approach)
  return `#!/bin/bash
export PRODUCT_NAME="${productName}"
export ACRONYM="${(acronym || 'mrm').toLowerCase()}"
export DYNAMODB_TABLE_PREFIX="${dynamoDbTablePrefix}"

${sessionManagerInstallScript}`;
}

// Generate Connection Gateway user data script from external file
function generateConnectionGatewayUserData(productName, tlsSecretName = '') {
  // Prepend environment variable exports before the script (matches dcv-infrastructure-stack.ts approach)
  // TLS_SECRET_REGION is empty - uses local region (secret is replicated to regional hub)
  return `#!/bin/bash
export PRODUCT_NAME="${productName}"
export TLS_SECRET_NAME="${tlsSecretName}"
export TLS_SECRET_REGION=""

${connectionGatewayInstallScript}`;
}

// Generate DCV Session Cleanup Lambda code (inline for CloudFormation)
function generateSessionCleanupLambdaCode() {
  return `
import json
import os
import boto3
import urllib.request
import urllib.parse
import urllib.error
import ssl
import base64

def safe_urlopen(url_or_request, *args, **kwargs):
    if isinstance(url_or_request, urllib.request.Request):
        url_to_check = url_or_request.full_url
    else:
        url_to_check = url_or_request
    parsed = urllib.parse.urlparse(url_to_check)
    if parsed.scheme not in ['https']:
        raise ValueError(f"Unsafe URL scheme: {parsed.scheme}")
    return urllib.request.urlopen(url_or_request, *args, **kwargs)

def lambda_handler(event, context):
    print(f'DCV session cleanup event: {json.dumps(event, indent=2)}')
    
    instance_id = None
    instance_state = None
    
    if 'detail' in event and 'instance-id' in event['detail']:
        instance_id = event['detail']['instance-id']
        instance_state = event['detail'].get('state', '')
        print(f"Instance {instance_id} state changed to: {instance_state}")
        if instance_state not in ['stopped', 'terminated']:
            return {'success': True, 'message': f'Ignored state {instance_state}'}
    else:
        return {'success': False, 'error': 'Invalid event format'}
    
    try:
        ssm = boto3.client('ssm')
        pascal_case_name = os.environ.get('PASCAL_CASE_NAME', 'MediaResourceManager')
        
        session_manager_dns = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/Endpoint')['Parameter']['Value']
        client_id = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientId')['Parameter']['Value']
        client_password = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientPassword', WithDecryption=True)['Parameter']['Value']
        
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        
        token_url = f"https://{session_manager_dns}:8443/oauth2/token?grant_type=client_credentials"
        credentials = f"{client_id}:{client_password}"
        encoded_credentials = base64.b64encode(credentials.encode()).decode()
        
        token_request = urllib.request.Request(token_url, method='POST', headers={'Authorization': f'Basic {encoded_credentials}'})
        with safe_urlopen(token_request, context=ssl_context, timeout=10) as response:
            token_data = json.loads(response.read().decode())
            access_token = token_data['access_token']
        
        base_url = f"https://{session_manager_dns}:8443"
        
        sessions_request = urllib.request.Request(
            f"{base_url}/describeSessions",
            data=json.dumps({}).encode(),
            headers={'Authorization': f'Bearer {access_token}', 'Content-Type': 'application/json'},
            method='POST'
        )
        
        with safe_urlopen(sessions_request, context=ssl_context, timeout=10) as response:
            sessions_data = json.loads(response.read().decode())
            sessions = sessions_data.get('Sessions', [])
        
        ec2 = boto3.client('ec2')
        try:
            instance_response = ec2.describe_instances(InstanceIds=[instance_id])
            instance_ip = instance_response['Reservations'][0]['Instances'][0]['PrivateIpAddress']
        except Exception as e:
            print(f"Failed to get instance IP: {e}")
            return {'success': False, 'error': f'Failed to get instance IP: {str(e)}'}
        
        sessions_to_delete = []
        for session in sessions:
            server_ip = session.get('Server', {}).get('Ip')
            if server_ip == instance_ip:
                sessions_to_delete.append({
                    'id': session.get('Id'),
                    'name': session.get('Name'),
                    'owner': session.get('Owner')
                })
        
        if not sessions_to_delete:
            return {'success': True, 'message': f'No sessions to clean up on {instance_id}'}
        
        delete_data = [{'SessionId': s['id'], 'Owner': s['owner'], 'Force': True} for s in sessions_to_delete]
        
        delete_request = urllib.request.Request(
            f"{base_url}/deleteSessions",
            data=json.dumps(delete_data).encode(),
            headers={'Authorization': f'Bearer {access_token}', 'Content-Type': 'application/json'}
        )
        
        with safe_urlopen(delete_request, context=ssl_context, timeout=10) as response:
            delete_response = json.loads(response.read().decode())
            deleted_count = len(delete_response.get('SuccessfulList', []))
        
        # Update DynamoDB in primary region
        primary_region = os.environ.get('PRIMARY_REGION')
        table_name = os.environ.get('WORKSTATION_TABLE_NAME', 'workstation-instances')
        if primary_region:
            dynamodb = boto3.resource('dynamodb', region_name=primary_region)
            try:
                table = dynamodb.Table(table_name)
                table.update_item(
                    Key={'instanceId': instance_id},
                    UpdateExpression='SET sessionsCleanedUp = :count, sessionCleanupAt = :timestamp',
                    ExpressionAttributeValues={':count': deleted_count, ':timestamp': context.aws_request_id},
                    ConditionExpression='attribute_exists(instanceId)'
                )
            except Exception as e:
                print(f"Failed to update DynamoDB: {e}")
        
        return {'success': True, 'instanceId': instance_id, 'sessionsDeleted': deleted_count}
        
    except Exception as error:
        print(f"DCV session cleanup failed: {error}")
        return {'success': False, 'error': str(error)}
`;
}

// Generate DCV Server Cleanup Lambda code (inline for CloudFormation)
function generateServerCleanupLambdaCode() {
  return `
import json
import os
import boto3
import urllib.request
import urllib.parse
import urllib.error
import ssl
import base64

def safe_urlopen(url_or_request, *args, **kwargs):
    if isinstance(url_or_request, urllib.request.Request):
        url_to_check = url_or_request.full_url
    else:
        url_to_check = url_or_request
    parsed = urllib.parse.urlparse(url_to_check)
    if parsed.scheme not in ['https']:
        raise ValueError(f"Unsafe URL scheme: {parsed.scheme}")
    return urllib.request.urlopen(url_or_request, *args, **kwargs)

def lambda_handler(event, context):
    print(f'DCV server cleanup event: {json.dumps(event, indent=2)}')
    
    instance_id = None
    if 'detail' in event and 'instance-id' in event['detail']:
        instance_id = event['detail']['instance-id']
        instance_state = event['detail'].get('state', '')
        if instance_state != 'terminated':
            return {'success': True, 'message': f'Ignored state {instance_state}'}
    else:
        instance_id = event.get('instanceId')
        if not instance_id:
            return {'success': False, 'error': 'instanceId required'}
    
    try:
        ssm = boto3.client('ssm')
        pascal_case_name = os.environ.get('PASCAL_CASE_NAME', 'MediaResourceManager')
        
        session_manager_dns = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/Endpoint')['Parameter']['Value']
        client_id = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientId')['Parameter']['Value']
        client_password = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientPassword', WithDecryption=True)['Parameter']['Value']
        
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        
        token_url = f"https://{session_manager_dns}:8443/oauth2/token?grant_type=client_credentials"
        credentials = f"{client_id}:{client_password}"
        encoded_credentials = base64.b64encode(credentials.encode()).decode()
        
        token_request = urllib.request.Request(token_url, method='POST', headers={'Authorization': f'Basic {encoded_credentials}'})
        with safe_urlopen(token_request, context=ssl_context, timeout=10) as response:
            token_data = json.loads(response.read().decode())
            access_token = token_data['access_token']
        
        base_url = f"https://{session_manager_dns}:8443"
        
        # Get all servers
        describe_request = urllib.request.Request(
            f"{base_url}/describeServers",
            data=json.dumps({}).encode(),
            headers={'Authorization': f'Bearer {access_token}', 'Content-Type': 'application/json'},
            method='POST'
        )
        
        with safe_urlopen(describe_request, context=ssl_context, timeout=10) as response:
            servers_data = json.loads(response.read().decode())
            servers = servers_data.get('Servers', [])
        
        # Find server for this instance
        server_to_remove = None
        for server in servers:
            server_instance_id = server.get('Host', {}).get('Aws', {}).get('EC2InstanceId')
            if server_instance_id == instance_id:
                server_to_remove = server.get('Id')
                break
        
        if not server_to_remove:
            return {'success': True, 'message': f'No server found for instance {instance_id}'}
        
        # First clean up sessions on this server
        sessions_request = urllib.request.Request(
            f"{base_url}/describeSessions",
            data=json.dumps({}).encode(),
            headers={'Authorization': f'Bearer {access_token}', 'Content-Type': 'application/json'},
            method='POST'
        )
        
        sessions_cleaned = 0
        with safe_urlopen(sessions_request, context=ssl_context, timeout=10) as response:
            sessions_data = json.loads(response.read().decode())
            for session in sessions_data.get('Sessions', []):
                if session.get('Server', {}).get('Id') == server_to_remove:
                    try:
                        delete_session_request = urllib.request.Request(
                            f"{base_url}/sessions/{session.get('Id')}",
                            headers={'Authorization': f'Bearer {access_token}', 'Content-Type': 'application/json'},
                            method='DELETE'
                        )
                        with safe_urlopen(delete_session_request, context=ssl_context, timeout=10):
                            sessions_cleaned += 1
                    except Exception as e:
                        print(f"Failed to delete session: {e}")
        
        # Remove the server
        remove_request = urllib.request.Request(
            f"{base_url}/servers/{server_to_remove}",
            headers={'Authorization': f'Bearer {access_token}', 'Content-Type': 'application/json'},
            method='DELETE'
        )
        
        with safe_urlopen(remove_request, context=ssl_context, timeout=10):
            print(f"Server {server_to_remove} removed successfully")
        
        # Update DynamoDB in primary region
        primary_region = os.environ.get('PRIMARY_REGION')
        table_name = os.environ.get('WORKSTATION_TABLE_NAME', 'workstation-instances')
        if primary_region:
            dynamodb = boto3.resource('dynamodb', region_name=primary_region)
            try:
                table = dynamodb.Table(table_name)
                table.update_item(
                    Key={'instanceId': instance_id},
                    UpdateExpression='SET dcvStatus = :status, dcvCleanedAt = :cleanedAt',
                    ExpressionAttributeValues={':status': 'cleaned', ':cleanedAt': context.aws_request_id},
                    ConditionExpression='attribute_exists(instanceId)'
                )
            except Exception as e:
                print(f"Failed to update DynamoDB: {e}")
        
        return {'success': True, 'instanceId': instance_id, 'serverId': server_to_remove, 'sessionsCleanedUp': sessions_cleaned}
        
    except Exception as error:
        print(f"DCV server cleanup failed: {error}")
        return {'success': False, 'error': str(error)}
`;
}

// Generate EC2 State Handler Lambda code (inline for CloudFormation)
function generateEc2StateHandlerCode() {
  return `
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

exports.handler = async (event) => {
    console.log('EC2 State Change Event:', JSON.stringify(event, null, 2));

    const instanceId = event.detail['instance-id'];
    const state = event.detail.state;

    if (!instanceId || !state) {
        console.log('Missing instanceId or state in event');
        return;
    }

    // Connect to DynamoDB in primary region
    const primaryRegion = process.env.PRIMARY_REGION;
    const tableName = process.env.WORKSTATION_TABLE_NAME || 'workstation-instances';
    const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: primaryRegion }));

    try {
        if (state === 'running') {
            await dynamodb.send(new UpdateCommand({
                TableName: tableName,
                Key: { instanceId },
                UpdateExpression: 'SET instanceStatus = :instanceStatus, updatedAt = :updatedAt',
                ExpressionAttributeValues: {
                    ':instanceStatus': state,
                    ':updatedAt': new Date().toISOString()
                },
                ConditionExpression: 'attribute_exists(instanceId)'
            }));
        } else if (state === 'stopped') {
            await dynamodb.send(new UpdateCommand({
                TableName: tableName,
                Key: { instanceId },
                UpdateExpression: 'SET instanceStatus = :instanceStatus, dcvStatus = :dcvStatus, #status = :workflowStatus, updatedAt = :updatedAt',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                    ':instanceStatus': state,
                    ':dcvStatus': 'stopped',
                    ':workflowStatus': 'Stopped',
                    ':updatedAt': new Date().toISOString()
                },
                ConditionExpression: 'attribute_exists(instanceId)'
            }));
        } else if (state === 'terminated' || state === 'shutting-down') {
            const workflowStatus = state === 'terminated' ? 'Terminated' : 'Stopped';
            const updateExpression = state === 'terminated' 
                ? 'SET instanceStatus = :instanceStatus, dcvStatus = :dcvStatus, #status = :workflowStatus, updatedAt = :updatedAt REMOVE dcvSessionId, sessionState'
                : 'SET instanceStatus = :instanceStatus, dcvStatus = :dcvStatus, #status = :workflowStatus, updatedAt = :updatedAt';
                
            await dynamodb.send(new UpdateCommand({
                TableName: tableName,
                Key: { instanceId },
                UpdateExpression: updateExpression,
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                    ':instanceStatus': state,
                    ':dcvStatus': 'stopped',
                    ':workflowStatus': workflowStatus,
                    ':updatedAt': new Date().toISOString()
                },
                ConditionExpression: 'attribute_exists(instanceId)'
            }));
        } else {
            await dynamodb.send(new UpdateCommand({
                TableName: tableName,
                Key: { instanceId },
                UpdateExpression: 'SET instanceStatus = :instanceStatus, updatedAt = :updatedAt',
                ExpressionAttributeValues: {
                    ':instanceStatus': state,
                    ':updatedAt': new Date().toISOString()
                },
                ConditionExpression: 'attribute_exists(instanceId)'
            }));
        }
        
        console.log('Updated instance', instanceId, '- status:', state);
    } catch (error) {
        if (error.name === 'ConditionalCheckFailedException') {
            console.log('Instance', instanceId, 'not found in workstation table - ignoring');
        } else {
            console.error('Error updating workstation status:', error);
            throw error;
        }
    }
};
`;
}

// Generate DCV Status Sync Lambda code (inline for CloudFormation)
function generateDcvStatusSyncCode() {
  return `
import json
import os
import boto3
import urllib.request
import urllib.parse
import urllib.error
import ssl
import base64
from datetime import datetime

def safe_urlopen(url_or_request, *args, **kwargs):
    if isinstance(url_or_request, urllib.request.Request):
        url_to_check = url_or_request.full_url
    else:
        url_to_check = url_or_request
    parsed = urllib.parse.urlparse(url_to_check)
    if parsed.scheme not in ['https']:
        raise ValueError(f"Unsafe URL scheme: {parsed.scheme}")
    return urllib.request.urlopen(url_or_request, *args, **kwargs)

def lambda_handler(event, context):
    print("Starting DCV connection status sync for regional hub...")
    
    pascal_case_name = os.environ.get('PASCAL_CASE_NAME', 'MediaResourceManager')
    primary_region = os.environ.get('PRIMARY_REGION')
    current_region = os.environ.get('CURRENT_REGION')
    workstation_table_name = os.environ.get('WORKSTATION_TABLE_NAME', 'workstation-instances')
    
    # Connect to DynamoDB in primary region
    dynamodb = boto3.resource('dynamodb', region_name=primary_region)
    table = dynamodb.Table(workstation_table_name)
    
    # SSM client for current region (where Session Manager is)
    ssm = boto3.client('ssm')
    
    # EC2 client for current region
    ec2 = boto3.client('ec2')
    
    try:
        # Get SSM parameters for DCV Session Manager (in current region)
        print("Getting SSM parameters...")
        client_id = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientId')['Parameter']['Value']
        client_password = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientPassword', WithDecryption=True)['Parameter']['Value']
        private_dns = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/Endpoint')['Parameter']['Value']
        
        # Create SSL context
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        
        # Get OAuth2 token
        print("Getting OAuth2 token...")
        token_url = f"https://{private_dns}:8443/oauth2/token?grant_type=client_credentials"
        credentials = f"{client_id}:{client_password}"
        encoded_credentials = base64.b64encode(credentials.encode()).decode()
        
        token_request = urllib.request.Request(
            token_url,
            method='POST',
            headers={'Authorization': f'Basic {encoded_credentials}'}
        )
        
        with safe_urlopen(token_request, context=ssl_context, timeout=10) as response:
            token_data = json.loads(response.read().decode())
            access_token = token_data['access_token']
        
        base_url = f"https://{private_dns}:8443"
        
        # Get all servers
        print("Getting server list...")
        describe_request = urllib.request.Request(
            f"{base_url}/describeServers",
            data=json.dumps({}).encode(),
            headers={
                'Authorization': f'Bearer {access_token}',
                'Content-Type': 'application/json'
            },
            method='POST'
        )
        
        with safe_urlopen(describe_request, context=ssl_context, timeout=10) as response:
            servers_data = json.loads(response.read().decode())
        
        # Get all sessions
        print("Getting session list...")
        sessions_request = urllib.request.Request(
            f"{base_url}/describeSessions",
            data=json.dumps({}).encode(),
            headers={
                'Authorization': f'Bearer {access_token}',
                'Content-Type': 'application/json'
            },
            method='POST'
        )
        
        with safe_urlopen(sessions_request, context=ssl_context, timeout=10) as response:
            sessions_data = json.loads(response.read().decode())
        
        # Process each server and match to DynamoDB instances by IP
        updated_count = 0
        for server in servers_data.get('Servers', []):
            server_ip = server.get('Ip')
            if not server_ip:
                continue
            
            # Find EC2 instance by private IP (in current region)
            try:
                ec2_response = ec2.describe_instances(
                    Filters=[
                        {'Name': 'private-ip-address', 'Values': [server_ip]},
                        {'Name': 'instance-state-name', 'Values': ['running', 'stopped', 'stopping']}
                    ]
                )
                
                instance_id = None
                instance_state = None
                for reservation in ec2_response['Reservations']:
                    for instance in reservation['Instances']:
                        if instance['PrivateIpAddress'] == server_ip:
                            instance_id = instance['InstanceId']
                            instance_state = instance['State']['Name']
                            break
                    if instance_id:
                        break
                
                if not instance_id:
                    continue
                    
            except Exception as e:
                print(f"Error finding instance for IP {server_ip}: {e}")
                continue
                
            print(f"Processing server for instance {instance_id}")
            
            # Find sessions for this server
            server_sessions = []
            for session in sessions_data.get('Sessions', []):
                if session.get('Server', {}).get('Id') == server.get('Id'):
                    server_sessions.append(session)
            
            # Calculate connection metrics
            total_connections = sum(session.get('NumOfConnections', 0) for session in server_sessions)
            
            # Find the most recent session for state info
            latest_session = None
            latest_time = None
            for session in server_sessions:
                if session.get('State') in ['READY', 'CREATING']:
                    creation_time = session.get('CreationTime')
                    if creation_time and (not latest_time or creation_time > latest_time):
                        latest_session = session
                        latest_time = creation_time
            
            # Prepare update data
            update_data = {
                'connectionCount': total_connections,
                'lastStatusCheck': datetime.utcnow().isoformat() + 'Z',
                'instanceStatus': instance_state
            }
            
            if latest_session:
                update_data['sessionState'] = latest_session.get('State', 'UNKNOWN')
                update_data['dcvSessionId'] = latest_session.get('Id')
                
                # Add last disconnection time if available
                last_disconnect = latest_session.get('LastDisconnectionTime')
                if last_disconnect:
                    update_data['lastDisconnectionTime'] = last_disconnect
            else:
                update_data['sessionState'] = 'NO_SESSION'
                update_data['dcvSessionId'] = None
            
            # Update DynamoDB in primary region
            try:
                update_expr = 'SET connectionCount = :cc, sessionState = :ss, lastStatusCheck = :lsc, dcvSessionId = :sid, instanceStatus = :ist'
                expr_values = {
                    ':cc': update_data['connectionCount'],
                    ':ss': update_data['sessionState'],
                    ':lsc': update_data['lastStatusCheck'],
                    ':sid': update_data['dcvSessionId'],
                    ':ist': update_data['instanceStatus']
                }
                
                if 'lastDisconnectionTime' in update_data:
                    update_expr += ', lastDisconnectionTime = :ldt'
                    expr_values[':ldt'] = update_data['lastDisconnectionTime']
                
                table.update_item(
                    Key={'instanceId': instance_id},
                    UpdateExpression=update_expr,
                    ExpressionAttributeValues=expr_values,
                    ConditionExpression='attribute_exists(instanceId)'
                )
                updated_count += 1
                print(f"Updated status for instance {instance_id}: {total_connections} connections, state: {update_data['sessionState']}")
                
            except dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
                print(f"Instance {instance_id} not found in workstation table - skipping")
            except Exception as e:
                print(f"Error updating instance {instance_id}: {e}")
        
        print(f"DCV connection status sync completed: {updated_count} instances updated")
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'Status sync completed',
                'region': current_region,
                'instancesUpdated': updated_count
            })
        }
        
    except Exception as e:
        print(f"Error in status sync: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }
`;
}

// Generate Manual Cleanup Lambda code (inline for CloudFormation)
function generateManualCleanupCode() {
  return `
import json
import os
import boto3
import urllib.request
import urllib.parse
import urllib.error
import ssl
import base64

def safe_urlopen(url_or_request, *args, **kwargs):
    if isinstance(url_or_request, urllib.request.Request):
        url_to_check = url_or_request.full_url
    else:
        url_to_check = url_or_request
    parsed = urllib.parse.urlparse(url_to_check)
    if parsed.scheme not in ['https']:
        raise ValueError(f"Unsafe URL scheme: {parsed.scheme}")
    return urllib.request.urlopen(url_or_request, *args, **kwargs)

def lambda_handler(event, context):
    """
    Manual cleanup function that can:
    1. Clean up all stale DCV servers (instances that no longer exist)
    2. Clean up a specific session by instanceId
    3. List all servers and sessions for debugging
    
    Event format:
    - { "action": "cleanup-stale" } - Clean up all stale servers
    - { "action": "cleanup-session", "instanceId": "i-xxx" } - Clean up sessions for specific instance
    - { "action": "list" } - List all servers and sessions
    """
    print(f'Manual DCV cleanup event: {json.dumps(event, indent=2)}')
    
    pascal_case_name = os.environ.get('PASCAL_CASE_NAME', 'MediaResourceManager')
    current_region = os.environ.get('CURRENT_REGION')
    
    action = event.get('action', 'cleanup-stale')
    target_instance_id = event.get('instanceId')
    
    try:
        # Get SSM parameters
        ssm = boto3.client('ssm')
        
        session_manager_dns = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/Endpoint')['Parameter']['Value']
        client_id = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientId')['Parameter']['Value']
        client_password = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientPassword', WithDecryption=True)['Parameter']['Value']
        
        print(f'Got parameters - endpoint: {session_manager_dns}')
        
        # Create SSL context
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        
        # Get OAuth2 token
        token_url = f"https://{session_manager_dns}:8443/oauth2/token?grant_type=client_credentials"
        credentials = f"{client_id}:{client_password}"
        encoded_credentials = base64.b64encode(credentials.encode()).decode()
        
        token_request = urllib.request.Request(
            token_url,
            method='POST',
            headers={'Authorization': f'Basic {encoded_credentials}'}
        )
        
        with safe_urlopen(token_request, context=ssl_context, timeout=10) as response:
            token_data = json.loads(response.read().decode())
            access_token = token_data['access_token']
        
        base_url = f"https://{session_manager_dns}:8443"
        
        # Get all servers
        describe_request = urllib.request.Request(
            f"{base_url}/describeServers",
            data=json.dumps({}).encode(),
            headers={
                'Authorization': f'Bearer {access_token}',
                'Content-Type': 'application/json'
            },
            method='POST'
        )
        
        with safe_urlopen(describe_request, context=ssl_context, timeout=10) as response:
            servers_data = json.loads(response.read().decode())
            servers = servers_data.get('Servers', [])
        
        # Get all sessions
        sessions_request = urllib.request.Request(
            f"{base_url}/describeSessions",
            data=json.dumps({}).encode(),
            headers={
                'Authorization': f'Bearer {access_token}',
                'Content-Type': 'application/json'
            },
            method='POST'
        )
        
        with safe_urlopen(sessions_request, context=ssl_context, timeout=10) as response:
            sessions_data = json.loads(response.read().decode())
            sessions = sessions_data.get('Sessions', [])
        
        # Handle different actions
        if action == 'list':
            return {
                'success': True,
                'region': current_region,
                'servers': [{'id': s.get('Id'), 'ip': s.get('Ip'), 'instanceId': s.get('Host', {}).get('Aws', {}).get('EC2InstanceId'), 'availability': s.get('Availability')} for s in servers],
                'sessions': [{'id': s.get('Id'), 'name': s.get('Name'), 'owner': s.get('Owner'), 'state': s.get('State'), 'serverId': s.get('Server', {}).get('Id')} for s in sessions]
            }
        
        elif action == 'cleanup-session' and target_instance_id:
            # Find server for this instance
            ec2 = boto3.client('ec2')
            try:
                instance_response = ec2.describe_instances(InstanceIds=[target_instance_id])
                instance_ip = instance_response['Reservations'][0]['Instances'][0]['PrivateIpAddress']
            except Exception as e:
                return {'success': False, 'error': f'Could not find instance {target_instance_id}: {str(e)}'}
            
            # Find sessions on this server
            sessions_deleted = 0
            for session in sessions:
                server_ip = None
                for server in servers:
                    if server.get('Id') == session.get('Server', {}).get('Id'):
                        server_ip = server.get('Ip')
                        break
                
                if server_ip == instance_ip:
                    try:
                        delete_data = [{'SessionId': session.get('Id'), 'Owner': session.get('Owner'), 'Force': True}]
                        delete_request = urllib.request.Request(
                            f"{base_url}/deleteSessions",
                            data=json.dumps(delete_data).encode(),
                            headers={'Authorization': f'Bearer {access_token}', 'Content-Type': 'application/json'}
                        )
                        with safe_urlopen(delete_request, context=ssl_context, timeout=10):
                            sessions_deleted += 1
                            print(f"Deleted session {session.get('Id')} for instance {target_instance_id}")
                    except Exception as e:
                        print(f"Failed to delete session: {e}")
            
            return {
                'success': True,
                'region': current_region,
                'instanceId': target_instance_id,
                'sessionsDeleted': sessions_deleted
            }
        
        else:  # cleanup-stale
            # Get all running instances
            ec2 = boto3.client('ec2')
            running_instances = set()
            
            try:
                response = ec2.describe_instances(
                    Filters=[{'Name': 'instance-state-name', 'Values': ['running', 'pending', 'stopping']}]
                )
                for reservation in response['Reservations']:
                    for instance in reservation['Instances']:
                        running_instances.add(instance['InstanceId'])
            except Exception as e:
                print(f"Error getting running instances: {e}")
                return {'success': False, 'error': str(e)}
            
            # Find stale servers
            stale_servers = []
            for server in servers:
                server_instance_id = server.get('Host', {}).get('Aws', {}).get('EC2InstanceId')
                if server_instance_id and server_instance_id not in running_instances:
                    stale_servers.append({
                        'id': server.get('Id'),
                        'instanceId': server_instance_id,
                        'availability': server.get('Availability')
                    })
            
            print(f"Found {len(stale_servers)} stale servers to clean up")
            
            # Clean up stale servers
            cleaned_count = 0
            for server_info in stale_servers:
                server_id = server_info['id']
                instance_id = server_info['instanceId']
                
                try:
                    # First clean up sessions on this server
                    for session in sessions:
                        if session.get('Server', {}).get('Id') == server_id:
                            try:
                                delete_data = [{'SessionId': session.get('Id'), 'Owner': session.get('Owner'), 'Force': True}]
                                delete_request = urllib.request.Request(
                                    f"{base_url}/deleteSessions",
                                    data=json.dumps(delete_data).encode(),
                                    headers={'Authorization': f'Bearer {access_token}', 'Content-Type': 'application/json'}
                                )
                                with safe_urlopen(delete_request, context=ssl_context, timeout=10):
                                    print(f"Deleted session {session.get('Id')} on stale server {server_id}")
                            except Exception as e:
                                print(f"Failed to delete session: {e}")
                    
                    # Delete server
                    remove_request = urllib.request.Request(
                        f"{base_url}/servers/{server_id}",
                        headers={
                            'Authorization': f'Bearer {access_token}',
                            'Content-Type': 'application/json'
                        },
                        method='DELETE'
                    )
                    
                    with safe_urlopen(remove_request, context=ssl_context, timeout=10):
                        print(f"Removed stale server {server_id} for instance {instance_id}")
                        cleaned_count += 1
                        
                except Exception as e:
                    print(f"Failed to remove server {server_id}: {e}")
            
            return {
                'success': True,
                'region': current_region,
                'totalServers': len(servers),
                'runningInstances': len(running_instances),
                'staleServers': len(stale_servers),
                'cleanedUp': cleaned_count,
                'message': f'Cleaned up {cleaned_count} of {len(stale_servers)} stale servers'
            }
        
    except Exception as error:
        print(f"Manual cleanup failed: {error}")
        return {'success': False, 'error': str(error)}
`;
}

// Helper function to calculate subnet CIDRs from VPC CIDR
// Similar to how CDK calculates subnets at synth time
function calculateSubnetCidrs(vpcCidr, publicMask, privateMask, azCount) {
  // Parse VPC CIDR
  const [vpcIp, vpcPrefix] = vpcCidr.split('/');
  const vpcPrefixNum = parseInt(vpcPrefix, 10);
  const vpcIpNum = ipToNumber(vpcIp);
  
  // Calculate subnet sizes
  const publicSubnetSize = Math.pow(2, 32 - publicMask);
  const privateSubnetSize = Math.pow(2, 32 - privateMask);
  
  const subnets = {
    public: [],
    private: []
  };
  
  let currentOffset = 0;
  
  // Allocate public subnets first (smaller, at the beginning)
  for (let i = 0; i < azCount; i++) {
    const subnetIp = numberToIp(vpcIpNum + currentOffset);
    subnets.public.push(`${subnetIp}/${publicMask}`);
    currentOffset += publicSubnetSize;
  }
  
  // Align to next private subnet boundary (e.g., /24 boundary)
  // CDK aligns larger subnets to their natural boundaries
  const alignmentSize = privateSubnetSize;
  if (currentOffset % alignmentSize !== 0) {
    currentOffset = Math.ceil(currentOffset / alignmentSize) * alignmentSize;
  }
  
  // Allocate private subnets (larger, after public, aligned)
  for (let i = 0; i < azCount; i++) {
    const subnetIp = numberToIp(vpcIpNum + currentOffset);
    subnets.private.push(`${subnetIp}/${privateMask}`);
    currentOffset += privateSubnetSize;
  }
  
  return subnets;
}

function ipToNumber(ip) {
  const parts = ip.split('.').map(Number);
  return (parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function numberToIp(num) {
  return [
    (num >>> 24) & 255,
    (num >>> 16) & 255,
    (num >>> 8) & 255,
    num & 255
  ].join('.');
}


// Generate subnet resources dynamically based on AZ count
function generateSubnetResources(subnetCidrs, azCount) {
  const resources = {};
  
  // Generate public subnets and their route table associations
  for (let i = 0; i < azCount; i++) {
    const num = i + 1;
    resources[`PublicSubnet${num}`] = {
      Type: 'AWS::EC2::Subnet',
      Properties: {
        VpcId: { Ref: 'VPC' },
        AvailabilityZoneId: { 'Fn::Select': [i, { Ref: 'AvailabilityZones' }] },
        CidrBlock: subnetCidrs.public[i],
        MapPublicIpOnLaunch: true,
        Tags: [{ Key: 'Name', Value: { 'Fn::Sub': `\${ProductName}-Regional-Public-${num}` } }]
      }
    };
    
    resources[`PublicSubnet${num}RouteTableAssociation`] = {
      Type: 'AWS::EC2::SubnetRouteTableAssociation',
      Properties: {
        SubnetId: { Ref: `PublicSubnet${num}` },
        RouteTableId: { Ref: 'PublicRouteTable' }
      }
    };
  }
  
  // Generate private subnets and their route table associations
  for (let i = 0; i < azCount; i++) {
    const num = i + 1;
    resources[`PrivateSubnet${num}`] = {
      Type: 'AWS::EC2::Subnet',
      Properties: {
        VpcId: { Ref: 'VPC' },
        AvailabilityZoneId: { 'Fn::Select': [i, { Ref: 'AvailabilityZones' }] },
        CidrBlock: subnetCidrs.private[i],
        MapPublicIpOnLaunch: false,
        Tags: [{ Key: 'Name', Value: { 'Fn::Sub': `\${ProductName}-Regional-Private-${num}` } }]
      }
    };
    
    resources[`PrivateSubnet${num}RouteTableAssociation`] = {
      Type: 'AWS::EC2::SubnetRouteTableAssociation',
      Properties: {
        SubnetId: { Ref: `PrivateSubnet${num}` },
        RouteTableId: { Ref: 'PrivateRouteTable' }
      }
    };
  }
  
  return resources;
}


// Generate array of subnet references for use in NLBs, ASGs, etc.
function getSubnetRefs(type, azCount) {
  const refs = [];
  for (let i = 1; i <= azCount; i++) {
    refs.push({ Ref: `${type}Subnet${i}` });
  }
  return refs;
}

// Generate DCV Lambda resources (S3-based code for VPC access to Session Manager API)
function generateDcvLambdaResources(acronymLower, privateSubnetRefs, lambdaAssets, enableWindows, enableLinux, enableMacOS) {
  const resources = {};

  // DCV Lambda Security Group (allows outbound to Session Manager NLB)
  resources.DcvLambdaSecurityGroup = {
    Type: 'AWS::EC2::SecurityGroup',
    Properties: {
      GroupName: { 'Fn::Sub': '${ProductName}-Regional-DCV-Lambda-SG' },
      GroupDescription: 'Security group for DCV Lambda functions to access Session Manager',
      VpcId: { Ref: 'VPC' },
      SecurityGroupEgress: [
        {
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          CidrIp: '0.0.0.0/0',
          Description: 'HTTPS outbound'
        },
        {
          IpProtocol: 'tcp',
          FromPort: 8443,
          ToPort: 8445,
          CidrIp: '0.0.0.0/0',
          Description: 'DCV Session Manager API ports'
        }
      ],
      Tags: [
        { Key: 'Name', Value: { 'Fn::Sub': '${ProductName}-Regional-DCV-Lambda-SG' } },
        { Key: 'ManagedBy', Value: { Ref: 'ProductName' } }
      ]
    }
  };

  // IAM Role for DCV Lambdas
  resources.DcvLambdaRole = {
    Type: 'AWS::IAM::Role',
    Properties: {
      RoleName: { 'Fn::Sub': '${ProductName}-Regional-DCV-Lambda-Role' },
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }]
      },
      ManagedPolicyArns: [
        'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole'
      ],
      Policies: [
        {
          PolicyName: 'DcvLambdaPermissions',
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['ssm:GetParameter', 'ssm:GetParameters'],
                Resource: { 'Fn::Sub': 'arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/${ProductName}/*' }
              },
              {
                Effect: 'Allow',
                Action: ['dynamodb:UpdateItem', 'dynamodb:GetItem', 'dynamodb:Query'],
                Resource: { 'Fn::Sub': 'arn:aws:dynamodb:${PrimaryRegion}:${AWS::AccountId}:table/*' }
              },
              {
                Effect: 'Allow',
                Action: ['ec2:DescribeInstances'],
                Resource: '*'
              },
              {
                Effect: 'Allow',
                Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
                Resource: { 'Fn::Sub': 'arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/*' }
              },
              {
                'Fn::If': [
                  'HasKmsKey',
                  {
                    Effect: 'Allow',
                    Action: ['kms:Decrypt', 'kms:GenerateDataKey'],
                    Resource: { Ref: 'DynamoDbKmsKeyArn' }
                  },
                  { Ref: 'AWS::NoValue' }
                ]
              }
            ]
          }
        }
      ]
    }
  };

  // DCV Session Manager Lambda (create/delete sessions)
  if (lambdaAssets.dcvSessionManager && lambdaAssets.dcvSessionManager.bucket) {
    resources.DcvSessionManagerFunction = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        FunctionName: `${acronymLower}-regional-dcv-session-manager`,
        Runtime: 'python3.12',
        Handler: 'index.lambda_handler',
        Role: { 'Fn::GetAtt': ['DcvLambdaRole', 'Arn'] },
        Timeout: 120,
        MemorySize: 256,
        ReservedConcurrentExecutions: 10,
        VpcConfig: {
          SubnetIds: privateSubnetRefs,
          SecurityGroupIds: [{ Ref: 'DcvLambdaSecurityGroup' }]
        },
        Environment: {
          Variables: {
            PASCAL_CASE_NAME: { Ref: 'ProductName' },
            PRIMARY_REGION: { Ref: 'PrimaryRegion' },
            WORKSTATION_TABLE_NAME: { Ref: 'WorkstationTableName' }
          }
        },
        Code: {
          S3Bucket: lambdaAssets.dcvSessionManager.bucket,
          S3Key: lambdaAssets.dcvSessionManager.key
        }
      }
    };
  }

  // DCV Session Cleanup Lambda
  if (lambdaAssets.dcvSessionCleanup && lambdaAssets.dcvSessionCleanup.bucket) {
    resources.DcvSessionCleanupFunction = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        FunctionName: `${acronymLower}-regional-dcv-session-cleanup`,
        Runtime: 'python3.12',
        Handler: 'index.lambda_handler',
        Role: { 'Fn::GetAtt': ['DcvLambdaRole', 'Arn'] },
        Timeout: 300,
        MemorySize: 256,
        ReservedConcurrentExecutions: 5,
        VpcConfig: {
          SubnetIds: privateSubnetRefs,
          SecurityGroupIds: [{ Ref: 'DcvLambdaSecurityGroup' }]
        },
        Environment: {
          Variables: {
            PASCAL_CASE_NAME: { Ref: 'ProductName' },
            PRIMARY_REGION: { Ref: 'PrimaryRegion' },
            WORKSTATION_TABLE_NAME: { Ref: 'WorkstationTableName' }
          }
        },
        Code: {
          S3Bucket: lambdaAssets.dcvSessionCleanup.bucket,
          S3Key: lambdaAssets.dcvSessionCleanup.key
        }
      }
    };
  }

  // DCV Readiness Check - Windows (conditional)
  if (enableWindows && lambdaAssets.dcvReadinessCheckWindows && lambdaAssets.dcvReadinessCheckWindows.bucket) {
    resources.DcvReadinessCheckWindowsFunction = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        FunctionName: `${acronymLower}-regional-dcv-readiness-check-windows`,
        Runtime: 'python3.12',
        Handler: 'index.lambda_handler',
        Role: { 'Fn::GetAtt': ['DcvLambdaRole', 'Arn'] },
        Timeout: 120,
        MemorySize: 256,
        ReservedConcurrentExecutions: 10,
        VpcConfig: {
          SubnetIds: privateSubnetRefs,
          SecurityGroupIds: [{ Ref: 'DcvLambdaSecurityGroup' }]
        },
        Environment: {
          Variables: {
            PASCAL_CASE_NAME: { Ref: 'ProductName' },
            PRIMARY_REGION: { Ref: 'PrimaryRegion' },
            WORKSTATION_TABLE_NAME: { Ref: 'WorkstationTableName' }
          }
        },
        Code: {
          S3Bucket: lambdaAssets.dcvReadinessCheckWindows.bucket,
          S3Key: lambdaAssets.dcvReadinessCheckWindows.key
        }
      }
    };
  }

  // DCV Readiness Check - Linux (conditional)
  if (enableLinux && lambdaAssets.dcvReadinessCheckLinux && lambdaAssets.dcvReadinessCheckLinux.bucket) {
    resources.DcvReadinessCheckLinuxFunction = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        FunctionName: `${acronymLower}-regional-dcv-readiness-check-linux`,
        Runtime: 'python3.12',
        Handler: 'index.lambda_handler',
        Role: { 'Fn::GetAtt': ['DcvLambdaRole', 'Arn'] },
        Timeout: 120,
        MemorySize: 256,
        ReservedConcurrentExecutions: 10,
        VpcConfig: {
          SubnetIds: privateSubnetRefs,
          SecurityGroupIds: [{ Ref: 'DcvLambdaSecurityGroup' }]
        },
        Environment: {
          Variables: {
            PASCAL_CASE_NAME: { Ref: 'ProductName' },
            PRIMARY_REGION: { Ref: 'PrimaryRegion' },
            WORKSTATION_TABLE_NAME: { Ref: 'WorkstationTableName' }
          }
        },
        Code: {
          S3Bucket: lambdaAssets.dcvReadinessCheckLinux.bucket,
          S3Key: lambdaAssets.dcvReadinessCheckLinux.key
        }
      }
    };
  }

  // DCV Readiness Check - macOS (conditional)
  if (enableMacOS && lambdaAssets.dcvReadinessCheckMacos && lambdaAssets.dcvReadinessCheckMacos.bucket) {
    resources.DcvReadinessCheckMacosFunction = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        FunctionName: `${acronymLower}-regional-dcv-readiness-check-macos`,
        Runtime: 'python3.12',
        Handler: 'index.lambda_handler',
        Role: { 'Fn::GetAtt': ['DcvLambdaRole', 'Arn'] },
        Timeout: 120,
        MemorySize: 256,
        ReservedConcurrentExecutions: 10,
        VpcConfig: {
          SubnetIds: privateSubnetRefs,
          SecurityGroupIds: [{ Ref: 'DcvLambdaSecurityGroup' }]
        },
        Environment: {
          Variables: {
            PASCAL_CASE_NAME: { Ref: 'ProductName' },
            PRIMARY_REGION: { Ref: 'PrimaryRegion' },
            WORKSTATION_TABLE_NAME: { Ref: 'WorkstationTableName' }
          }
        },
        Code: {
          S3Bucket: lambdaAssets.dcvReadinessCheckMacos.bucket,
          S3Key: lambdaAssets.dcvReadinessCheckMacos.key
        }
      }
    };
  }

  // Configure ONTAP CIFS Lambda - configures SMB/CIFS on FSx ONTAP in regional hubs
  // Needs VPC access to SSH to FSx ONTAP SVM management endpoint
  if (lambdaAssets.configureOntapCifs && lambdaAssets.configureOntapCifs.bucket) {
    // Security group for ONTAP CIFS configurator (needs SSH and HTTPS to FSx ONTAP)
    resources.OntapCifsLambdaSecurityGroup = {
      Type: 'AWS::EC2::SecurityGroup',
      Properties: {
        GroupName: { 'Fn::Sub': '${ProductName}-Regional-ONTAP-CIFS-Lambda-SG' },
        GroupDescription: 'Security group for ONTAP CIFS Lambda to access FSx ONTAP management',
        VpcId: { Ref: 'VPC' },
        SecurityGroupEgress: [
          {
            IpProtocol: 'tcp',
            FromPort: 22,
            ToPort: 22,
            CidrIp: '0.0.0.0/0',
            Description: 'SSH to FSx ONTAP SVM management'
          },
          {
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
            CidrIp: '0.0.0.0/0',
            Description: 'HTTPS to FSx ONTAP REST API'
          }
        ],
        Tags: [
          { Key: 'Name', Value: { 'Fn::Sub': '${ProductName}-Regional-ONTAP-CIFS-Lambda-SG' } },
          { Key: 'ManagedBy', Value: { Ref: 'ProductName' } }
        ]
      }
    };

    // IAM Role for ONTAP CIFS Lambda
    resources.OntapCifsLambdaRole = {
      Type: 'AWS::IAM::Role',
      Properties: {
        RoleName: { 'Fn::Sub': '${ProductName}-Regional-ONTAP-CIFS-Lambda-Role' },
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: 'sts:AssumeRole'
          }]
        },
        ManagedPolicyArns: [
          'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole'
        ],
        Policies: [{
          PolicyName: 'OntapCifsLambdaPolicy',
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: [
                  'secretsmanager:GetSecretValue',
                  'secretsmanager:UpdateSecret'
                ],
                Resource: { 'Fn::Sub': 'arn:aws:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:/${ProductName}/Storage/*' }
              },
              {
                Effect: 'Allow',
                Action: [
                  'fsx:DescribeStorageVirtualMachines'
                ],
                Resource: '*'
              }
            ]
          }
        }],
        Tags: [
          { Key: 'ManagedBy', Value: { Ref: 'ProductName' } }
        ]
      }
    };

    resources.ConfigureOntapCifsFunction = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        FunctionName: `${acronymLower}-regional-configure-ontap-cifs`,
        Runtime: 'nodejs22.x',
        Handler: 'index.handler',
        Role: { 'Fn::GetAtt': ['OntapCifsLambdaRole', 'Arn'] },
        Timeout: 300,
        MemorySize: 256,
        ReservedConcurrentExecutions: 5,
        VpcConfig: {
          SubnetIds: privateSubnetRefs,
          SecurityGroupIds: [{ Ref: 'OntapCifsLambdaSecurityGroup' }]
        },
        Environment: {
          Variables: {
            PASCAL_CASE_NAME: { Ref: 'ProductName' },
            PRIMARY_REGION: { Ref: 'PrimaryRegion' }
          }
        },
        Code: {
          S3Bucket: lambdaAssets.configureOntapCifs.bucket,
          S3Key: lambdaAssets.configureOntapCifs.key
        }
      }
    };
  }

  return resources;
}


// Generate macOS Dedicated Host resources (License Configuration + Host Resource Group)
function generateMacOSResources(productName, acronymLower) {
  return {
    // IAM Role for the License Configuration Custom Resource Lambda
    MacOSLicenseConfigRole: {
      Type: 'AWS::IAM::Role',
      Properties: {
        RoleName: { 'Fn::Sub': '${ProductName}-Regional-MacOS-LicenseConfig-Role' },
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: 'sts:AssumeRole'
          }]
        },
        ManagedPolicyArns: [
          'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
        ],
        Policies: [{
          PolicyName: 'LicenseManagerAccess',
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: [
                  'license-manager:CreateLicenseConfiguration',
                  'license-manager:DeleteLicenseConfiguration',
                  'license-manager:GetLicenseConfiguration',
                  'license-manager:ListLicenseConfigurations',
                  'license-manager:UpdateLicenseConfiguration',
                  'license-manager:TagResource'
                ],
                Resource: '*'
              },
              {
                Effect: 'Allow',
                Action: [
                  'iam:CreateServiceLinkedRole'
                ],
                Resource: 'arn:aws:iam::*:role/aws-service-role/license-manager.amazonaws.com/*',
                Condition: {
                  StringEquals: {
                    'iam:AWSServiceName': 'license-manager.amazonaws.com'
                  }
                }
              }
            ]
          }
        }]
      }
    },

    // Lambda function to create License Configuration (not a native CFN resource)
    MacOSLicenseConfigFunction: {
      Type: 'AWS::Lambda::Function',
      Properties: {
        FunctionName: { 'Fn::Sub': '${ProductName}-Regional-MacOS-LicenseConfig' },
        Runtime: 'nodejs22.x',
        Handler: 'index.handler',
        Role: { 'Fn::GetAtt': ['MacOSLicenseConfigRole', 'Arn'] },
        Timeout: 60,
        Code: {
          ZipFile: generateLicenseConfigLambdaCode()
        }
      }
    },

    // Custom Resource to create the License Configuration
    MacOSLicenseConfiguration: {
      Type: 'Custom::LicenseConfiguration',
      Properties: {
        ServiceToken: { 'Fn::GetAtt': ['MacOSLicenseConfigFunction', 'Arn'] },
        LicenseConfigName: { 'Fn::Sub': '${ProductName}-macOS-License' },
        Description: { 'Fn::Sub': 'License configuration for macOS dedicated hosts in ${AWS::Region}' }
      }
    },

    // Host Resource Group for macOS Dedicated Hosts (native CFN resource)
    MacHostResourceGroup: {
      Type: 'AWS::ResourceGroups::Group',
      DependsOn: 'MacOSLicenseConfiguration',
      Properties: {
        Name: { 'Fn::Sub': '${ProductName}-Mac-Host-Resource-Group' },
        Description: 'Host Resource Group for macOS Dedicated Hosts with auto-allocation',
        Configuration: [
          {
            Type: 'AWS::EC2::HostManagement',
            Parameters: [
              {
                Name: 'allowed-host-based-license-configurations',
                Values: [{ 'Fn::GetAtt': ['MacOSLicenseConfiguration', 'LicenseConfigurationArn'] }]
              },
              {
                Name: 'allowed-host-families',
                Values: ['mac2', 'mac2-m2', 'mac2-m2pro']
              },
              {
                Name: 'auto-allocate-host',
                Values: ['true']
              },
              {
                Name: 'auto-release-host',
                Values: ['false']
              }
            ]
          },
          {
            Type: 'AWS::ResourceGroups::Generic',
            Parameters: [
              {
                Name: 'allowed-resource-types',
                Values: ['AWS::EC2::Host']
              },
              {
                Name: 'deletion-protection',
                Values: ['UNLESS_EMPTY']
              }
            ]
          }
        ],
        Tags: [
          { Key: 'ManagedBy', Value: { Ref: 'ProductName' } },
          { Key: 'Purpose', Value: 'macOS-Dedicated-Host-Management' }
        ]
      }
    }
  };
}

// Generate inline Lambda code for License Configuration Custom Resource
function generateLicenseConfigLambdaCode() {
  return `
const { LicenseManagerClient, CreateLicenseConfigurationCommand, DeleteLicenseConfigurationCommand, ListLicenseConfigurationsCommand } = require('@aws-sdk/client-license-manager');
const https = require('https');
const url = require('url');

const licenseManager = new LicenseManagerClient({});

exports.handler = async (event, context) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  const requestType = event.RequestType;
  const props = event.ResourceProperties;
  const licenseConfigName = props.LicenseConfigName;
  const description = props.Description || 'License configuration for macOS Dedicated Hosts';
  
  try {
    let licenseConfigArn;
    
    if (requestType === 'Delete') {
      // Find and delete the license configuration
      const listResponse = await licenseManager.send(new ListLicenseConfigurationsCommand({
        Filters: [{ Name: 'name', Values: [licenseConfigName] }]
      }));
      
      if (listResponse.LicenseConfigurations && listResponse.LicenseConfigurations.length > 0) {
        licenseConfigArn = listResponse.LicenseConfigurations[0].LicenseConfigurationArn;
        try {
          await licenseManager.send(new DeleteLicenseConfigurationCommand({
            LicenseConfigurationArn: licenseConfigArn
          }));
          console.log('Deleted license configuration:', licenseConfigArn);
        } catch (deleteError) {
          // Ignore if already deleted or in use
          console.log('Could not delete license configuration:', deleteError.message);
        }
      }
      
      await sendResponse(event, context, 'SUCCESS', { LicenseConfigurationArn: event.PhysicalResourceId || 'deleted' });
      return;
    }
    
    // Create or Update - check if it already exists
    const listResponse = await licenseManager.send(new ListLicenseConfigurationsCommand({
      Filters: [{ Name: 'name', Values: [licenseConfigName] }]
    }));
    
    if (listResponse.LicenseConfigurations && listResponse.LicenseConfigurations.length > 0) {
      licenseConfigArn = listResponse.LicenseConfigurations[0].LicenseConfigurationArn;
      console.log('License configuration already exists:', licenseConfigArn);
    } else {
      // Create new license configuration
      const createResponse = await licenseManager.send(new CreateLicenseConfigurationCommand({
        Name: licenseConfigName,
        Description: description,
        LicenseCountingType: 'Core',
        LicenseCount: 1000,
        LicenseCountHardLimit: false,
        LicenseRules: ['#allowedTenancy=EC2-DedicatedHost'],
        Tags: [
          { Key: 'Purpose', Value: 'macOS-Dedicated-Host-Management' },
          { Key: 'ManagedBy', Value: 'CloudFormation' }
        ]
      }));
      
      licenseConfigArn = createResponse.LicenseConfigurationArn;
      console.log('Created license configuration:', licenseConfigArn);
    }
    
    await sendResponse(event, context, 'SUCCESS', {
      LicenseConfigurationArn: licenseConfigArn
    }, licenseConfigArn);
    
  } catch (error) {
    console.error('Error:', error);
    await sendResponse(event, context, 'FAILED', { Error: error.message });
  }
};

async function sendResponse(event, context, status, data, physicalResourceId) {
  const responseBody = JSON.stringify({
    Status: status,
    Reason: 'See CloudWatch Log Stream: ' + context.logStreamName,
    PhysicalResourceId: physicalResourceId || event.PhysicalResourceId || context.logStreamName,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data
  });
  
  const parsedUrl = url.parse(event.ResponseURL);
  const options = {
    hostname: parsedUrl.hostname,
    port: 443,
    path: parsedUrl.path,
    method: 'PUT',
    headers: {
      'Content-Type': '',
      'Content-Length': responseBody.length
    }
  };
  
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      console.log('Status code:', res.statusCode);
      resolve();
    });
    req.on('error', (e) => {
      console.error('Error sending response:', e);
      reject(e);
    });
    req.write(responseBody);
    req.end();
  });
}
`;
}


// Generate inline Lambda code for TLS certificate replication from primary region
function generateTlsCertReplicatorLambdaCode() {
  return `
const { SecretsManagerClient, GetSecretValueCommand, CreateSecretCommand, UpdateSecretCommand, DescribeSecretCommand, TagResourceCommand } = require('@aws-sdk/client-secrets-manager');
const https = require('https');
const url = require('url');

exports.handler = async (event, context) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  const requestType = event.RequestType;
  const sourceRegion = process.env.SOURCE_REGION;
  const sourceSecretName = process.env.SOURCE_SECRET_NAME;
  const targetSecretName = event.ResourceProperties.TargetSecretName;
  
  // Get current region from Lambda environment
  const targetRegion = process.env.AWS_REGION;
  
  console.log('Source:', sourceRegion, sourceSecretName);
  console.log('Target:', targetRegion, targetSecretName);
  
  try {
    if (requestType === 'Delete') {
      // On delete, we leave the secret in place for safety
      // It can be manually deleted if needed
      console.log('Delete requested - leaving secret in place for safety');
      await sendResponse(event, context, 'SUCCESS', { Message: 'Secret retained for safety' });
      return;
    }
    
    // Create or Update - copy secret from source region
    const sourceClient = new SecretsManagerClient({ region: sourceRegion });
    const targetClient = new SecretsManagerClient({ region: targetRegion });
    
    // Get secret from source region
    console.log('Retrieving secret from source region...');
    let sourceSecret;
    try {
      const getResponse = await sourceClient.send(new GetSecretValueCommand({
        SecretId: sourceSecretName
      }));
      sourceSecret = getResponse.SecretString;
      console.log('Successfully retrieved source secret');
    } catch (error) {
      if (error.name === 'ResourceNotFoundException') {
        console.log('Source secret not found - this is OK if no custom TLS cert is configured');
        await sendResponse(event, context, 'SUCCESS', { 
          Message: 'Source secret not found - using self-signed certificate',
          SecretArn: 'none'
        });
        return;
      }
      throw error;
    }
    
    // Check if target secret exists
    let secretExists = false;
    let secretArn;
    try {
      const describeResponse = await targetClient.send(new DescribeSecretCommand({
        SecretId: targetSecretName
      }));
      secretExists = true;
      secretArn = describeResponse.ARN;
      console.log('Target secret exists:', secretArn);
    } catch (error) {
      if (error.name !== 'ResourceNotFoundException') {
        throw error;
      }
      console.log('Target secret does not exist, will create');
    }
    
    if (secretExists) {
      // Update existing secret
      console.log('Updating existing secret...');
      await targetClient.send(new UpdateSecretCommand({
        SecretId: targetSecretName,
        SecretString: sourceSecret,
        Description: 'TLS certificate replicated from primary region for DCV Connection Gateway'
      }));
      console.log('Secret updated successfully');
    } else {
      // Create new secret
      console.log('Creating new secret...');
      const createResponse = await targetClient.send(new CreateSecretCommand({
        Name: targetSecretName,
        SecretString: sourceSecret,
        Description: 'TLS certificate replicated from primary region for DCV Connection Gateway',
        Tags: [
          { Key: 'ManagedBy', Value: 'CloudFormation' },
          { Key: 'Purpose', Value: 'DCV-ConnectionGateway-TLS' },
          { Key: 'SourceRegion', Value: sourceRegion }
        ]
      }));
      secretArn = createResponse.ARN;
      console.log('Secret created:', secretArn);
    }
    
    await sendResponse(event, context, 'SUCCESS', {
      SecretArn: secretArn,
      Message: 'TLS certificate replicated successfully'
    }, secretArn);
    
  } catch (error) {
    console.error('Error:', error);
    await sendResponse(event, context, 'FAILED', { Error: error.message });
  }
};

async function sendResponse(event, context, status, data, physicalResourceId) {
  const responseBody = JSON.stringify({
    Status: status,
    Reason: 'See CloudWatch Log Stream: ' + context.logStreamName,
    PhysicalResourceId: physicalResourceId || event.PhysicalResourceId || context.logStreamName,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data
  });
  
  const parsedUrl = url.parse(event.ResponseURL);
  const options = {
    hostname: parsedUrl.hostname,
    port: 443,
    path: parsedUrl.path,
    method: 'PUT',
    headers: {
      'Content-Type': '',
      'Content-Length': responseBody.length
    }
  };
  
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      console.log('Status code:', res.statusCode);
      resolve();
    });
    req.on('error', (e) => {
      console.error('Error sending response:', e);
      reject(e);
    });
    req.write(responseBody);
    req.end();
  });
}
`;
}


// Generate inline Lambda code for emptying S3 bucket on stack deletion
function generateEmptyBucketLambdaCode() {
  return `
const { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const https = require('https');
const url = require('url');

const s3 = new S3Client({});

exports.handler = async (event, context) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  const bucketName = event.ResourceProperties.BucketName;
  
  // Only empty bucket on Delete
  if (event.RequestType !== 'Delete') {
    await sendResponse(event, context, 'SUCCESS', {});
    return;
  }
  
  try {
    console.log('Emptying bucket:', bucketName);
    
    let keyMarker;
    let versionIdMarker;
    let totalDeleted = 0;
    
    do {
      // List all object versions (including delete markers)
      const listParams = { Bucket: bucketName };
      if (keyMarker) {
        listParams.KeyMarker = keyMarker;
        listParams.VersionIdMarker = versionIdMarker;
      }
      
      const listResponse = await s3.send(new ListObjectVersionsCommand(listParams));
      
      const objectsToDelete = [];
      
      // Add versions
      if (listResponse.Versions) {
        for (const version of listResponse.Versions) {
          objectsToDelete.push({ Key: version.Key, VersionId: version.VersionId });
        }
      }
      
      // Add delete markers
      if (listResponse.DeleteMarkers) {
        for (const marker of listResponse.DeleteMarkers) {
          objectsToDelete.push({ Key: marker.Key, VersionId: marker.VersionId });
        }
      }
      
      // Delete objects in batches (max 1000 per request)
      if (objectsToDelete.length > 0) {
        // Split into chunks of 1000 if needed
        for (let i = 0; i < objectsToDelete.length; i += 1000) {
          const chunk = objectsToDelete.slice(i, i + 1000);
          await s3.send(new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: chunk, Quiet: true }
          }));
          totalDeleted += chunk.length;
          console.log('Deleted', chunk.length, 'objects, total:', totalDeleted);
        }
      }
      
      // Update markers for next iteration
      keyMarker = listResponse.IsTruncated ? listResponse.NextKeyMarker : null;
      versionIdMarker = listResponse.IsTruncated ? listResponse.NextVersionIdMarker : null;
      
    } while (keyMarker);
    
    console.log('Bucket emptied successfully, total objects deleted:', totalDeleted);
    await sendResponse(event, context, 'SUCCESS', { ObjectsDeleted: totalDeleted });
    
  } catch (error) {
    console.error('Error emptying bucket:', error);
    // Don't fail the stack deletion even if bucket emptying fails
    await sendResponse(event, context, 'SUCCESS', { Error: error.message });
  }
};

async function sendResponse(event, context, status, data) {
  const responseBody = JSON.stringify({
    Status: status,
    Reason: 'See CloudWatch Log Stream: ' + context.logStreamName,
    PhysicalResourceId: event.PhysicalResourceId || context.logStreamName,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data
  });
  
  const parsedUrl = url.parse(event.ResponseURL);
  const options = {
    hostname: parsedUrl.hostname,
    port: 443,
    path: parsedUrl.path,
    method: 'PUT',
    headers: {
      'Content-Type': '',
      'Content-Length': responseBody.length
    }
  };
  
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      console.log('Status code:', res.statusCode);
      resolve();
    });
    req.on('error', (e) => {
      console.error('Error sending response:', e);
      reject(e);
    });
    req.write(responseBody);
    req.end();
  });
}
`;
}
