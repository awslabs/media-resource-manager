// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface AgentTestInfrastructureConstructProps {
  pascalCaseName: string;
  acronym: string;
  vpc: ec2.IVpc;
  privateSubnets: ec2.ISubnet[];
  uploadsBucketArn: string;
}

export class AgentTestInfrastructureConstruct extends Construct {
  public readonly testSubnet: ec2.ISubnet;
  public readonly testSecurityGroup: ec2.SecurityGroup;
  public readonly testInstanceRole: iam.Role;
  public readonly testInstanceProfile: iam.CfnInstanceProfile;

  constructor(scope: Construct, id: string, props: AgentTestInfrastructureConstructProps) {
    super(scope, id);

    // Use the first private subnet for test instances
    // In production, you might want a dedicated isolated subnet
    this.testSubnet = props.privateSubnets[0];

    // Create security group with minimal outbound rules
    // Only allows HTTPS to VPC endpoints (S3, SSM, Secrets Manager)
    this.testSecurityGroup = new ec2.SecurityGroup(this, 'TestInstanceSecurityGroup', {
      vpc: props.vpc,
      securityGroupName: `${props.pascalCaseName}-TestInstance-SG`,
      description: 'Security group for Install Script Agent test instances - minimal permissions',
      allowAllOutbound: false, // Explicitly deny all outbound by default
    });

    // Allow HTTPS outbound to VPC CIDR (for VPC endpoints)
    this.testSecurityGroup.addEgressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      'Allow HTTPS to VPC endpoints'
    );

    // Allow HTTPS outbound to internet (for downloading software from GitHub, etc.)
    this.testSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS to internet for software downloads'
    );

    // Allow HTTP outbound to internet (some downloads may use HTTP)
    this.testSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP to internet for software downloads'
    );

    // Create VPC endpoints if they don't exist
    // Note: These may already exist in the VPC, so we use try/catch pattern
    this.createVpcEndpointsIfNeeded(props.vpc, props.privateSubnets);

    // Create IAM role for test instances with minimal permissions
    this.testInstanceRole = new iam.Role(this, 'TestInstanceRole', {
      roleName: `${props.pascalCaseName}-TestInstanceRole`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'IAM role for Install Script Agent test instances - minimal permissions',
      managedPolicies: [
        // SSM managed policy for SSM agent communication
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // S3 read-only access for downloading installers
    this.testInstanceRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3ReadAccess',
      actions: [
        's3:GetObject',
        's3:ListBucket',
      ],
      resources: [
        props.uploadsBucketArn,
        `${props.uploadsBucketArn}/*`,
      ],
    }));

    // Secrets Manager read access for license keys
    this.testInstanceRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SecretsManagerReadAccess',
      actions: [
        'secretsmanager:GetSecretValue',
      ],
      resources: [
        `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:/${props.pascalCaseName}/Software/*`,
      ],
    }));

    // Create instance profile
    this.testInstanceProfile = new iam.CfnInstanceProfile(this, 'TestInstanceProfile', {
      instanceProfileName: `${props.pascalCaseName}-TestInstanceProfile`,
      roles: [this.testInstanceRole.roleName],
    });

    // Create Lambda for orphaned instance cleanup
    const cleanupLambda = new lambda.Function(this, 'OrphanedInstanceCleanupLambda', {
      functionName: `${props.acronym.toLowerCase()}-orphaned-instance-cleanup`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const { EC2Client, DescribeInstancesCommand, TerminateInstancesCommand } = require('@aws-sdk/client-ec2');

const ec2Client = new EC2Client({ region: process.env.AWS_REGION });
const MAX_LIFETIME_MINUTES = parseInt(process.env.MAX_LIFETIME_MINUTES || '30', 10);

exports.handler = async (event) => {
  console.log('Starting orphaned instance cleanup...');
  
  try {
    // Find test instances that have exceeded their max lifetime
    const describeResponse = await ec2Client.send(new DescribeInstancesCommand({
      Filters: [
        { Name: 'tag:Purpose', Values: ['InstallScriptTest'] },
        { Name: 'tag:AutoTerminate', Values: ['true'] },
        { Name: 'instance-state-name', Values: ['running', 'pending'] },
      ],
    }));
    
    const instancesToTerminate = [];
    const now = new Date();
    
    for (const reservation of describeResponse.Reservations || []) {
      for (const instance of reservation.Instances || []) {
        const launchTime = new Date(instance.LaunchTime);
        const ageMinutes = (now - launchTime) / (1000 * 60);
        
        // Get MaxLifetime tag or use default
        const maxLifetimeTag = instance.Tags?.find(t => t.Key === 'MaxLifetime');
        const maxLifetime = maxLifetimeTag ? parseInt(maxLifetimeTag.Value, 10) : MAX_LIFETIME_MINUTES;
        
        if (ageMinutes > maxLifetime) {
          console.log(\`Instance \${instance.InstanceId} has exceeded max lifetime (\${ageMinutes.toFixed(1)} > \${maxLifetime} minutes)\`);
          instancesToTerminate.push(instance.InstanceId);
        }
      }
    }
    
    if (instancesToTerminate.length > 0) {
      console.log(\`Terminating \${instancesToTerminate.length} orphaned instances: \${instancesToTerminate.join(', ')}\`);
      await ec2Client.send(new TerminateInstancesCommand({
        InstanceIds: instancesToTerminate,
      }));
      console.log('Termination initiated successfully');
    } else {
      console.log('No orphaned instances found');
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: \`Terminated \${instancesToTerminate.length} orphaned instances\`,
        instances: instancesToTerminate,
      }),
    };
  } catch (error) {
    console.error('Error during cleanup:', error);
    throw error;
  }
};
      `),
      timeout: cdk.Duration.minutes(5),
      environment: {
        MAX_LIFETIME_MINUTES: '30',
      },
    });

    // Grant EC2 permissions to cleanup Lambda
    cleanupLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ec2:DescribeInstances',
        'ec2:TerminateInstances',
      ],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'ec2:ResourceTag/Purpose': 'InstallScriptTest',
        },
      },
    }));

    // Allow describing instances without condition
    cleanupLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeInstances'],
      resources: ['*'],
    }));

    // EventBridge rule to run cleanup every 5 minutes
    const cleanupRule = new events.Rule(this, 'OrphanedInstanceCleanupRule', {
      ruleName: `${props.pascalCaseName}-OrphanedInstanceCleanup`,
      description: 'Cleanup orphaned test instances every 5 minutes',
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
    });

    cleanupRule.addTarget(new targets.LambdaFunction(cleanupLambda));

    // Store SSM parameters for discovery
    new ssm.StringParameter(this, 'TestSubnetIdParameter', {
      parameterName: `/${props.pascalCaseName}/Agent/TestSubnetId`,
      stringValue: this.testSubnet.subnetId,
      description: 'Subnet ID for test instances',
    });

    new ssm.StringParameter(this, 'TestSecurityGroupIdParameter', {
      parameterName: `/${props.pascalCaseName}/Agent/TestSecurityGroupId`,
      stringValue: this.testSecurityGroup.securityGroupId,
      description: 'Security group ID for test instances',
    });

    new ssm.StringParameter(this, 'TestInstanceProfileArnParameter', {
      parameterName: `/${props.pascalCaseName}/Agent/TestInstanceProfileArn`,
      stringValue: this.testInstanceProfile.attrArn,
      description: 'Instance profile ARN for test instances',
    });

    // Store base AMI IDs for different platforms
    // These should be updated to match your organization's base AMIs
    new ssm.StringParameter(this, 'WindowsBaseAmiParameter', {
      parameterName: `/${props.pascalCaseName}/Agent/WindowsBaseAmiId`,
      stringValue: 'resolve:ssm:/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base',
      description: 'Base AMI ID for Windows test instances',
    });

    new ssm.StringParameter(this, 'LinuxBaseAmiParameter', {
      parameterName: `/${props.pascalCaseName}/Agent/LinuxBaseAmiId`,
      stringValue: 'resolve:ssm:/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id',
      description: 'Base AMI ID for Linux test instances',
    });
  }

  private createVpcEndpointsIfNeeded(vpc: ec2.IVpc, subnets: ec2.ISubnet[]): void {
    // Create VPC endpoints for S3, SSM, and Secrets Manager
    // These enable private connectivity without internet access

    // S3 Gateway Endpoint (free)
    try {
      new ec2.GatewayVpcEndpoint(this, 'S3Endpoint', {
        vpc,
        service: ec2.GatewayVpcEndpointAwsService.S3,
      });
    } catch (e) {
      // Endpoint may already exist
      console.log('S3 endpoint may already exist');
    }

    // SSM Interface Endpoints (required for SSM agent)
    const ssmEndpoints = [
      { id: 'SsmEndpoint', service: ec2.InterfaceVpcEndpointAwsService.SSM },
      { id: 'SsmMessagesEndpoint', service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES },
      { id: 'Ec2MessagesEndpoint', service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES },
    ];

    for (const endpoint of ssmEndpoints) {
      try {
        new ec2.InterfaceVpcEndpoint(this, endpoint.id, {
          vpc,
          service: endpoint.service,
          subnets: { subnets },
          privateDnsEnabled: true,
        });
      } catch (e) {
        // Endpoint may already exist
        console.log(`${endpoint.id} may already exist`);
      }
    }

    // Secrets Manager Interface Endpoint
    try {
      new ec2.InterfaceVpcEndpoint(this, 'SecretsManagerEndpoint', {
        vpc,
        service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        subnets: { subnets },
        privateDnsEnabled: true,
      });
    } catch (e) {
      // Endpoint may already exist
      console.log('Secrets Manager endpoint may already exist');
    }
  }
}
