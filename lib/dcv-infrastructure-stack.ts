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
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as route53 from 'aws-cdk-lib/aws-route53';
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
  /** 'cloudfront' (default): browsers reach the gateway through CloudFront. 'direct': through the NLB. */
  dcvBrowserPath?: string;
  /** Optional Route 53 hosted zone: HTTPS from CloudFront to the origin load balancer. */
  dcvHostedZoneId?: string;
  /** Optional client allowlist for the gateway's public ports (TCP 8443, UDP 8444). */
  dcvAllowedClientCidrs?: string[];
  dcvAllowedPrefixListIds?: string[];
}

const windowsDcvInstallContent = require('../ssm-documents/windows-dcv-install');
const windowsAutoLoginConfigureContent = require('../ssm-documents/windows-autologin-configure');
const windowsDisableCtrlAltDelContent = require('../ssm-documents/windows-disable-ctrl-alt-del');
const windowsSetupFsxSchedulerContent = require('../ssm-documents/windows-setup-fsx-scheduler');

// Load user data scripts from centralized location
const sessionManagerInstallScript = fs.readFileSync(path.join(__dirname, '../user-data/session-manager-install.sh'), 'utf8');
const connectionGatewayInstallScript = fs.readFileSync(path.join(__dirname, '../user-data/connection-gateway-install.sh'), 'utf8');

// Shared with the regional hub template generator.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const gatewayBrowserPath = require('../lambda/generate-regional-hub-template/gateway-browser-path');

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

    // Every IPv4 CIDR block of the VPC, as a prefix list: an imported VPC can
    // have secondary blocks, and MRM's subnets may sit in any of them.
    const vpcCidrsFunction = new lambda.Function(this, 'VpcCidrPrefixListFunction', {
      functionName: `${props.acronym.toLowerCase()}-vpc-cidr-prefix-list`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/vpc-cidr-prefix-list')),
      timeout: cdk.Duration.minutes(3),
    });
    const vpcCidrsTag = { key: `${props.pascalCaseName}:VpcCidrs`, value: 'true' };
    // Describe calls don't support resource-level permissions.
    vpcCidrsFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeVpcs', 'ec2:DescribeManagedPrefixLists', 'ec2:GetManagedPrefixListEntries'],
      resources: ['*'],
    }));
    vpcCidrsFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:CreateManagedPrefixList'],
      resources: [`arn:aws:ec2:${this.region}:${this.account}:prefix-list/*`],
      conditions: { StringEquals: { [`aws:RequestTag/${vpcCidrsTag.key}`]: vpcCidrsTag.value } },
    }));
    vpcCidrsFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:CreateTags'],
      resources: [`arn:aws:ec2:${this.region}:${this.account}:prefix-list/*`],
      conditions: { StringEquals: { 'ec2:CreateAction': 'CreateManagedPrefixList' } },
    }));
    vpcCidrsFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:ModifyManagedPrefixList', 'ec2:DeleteManagedPrefixList'],
      resources: [`arn:aws:ec2:${this.region}:${this.account}:prefix-list/*`],
      conditions: { StringEquals: { [`aws:ResourceTag/${vpcCidrsTag.key}`]: vpcCidrsTag.value } },
    }));
    const vpcCidrsProvider = new cr.Provider(this, 'VpcCidrPrefixListProvider', {
      onEventHandler: vpcCidrsFunction,
    });
    const vpcCidrs = new cdk.CustomResource(this, 'VpcCidrPrefixList', {
      serviceToken: vpcCidrsProvider.serviceToken,
      properties: {
        VpcId: vpcId,
        PrefixListName: `${props.pascalCaseName}-VpcCidrs`,
        TagKey: vpcCidrsTag.key,
        TagValue: vpcCidrsTag.value,
        // Re-read the VPC on every deploy, so a CIDR block associated later
        // is added. A no-op when nothing changed.
        Refresh: Date.now().toString(),
      },
    });
    const vpcCidrsPeer = ec2.Peer.prefixList(vpcCidrs.getAttString('PrefixListId'));
    // Have the list before the groups drop their older rules, so the rules
    // that reference it follow within seconds.
    sessionManagerSg.node.addDependency(vpcCidrs);
    connectionGatewaySg.node.addDependency(vpcCidrs);

    // The Session Manager sits behind an internal NLB, so its callers
    // (Lambdas, gateway, workstations) are in the VPC.
    // CLI to Broker communication
    sessionManagerSg.addIngressRule(
      vpcCidrsPeer,
      ec2.Port.tcp(8443),
      'allow CLI to Broker communication from within VPC'
    );

    // Agent to Broker communication (workstations)
    sessionManagerSg.addIngressRule(
      vpcCidrsPeer,
      ec2.Port.tcp(8445),
      'allow Agent to Broker communication from within VPC'
    );

    // Gateway client ports: TCP 8443 (native TCP, and browsers in direct mode)
    // and UDP 8444 (QUIC). The NLB keeps the client IP, so the allowlist
    // applies here. Empty allowlist: open, as the gateway only accepts
    // connections with a DCV session token.
    const browserPath = gatewayBrowserPath.parseBrowserPath(props.dcvBrowserPath);
    const allowedClientCidrs: string[] = gatewayBrowserPath.parseAllowedClientCidrs(props.dcvAllowedClientCidrs);
    const allowedPrefixListIds: string[] = gatewayBrowserPath.parseAllowedPrefixListIds(props.dcvAllowedPrefixListIds);
    const clientAllowlist = allowedClientCidrs.length > 0 || allowedPrefixListIds.length > 0;
    if (!clientAllowlist) {
      connectionGatewaySg.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(8443),
        'allow TCP DCV access from public internet'
      );

      // UDP DCV access on port 8444 for QUIC when TLS is enabled on 8443
      connectionGatewaySg.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.udp(8444),
        'allow UDP DCV/QUIC access from public internet (TLS mode)'
      );
    }
    for (const cidr of allowedClientCidrs) {
      connectionGatewaySg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(8443), 'allow TCP DCV access from an allowed client network');
      connectionGatewaySg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.udp(8444), 'allow UDP DCV/QUIC access from an allowed client network');
    }
    // One security group per prefix list and protocol, so each list fits the
    // rules-per-security-group quota (a prefix list counts as its max entries).
    const allowlistSecurityGroups: ec2.SecurityGroup[] = [];
    allowedPrefixListIds.forEach((prefixListId, i) => {
      for (const [port, label] of [[ec2.Port.tcp(8443), 'Tcp'], [ec2.Port.udp(8444), 'Udp']] as [ec2.Port, string][]) {
        const sg = new ec2.SecurityGroup(this, `ConnectionGatewayAllowedPrefixList${i + 1}${label}SG`, {
          vpc: this.vpc,
          description: `DCV Connection Gateway ${label.toUpperCase()} from allowed prefix list ${i + 1}`,
          allowAllOutbound: false,
        });
        sg.addIngressRule(ec2.Peer.prefixList(prefixListId), port, 'allow DCV access from an allowed prefix list');
        allowlistSecurityGroups.push(sg);
      }
    });

    // Health check port for Network Load Balancer (NLB nodes are in the VPC)
    connectionGatewaySg.addIngressRule(
      vpcCidrsPeer,
      ec2.Port.tcp(8989),
      'allow health check for NLB targets from within VPC'
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
    const connectionGatewayLaunchTemplate = new ec2.LaunchTemplate(this, 'ConnectionGatewayLaunchTemplate', {
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
    });
    allowlistSecurityGroups.forEach(sg => connectionGatewayLaunchTemplate.addSecurityGroup(sg));

    this.connectionGatewayAsg = new autoscaling.AutoScalingGroup(this, 'ConnectionGatewayAsg', {
      vpc: this.vpc,
      launchTemplate: connectionGatewayLaunchTemplate,
      minCapacity: 1,
      maxCapacity: 3,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      // Replace gateways one at a time when the launch template changes, so
      // a new gateway config reaches running gateways. Gateways have no
      // cfn-signal, so PauseTime gives a new one time to install and start
      // before the old one is terminated. Same policy in the hub template.
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
        maxBatchSize: 1,
        minInstancesInService: 1,
        pauseTime: cdk.Duration.minutes(5),
      }),
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

    // Browser path through CloudFront (default): distribution -> VPC origin ->
    // internal ALB -> gateway TCP 8443. Same shape as the hub template
    // (lambda/generate-regional-hub-template/gateway-browser-path.js).
    let browserDistribution: cloudfront.CfnDistribution | undefined;
    if (browserPath === 'cloudfront') {
      browserDistribution = this.createCloudFrontBrowserPath({
        acronym: props.acronym,
        pascalCaseName: props.pascalCaseName,
        privateSubnetIds,
        connectionGatewaySg,
        hostedZoneId: props.dcvHostedZoneId,
      });
    }

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

    // Standalone Windows workstations read their own SMB mount credentials at
    // logon. The FSx SMB mount manager writes one secret per workstation,
    // /<ProductName>/Workstation/<instanceId>/SmbMount, and gives each a
    // resource policy that denies GetSecretValue to every caller except a
    // workstation role session for that instance ID. Regional hub workstation
    // roles already read /<ProductName>/Workstation/* in this Region.
    workstationInstanceRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/${props.pascalCaseName}/Workstation/*/SmbMount-*`,
      ],
    }));

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

    // URL the browser viewer connects to (serverUrl): the gateway's CloudFront
    // distribution, or the gateway itself in direct mode.
    const browserGatewayUrl = browserDistribution
      ? `https://${browserDistribution.attrDomainName}`
      : `https://${connectionGatewayEndpoint}:8443`;
    new ssm.StringParameter(this, 'BrowserGatewayUrlParameter', {
      parameterName: `/${props.pascalCaseName}/DCV/BrowserGatewayUrl`,
      stringValue: browserGatewayUrl,
      description: 'DCV Connection Gateway URL for browser sessions',
    });
    new cdk.CfnOutput(this, 'BrowserGatewayUrl', {
      value: browserGatewayUrl,
      description: 'DCV Connection Gateway URL for browser sessions',
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
   * CloudFront distribution for browser sessions: a VPC origin on an internal
   * ALB that forwards to the gateway on TCP 8443. Browsers get a publicly
   * trusted *.cloudfront.net certificate. The ALB doesn't validate the
   * gateway's (often self-signed) certificate.
   *
   * CloudFront creates a service-managed security group
   * (CloudFront-VPCOrigins-Service-SG) and network interfaces in the VPC for
   * the VPC origin. They aren't part of this stack (docs/GATEWAY_BROWSER_PATH.md).
   */
  private createCloudFrontBrowserPath(o: {
    acronym: string;
    pascalCaseName: string;
    privateSubnetIds: string[];
    connectionGatewaySg: ec2.SecurityGroup;
    hostedZoneId?: string;
  }): cloudfront.CfnDistribution {
    const acronymLower = o.acronym.toLowerCase();
    const https = Boolean(o.hostedZoneId);
    const listenerPort = https ? 443 : 80;

    // Account-specific values: subnets outside the AZ IDs VPC origins don't
    // support, CloudFront's origin-facing prefix list, the hosted zone's name.
    const lookupFunction = new lambda.Function(this, 'GatewayOriginLookupFunction', {
      functionName: `${acronymLower}-gateway-origin-lookup`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/gateway-origin-lookup')),
      timeout: cdk.Duration.minutes(1),
    });
    // Describe calls don't support resource-level permissions.
    lookupFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeSubnets', 'ec2:DescribeManagedPrefixLists'],
      resources: ['*'],
    }));
    if (o.hostedZoneId) {
      lookupFunction.addToRolePolicy(new iam.PolicyStatement({
        actions: ['route53:GetHostedZone'],
        resources: [`arn:aws:route53:::hostedzone/${o.hostedZoneId}`],
      }));
    }
    const lookupProvider = new cr.Provider(this, 'GatewayOriginLookupProvider', {
      onEventHandler: lookupFunction,
    });
    const lookup = new cdk.CustomResource(this, 'GatewayOriginLookup', {
      serviceToken: lookupProvider.serviceToken,
      properties: {
        SubnetIds: o.privateSubnetIds,
        ExcludedAzIds: gatewayBrowserPath.VPC_ORIGIN_EXCLUDED_AZ_IDS,
        PrefixListName: gatewayBrowserPath.CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST,
        HostedZoneId: o.hostedZoneId || '',
      },
    });

    const albSg = new ec2.SecurityGroup(this, 'GatewayBrowserAlbSG', {
      vpc: this.vpc,
      securityGroupName: `${o.pascalCaseName}-DCV-Gateway-Browser-ALB-SG`,
      description: 'Gateway browser-path load balancer, reachable only from CloudFront',
      allowAllOutbound: false,
    });
    albSg.addIngressRule(
      ec2.Peer.prefixList(lookup.getAttString('PrefixListId')),
      ec2.Port.tcp(listenerPort),
      'CloudFront origin-facing (VPC origin)'
    );
    albSg.addEgressRule(o.connectionGatewaySg, ec2.Port.tcp(8443), 'Gateway web port');
    o.connectionGatewaySg.addIngressRule(
      albSg,
      ec2.Port.tcp(8443),
      'allow DCV browser sessions from the CloudFront origin load balancer'
    );

    const alb = new elbv2.CfnLoadBalancer(this, 'GatewayBrowserAlb', {
      name: `${acronymLower}-gateway-browser-alb`,
      type: 'application',
      scheme: 'internal',
      ipAddressType: 'ipv4',
      subnets: cdk.Fn.split(',', lookup.getAttString('SubnetIds')),
      securityGroups: [albSg.securityGroupId],
      // No access logs by default: the first browser request carries the DCV
      // session token in its query string.
      loadBalancerAttributes: [
        { key: 'idle_timeout.timeout_seconds', value: '60' },
        { key: 'routing.http.drop_invalid_header_fields.enabled', value: 'true' },
      ],
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'GatewayBrowserTargetGroup', {
      vpc: this.vpc,
      targetType: elbv2.TargetType.INSTANCE,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      port: 8443,
      protocolVersion: elbv2.ApplicationProtocolVersion.HTTP1,
      deregistrationDelay: cdk.Duration.seconds(30),
      // The gateway's health port (8989) accepts TCP and sends nothing, and ALB
      // health checks are HTTP(S) only, so check the web port. A token-only
      // gateway answers GET / with 404.
      healthCheck: {
        protocol: elbv2.Protocol.HTTPS,
        port: 'traffic-port',
        path: '/',
        interval: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
        healthyHttpCodes: '200-499',
      },
    });
    this.connectionGatewayAsg.attachToApplicationTargetGroup(targetGroup);

    let originName: string | undefined;
    let certificate: certificatemanager.CfnCertificate | undefined;
    let originRecord: route53.CfnRecordSet | undefined;
    if (o.hostedZoneId) {
      originName = gatewayBrowserPath.originDomainName(this.region, lookup.getAttString('HostedZoneName')) as string;
      certificate = new certificatemanager.CfnCertificate(this, 'GatewayBrowserOriginCertificate', {
        domainName: originName,
        validationMethod: 'DNS',
        domainValidationOptions: [{ domainName: originName, hostedZoneId: o.hostedZoneId }],
      });
      originRecord = new route53.CfnRecordSet(this, 'GatewayBrowserOriginRecord', {
        hostedZoneId: o.hostedZoneId,
        name: originName,
        type: 'A',
        aliasTarget: {
          dnsName: alb.attrDnsName,
          hostedZoneId: alb.attrCanonicalHostedZoneId,
          evaluateTargetHealth: false,
        },
      });
    }

    const listener = new elbv2.CfnListener(this, 'GatewayBrowserListener', {
      loadBalancerArn: alb.ref,
      port: listenerPort,
      protocol: https ? 'HTTPS' : 'HTTP',
      certificates: certificate ? [{ certificateArn: certificate.ref }] : undefined,
      sslPolicy: https ? 'ELBSecurityPolicy-TLS13-1-2-2021-06' : undefined,
      defaultActions: [{ type: 'forward', targetGroupArn: targetGroup.targetGroupArn }],
    });

    const vpcOrigin = new cloudfront.CfnVpcOrigin(this, 'GatewayBrowserVpcOrigin', {
      vpcOriginEndpointConfig: {
        name: `${acronymLower}-gateway-${this.region}`,
        arn: alb.ref,
        httpPort: 80,
        httpsPort: 443,
        originProtocolPolicy: https ? 'https-only' : 'http-only',
        originSslProtocols: ['TLSv1.2'],
      },
    });
    vpcOrigin.addResourceDependency(listener);
    if (originRecord) vpcOrigin.addResourceDependency(originRecord);

    const corsFunction = new cloudfront.CfnFunction(this, 'GatewayBrowserCorsFunction', {
      name: `${acronymLower}-gateway-cors-${this.region.replace(/-/g, '')}`,
      autoPublish: true,
      functionConfig: { comment: 'Answers CORS preflights for the DCV gateway', runtime: 'cloudfront-js-2.0' },
      functionCode: gatewayBrowserPath.CORS_PREFLIGHT_FUNCTION_CODE,
    });

    return new cloudfront.CfnDistribution(this, 'GatewayBrowserDistribution', {
      distributionConfig: {
        comment: `${o.pascalCaseName} DCV gateway browser path (${this.region})`,
        enabled: true,
        httpVersion: 'http2',
        ipv6Enabled: false,
        priceClass: 'PriceClass_All',
        viewerCertificate: { cloudFrontDefaultCertificate: true },
        // No standard logging: the first browser request carries the DCV
        // session token in its query string.
        origins: [{
          id: 'gateway-alb',
          domainName: originName || alb.attrDnsName,
          vpcOriginConfig: {
            vpcOriginId: vpcOrigin.attrId,
            originReadTimeout: 30,
            originKeepaliveTimeout: 5,
          },
        }],
        defaultCacheBehavior: {
          targetOriginId: 'gateway-alb',
          viewerProtocolPolicy: 'https-only',
          allowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'],
          cachedMethods: ['GET', 'HEAD'],
          compress: false,
          cachePolicyId: gatewayBrowserPath.MANAGED_CACHE_POLICY_CACHING_DISABLED,
          originRequestPolicyId: gatewayBrowserPath.MANAGED_ORIGIN_REQUEST_POLICY_ALL_VIEWER,
          responseHeadersPolicyId: gatewayBrowserPath.MANAGED_RESPONSE_HEADERS_POLICY_SIMPLE_CORS,
          functionAssociations: [{
            eventType: 'viewer-request',
            functionArn: corsFunction.attrFunctionArn,
          }],
        },
      },
    });
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
