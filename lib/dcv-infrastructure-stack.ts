// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as fs from 'fs';
import * as path from 'path';
import { Construct } from 'constructs';
import { CleanupConstruct } from './constructs/cleanup-construct';


export interface DcvInfrastructureStackProps extends cdk.StackProps {
  productName: string;
  pascalCaseName: string;
  acronym: string;
  workstationTableName?: string;
  dcvCertificateArn?: string;
  dcvDomainName?: string;
  dcvCertificateContent?: string;  // PEM certificate content for Connection Gateway TLS
  dcvPrivateKeyContent?: string;   // PEM private key content for Connection Gateway TLS
  dataEncryptionKey?: kms.IKey;
}

const windowsDcvInstallContent = require('../ssm-documents/windows-dcv-install');
const windowsAutoLoginConfigureContent = require('../ssm-documents/windows-autologin-configure');
const windowsDisableCtrlAltDelContent = require('../ssm-documents/windows-disable-ctrl-alt-del');
const windowsSetupFsxSchedulerContent = require('../ssm-documents/windows-setup-fsx-scheduler');

// Load user data scripts from centralized location
const sessionManagerInstallScript = fs.readFileSync(path.join(__dirname, '../user-data/session-manager-install.sh'), 'utf8');
const connectionGatewayInstallScript = fs.readFileSync(path.join(__dirname, '../user-data/connection-gateway-install.sh'), 'utf8');

export class DcvInfrastructureStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly sessionManagerInstance: autoscaling.AutoScalingGroup;
  public readonly connectionGatewayAsg: autoscaling.AutoScalingGroup;
  public readonly networkLoadBalancer: elbv2.NetworkLoadBalancer;
  public readonly sessionManagerNlb: elbv2.NetworkLoadBalancer;
  public readonly workstationSecurityGroup: ec2.SecurityGroup;
  public readonly workstationLaunchTemplate: ec2.LaunchTemplate;
  public readonly standaloneAdminPasswordSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: DcvInfrastructureStackProps) {
    super(scope, id, {
      ...props,
      description: "DCV Session Manager infrastructure for remote desktop connectivity and load balancing"
    });

    // Import existing VPC from Network module
    const vpcId = ssm.StringParameter.valueForStringParameter(
      this, 
      `/${props.pascalCaseName}/Network/VpcId`
    );
    const vpcCidrBlock = ssm.StringParameter.valueForStringParameter(
      this,
      `/${props.pascalCaseName}/Network/VpcCidr`
    );

    // For CDK synth-time, we need to read the actual AZ values from parameters.json
    // to construct the VPC properly. SSM tokens don't work for fromVpcAttributes availabilityZones.
    const params = this.loadNetworkParameters();
    const azList = params.availabilityZones;
    const numAzs = azList.length;

    // Check if explicit subnet IDs are provided (for VPCs with multiple subnets per AZ)
    const hasExplicitSubnets = params.privateSubnetIds && params.privateSubnetIds.length > 0;

    // Build subnet ID arrays
    let privateSubnetIds: string[];
    let publicSubnetIds: string[];

    if (hasExplicitSubnets) {
      // Use explicit subnet IDs from parameters.json
      // This handles VPCs with multiple subnets per AZ
      // Route tables are not available for imported subnets with explicit IDs
      privateSubnetIds = params.privateSubnetIds!;
      publicSubnetIds = params.publicSubnetIds || [];
      
      this.vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedVpc', {
        vpcId: vpcId,
        vpcCidrBlock: vpcCidrBlock,
        availabilityZones: azList,
        privateSubnetIds: privateSubnetIds,
        publicSubnetIds: publicSubnetIds,
      });
    } else {
      // Build subnet ID and route table arrays dynamically based on AZ count (original behavior)
      privateSubnetIds = [];
      publicSubnetIds = [];
      const privateRouteTableIds: string[] = [];
      const publicRouteTableIds: string[] = [];
      
      for (let i = 1; i <= numAzs; i++) {
        privateSubnetIds.push(
          ssm.StringParameter.valueForStringParameter(
            this,
            `/${props.pascalCaseName}/Network/PrivateSubnet${i}/SubnetID`
          )
        );
        publicSubnetIds.push(
          ssm.StringParameter.valueForStringParameter(
            this,
            `/${props.pascalCaseName}/Network/PublicSubnet${i}/SubnetID`
          )
        );
        privateRouteTableIds.push(
          ssm.StringParameter.valueForStringParameter(
            this,
            `/${props.pascalCaseName}/Network/PrivateSubnet${i}/RouteTableID`
          )
        );
        publicRouteTableIds.push(
          ssm.StringParameter.valueForStringParameter(
            this,
            `/${props.pascalCaseName}/Network/PublicSubnet${i}/RouteTableID`
          )
        );
      }
      
      this.vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedVpc', {
        vpcId: vpcId,
        vpcCidrBlock: vpcCidrBlock,
        availabilityZones: azList,
        privateSubnetIds: privateSubnetIds,
        privateSubnetRouteTableIds: privateRouteTableIds,
        publicSubnetIds: publicSubnetIds,
        publicSubnetRouteTableIds: publicRouteTableIds,
      });
    }

    // Note: Using DHCP options provided by Modular Cloud Studio
    // MCS handles DNS resolution via Route 53 outbound endpoints

    // VPC Interface Endpoints for AWS API access from private subnets
    // The DCV session manager Lambda runs in the VPC and needs to call
    // EC2, AutoScaling, and ELB APIs for the DCV dashboard.
    // Without these endpoints (or a NAT Gateway), those API calls time out.
    const endpointSubnets = privateSubnetIds.map((subnetId, index) =>
      ec2.Subnet.fromSubnetId(this, `EndpointSubnet${index}`, subnetId)
    );
    const apiEndpoints = [
      { id: 'Ec2Endpoint', service: ec2.InterfaceVpcEndpointAwsService.EC2 },
      { id: 'AutoScalingEndpoint', service: ec2.InterfaceVpcEndpointAwsService.AUTOSCALING },
      { id: 'ElbEndpoint', service: ec2.InterfaceVpcEndpointAwsService.ELASTIC_LOAD_BALANCING },
    ];
    for (const ep of apiEndpoints) {
      new ec2.InterfaceVpcEndpoint(this, ep.id, {
        vpc: this.vpc,
        service: ep.service,
        subnets: { subnets: endpointSubnets },
        privateDnsEnabled: true,
      });
    }

    // CKV_AWS_91: S3 bucket for NLB access logs
    const nlbAccessLogsBucket = new s3.Bucket(this, 'NlbAccessLogsBucket', {
      bucketName: `${props.acronym.toLowerCase()}-nlb-logs-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [
        {
          id: 'DeleteOldLogs',
          expiration: cdk.Duration.days(90),
          noncurrentVersionExpiration: cdk.Duration.days(30),
        }
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Ensure NACL rules allow UDP traffic for DCV QUIC protocol
    // Imported VPCs may have restrictive NACLs that block UDP 8443/8444,
    // causing DCV native client connections to time out
    const ensureNaclRulesFunction = new lambda.Function(this, 'EnsureNaclRulesFunction', {
      functionName: `${props.acronym.toLowerCase()}-ensure-nacl-rules`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/ensure-nacl-rules')),
      timeout: cdk.Duration.minutes(1),
    });

    ensureNaclRulesFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:DescribeNetworkAcls',
        'ec2:CreateNetworkAclEntry',
      ],
      resources: ['*'],
    }));

    // Collect all subnet IDs (private + public) to check their NACLs
    const allSubnetIds = [
      ...privateSubnetIds,
      ...publicSubnetIds,
    ];

    const ensureNaclRulesProvider = new cr.Provider(this, 'EnsureNaclRulesProvider', {
      onEventHandler: ensureNaclRulesFunction,
    });

    new cdk.CustomResource(this, 'EnsureNaclRules', {
      serviceToken: ensureNaclRulesProvider.serviceToken,
      properties: {
        SubnetIds: allSubnetIds,
        // Force update when subnets change
        SubnetHash: allSubnetIds.join(','),
      },
    });

    // Security Groups
    const sessionManagerSg = new ec2.SecurityGroup(this, 'SessionManagerSG', {
      vpc: this.vpc,
      securityGroupName: `${props.pascalCaseName}-DCV-SessionManager-SG`,
      description: 'Security group for DCV Session Manager',
      allowAllOutbound: true,
    });

    const connectionGatewaySg = new ec2.SecurityGroup(this, 'ConnectionGatewaySG', {
      vpc: this.vpc,
      securityGroupName: `${props.pascalCaseName}-DCV-ConnectionGateway-SG`,
      description: 'Security group for DCV Connection Gateway',
      allowAllOutbound: true,
    });

    const workstationSg = new ec2.SecurityGroup(this, 'WorkstationSG', {
      vpc: this.vpc,
      securityGroupName: `${props.pascalCaseName}-DCV-Workstation-SG`,
      description: 'Security group for DCV Workstations',
      allowAllOutbound: true,
    });

    // Assign to public property
    this.workstationSecurityGroup = workstationSg;

    // Allow DCV traffic between components
    // Self-referencing rule for broker-to-broker communication
    sessionManagerSg.addIngressRule(
      sessionManagerSg,
      ec2.Port.allTraffic(),
      'allow Broker to Broker communication'
    );

    // Connection Gateway to Session Manager resolver communication
    sessionManagerSg.addIngressRule(
      connectionGatewaySg,
      ec2.Port.tcp(8447),
      'allow Gateway to Broker resolver communication'
    );

    // Get VPC CIDR from parameter store
    const vpcCidr = ssm.StringParameter.valueForStringParameter(this, `/${props.pascalCaseName}/Network/VpcCidr`);

    // Allow Gateway to Broker communication through NLB (NLB doesn't preserve source SG)
    sessionManagerSg.addIngressRule(
      ec2.Peer.ipv4(vpcCidr),
      ec2.Port.tcp(8447),
      'allow Gateway to Broker communication from NLB within VPC'
    );

    // CLI to Broker communication (external access)
    sessionManagerSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(8443),
      'allow CLI to Broker communication'
    );

    // Agent to Broker communication (workstations)
    sessionManagerSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(8445),
      'allow Agent to Broker communication'
    );

    connectionGatewaySg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(8443),
      'allow TCP DCV access from public internet'
    );

    // UDP DCV access for Connection Gateway
    connectionGatewaySg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(8443),
      'allow UDP DCV access from public internet'
    );

    // UDP DCV access on port 8444 for QUIC when TLS is enabled on 8443
    connectionGatewaySg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(8444),
      'allow UDP DCV/QUIC access from public internet (TLS mode)'
    );

    // Health check port for Network Load Balancer
    connectionGatewaySg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(8989),
      'allow health check for NLB targets'
    );

    workstationSg.addIngressRule(
      connectionGatewaySg,
      ec2.Port.tcp(8443),
      'allow DCV streaming traffic from Gateway'
    );

    // UDP DCV streaming traffic for workstations
    workstationSg.addIngressRule(
      connectionGatewaySg,
      ec2.Port.udp(8443),
      'allow DCV streaming traffic from Gateway'
    );

    // UDP DCV streaming traffic on port 8444 for QUIC when TLS is enabled
    workstationSg.addIngressRule(
      connectionGatewaySg,
      ec2.Port.udp(8444),
      'allow DCV/QUIC streaming traffic from Gateway (TLS mode)'
    );

    // Allow DCV traffic from NLB within VPC (NLB doesn't preserve source SG)
    workstationSg.addIngressRule(
      ec2.Peer.ipv4(vpcCidr),
      ec2.Port.tcp(8443),
      'allow DCV traffic from NLB within VPC'
    );

    workstationSg.addIngressRule(
      ec2.Peer.ipv4(vpcCidr),
      ec2.Port.udp(8443),
      'allow DCV traffic from NLB within VPC'
    );

    // UDP port 8444 for QUIC when TLS is enabled
    workstationSg.addIngressRule(
      ec2.Peer.ipv4(vpcCidr),
      ec2.Port.udp(8444),
      'allow DCV/QUIC traffic from NLB within VPC (TLS mode)'
    );

    // Allow SMB traffic for FSx file systems
    workstationSg.addIngressRule(
      ec2.Peer.ipv4(vpcCidr),
      ec2.Port.tcp(445),
      'allow SMB access to FSx file systems'
    );

    // Note: allowAllOutbound: true handles all egress traffic automatically

    // IAM Roles
    const sessionManagerRole = new iam.Role(this, 'SessionManagerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      roleName: `${props.pascalCaseName}-DCV-SessionManager-Role`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // DynamoDB permissions for session persistence
    sessionManagerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:BatchGetItem',
        'dynamodb:BatchWriteItem',
        'dynamodb:ConditionCheckItem',
        'dynamodb:PutItem',
        'dynamodb:DescribeTable',
        'dynamodb:DeleteItem',
        'dynamodb:GetItem',
        'dynamodb:Scan',
        'dynamodb:Query',
        'dynamodb:UpdateItem',
        'dynamodb:CreateTable',
      ],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:*/*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:*/*/index/*`,
      ],
    }));

    // SSM Parameter permissions
    sessionManagerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:DescribeParameters'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/*`],
    }));

    sessionManagerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:PutParameter', 'ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/DCV/SessionManager/Endpoint`],
    }));

    const connectionGatewayRole = new iam.Role(this, 'ConnectionGatewayRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      roleName: `${props.pascalCaseName}-DCV-ConnectionGateway-Role`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    connectionGatewayRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:DescribeParameters'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/*`],
    }));

    connectionGatewayRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/DCV/SessionManager/Endpoint`],
    }));

    // Create Secrets Manager secret for DCV TLS certificate if cert content is provided
    let dcvTlsCertSecret: secretsmanager.Secret | undefined;
    if (props.dcvCertificateContent && props.dcvPrivateKeyContent) {
      dcvTlsCertSecret = new secretsmanager.Secret(this, 'DcvTlsCertificateSecret', {
        secretName: `/${props.pascalCaseName}/DCV/ConnectionGateway/TlsCertificate`,
        description: 'TLS certificate and private key for DCV Connection Gateway',
        secretStringValue: cdk.SecretValue.unsafePlainText(JSON.stringify({
          certificate: props.dcvCertificateContent,
          privateKey: props.dcvPrivateKeyContent,
        })),
      });

      // Grant Connection Gateway role permission to read the secret
      dcvTlsCertSecret.grantRead(connectionGatewayRole);
    }

    // User data scripts - use centralized scripts from user-data/ directory
    // Prepend environment variable exports before the script
    const sessionManagerScript = `#!/bin/bash
export PRODUCT_NAME="${props.pascalCaseName}"
export ACRONYM="${props.acronym.toLowerCase()}"
export DYNAMODB_TABLE_PREFIX="dcv-session-manager-"

${sessionManagerInstallScript}`;
    
    const sessionManagerUserData = ec2.UserData.forLinux();
    sessionManagerUserData.addCommands(sessionManagerScript);

    // Connection Gateway user data - use centralized script from user-data/ directory
    // Prepend environment variable exports before the script
    const tlsSecretName = props.dcvCertificateContent && props.dcvPrivateKeyContent 
      ? `/${props.pascalCaseName}/DCV/ConnectionGateway/TlsCertificate`
      : '';
    
    const connectionGatewayScript = `#!/bin/bash
export PRODUCT_NAME="${props.pascalCaseName}"
export TLS_SECRET_NAME="${tlsSecretName}"
export TLS_SECRET_REGION="${this.region}"

${connectionGatewayInstallScript}`;
    
    const connectionGatewayUserData = ec2.UserData.forLinux();
    connectionGatewayUserData.addCommands(connectionGatewayScript);

    // DCV Session Manager Auto Scaling Group
    this.sessionManagerInstance = new autoscaling.AutoScalingGroup(this, 'SessionManagerAsg', {
      vpc: this.vpc,
      launchTemplate: new ec2.LaunchTemplate(this, 'SessionManagerLaunchTemplate', {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.M6G, ec2.InstanceSize.LARGE),
        machineImage: ec2.MachineImage.fromSsmParameter(
          '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64',
          { os: ec2.OperatingSystemType.LINUX }
        ),
        securityGroup: sessionManagerSg,
        role: sessionManagerRole,
        userData: sessionManagerUserData,
        // CKV_AWS_79: Require IMDSv2 for enhanced security
        requireImdsv2: true,
      }),
      minCapacity: 1,
      maxCapacity: 1,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    // Create Network Load Balancer for Session Manager (stable endpoint)
    const sessionManagerNlb = new elbv2.NetworkLoadBalancer(this, 'SessionManagerNLB', {
      vpc: this.vpc,
      internetFacing: false, // Internal NLB since session manager is in private subnets
      crossZoneEnabled: true, // Enable cross-zone load balancing for workstations in different AZs
      loadBalancerName: `${props.acronym.toLowerCase()}-session-manager-nlb`,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      }
    });

    // CKV_AWS_91: Enable access logging for Session Manager NLB
    sessionManagerNlb.logAccessLogs(nlbAccessLogsBucket, 'session-manager-nlb');

    // Create target group for Session Manager
    const sessionManagerTargetGroup = new elbv2.NetworkTargetGroup(this, 'SessionManagerTargetGroup', {
      vpc: this.vpc,
      port: 8445,
      protocol: elbv2.Protocol.TCP,
      targetType: elbv2.TargetType.INSTANCE,
      healthCheck: {
        enabled: true,
        port: '8445',
        protocol: elbv2.Protocol.TCP,
        healthyThresholdCount: 3,
        unhealthyThresholdCount: 3,
        timeout: cdk.Duration.seconds(10),
        interval: cdk.Duration.seconds(30)
      }
    });

    // Create target group for Session Manager API (port 8443)
    const sessionManagerApiTargetGroup = new elbv2.NetworkTargetGroup(this, 'SessionManagerApiTargetGroup', {
      vpc: this.vpc,
      port: 8443,
      protocol: elbv2.Protocol.TCP,
      targetType: elbv2.TargetType.INSTANCE,
      healthCheck: {
        enabled: true,
        port: '8443',
        protocol: elbv2.Protocol.TCP,
        healthyThresholdCount: 3,
        unhealthyThresholdCount: 3,
        timeout: cdk.Duration.seconds(10),
        interval: cdk.Duration.seconds(30)
      }
    });

    // Create target group for Session Manager Resolver (port 8447)
    const sessionManagerResolverTargetGroup = new elbv2.NetworkTargetGroup(this, 'SessionManagerResolverTargetGroup', {
      vpc: this.vpc,
      port: 8447,
      protocol: elbv2.Protocol.TCP,
      targetType: elbv2.TargetType.INSTANCE,
      healthCheck: {
        enabled: true,
        port: '8447',
        protocol: elbv2.Protocol.TCP,
        healthyThresholdCount: 3,
        unhealthyThresholdCount: 3,
        timeout: cdk.Duration.seconds(10),
        interval: cdk.Duration.seconds(30)
      }
    });

    // Create NLB listener for agent connections (port 8445)
    sessionManagerNlb.addListener('SessionManagerListener', {
      port: 8445,
      protocol: elbv2.Protocol.TCP,
      defaultTargetGroups: [sessionManagerTargetGroup]
    });

    // Create NLB listener for API connections (port 8443)
    sessionManagerNlb.addListener('SessionManagerApiListener', {
      port: 8443,
      protocol: elbv2.Protocol.TCP,
      defaultTargetGroups: [sessionManagerApiTargetGroup]
    });

    // Create NLB listener for resolver connections (port 8447)
    sessionManagerNlb.addListener('SessionManagerResolverListener', {
      port: 8447,
      protocol: elbv2.Protocol.TCP,
      defaultTargetGroups: [sessionManagerResolverTargetGroup]
    });

    // Attach ASG to all target groups
    this.sessionManagerInstance.attachToNetworkTargetGroup(sessionManagerTargetGroup);
    this.sessionManagerInstance.attachToNetworkTargetGroup(sessionManagerApiTargetGroup);
    this.sessionManagerInstance.attachToNetworkTargetGroup(sessionManagerResolverTargetGroup);

    // Store NLB DNS name in the parameter that workstations actually use
    new ssm.StringParameter(this, 'SessionManagerEndpoint', {
      parameterName: `/${props.pascalCaseName}/DCV/SessionManager/Endpoint`,
      stringValue: sessionManagerNlb.loadBalancerDnsName,
      description: 'DCV Session Manager stable endpoint (NLB DNS name) - used by workstations'
    });

    // Store reference to Session Manager NLB
    this.sessionManagerNlb = sessionManagerNlb;

    // Add DynamoDB permissions to match working reference role
    sessionManagerRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'dynamodb:BatchGetItem',
        'dynamodb:BatchWriteItem',
        'dynamodb:ConditionCheckItem',
        'dynamodb:CreateTable',
        'dynamodb:DeleteItem',
        'dynamodb:DescribeTable',
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:Query',
        'dynamodb:Scan',
        'dynamodb:UpdateItem'
      ],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:*/*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:*/*/index/*`
      ]
    }));

    // Add SSM describe parameters permission
    sessionManagerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:DescribeParameters'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/*`]
    }));
    sessionManagerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:PutParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/DCV/SessionManager/ClientName`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/DCV/SessionManager/ClientId`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/DCV/SessionManager/ClientPassword`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/DCV/SessionManager/ClientExitCode`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/DCV/SessionManager/Endpoint`
      ]
    }));

    // Add CloudWatch Logs permissions for better debugging
    sessionManagerRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'logs:DescribeLogStreams'
      ],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/ec2/${props.acronym.toLowerCase()}-dcv-*`]
    }));

    // Network Load Balancer for Connection Gateway
    this.networkLoadBalancer = new elbv2.NetworkLoadBalancer(this, 'DcvNetworkLoadBalancer', {
      vpc: this.vpc,
      internetFacing: true,
      crossZoneEnabled: true, // Enable cross-zone load balancing for workstations in different AZs
      loadBalancerName: `${props.acronym.toLowerCase()}-connection-gateway-nlb`,
    });

    // CKV_AWS_91: Enable access logging for DCV NLB
    this.networkLoadBalancer.logAccessLogs(nlbAccessLogsBucket, 'dcv-nlb');

    // Connection Gateway Auto Scaling Group
    this.connectionGatewayAsg = new autoscaling.AutoScalingGroup(this, 'ConnectionGatewayAsg', {
      vpc: this.vpc,
      launchTemplate: new ec2.LaunchTemplate(this, 'ConnectionGatewayLaunchTemplate', {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.C7G, ec2.InstanceSize.LARGE),
        machineImage: ec2.MachineImage.fromSsmParameter(
          '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64',
          { os: ec2.OperatingSystemType.LINUX }
        ),
        securityGroup: connectionGatewaySg,
        role: connectionGatewayRole,
        userData: connectionGatewayUserData,
        // CKV_AWS_79: Require IMDSv2 for enhanced security
        requireImdsv2: true,
      }),
      minCapacity: 1,
      maxCapacity: 3,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    // SSL/TLS Certificate configuration for DCV Connection Gateway
    // Certificate ARN and domain name can be provided via:
    // 1. Stack props (from parameters.json)
    // 2. CDK context (-c flag or cdk.json)
    const existingCertArn = props.dcvCertificateArn || this.node.tryGetContext('dcvCertificateArn');
    const dcvDomainName = props.dcvDomainName || this.node.tryGetContext('dcvDomainName');
    
    let dcvCertificate: certificatemanager.ICertificate | undefined;
    
    if (existingCertArn) {
      // Use existing certificate
      dcvCertificate = certificatemanager.Certificate.fromCertificateArn(
        this, 'DcvCertificate', existingCertArn
      );
    } else if (dcvDomainName) {
      // Create new certificate
      dcvCertificate = new certificatemanager.Certificate(this, 'DcvCertificate', {
        domainName: dcvDomainName,
        validation: certificatemanager.CertificateValidation.fromDns(),
      });
    }

    // NLB Listeners and Target Groups configuration
    // Note: DCV Connection Gateway always uses TLS internally, so we use TCP passthrough
    // to let the Gateway handle TLS with its self-signed certificate.
    // For custom domain with ACM certificate, the certificate is used for DNS validation
    // but the actual TLS is handled by the Connection Gateway.
    
    // TCP Target Group for passthrough (Gateway handles TLS)
    const tcpTargetGroup = new elbv2.NetworkTargetGroup(this, 'ConnectionGatewayTargetGroup', {
      port: 8443,
      protocol: elbv2.Protocol.TCP,
      vpc: this.vpc,
      targets: [this.connectionGatewayAsg],
      healthCheck: {
        port: '8989',
        protocol: elbv2.Protocol.TCP,
        unhealthyThresholdCount: 5,
      },
    });

    // TCP Listener - passthrough to Connection Gateway (Gateway handles TLS)
    this.networkLoadBalancer.addListener('DcvListener', {
      port: 8443,
      protocol: elbv2.Protocol.TCP,
      defaultTargetGroups: [tcpTargetGroup],
    });

    // UDP Target Group and Listener for native DCV client (better streaming performance)
    // Uses port 8444 for QUIC when custom domain is configured
    const udpTargetGroup = new elbv2.NetworkTargetGroup(this, 'ConnectionGatewayUdpTargetGroup', {
      port: 8444,
      protocol: elbv2.Protocol.UDP,
      vpc: this.vpc,
      targets: [this.connectionGatewayAsg],
      healthCheck: {
        port: '8989',
        protocol: elbv2.Protocol.TCP,
        unhealthyThresholdCount: 5,
      },
    });

    this.networkLoadBalancer.addListener('DcvUdpListener', {
      port: 8444,
      protocol: elbv2.Protocol.UDP,
      defaultTargetGroups: [udpTargetGroup],
    });

    // SSM Document for DCV and SMAgent installation
    const dcvInstallDocument = new ssm.CfnDocument(this, 'DCVInstallDocument', {
      name: `${props.pascalCaseName}-Windows-DCV-Install`,
      documentType: 'Command',
      documentFormat: 'YAML',
      content: windowsDcvInstallContent,
      updateMethod: 'NewVersion',
    });

    // SSM Document for Windows Auto-Login configuration (standalone workstations)
    const windowsAutoLoginDocument = new ssm.CfnDocument(this, 'WindowsAutoLoginConfigureDocument', {
      name: `${props.pascalCaseName}-Windows-AutoLoginConfigure`,
      documentType: 'Command',
      documentFormat: 'JSON',
      content: windowsAutoLoginConfigureContent,
      updateMethod: 'NewVersion',
    });

    // SSM Document to disable CTRL+ALT+DEL requirement for easier DCV login
    const windowsDisableCtrlAltDelDocument = new ssm.CfnDocument(this, 'WindowsDisableCtrlAltDelDocument', {
      name: `${props.pascalCaseName}-Windows-DisableCtrlAltDel`,
      documentType: 'Command',
      documentFormat: 'JSON',
      content: windowsDisableCtrlAltDelContent,
      updateMethod: 'NewVersion',
    });

    // SSM Document to setup FSx mount task scheduler
    const windowsSetupFsxSchedulerDocument = new ssm.CfnDocument(this, 'WindowsSetupFsxSchedulerDocument', {
      name: `${props.pascalCaseName}-Windows-SetupFsxScheduler`,
      documentType: 'Command',
      documentFormat: 'JSON',
      content: windowsSetupFsxSchedulerContent,
      updateMethod: 'NewVersion',
    });

    // Workstation Instance Role
    const workstationInstanceRole = new iam.Role(this, 'WorkstationInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMDirectoryServiceAccess'),
      ],
      inlinePolicies: {
        SSMParameterAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['ssm:GetParameter', 'ssm:GetParameters'],
              resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/DCV/*`,
                `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/Workstation/*`,
              ],
            }),
          ],
        }),
        DirectoryServiceAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['ds:CreateComputer', 'ds:DescribeDirectories'],
              resources: [`arn:aws:ds:${this.region}:${this.account}:directory/*`],
            }),
          ],
        }),
        DCVLicenseAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:GetObject'],
              resources: [`arn:aws:s3:::dcv-license.${this.region}/*`],
            }),
          ],
        }),
        DCVLicensingAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:GetObject'],
              resources: [`arn:aws:s3:::dcv-license.${this.region}.amazonaws.com/*`],
            }),
          ],
        }),
        // S3 access for Mountpoint S3 storage mounts
        MountpointS3Access: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                's3:ListBucket',
              ],
              resources: ['arn:aws:s3:::*'],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                's3:GetObject',
                's3:PutObject',
                's3:DeleteObject',
              ],
              resources: ['arn:aws:s3:::*/*'],
            }),
          ],
        }),
      },
    });

    // Workstation Launch Template (simplified - just basic Windows setup)
    const workstationUserData = ec2.UserData.forWindows();
    workstationUserData.addCommands(
      '# Basic Windows setup - DCV installation will be done via SSM document',
      'Write-Output "Workstation instance started - DCV installation will be triggered via SSM"'
    );

    this.workstationLaunchTemplate = new ec2.LaunchTemplate(this, 'WorkstationLaunchTemplate', {
      launchTemplateName: `${props.pascalCaseName}-Workstation-LaunchTemplate`,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.LARGE),
      machineImage: ec2.MachineImage.latestWindows(ec2.WindowsVersion.WINDOWS_SERVER_2022_ENGLISH_FULL_BASE),
      securityGroup: this.workstationSecurityGroup,
      userData: workstationUserData,
      role: workstationInstanceRole,
      // CKV_AWS_79: Require IMDSv2 for enhanced security
      requireImdsv2: true,
    });

    // Create a secret for standalone workstation admin password
    this.standaloneAdminPasswordSecret = new secretsmanager.Secret(this, 'StandaloneAdminPassword', {
      secretName: `/${props.pascalCaseName}/Workstation/StandaloneAdminPassword`,
      description: 'Administrator password for standalone (non-domain-joined) workstations',
      generateSecretString: {
        excludePunctuation: false,
        includeSpace: false,
        passwordLength: 16,
        requireEachIncludedType: true,
        excludeCharacters: '"\'`\\/$@',
      },
    });

    // Grant the workstation instance role permission to read the secret
    this.standaloneAdminPasswordSecret.grantRead(workstationInstanceRole);

    // Store the secret ARN in SSM for cross-stack references (secret name has random suffix)
    new ssm.StringParameter(this, 'StandaloneAdminPasswordSecretArnParameter', {
      parameterName: `/${props.pascalCaseName}/Workstation/StandaloneAdminPasswordSecretArn`,
      stringValue: this.standaloneAdminPasswordSecret.secretArn,
      description: 'ARN of the standalone admin password secret'
    });

    // Store values in SSM parameters for cross-stack references
    new ssm.StringParameter(this, 'DCVInstallDocumentNameParameter', {
      parameterName: `/${props.pascalCaseName}/DCV/InstallDocumentName`,
      stringValue: dcvInstallDocument.ref,
      description: 'SSM Document name for DCV installation'
    });

    new ssm.StringParameter(this, 'WorkstationLaunchTemplateIdParameter', {
      parameterName: `/${props.pascalCaseName}/DCV/LaunchTemplateId`,
      stringValue: this.workstationLaunchTemplate.launchTemplateId!,
      description: 'Launch Template ID for workstations'
    });

    new ssm.StringParameter(this, 'WorkstationSecurityGroupIdParameter', {
      parameterName: `/${props.pascalCaseName}/DCV/SecurityGroupId`,
      stringValue: this.workstationSecurityGroup.securityGroupId,
      description: 'Security Group ID for workstation instances'
    });

    // Note: SessionManagerEndpoint parameter is created earlier in the file

    new ssm.StringParameter(this, 'WorkstationInstanceRoleArnParameter', {
      parameterName: `/${props.pascalCaseName}/DCV/InstanceRoleArn`,
      stringValue: workstationInstanceRole.roleArn,
      description: 'Workstation Instance Role ARN'
    });

    // Keep outputs for convenience (without exports)
    new cdk.CfnOutput(this, 'DCVInstallDocumentName', {
      value: dcvInstallDocument.ref,
      description: 'SSM Document name for DCV installation',
    });

    new cdk.CfnOutput(this, 'WorkstationLaunchTemplateId', {
      value: this.workstationLaunchTemplate.launchTemplateId!,
      description: 'Launch Template ID for workstations',
    });

    // Define connection gateway endpoint - use custom domain if configured (for TLS certificate matching)
    const connectionGatewayEndpoint = dcvDomainName || this.networkLoadBalancer.loadBalancerDnsName;

    // Store DCV endpoint in SSM Parameter Store for MCS module integration
    new ssm.StringParameter(this, 'DcvEndpointParameter', {
      parameterName: `/${props.pascalCaseName}/DCV/Endpoint`,
      stringValue: `https://${connectionGatewayEndpoint}:8443`,
      description: 'DCV Connection Gateway Endpoint'
    });

    // Outputs
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'VPC ID for workstation infrastructure',
    });

    new cdk.CfnOutput(this, 'DcvEndpoint', {
      value: `https://${connectionGatewayEndpoint}:8443`,
      description: 'DCV Connection Gateway Endpoint',
    });

    new cdk.CfnOutput(this, 'DcvCertificateStatus', {
      value: dcvCertificate ? 'TLS Enabled' : 'TLS Disabled (TCP mode)',
      description: 'DCV Connection Gateway TLS Certificate Status',
    });

    new cdk.CfnOutput(this, 'WorkstationSecurityGroupId', {
      value: workstationSg.securityGroupId,
      description: 'Security Group ID for workstation instances',
    });

    new cdk.CfnOutput(this, 'SessionManagerAsgName', {
      value: this.sessionManagerInstance.autoScalingGroupName,
      description: 'Auto Scaling Group name for the DCV Session Manager',
    });

    new cdk.CfnOutput(this, 'DcvClientParameterName', {
      value: `/${props.pascalCaseName}/DCV/SessionManager/ClientName`,
      description: 'SSM Parameter name where DCV client name is stored',
    });

    new cdk.CfnOutput(this, 'DcvClientIdParameterName', {
      value: `/${props.pascalCaseName}/DCV/SessionManager/ClientId`,
      description: 'SSM Parameter name where DCV client ID is stored',
    });

    new cdk.CfnOutput(this, 'DcvClientPasswordParameterName', {
      value: `/${props.pascalCaseName}/DCV/SessionManager/ClientPassword`,
      description: 'SSM Parameter name where DCV client password is stored (SecureString)',
    });

    new cdk.CfnOutput(this, 'DcvClientExitCodeParameterName', {
      value: `/${props.pascalCaseName}/DCV/SessionManager/ClientExitCode`,
      description: 'SSM Parameter name where DCV client registration exit code is stored',
    });

    new cdk.CfnOutput(this, 'DcvPrivateDnsParameterName', {
      value: `/${props.pascalCaseName}/DCV/SessionManager/Endpoint`,
      description: 'SSM Parameter name where DCV Session Manager private DNS is stored',
    });

    // Store Connection Gateway endpoint in Parameter Store
    new ssm.StringParameter(this, 'DcvConnectionGatewayEndpoint', {
      parameterName: `/${props.pascalCaseName}/DCV/ConnectionGateway/Endpoint`,
      stringValue: connectionGatewayEndpoint,
      description: 'DCV Connection Gateway endpoint for client connections',
    });

    new cdk.CfnOutput(this, 'DcvConnectionGatewayEndpointParameterName', {
      value: `/${props.pascalCaseName}/DCV/ConnectionGateway/Endpoint`,
      description: 'SSM Parameter name where DCV Connection Gateway endpoint is stored',
    });

    // Add cleanup construct to handle workstation and ENI cleanup during stack deletion
    if (props.workstationTableName) {
      new CleanupConstruct(this, 'StackCleanup', {
        securityGroupId: workstationSg.securityGroupId,
        workstationTableName: props.workstationTableName,
        acronym: props.acronym,
        pascalCaseName: props.pascalCaseName,
        dataEncryptionKey: props.dataEncryptionKey,
      });
    }
  }

  /**
   * Load network parameters from parameters.json for synth-time configuration
   */
  private loadNetworkParameters(): { 
    availabilityZones: string[];
    privateSubnetIds?: string[];
    publicSubnetIds?: string[];
  } {
    const fs = require('fs');
    const path = require('path');
    const paramsPath = path.join(process.cwd(), 'parameters.json');
    
    if (!fs.existsSync(paramsPath)) {
      // Default to 3 AZs if no parameters file
      return { availabilityZones: ['us-east-1a', 'us-east-1b', 'us-east-1c'] };
    }

    const paramsArray = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
    const azParam = paramsArray.find((p: any) => p.ParameterKey === 'AvailabilityZones');
    const privateSubnetIdsParam = paramsArray.find((p: any) => p.ParameterKey === 'PrivateSubnetIds');
    const publicSubnetIdsParam = paramsArray.find((p: any) => p.ParameterKey === 'PublicSubnetIds');
    
    const result: { 
      availabilityZones: string[];
      privateSubnetIds?: string[];
      publicSubnetIds?: string[];
    } = {
      availabilityZones: ['us-east-1a', 'us-east-1b', 'us-east-1c']
    };
    
    if (azParam?.ParameterValue) {
      result.availabilityZones = azParam.ParameterValue.split(',').map((az: string) => az.trim()).filter((az: string) => az);
    }
    
    if (privateSubnetIdsParam?.ParameterValue) {
      result.privateSubnetIds = privateSubnetIdsParam.ParameterValue.split(',').map((id: string) => id.trim()).filter((id: string) => id);
    }
    
    if (publicSubnetIdsParam?.ParameterValue) {
      result.publicSubnetIds = publicSubnetIdsParam.ParameterValue.split(',').map((id: string) => id.trim()).filter((id: string) => id);
    }
    
    return result;
  }
}
