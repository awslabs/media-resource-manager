// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DEPLOYMENT ORDER REQUIRED:
 * 1. Deploy: Database, Auth, DCV, Main (this stack)
 * 2. Deploy: Frontend 
 * 3. REDEPLOY: Main (this stack again to pick up real frontend URL for CORS)
 */

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';

import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import { StorageStack } from './storage-stack';
import { DataSyncStack } from './datasync-stack';

export interface ApiStackProps extends cdk.StackProps {
  productName: string;
  pascalCaseName: string;
  acronym: string;
  userTable: dynamodb.Table;
  workstationTable: dynamodb.Table;
  amiTable: dynamodb.Table;
  groupsTable: dynamodb.Table;
  storageTable: dynamodb.Table;
  regionalHubsTable: dynamodb.Table;
  imagePipelinesTable: dynamodb.Table;
  softwareLibraryTable: dynamodb.Table;
  instanceTypeCatalogTable?: dynamodb.Table;  // Optional - for dynamic instance type catalog
  windowsWorkstationCreationStateMachine: stepfunctions.StateMachine;
  linuxWorkstationCreationStateMachine: stepfunctions.StateMachine;
  // macOS state machine ARN is imported from SSM to avoid CloudFormation export dependencies
  workstationStartStateMachine: string;
  vpc: ec2.IVpc;
  storageStack: StorageStack;
  imageBuilderInstanceProfile: string;
  imageBuilderLogsBucket: string;
  imageBuilderServiceRoleArn: string;
  imageBuilderUploadsBucket: string;
  buildSubnetId: string;
  buildSecurityGroupId: string;
  dataEncryptionKey?: kms.IKey;  // KMS key for encrypted DynamoDB tables and S3 buckets
  dataSyncStack?: DataSyncStack;  // Optional DataSync stack for data transfer management
  // Optional Install Script Agent tables (from AgentCoreStack)
  agentExecutionStateTable?: dynamodb.ITable;
  agentUsageTable?: dynamodb.ITable;
  agentProgressTable?: dynamodb.ITable;
  scriptGenerationStateMachine?: stepfunctions.IStateMachine;
  enableBedrockFeatures?: boolean;  // When false, skips Bedrock-dependent Lambda functions
}

export class ApiStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;
  public readonly dcvSessionManagerFunction: lambda.Function;
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, {
      ...props,
      description: "Workstation management API with Lambda functions for EC2 instance lifecycle operations"
    });

    // Import SSM parameters from deployment
    const workstationSecurityGroupId = ssm.StringParameter.valueForStringParameter(this, `/${props.pascalCaseName}/DCV/SecurityGroupId`);
    const workstationLaunchTemplateId = ssm.StringParameter.valueForStringParameter(this, `/${props.pascalCaseName}/DCV/LaunchTemplateId`);
    const workstationInstanceRoleArn = ssm.StringParameter.valueForStringParameter(this, `/${props.pascalCaseName}/DCV/InstanceRoleArn`);
    const sessionManagerNlbDns = ssm.StringParameter.valueForStringParameter(this, `/${props.pascalCaseName}/DCV/SessionManager/Endpoint`);
    const ldapLayerArn = ssm.StringParameter.valueForStringParameter(this, `/${props.pascalCaseName}/Auth/LdapLayerArn`);
    
    // Import macOS state machine ARN from SSM (avoids CloudFormation export dependencies)
    const macosStateMachineArn = ssm.StringParameter.valueForStringParameter(this, `/${props.pascalCaseName}/Workstation/MacOSStateMachineArn`);

    // Import LDAP layer from SSM parameter (avoids cross-stack export issues)
    const ldapLayer = lambda.LayerVersion.fromLayerVersionArn(this, 'ImportedLdapLayer', ldapLayerArn);

    // Import resources using the parameter values
    const workstationSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(this, 'ImportedWorkstationSG', workstationSecurityGroupId);
    const workstationLaunchTemplate = ec2.LaunchTemplate.fromLaunchTemplateAttributes(this, 'ImportedLaunchTemplate', {
      launchTemplateId: workstationLaunchTemplateId,
    });
    const dcvSessionManagerEndpoint = `https://${sessionManagerNlbDns}:8443`;

    // JWT secret stored in Secrets Manager (auto-generated on first deploy)
    // Note: Uses AWS-managed encryption to avoid circular dependency with Infra stack's KMS key
    const jwtSecret = new secretsmanager.Secret(this, 'JwtSecret', {
      secretName: `/${props.pascalCaseName}/Auth/JwtSecret`,
      description: 'JWT signing secret for workstation management authentication',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 64,
      },
    });

    // Lambda execution role
    const lambdaRole = new iam.Role(this, 'WorkstationLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });

    // Grant DynamoDB permissions
    props.userTable.grantReadWriteData(lambdaRole);
    props.workstationTable.grantReadWriteData(lambdaRole);
    props.amiTable.grantReadWriteData(lambdaRole);
    props.groupsTable.grantReadWriteData(lambdaRole);
    props.softwareLibraryTable.grantReadWriteData(lambdaRole);
    
    // Grant read access to instance type catalog table if provided
    if (props.instanceTypeCatalogTable) {
      props.instanceTypeCatalogTable.grantReadData(lambdaRole);
    }

    // Grant KMS permissions if tables use customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(lambdaRole);
    }

    // Grant Cognito permissions for user management
    // Grant Directory Services and SSM permissions for user management
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ds:CreateUser',
        'ds:ResetUserPassword',
        'ds:DescribeDirectories',
        'ds-data:ListGroupMembers',
        'ds-data:DescribeUser',
        'ssm:GetParametersByPath',
        'ssm:GetParameter',
        'cognito-idp:ListUsers'
      ],
      resources: [
        '*'
      ],
    }));
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:DescribeInstances',
        'ec2:DescribeImages',
        'ec2:DeregisterImage',
        'ec2:CopyImage',
        'ec2:RunInstances',
        'ec2:TerminateInstances',
        'ec2:StartInstances',
        'ec2:StopInstances',
        'ec2:RebootInstances',
        'ec2:ModifyInstanceAttribute',
        'ec2:CreateTags',
        'ec2:DescribeInstanceStatus',
        'ec2:DescribeSubnets',
        'ec2:DescribeSecurityGroups',
        'ec2:DescribeVolumes',
      ],
      resources: ['*'],
    }));

    // Grant CloudFormation permissions to read stack outputs
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudformation:DescribeStacks',
      ],
      resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/${props.pascalCaseName}-Dcv/*`],
    }));

    // Grant SSM permissions for settings management
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
        'ssm:PutParameter',
      ],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/DCV/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/Frontend/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/API/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/Network/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/Identity/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/Settings/*`,
      ],
    }));

    // Grant SSM permissions for AWS-managed AMI parameters
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}::parameter/aws/service/ami-windows-latest/*`,
        `arn:aws:ssm:${this.region}::parameter/aws/service/ami-amazon-linux-latest/*`,
        `arn:aws:ssm:${this.region}::parameter/aws/service/canonical/*`,
      ],
    }));

    // Grant Step Functions permissions
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'states:StartExecution',
      ],
      resources: [
        props.windowsWorkstationCreationStateMachine.stateMachineArn,
        props.linuxWorkstationCreationStateMachine.stateMachineArn,
        macosStateMachineArn,
        props.workstationStartStateMachine
      ],
    }));

    // Grant IAM PassRole permission for workstation instance role
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [workstationInstanceRoleArn],
    }));

    // Grant SSM permissions for DCV installation
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:SendCommand',
        'ssm:GetCommandInvocation',
        'ssm:DescribeInstanceInformation'
      ],
      resources: ['*'],
    }));

    // Grant Directory Service permissions for domain listing and user management
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ds:DescribeDirectories',
        'ds:AccessDSData',
        'ds:ResetUserPassword'
      ],
      resources: ['*'],
    }));

    // Grant Directory Service Data permissions for user and group management
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ds-data:CreateUser',
        'ds-data:DescribeUser',
        'ds-data:UpdateUser',
        'ds-data:DisableUser',
        'ds-data:DeleteUser',
        'ds-data:AddGroupMember',
        'ds-data:CreateGroup',
        'ds-data:DescribeGroup',
        'ds-data:UpdateGroup',
        'ds-data:DeleteGroup'
      ],
      resources: ['*'],
    }));

    // Grant Image Builder permissions
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'imagebuilder:CreateImagePipeline',
        'imagebuilder:CreateImageRecipe',
        'imagebuilder:CreateInfrastructureConfiguration',
        'imagebuilder:CreateDistributionConfiguration',
        'imagebuilder:CreateComponent',
        'imagebuilder:DeleteImagePipeline',
        'imagebuilder:DeleteImageRecipe',
        'imagebuilder:DeleteInfrastructureConfiguration',
        'imagebuilder:DeleteDistributionConfiguration',
        'imagebuilder:DeleteComponent',
        'imagebuilder:DeleteImage',
        'imagebuilder:GetComponent',
        'imagebuilder:GetWorkflow',
        'imagebuilder:GetImageRecipe',
        'imagebuilder:GetInfrastructureConfiguration',
        'imagebuilder:GetDistributionConfiguration',
        'imagebuilder:StartImagePipelineExecution',
        'imagebuilder:GetImagePipeline',
        'imagebuilder:UpdateImagePipeline',
        'imagebuilder:ListImagePipelines',
        'imagebuilder:ListImageRecipes',
        'imagebuilder:ListImages',
        'imagebuilder:ListComponentBuildVersions',
        'imagebuilder:TagResource',
      ],
      resources: ['*'],
    }));

    // Grant Resource Groups permissions for macOS Host Resource Group placement
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'resource-groups:GetGroup',
        'resource-groups:ListGroupResources'
      ],
      resources: [`arn:aws:resource-groups:${this.region}:${this.account}:group/${props.pascalCaseName}-Mac-Host-Resource-Group`],
    }));

    // Grant IAM PassRole permission for Image Builder service role
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [props.imageBuilderServiceRoleArn],
    }));

    // Grant IAM CreateServiceLinkedRole permission for ImageBuilder
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:CreateServiceLinkedRole'],
      resources: [`arn:aws:iam::${this.account}:role/aws-service-role/imagebuilder.amazonaws.com/AWSServiceRoleForImageBuilder`],
    }));

    // Grant S3 permissions for Image Builder logs bucket
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:PutObject', 's3:GetBucketAcl'],
      resources: [
        `arn:aws:s3:::${props.imageBuilderLogsBucket}`,
        `arn:aws:s3:::${props.imageBuilderLogsBucket}/*`
      ],
    }));

    // Environment variables for Lambda functions
    const lambdaEnvironment: Record<string, string> = {
      USER_TABLE_NAME: props.userTable.tableName,
      WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
      AMI_TABLE_NAME: props.amiTable.tableName,
      GROUPS_TABLE_NAME: props.groupsTable.tableName,
      VPC_ID: props.vpc.vpcId,
      SUBNET_ID: props.vpc.privateSubnets[0].subnetId,
      SECURITY_GROUP_ID: workstationSecurityGroupId,
      LAUNCH_TEMPLATE_ID: workstationLaunchTemplateId,
      STATE_MACHINE_ARN: props.windowsWorkstationCreationStateMachine.stateMachineArn,
      START_STATE_MACHINE_ARN: props.workstationStartStateMachine,
      PASCAL_CASE_NAME: props.pascalCaseName,
    };
    
    // Add instance type catalog table if provided
    if (props.instanceTypeCatalogTable) {
      lambdaEnvironment.INSTANCE_TYPE_CATALOG_TABLE_NAME = props.instanceTypeCatalogTable.tableName;
    }

    // Lambda functions - updated to fix syntax error
    
    // User and Group Management Function
    const userGroupManagerFunction = new lambda.Function(this, 'UserGroupManagerFunction', {
      functionName: `${props.acronym.toLowerCase()}-user-group-manager`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/user-group-manager'),
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 20,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        USER_TABLE_NAME: props.userTable.tableName,
        GROUPS_TABLE_NAME: props.groupsTable.tableName,
        PASCAL_CASE_NAME: props.pascalCaseName,
      },
    });

    // Grant permissions to UserGroupManager
    props.userTable.grantReadWriteData(userGroupManagerFunction);
    props.groupsTable.grantReadWriteData(userGroupManagerFunction);
    
    // Grant KMS permissions if tables use customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(userGroupManagerFunction);
    }
    
    userGroupManagerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ds:*',
        'ds-data:*',
        'ssm:GetParameter',
        'cognito-idp:ListUsers',
        'cognito-idp:AdminListGroupsForUser'
      ],
      resources: ['*']
    }));

    // Identity Center Sync Function
    const identityCenterSyncFunction = new lambda.Function(this, 'IdentityCenterSyncFunction', {
      functionName: `${props.acronym.toLowerCase()}-identity-center-sync`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/identity-center-sync'),
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        USER_TABLE_NAME: props.userTable.tableName,
        PASCAL_CASE_NAME: props.pascalCaseName,
      },
    });

    // Grant permissions to Identity Center Sync
    props.userTable.grantReadWriteData(identityCenterSyncFunction);
    
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(identityCenterSyncFunction);
    }
    
    identityCenterSyncFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'identitystore:ListUsers',
        'identitystore:DescribeUser',
        'identitystore:ListGroups',
        'identitystore:ListGroupMemberships',
        'sso:ListInstances',
        'sso-admin:ListInstances'
      ],
      resources: ['*']
    }));
    
    // Grant SSM read permission for Identity Store ID parameter
    identityCenterSyncFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/Identity/*`]
    }));

    // User Details Management Function
    const userDetailsManagerFunction = new lambda.Function(this, 'UserDetailsManagerFunction', {
      functionName: `${props.acronym.toLowerCase()}-user-details-manager`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/user-details-manager'),
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 20,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        USER_TABLE_NAME: props.userTable.tableName,
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
        GROUPS_TABLE_NAME: props.groupsTable.tableName,
        PASCAL_CASE_NAME: props.pascalCaseName,
      },
    });

    // Grant permissions to UserDetailsManager
    props.userTable.grantReadData(userDetailsManagerFunction);
    props.workstationTable.grantReadData(userDetailsManagerFunction);
    props.groupsTable.grantReadData(userDetailsManagerFunction);
    
    // Grant KMS permissions if tables use customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantDecrypt(userDetailsManagerFunction);
    }
    
    userDetailsManagerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ds:*',
        'ds-data:*',
        'ssm:GetParameter',
        'cognito-idp:AdminGetUser'
      ],
      resources: ['*']
    }));

    const mainLambdaFunction = new lambda.Function(this, 'MainLambdaFunction', {
      functionName: `${props.acronym.toLowerCase()}-workstation-api`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      description: 'Main lambda function - external file',
      code: lambda.Code.fromAsset('lambda/workstation-api'),
      environmentEncryption: props.dataEncryptionKey,
      environment: lambdaEnvironment,
      role: lambdaRole,
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 25,
    });

    // Image Management Lambda function
    const imageManagerFunction = new lambda.Function(this, 'ImageManagerFunction', {
      functionName: `${props.acronym.toLowerCase()}-image-manager`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      description: 'Image management function',
      code: lambda.Code.fromAsset('lambda/image-manager'),
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        ...lambdaEnvironment,
        IMAGES_TABLE_NAME: props.amiTable.tableName,
        PIPELINES_TABLE_NAME: props.imagePipelinesTable.tableName,
        IMAGE_BUILDER_INSTANCE_PROFILE: props.imageBuilderInstanceProfile,
        LOGS_BUCKET_NAME: props.imageBuilderLogsBucket,
        BUILD_SUBNET_ID: props.buildSubnetId,
        BUILD_SECURITY_GROUP_ID: props.buildSecurityGroupId,
        IMAGE_BUILDER_SERVICE_ROLE_ARN: props.imageBuilderServiceRoleArn,
        PASCAL_CASE_NAME: props.pascalCaseName,
        ACRONYM: props.acronym,
        REGIONAL_HUBS_TABLE_NAME: props.regionalHubsTable.tableName,
      },
      role: lambdaRole,
      timeout: cdk.Duration.minutes(2),
      reservedConcurrentExecutions: 5,
    });

    // Grant image function access to AMI table
    props.amiTable.grantReadWriteData(imageManagerFunction);
    // Grant access to pipelines table
    props.imagePipelinesTable.grantReadWriteData(imageManagerFunction);
    // Grant read access to regional hubs table for multi-region AMI distribution
    props.regionalHubsTable.grantReadData(imageManagerFunction);

    // Grant KMS permissions if tables use customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(imageManagerFunction);
    }

    // Software Library Lambda function
    const softwareLibraryFunction = new lambda.Function(this, 'SoftwareLibraryFunction', {
      functionName: `${props.acronym.toLowerCase()}-software-library`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      description: 'Software library management function',
      code: lambda.Code.fromAsset('lambda/software-library'),
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        ...lambdaEnvironment,
        SOFTWARE_LIBRARY_TABLE_NAME: props.softwareLibraryTable.tableName,
        UPLOADS_BUCKET_NAME: props.imageBuilderUploadsBucket,
      },
      role: lambdaRole,
      timeout: cdk.Duration.minutes(1),
      reservedConcurrentExecutions: 5,
    });

    // Grant software library function access to its table
    props.softwareLibraryTable.grantReadWriteData(softwareLibraryFunction);

    // Grant S3 permissions for media uploads
    softwareLibraryFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
      resources: [`arn:aws:s3:::${props.imageBuilderUploadsBucket}/software/*`],
    }));

    // Grant KMS permissions if encryption key is provided
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(softwareLibraryFunction);
    }

    // Install Script Agent Lambda functions (only if agent tables are provided)
    let invokeInstallScriptAgentFunction: lambda.Function | undefined;
    let installScriptProgressFunction: lambda.Function | undefined;
    let cancelInstallScriptFunction: lambda.Function | undefined;

    if (props.agentExecutionStateTable && props.agentUsageTable) {
      // Invoke Install Script Agent Lambda
      invokeInstallScriptAgentFunction = new lambda.Function(this, 'InvokeInstallScriptAgentFunction', {
        functionName: `${props.acronym.toLowerCase()}-invoke-install-script-agent`,
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        description: 'Invokes the Install Script Agent to generate installation scripts',
        code: lambda.Code.fromAsset('lambda/invoke-install-script-agent'),
        environmentEncryption: props.dataEncryptionKey,
        environment: {
          ...lambdaEnvironment,
          EXECUTION_STATE_TABLE_NAME: props.agentExecutionStateTable.tableName,
          USAGE_TABLE_NAME: props.agentUsageTable.tableName,
          STATE_MACHINE_ARN: props.scriptGenerationStateMachine?.stateMachineArn || '',
        },
        role: lambdaRole,
        timeout: cdk.Duration.minutes(15),
        memorySize: 256,
        reservedConcurrentExecutions: 5,
      });

      // Grant permissions
      props.agentExecutionStateTable.grantReadWriteData(invokeInstallScriptAgentFunction);
      props.agentUsageTable.grantReadWriteData(invokeInstallScriptAgentFunction);

      // SSM permissions for reading agent config
      invokeInstallScriptAgentFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/Agent/*`],
      }));

      // SSM permissions for reading AgentCore runtime ARN
      invokeInstallScriptAgentFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/agentcore/*`,
        ],
      }));

      // Step Functions permissions to start the state machine
      invokeInstallScriptAgentFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['states:StartExecution'],
        resources: [`arn:aws:states:${this.region}:${this.account}:stateMachine:${props.acronym.toLowerCase()}-script-generation`],
      }));

      // Install Script Progress Lambda (SSE)
      installScriptProgressFunction = new lambda.Function(this, 'InstallScriptProgressFunction', {
        functionName: `${props.acronym.toLowerCase()}-install-script-progress`,
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        description: 'Streams progress updates for script generation via SSE',
        code: lambda.Code.fromAsset('lambda/install-script-progress'),
        environmentEncryption: props.dataEncryptionKey,
        environment: {
          ...lambdaEnvironment,
          EXECUTION_STATE_TABLE_NAME: props.agentExecutionStateTable.tableName,
          PROGRESS_TABLE_NAME: props.agentProgressTable?.tableName || '',
        },
        role: lambdaRole,
        timeout: cdk.Duration.seconds(30),
        reservedConcurrentExecutions: 15,
      });

      // Grant permissions
      props.agentExecutionStateTable.grantReadData(installScriptProgressFunction);
      if (props.agentProgressTable) {
        props.agentProgressTable.grantReadData(installScriptProgressFunction);
      }

      // Cancel Install Script Lambda
      cancelInstallScriptFunction = new lambda.Function(this, 'CancelInstallScriptFunction', {
        functionName: `${props.acronym.toLowerCase()}-cancel-install-script`,
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        description: 'Cancels ongoing script generation and cleans up resources',
        code: lambda.Code.fromAsset('lambda/cancel-install-script'),
        environmentEncryption: props.dataEncryptionKey,
        environment: {
          ...lambdaEnvironment,
          EXECUTION_STATE_TABLE_NAME: props.agentExecutionStateTable.tableName,
        },
        role: lambdaRole,
        timeout: cdk.Duration.minutes(2),
        reservedConcurrentExecutions: 5,
      });

      // Grant permissions
      props.agentExecutionStateTable.grantReadWriteData(cancelInstallScriptFunction);

      // EC2 permissions for terminating test instances
      cancelInstallScriptFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ec2:TerminateInstances', 'ec2:DescribeInstances'],
        resources: ['*'],
      }));
    }

    // Chat Requirements Lambda - lightweight Bedrock chat for gathering requirements
    // Only deployed when Bedrock features are enabled
    let chatRequirementsFunction: lambda.Function | undefined;
    if (props.enableBedrockFeatures !== false) {
      chatRequirementsFunction = new lambda.Function(this, 'ChatRequirementsFunction', {
        functionName: `${props.acronym.toLowerCase()}-chat-requirements`,
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        description: 'Conversational chatbot for gathering installation script requirements',
        code: lambda.Code.fromAsset('lambda/chat-requirements'),
        environmentEncryption: props.dataEncryptionKey,
        environment: {
          ...lambdaEnvironment,
          BEDROCK_MODEL_ID: 'anthropic.claude-3-5-haiku-20241022-v1:0',
        },
        role: lambdaRole,
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        reservedConcurrentExecutions: 15,
      });

      // Grant Bedrock permissions for chat
      chatRequirementsFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-5-haiku-20241022-v1:0`,
          `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0`,
        ],
      }));
    }

    // FSx SMB Mount Manager Lambda function (Windows)
    // Note: Keep construct ID as 'FsxMountManagerFunction' to preserve CloudFormation logical ID
    const fsxSmbMountManagerFunction = new lambda.Function(this, 'FsxMountManagerFunction', {
      functionName: `${props.acronym.toLowerCase()}-fsx-mount-manager`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/fsx-smb-mount-manager'),
      timeout: cdk.Duration.minutes(10),
      reservedConcurrentExecutions: 5,
      description: 'Manage FSx SMB volume mounting via Windows login scripts',
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        STORAGE_TABLE_NAME: props.storageTable.tableName,
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
        PASCAL_CASE_NAME: props.pascalCaseName,
      }
    });

    // Grant permissions for FSx SMB mount manager
    props.storageTable.grantReadData(fsxSmbMountManagerFunction);
    props.workstationTable.grantReadData(fsxSmbMountManagerFunction);
    
    // Grant KMS permissions if tables use customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantDecrypt(fsxSmbMountManagerFunction);
    }
    
    fsxSmbMountManagerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:SendCommand',
        'ssm:GetCommandInvocation',
        'ssm:DescribeInstanceInformation',
        'ssm:ListCommandInvocations',
        'ssm:DescribeInstanceAssociationsStatus',
        'ssm:GetParameter',
        'ec2:DescribeInstances',
        'ec2:DescribeVolumes'
      ],
      resources: ['*'],
    }));

    // Grant access to Secrets Manager for AD credentials (for non-domain-joined workstations)
    // and ONTAP credentials for FSxN storage (which may be in regional hubs)
    fsxSmbMountManagerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        // AD credentials in primary region
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/${props.pascalCaseName}/Identity/*`,
        // Storage credentials in primary region
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/${props.pascalCaseName}/Storage/*`,
        // Storage credentials in any region (for regional FSxN storage)
        `arn:aws:secretsmanager:*:${this.account}:secret:/${props.pascalCaseName}/Storage/*`
      ],
    }));

    // Grant FSx permissions for describing SVMs (needed for FSxN mount)
    fsxSmbMountManagerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['fsx:DescribeStorageVirtualMachines'],
      resources: ['*'],
    }));

    // Workstation Management Lambda function
    const workstationManagerFunction = new lambda.Function(this, 'WorkstationManagerFunction', {
      functionName: `${props.acronym.toLowerCase()}-workstation-manager`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      description: 'Workstation management function',
      code: lambda.Code.fromAsset('lambda/workstation-manager'),
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        ...lambdaEnvironment,
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
        USER_TABLE_NAME: props.userTable.tableName,
        GROUPS_TABLE_NAME: props.groupsTable.tableName,
        STATE_MACHINE_ARN: props.windowsWorkstationCreationStateMachine.stateMachineArn,
        LINUX_STATE_MACHINE_ARN: props.linuxWorkstationCreationStateMachine.stateMachineArn,
        MACOS_STATE_MACHINE_ARN: macosStateMachineArn,
        START_STATE_MACHINE_ARN: props.workstationStartStateMachine,
        FSX_SMB_MOUNT_MANAGER_FUNCTION_ARN: fsxSmbMountManagerFunction.functionArn,
        // NFS mount manager ARN is read from SSM to avoid tight CloudFormation cross-stack coupling
        FSX_NFS_MOUNT_MANAGER_FUNCTION_ARN: ssm.StringParameter.valueForStringParameter(
          this, `/${props.pascalCaseName}/Storage/NfsMountManagerFunctionArn`
        ),
        AMI_TABLE_NAME: props.amiTable.tableName,
        REGIONAL_HUBS_TABLE_NAME: props.regionalHubsTable.tableName,
      },
      role: lambdaRole,
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 20,
    });

    // Grant workstation manager permission to invoke mount manager functions
    fsxSmbMountManagerFunction.grantInvoke(workstationManagerFunction);    // Grant permission to invoke NFS mount manager (using wildcard since ARN is from SSM)
    workstationManagerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${props.acronym.toLowerCase()}-nfs-mount-manager`],
    }));

    // ─── Volume Manager — Lambda durable function ─────────────────────────────
    // Dedicated durable Lambda for EBS volume operations (add, resize, detach).
    // Uses checkpoint/replay so create→attach and detach→delete workflows
    // complete reliably even if the function is interrupted mid-flight.
    // Note: functionName is intentionally omitted — CDK requires this when
    // durableConfig is set to avoid resource replacement issues on updates.
    const volumeManagerFunction = new lambda.Function(this, 'VolumeManagerFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      description: 'Durable EBS volume management — add, resize, detach',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/volume-manager')),
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
        PASCAL_CASE_NAME: props.pascalCaseName,
        AWS_REGION_NAME: this.region,
      },
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 10,
      durableConfig: {
        executionTimeout: cdk.Duration.days(7),
        retentionPeriod: cdk.Duration.days(14),
      },
    });

    // Durable functions require the AWSLambdaBasicDurableExecutionRolePolicy
    // for checkpoint operations (lambda:CheckpointDurableExecution, lambda:GetDurableExecutionState)
    volumeManagerFunction.role?.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicDurableExecutionRolePolicy')
    );

    // EC2 permissions for volume operations
    volumeManagerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:DescribeInstances',
        'ec2:DescribeVolumes',
        'ec2:CreateVolume',
        'ec2:AttachVolume',
        'ec2:DetachVolume',
        'ec2:DeleteVolume',
        'ec2:ModifyVolume',
        'ec2:CreateTags',
      ],
      resources: ['*'],
    }));

    // SSM permissions to extend file system after resize
    volumeManagerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:SendCommand',
        'ssm:GetCommandInvocation',
      ],
      resources: ['*'],
    }));

    // DynamoDB read access to look up workstation region
    props.workstationTable.grantReadData(volumeManagerFunction);

    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(volumeManagerFunction);
    }

    // Durable functions require a version + alias for invocation via qualified ARN
    const volumeManagerAlias = new lambda.Alias(this, 'VolumeManagerAlias', {
      aliasName: 'live',
      version: volumeManagerFunction.currentVersion,
    });

    // Allow workstation-manager to invoke the volume-manager durable function asynchronously
    volumeManagerAlias.grantInvoke(workstationManagerFunction);
    workstationManagerFunction.addEnvironment('VOLUME_MANAGER_FUNCTION_ARN', volumeManagerAlias.functionArn);

    // Grant workstation function access to tables and state machines
    props.workstationTable.grantReadWriteData(workstationManagerFunction);
    props.userTable.grantReadData(workstationManagerFunction);
    props.regionalHubsTable.grantReadData(workstationManagerFunction);
    props.groupsTable.grantReadData(workstationManagerFunction);
    
    // Grant KMS permissions if tables use customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(workstationManagerFunction);
    }
    
    workstationManagerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'states:StartExecution',
      ],
      resources: [
        props.windowsWorkstationCreationStateMachine.stateMachineArn,
        props.linuxWorkstationCreationStateMachine.stateMachineArn,
        macosStateMachineArn,
        props.workstationStartStateMachine
      ],
    }));
    workstationManagerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ds:DescribeDirectories',
        'ds-data:ListGroupMembers',
        'ssm:GetParameter',
        'cognito-idp:ListUsers',
      ],
      resources: ['*'],
    }));

    // DCV Session Manager Lambda function
    const dcvSessionManagerFunction = new lambda.Function(this, 'DcvSessionManagerFunction', {
      functionName: `${props.acronym.toLowerCase()}-dcv-session-manager`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset('lambda/dcv-session-manager'),
      timeout: cdk.Duration.seconds(120),
      reservedConcurrentExecutions: 20,
      memorySize: 256,
      description: 'DCV Session Manager with provisioned concurrency',
      vpc: props.vpc,
      securityGroups: [workstationSecurityGroup],
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        DCV_SESSION_MANAGER_ENDPOINT: dcvSessionManagerEndpoint,
        PASCAL_CASE_NAME: props.pascalCaseName,
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
        USER_TABLE_NAME: props.userTable.tableName,
        GROUPS_TABLE_NAME: props.groupsTable.tableName,
        REGIONAL_HUBS_TABLE_NAME: props.regionalHubsTable.tableName,
        AWS_ACCOUNT_ID: this.account,
        ACRONYM: props.acronym,
      },
    });

    // Provisioned concurrency to eliminate VPC Lambda cold starts.
    // API Gateway REST API has a hard 29-second integration timeout.
    // VPC Lambda cold starts (ENI attach + SSL + SSM lookups + broker API)
    // can exceed 29s, causing 504 errors on the first request.
    const dcvSessionManagerAlias = new lambda.Alias(this, 'DcvSessionManagerAlias', {
      aliasName: 'live',
      version: dcvSessionManagerFunction.currentVersion,
      provisionedConcurrentExecutions: 1,
    });

    // Add permission to invoke regional DCV session manager Lambdas
    dcvSessionManagerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:*:${this.account}:function:${props.acronym.toLowerCase()}-regional-dcv-session-manager`],
    }));

    // Add SSM permissions for DCV function
    dcvSessionManagerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters',
      ],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/DCV/SessionManager/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/DCV/ConnectionGateway/*`,
      ],
    }));

    // Add ELB permissions for load balancer health checks
    dcvSessionManagerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'elasticloadbalancing:DescribeLoadBalancers',
        'elasticloadbalancing:DescribeTargetGroups',
        'elasticloadbalancing:DescribeTargetHealth',
      ],
      resources: ['*'],
    }));

    // Add autoscaling permissions for ASG monitoring
    dcvSessionManagerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'autoscaling:DescribeAutoScalingGroups',
        'autoscaling:DescribeAutoScalingInstances',
      ],
      resources: ['*'],
    }));

    // Add DynamoDB permissions for workstation assignments
    dcvSessionManagerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:Scan',
        'dynamodb:Query',
        'dynamodb:GetItem',
      ],
      resources: [props.workstationTable.tableArn],
    }));

    // Add DynamoDB permissions for user display names (for assigned user column)
    dcvSessionManagerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:Scan',
        'dynamodb:Query',
        'dynamodb:GetItem',
      ],
      resources: [props.userTable.tableArn],
    }));

    // Add DynamoDB permissions for regional hubs (for multi-region load balancer info)
    dcvSessionManagerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:Scan',
        'dynamodb:Query',
        'dynamodb:GetItem',
      ],
      resources: [props.regionalHubsTable.tableArn],
    }));

    // Add DynamoDB permissions for groups table (for group assignments)
    dcvSessionManagerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:Scan',
        'dynamodb:Query',
        'dynamodb:GetItem',
      ],
      resources: [props.groupsTable.tableArn],
    }));

    // Grant KMS permissions if tables use customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantDecrypt(dcvSessionManagerFunction);
    }

    // Add EC2 permissions for instance state monitoring
    dcvSessionManagerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:DescribeInstances',
      ],
      resources: ['*'],
    }));

    // Store reference for other stacks
    this.dcvSessionManagerFunction = dcvSessionManagerFunction;

    // CORS: Deployed with a permissive wildcard so the API works immediately after CDK deploy.
    // The cors-updater Lambda tightens this to the specific frontend URL when it runs:
    // (1) from deploy.sh when API routes change, and (2) via EventBridge when the
    // Frontend URL SSM parameter is updated.
    // Note: allowCredentials is omitted because browsers reject * with credentials.
    // This is fine — auth uses Bearer tokens, not cookies. The cors-updater re-enables
    // credentials when it sets the specific frontend URL.

    // API Gateway
    this.api = new apigateway.RestApi(this, 'WorkstationApi', {
      restApiName: `${props.pascalCaseName}-Workstation-API`,
      description: 'API for managing workstations',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    // Add CORS headers to API Gateway error responses (4XX/5XX)
    // Without this, authorizer rejections (401) and integration errors (500)
    // don't include CORS headers, causing the browser to report CORS errors
    // instead of the actual error.
    this.api.addGatewayResponse('Default4XX', {
      type: apigateway.ResponseType.DEFAULT_4XX,
      responseHeaders: {
        'Access-Control-Allow-Origin': "'*'",
        'Access-Control-Allow-Headers': "'Content-Type,Authorization'",
      },
    });
    this.api.addGatewayResponse('Default5XX', {
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: {
        'Access-Control-Allow-Origin': "'*'",
        'Access-Control-Allow-Headers': "'Content-Type,Authorization'",
      },
    });

    // Set the API URL for use by other stacks
    this.apiUrl = this.api.url;

    // JWT Lambda Authorizer (supports both LDAP and Cognito tokens)
    const jwtAuthorizerFunction = new lambda.Function(this, 'JwtAuthorizerFunction', {
      functionName: `${props.acronym.toLowerCase()}-jwt-authorizer`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/jwt-authorizer')),
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        JWT_SECRET_ARN: jwtSecret.secretArn,
        ADMIN_GROUP_NAME: ssm.StringParameter.valueForStringParameter(this, `/${props.pascalCaseName}/Auth/AdminGroupName`)
      },
      timeout: cdk.Duration.seconds(10),
      reservedConcurrentExecutions: 25,
    });

    // Grant permission to read the JWT secret
    jwtSecret.grantRead(jwtAuthorizerFunction);

    const authorizer = new apigateway.TokenAuthorizer(this, 'JwtAuthorizer', {
      handler: jwtAuthorizerFunction,
      identitySource: 'method.request.header.Authorization',
      resultsCacheTtl: cdk.Duration.seconds(0),
    });

    // Progress tracking table for real-time updates
    // CKV_AWS_28: Enable point-in-time recovery for data protection
    const progressTable = new dynamodb.Table(this, 'ProgressTable', {
      tableName: `${props.acronym.toLowerCase()}-progress`,
      partitionKey: { name: 'instanceId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Use KMS encryption if available
      encryption: props.dataEncryptionKey 
        ? dynamodb.TableEncryption.CUSTOMER_MANAGED 
        : dynamodb.TableEncryption.AWS_MANAGED,
      encryptionKey: props.dataEncryptionKey,
    });

    // Grant KMS permissions for progress table if using customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(lambdaRole);
    }

    // SSE Lambda for streaming progress
    const sseProgressFunction = new lambda.Function(this, 'SSEProgressFunction', {
      functionName: `${props.acronym.toLowerCase()}-stream-progress`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/stream-progress'),
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 20,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PROGRESS_TABLE_NAME: progressTable.tableName,
      },
    });

    progressTable.grantReadData(sseProgressFunction);

    // API Resources
    const workstationsResource = this.api.root.addResource('workstations');
    const usersResource = this.api.root.addResource('users');
    const groupsResource = this.api.root.addResource('groups');
    const settingsResource = this.api.root.addResource('settings');
    const domainsResource = this.api.root.addResource('domains');
    const imagesResource = this.api.root.addResource('images');
    const changePasswordResource = this.api.root.addResource('change-password');
    const progressResource = this.api.root.addResource('progress');
    const storageResource = this.api.root.addResource('storage');
    const storageIdResource = storageResource.addResource('{storageId}');

    // SSE Progress endpoint
    const sseIntegration = new apigateway.LambdaIntegration(sseProgressFunction);
    progressResource.addMethod('GET', sseIntegration, { 
      authorizer
    });

    // Lambda integrations
    // ─────────────────────────────────────────────────────────────────────────
    // ROUTING OVERVIEW — which Lambda handles which API routes:
    //
    // workstationIntegration (mrm-workstation-manager):
    //   GET/POST   /workstations
    //   GET/PUT/DELETE /workstations/{id}
    //   POST       /workstations/start
    //   POST       /workstations/stop
    //   POST       /workstations/reboot
    //
    // lambdaIntegration (mrm-workstation-api) — settings, keep-alive, misc:
    //   POST/DELETE /workstations/keep-alive
    //   DELETE      /workstations/{id}/keep-alive
    //   GET/POST    /settings
    //   GET/POST    /settings/instance-types
    //   GET         /instance-types/catalog
    //   GET         /domains
    //
    // userGroupIntegration (mrm-user-group-manager):
    //   GET/POST    /users, /users/disable, /users/enable, /users/delete
    //   GET/PUT/DELETE /users/{id}/schedule
    //   GET/POST/PUT/DELETE /groups, /groups/{groupId}
    //
    // userDetailsIntegration (mrm-user-details-manager):
    //   GET         /users/{id}
    //
    // imageIntegration (mrm-image-manager):
    //   All         /images/* (AMIs, pipelines, copy)
    //
    // softwareLibraryIntegration (mrm-software-library):
    //   All         /images/software/*
    //
    // identityCenterSyncIntegration (mrm-identity-center-sync):
    //   POST        /users/sync
    //
    // Storage, DataSync, Regions — each have dedicated Lambdas (see below)
    // ─────────────────────────────────────────────────────────────────────────
    const lambdaIntegration = new apigateway.LambdaIntegration(mainLambdaFunction);
    const userGroupIntegration = new apigateway.LambdaIntegration(userGroupManagerFunction);
    const userDetailsIntegration = new apigateway.LambdaIntegration(userDetailsManagerFunction);
    const imageIntegration = new apigateway.LambdaIntegration(imageManagerFunction);
    const softwareLibraryIntegration = new apigateway.LambdaIntegration(softwareLibraryFunction);
    const workstationIntegration = new apigateway.LambdaIntegration(workstationManagerFunction);
    const identityCenterSyncIntegration = new apigateway.LambdaIntegration(identityCenterSyncFunction);
    const volumeManagerIntegration = new apigateway.LambdaIntegration(volumeManagerAlias);

    // Storage integrations
    const listStorageIntegration = new apigateway.LambdaIntegration(props.storageStack.functions.listStorage);
    const getStorageIntegration = new apigateway.LambdaIntegration(props.storageStack.functions.getStorage);
    const createStorageIntegration = new apigateway.LambdaIntegration(props.storageStack.functions.createStorage);
    const updateStorageIntegration = new apigateway.LambdaIntegration(props.storageStack.functions.updateStorage);
    const deleteStorageIntegration = new apigateway.LambdaIntegration(props.storageStack.functions.deleteStorage);
    const s3MountIntegration = new apigateway.LambdaIntegration(props.storageStack.functions.s3MountManager);
    const nfsMountIntegration = new apigateway.LambdaIntegration(props.storageStack.functions.nfsMountManager);
    const listS3BucketsIntegration = new apigateway.LambdaIntegration(props.storageStack.functions.listS3Buckets);

    // API Methods - now using dedicated functions
    workstationsResource.addMethod('GET', workstationIntegration, { authorizer });
    workstationsResource.addMethod('POST', workstationIntegration, { authorizer });
    
    const workstationResource = workstationsResource.addResource('{id}');
    workstationResource.addMethod('GET', workstationIntegration, { authorizer });
    workstationResource.addMethod('PUT', workstationIntegration, { authorizer });
    workstationResource.addMethod('DELETE', workstationIntegration, { authorizer });

    const startResource = workstationsResource.addResource('start');
    startResource.addMethod('POST', workstationIntegration, { authorizer });

    const stopResource = workstationsResource.addResource('stop');
    stopResource.addMethod('POST', workstationIntegration, { authorizer });

    const rebootResource = workstationsResource.addResource('reboot');
    rebootResource.addMethod('POST', workstationIntegration, { authorizer });

    const changeInstanceTypeResource = workstationsResource.addResource('change-instance-type');
    changeInstanceTypeResource.addMethod('POST', workstationIntegration, { authorizer });

    // Volume management routes — invoked asynchronously via workstation-manager
    // (durable functions with >15min timeout cannot be invoked synchronously)
    const volumesResource = workstationsResource.addResource('volumes');
    const resizeVolumeResource = volumesResource.addResource('resize');
    resizeVolumeResource.addMethod('POST', workstationIntegration, { authorizer });
    const addVolumeResource = volumesResource.addResource('add');
    addVolumeResource.addMethod('POST', workstationIntegration, { authorizer });
    const detachVolumeResource = volumesResource.addResource('detach');
    detachVolumeResource.addMethod('POST', workstationIntegration, { authorizer });

    // Keep Alive endpoint - allows users to temporarily prevent auto-shutdown
    const keepAliveResource = workstationsResource.addResource('keep-alive');
    keepAliveResource.addMethod('POST', lambdaIntegration, { authorizer });

    // Keep Alive cancel endpoint on individual workstation
    const workstationKeepAliveResource = workstationResource.addResource('keep-alive');
    workstationKeepAliveResource.addMethod('DELETE', lambdaIntegration, { authorizer });

    // User and Group endpoints - now using dedicated function
    usersResource.addMethod('GET', userGroupIntegration, { authorizer });
    usersResource.addMethod('POST', userGroupIntegration, { authorizer });

    // Identity Center sync endpoint
    const syncUsersResource = usersResource.addResource('sync');
    syncUsersResource.addMethod('POST', identityCenterSyncIntegration, { authorizer });

    const disableUsersResource = usersResource.addResource('disable');
    disableUsersResource.addMethod('POST', userGroupIntegration, { authorizer });

    const enableUsersResource = usersResource.addResource('enable');
    enableUsersResource.addMethod('POST', userGroupIntegration, { authorizer });

    const deleteUsersResource = usersResource.addResource('delete');
    deleteUsersResource.addMethod('POST', userGroupIntegration, { authorizer });

    const userResource = usersResource.addResource('{id}');
    userResource.addMethod('GET', userDetailsIntegration, { authorizer });

    // User schedule endpoints - for auto-start scheduling
    const userScheduleResource = userResource.addResource('schedule');
    userScheduleResource.addMethod('GET', userGroupIntegration, { authorizer });
    userScheduleResource.addMethod('PUT', userGroupIntegration, { authorizer });
    userScheduleResource.addMethod('DELETE', userGroupIntegration, { authorizer });

    groupsResource.addMethod('GET', userGroupIntegration, { authorizer });
    groupsResource.addMethod('POST', userGroupIntegration, { authorizer });
    
    // Add DELETE method for individual groups
    const groupIdResource = groupsResource.addResource('{groupId}');
    groupIdResource.addMethod('GET', userGroupIntegration, { authorizer });
    groupIdResource.addMethod('PUT', userGroupIntegration, { authorizer });
    groupIdResource.addMethod('DELETE', userGroupIntegration, { authorizer });

    settingsResource.addMethod('GET', lambdaIntegration, { authorizer });
    settingsResource.addMethod('POST', lambdaIntegration, { authorizer });

    // Settings sub-resources
    const instanceTypesResource = settingsResource.addResource('instance-types');
    instanceTypesResource.addMethod('GET', lambdaIntegration, { authorizer });
    instanceTypesResource.addMethod('POST', lambdaIntegration, { authorizer });

    // Instance Type Catalog endpoint - returns dynamic catalog from DynamoDB
    const instanceTypesCatalogResource = this.api.root.addResource('instance-types');
    const catalogResource = instanceTypesCatalogResource.addResource('catalog');
    catalogResource.addMethod('GET', lambdaIntegration, { authorizer });

    domainsResource.addMethod('GET', lambdaIntegration, { authorizer });

    // Change Password Lambda function
    const changePasswordFunction = new lambda.Function(this, 'ChangePasswordFunction', {
      functionName: `${props.acronym.toLowerCase()}-change-password`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/change-password'),
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
      },
    });

    // Grant permissions for change password function
    changePasswordFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ds:ResetUserPassword',
        'ssm:GetParameter',
      ],
      resources: [
        `arn:aws:ds:${this.region}:${this.account}:directory/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/Identity/*`,
      ],
    }));

    // Change password endpoint
    const changePasswordIntegration = new apigateway.LambdaIntegration(changePasswordFunction);
    changePasswordResource.addMethod('POST', changePasswordIntegration, { authorizer });

    // Images endpoints - now using dedicated function
    imagesResource.addMethod('GET', imageIntegration, { authorizer });
    imagesResource.addMethod('POST', imageIntegration, { authorizer });
    
    // Image copy endpoint
    const imageCopyResource = imagesResource.addResource('copy');
    imageCopyResource.addMethod('POST', imageIntegration, { authorizer });
    
    const imageResource = imagesResource.addResource('{id}');
    imageResource.addMethod('PUT', imageIntegration, { authorizer });
    imageResource.addMethod('DELETE', imageIntegration, { authorizer });

    // Image Builder Pipeline endpoints
    const createPipelineResource = imagesResource.addResource('create-pipeline');
    createPipelineResource.addMethod('POST', imageIntegration, { authorizer });
    
    const pipelinesResource = imagesResource.addResource('pipelines');
    pipelinesResource.addMethod('GET', imageIntegration, { authorizer });
    
    const pipelineResource = pipelinesResource.addResource('{pipelineId}');
    pipelineResource.addMethod('PUT', imageIntegration, { authorizer });
    pipelineResource.addMethod('DELETE', imageIntegration, { authorizer });
    
    const pipelineStatusResource = pipelineResource.addResource('status');
    pipelineStatusResource.addMethod('GET', imageIntegration, { authorizer });
    
    const pipelineExecuteResource = pipelineResource.addResource('execute');
    pipelineExecuteResource.addMethod('POST', imageIntegration, { authorizer });

    // Software Library endpoints
    const softwareResource = imagesResource.addResource('software');
    softwareResource.addMethod('GET', softwareLibraryIntegration, { authorizer });
    softwareResource.addMethod('POST', softwareLibraryIntegration, { authorizer });
    
    // Upload URL endpoint for media files
    const uploadUrlResource = softwareResource.addResource('upload-url');
    uploadUrlResource.addMethod('POST', softwareLibraryIntegration, { authorizer });
    
    const softwareIdResource = softwareResource.addResource('{softwareId}');
    softwareIdResource.addMethod('GET', softwareLibraryIntegration, { authorizer });
    softwareIdResource.addMethod('PUT', softwareLibraryIntegration, { authorizer });
    softwareIdResource.addMethod('DELETE', softwareLibraryIntegration, { authorizer });

    // Install Script Agent endpoints (only if agent functions are available)
    if (invokeInstallScriptAgentFunction && installScriptProgressFunction && cancelInstallScriptFunction) {
      const invokeAgentIntegration = new apigateway.LambdaIntegration(invokeInstallScriptAgentFunction);
      const progressIntegration = new apigateway.LambdaIntegration(installScriptProgressFunction);
      const cancelIntegration = new apigateway.LambdaIntegration(cancelInstallScriptFunction);

      // POST /images/software/{softwareId}/generate-script
      const generateScriptResource = softwareIdResource.addResource('generate-script');
      generateScriptResource.addMethod('POST', invokeAgentIntegration, { authorizer });

      // GET /images/software/{softwareId}/generation-progress (SSE)
      const generationProgressResource = softwareIdResource.addResource('generation-progress');
      generationProgressResource.addMethod('GET', progressIntegration, { authorizer });

      // POST /images/software/{softwareId}/cancel-generation
      const cancelGenerationResource = softwareIdResource.addResource('cancel-generation');
      cancelGenerationResource.addMethod('POST', cancelIntegration, { authorizer });

      // Draft script generation endpoints (no softwareId required)
      // POST /images/software/generate-script-draft
      const generateScriptDraftResource = softwareResource.addResource('generate-script-draft');
      generateScriptDraftResource.addMethod('POST', invokeAgentIntegration, { authorizer });

      // GET /images/software/generation-progress-draft
      const generationProgressDraftResource = softwareResource.addResource('generation-progress-draft');
      generationProgressDraftResource.addMethod('GET', progressIntegration, { authorizer });

      // POST /images/software/cancel-generation - Cancel draft generation by executionId
      const cancelGenerationDraftResource = softwareResource.addResource('cancel-generation');
      cancelGenerationDraftResource.addMethod('POST', cancelIntegration, { authorizer });
    }

    // Chat Requirements endpoint (only when Bedrock features are enabled)
    if (chatRequirementsFunction) {
      const chatRequirementsIntegration = new apigateway.LambdaIntegration(chatRequirementsFunction);
      const chatResource = softwareResource.addResource('chat');
      chatResource.addMethod('POST', chatRequirementsIntegration, { authorizer });
    }

    // Storage endpoints
    storageResource.addMethod('GET', listStorageIntegration, { authorizer });
    storageResource.addMethod('POST', createStorageIntegration, { authorizer });
    storageIdResource.addMethod('GET', getStorageIntegration, { authorizer });
    storageIdResource.addMethod('PUT', updateStorageIntegration, { authorizer });
    storageIdResource.addMethod('DELETE', deleteStorageIntegration, { authorizer });

    // S3 Mount endpoint - POST /storage/mount
    const storageMountResource = storageResource.addResource('mount');
    storageMountResource.addMethod('POST', s3MountIntegration, { authorizer });

    // NFS Mount endpoint - POST /storage/nfs-mount (for FSxN on Linux/macOS)
    const storageNfsMountResource = storageResource.addResource('nfs-mount');
    storageNfsMountResource.addMethod('POST', nfsMountIntegration, { authorizer });

    // S3 Buckets endpoint - GET /storage/s3-buckets (for Mountpoint S3 bucket selection)
    const storageS3BucketsResource = storageResource.addResource('s3-buckets');
    storageS3BucketsResource.addMethod('GET', listS3BucketsIntegration, { authorizer });

    // Storage Config endpoint - GET /storage/config (for cross-account bucket policy generation)
    const storageConfigResource = storageResource.addResource('config');
    storageConfigResource.addMethod('GET', listS3BucketsIntegration, { authorizer });

    // ===========================================
    // DATASYNC API
    // ===========================================
    if (props.dataSyncStack) {
      const datasyncResource = this.api.root.addResource('datasync');
      
      // DataSync Location endpoints
      const locationsResource = datasyncResource.addResource('locations');
      const locationIdResource = locationsResource.addResource('{locationId}');
      
      const listLocationsIntegration = new apigateway.LambdaIntegration(props.dataSyncStack.functions.listLocations);
      const createLocationIntegration = new apigateway.LambdaIntegration(props.dataSyncStack.functions.createLocation);
      const deleteLocationIntegration = new apigateway.LambdaIntegration(props.dataSyncStack.functions.deleteLocation);
      
      locationsResource.addMethod('GET', listLocationsIntegration, { authorizer });
      locationsResource.addMethod('POST', createLocationIntegration, { authorizer });
      locationIdResource.addMethod('DELETE', deleteLocationIntegration, { authorizer });
      
      // DataSync Task endpoints
      const tasksResource = datasyncResource.addResource('tasks');
      const taskIdResource = tasksResource.addResource('{taskId}');
      
      const listTasksIntegration = new apigateway.LambdaIntegration(props.dataSyncStack.functions.listTasks);
      const createTaskIntegration = new apigateway.LambdaIntegration(props.dataSyncStack.functions.createTask);
      const updateTaskIntegration = new apigateway.LambdaIntegration(props.dataSyncStack.functions.updateTask);
      const deleteTaskIntegration = new apigateway.LambdaIntegration(props.dataSyncStack.functions.deleteTask);
      
      tasksResource.addMethod('GET', listTasksIntegration, { authorizer });
      tasksResource.addMethod('POST', createTaskIntegration, { authorizer });
      taskIdResource.addMethod('PUT', updateTaskIntegration, { authorizer });
      taskIdResource.addMethod('DELETE', deleteTaskIntegration, { authorizer });
      
      // Task execution endpoints
      const executeResource = taskIdResource.addResource('execute');
      const executionsResource = taskIdResource.addResource('executions');
      
      const startExecutionIntegration = new apigateway.LambdaIntegration(props.dataSyncStack.functions.startExecution);
      const getExecutionsIntegration = new apigateway.LambdaIntegration(props.dataSyncStack.functions.getExecutions);
      
      executeResource.addMethod('POST', startExecutionIntegration, { authorizer });
      executionsResource.addMethod('GET', getExecutionsIntegration, { authorizer });
      
      // S3 buckets endpoint for location creation dropdown
      const s3BucketsResource = datasyncResource.addResource('s3-buckets');
      const listS3BucketsIntegration = new apigateway.LambdaIntegration(props.dataSyncStack.functions.listS3Buckets);
      s3BucketsResource.addMethod('GET', listS3BucketsIntegration, { authorizer });

      // Config endpoint for cross-account bucket policy generation (reuses listS3Buckets Lambda)
      const configResource = datasyncResource.addResource('config');
      configResource.addMethod('GET', listS3BucketsIntegration, { authorizer });
    }

    // ===========================================
    // REGIONAL HUBS API
    // ===========================================

    // Regional Hub Lambda Functions
    const listRegionalHubsFunction = new lambda.Function(this, 'ListRegionalHubsFunction', {
      functionName: `${props.acronym.toLowerCase()}-list-regional-hubs`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/list-regional-hubs'),
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        REGIONAL_HUBS_TABLE_NAME: props.regionalHubsTable.tableName,
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
        VPC_ID: props.vpc.vpcId,
        DCV_ENDPOINT: sessionManagerNlbDns,
      },
    });

    // Grant EC2 permissions for VPC CIDR lookup
    listRegionalHubsFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ec2:DescribeVpcs'],
      resources: ['*'],
    }));

    const getRegionalHubFunction = new lambda.Function(this, 'GetRegionalHubFunction', {
      functionName: `${props.acronym.toLowerCase()}-get-regional-hub`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/get-regional-hub'),
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        REGIONAL_HUBS_TABLE_NAME: props.regionalHubsTable.tableName,
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
        VPC_ID: props.vpc.vpcId,
        DCV_ENDPOINT: sessionManagerNlbDns,
        PASCAL_CASE_NAME: props.pascalCaseName,
      },
    });

    // Grant EC2 and SSM permissions for primary region infrastructure lookup
    getRegionalHubFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:DescribeVpcs',
        'ec2:DescribeSubnets',
        'ec2:DescribeSecurityGroups',
      ],
      resources: ['*'],
    }));

    getRegionalHubFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/*`],
    }));

    const createRegionalHubFunction = new lambda.Function(this, 'CreateRegionalHubFunction', {
      functionName: `${props.acronym.toLowerCase()}-create-regional-hub`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/create-regional-hub'),
      timeout: cdk.Duration.minutes(1),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        REGIONAL_HUBS_TABLE_NAME: props.regionalHubsTable.tableName,
        PASCAL_CASE_NAME: props.pascalCaseName,
      },
    });

    const deleteRegionalHubFunction = new lambda.Function(this, 'DeleteRegionalHubFunction', {
      functionName: `${props.acronym.toLowerCase()}-delete-regional-hub`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/delete-regional-hub'),
      timeout: cdk.Duration.minutes(1),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        REGIONAL_HUBS_TABLE_NAME: props.regionalHubsTable.tableName,
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
        PASCAL_CASE_NAME: props.pascalCaseName,
      },
    });

    const updateRegionalHubFunction = new lambda.Function(this, 'UpdateRegionalHubFunction', {
      functionName: `${props.acronym.toLowerCase()}-update-regional-hub`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/update-regional-hub'),
      timeout: cdk.Duration.minutes(2),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        REGIONAL_HUBS_TABLE_NAME: props.regionalHubsTable.tableName,
        PASCAL_CASE_NAME: props.pascalCaseName,
        ACRONYM: props.acronym,
      },
    });

    // Grant DynamoDB permissions to regional hub functions
    props.regionalHubsTable.grantReadData(listRegionalHubsFunction);
    props.regionalHubsTable.grantReadData(getRegionalHubFunction);
    props.regionalHubsTable.grantReadWriteData(createRegionalHubFunction);
    props.regionalHubsTable.grantReadWriteData(deleteRegionalHubFunction);
    props.regionalHubsTable.grantReadWriteData(updateRegionalHubFunction);
    
    props.workstationTable.grantReadData(listRegionalHubsFunction);
    props.workstationTable.grantReadData(getRegionalHubFunction);
    props.workstationTable.grantReadData(deleteRegionalHubFunction);

    // Grant KMS permissions if tables use customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantDecrypt(listRegionalHubsFunction);
      props.dataEncryptionKey.grantDecrypt(getRegionalHubFunction);
      props.dataEncryptionKey.grantEncryptDecrypt(createRegionalHubFunction);
      props.dataEncryptionKey.grantEncryptDecrypt(deleteRegionalHubFunction);
      props.dataEncryptionKey.grantEncryptDecrypt(updateRegionalHubFunction);
    }

    // Grant EC2 permissions for region/AZ validation
    createRegionalHubFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:DescribeRegions',
        'ec2:DescribeAvailabilityZones',
      ],
      resources: ['*'],
    }));

    // Grant SSM permissions to look up state machine ARNs
    createRegionalHubFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/RegionalHub/*`],
    }));

    // Grant Step Functions permissions to start executions
    createRegionalHubFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['states:StartExecution'],
      resources: [`arn:aws:states:${this.region}:${this.account}:stateMachine:${props.acronym.toLowerCase()}-regional-hub-*`],
    }));

    // Grant SSM permissions to delete function
    deleteRegionalHubFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/RegionalHub/*`],
    }));

    // Grant Step Functions permissions to delete function
    deleteRegionalHubFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['states:StartExecution'],
      resources: [`arn:aws:states:${this.region}:${this.account}:stateMachine:${props.acronym.toLowerCase()}-regional-hub-*`],
    }));

    // Grant Lambda invoke permissions to update function (calls generate-template and update-cfn)
    updateRegionalHubFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [
        `arn:aws:lambda:${this.region}:${this.account}:function:${props.acronym.toLowerCase()}-generate-regional-hub-template`,
        `arn:aws:lambda:${this.region}:${this.account}:function:${props.acronym.toLowerCase()}-update-regional-hub-cfn`,
      ],
    }));

    // Regional Hubs API endpoints
    const regionsResource = this.api.root.addResource('regions');
    const regionIdResource = regionsResource.addResource('{region}');

    const listRegionalHubsIntegration = new apigateway.LambdaIntegration(listRegionalHubsFunction);
    const getRegionalHubIntegration = new apigateway.LambdaIntegration(getRegionalHubFunction);
    const createRegionalHubIntegration = new apigateway.LambdaIntegration(createRegionalHubFunction);
    const deleteRegionalHubIntegration = new apigateway.LambdaIntegration(deleteRegionalHubFunction);
    const updateRegionalHubIntegration = new apigateway.LambdaIntegration(updateRegionalHubFunction);

    regionsResource.addMethod('GET', listRegionalHubsIntegration, { authorizer });
    regionsResource.addMethod('POST', createRegionalHubIntegration, { authorizer });
    regionIdResource.addMethod('GET', getRegionalHubIntegration, { authorizer });
    regionIdResource.addMethod('DELETE', deleteRegionalHubIntegration, { authorizer });
    regionIdResource.addMethod('PUT', updateRegionalHubIntegration, { authorizer });

    // Get Availability Zones endpoint - GET /regions/{region}/availability-zones
    const getAvailabilityZonesFunction = new lambda.Function(this, 'GetAvailabilityZonesFunction', {
      functionName: `${props.acronym.toLowerCase()}-get-availability-zones`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/get-availability-zones'),
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
    });

    // Grant EC2 permissions for AZ and instance type offerings lookup
    getAvailabilityZonesFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:DescribeAvailabilityZones',
        'ec2:DescribeInstanceTypeOfferings',
      ],
      resources: ['*'],
    }));

    // Grant KMS permissions if using customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantDecrypt(getAvailabilityZonesFunction);
    }

    const availabilityZonesResource = regionIdResource.addResource('availability-zones');
    const getAvailabilityZonesIntegration = new apigateway.LambdaIntegration(getAvailabilityZonesFunction);
    availabilityZonesResource.addMethod('GET', getAvailabilityZonesIntegration, { authorizer });

    // Direct LDAP Authentication endpoint with JWT tokens
    const directLdapAuthFunction = new lambda.Function(this, 'DirectLdapAuthFunction', {
      functionName: `${props.acronym.toLowerCase()}-ldap-auth`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      vpc: props.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [workstationSecurityGroup],
      layers: [ldapLayer],
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/ldap-auth')),
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        JWT_SECRET_ARN: jwtSecret.secretArn,
        PASCAL_CASE_NAME: props.pascalCaseName,
      },
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 15,
    });

    // Grant permission to read the JWT secret
    jwtSecret.grantRead(directLdapAuthFunction);

    // Grant workstation manager function permission to invoke LDAP auth function
    directLdapAuthFunction.grantInvoke(workstationManagerFunction);
    workstationManagerFunction.addEnvironment('LDAP_AUTH_FUNCTION_NAME', directLdapAuthFunction.functionName);

    // Grant DirectLdapAuthFunction minimal required permissions
    directLdapAuthFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/Identity/*`,
      ],
    }));

    // Grant read access to user table for authentication
    props.userTable.grantReadData(directLdapAuthFunction);

    // Grant KMS permissions if tables use customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantDecrypt(directLdapAuthFunction);
    }

    const authResource = this.api.root.addResource('auth');
    const directAuthResource = authResource.addResource('ldap');
    const directAuthIntegration = new apigateway.LambdaIntegration(directLdapAuthFunction);
    
    // Login endpoint
    directAuthResource.addMethod('POST', directAuthIntegration);
    
    // JWT validation endpoint
    const validateResource = authResource.addResource('validate');
    const validateFunction = new lambda.Function(this, 'ValidateJwtFunction', {
      functionName: `${props.acronym.toLowerCase()}-validate-jwt`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/validate-jwt')),
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        JWT_SECRET_ARN: jwtSecret.secretArn
      },
      timeout: cdk.Duration.seconds(10),
      reservedConcurrentExecutions: 25,
    });

    // Grant permission to read the JWT secret
    jwtSecret.grantRead(validateFunction);
    
    const validateIntegration = new apigateway.LambdaIntegration(validateFunction);
    validateResource.addMethod('GET', validateIntegration);

    // DCV Session Manager endpoints
    const dcvResource = this.api.root.addResource('dcv');
    const dcvIntegration = new apigateway.LambdaIntegration(dcvSessionManagerAlias);
    dcvResource.addMethod('POST', dcvIntegration, { authorizer });

    // Store API endpoint in SSM Parameter Store for MCS module integration
    // Lambda function to update CORS when frontend URL parameter changes
    const corsUpdaterFunction = new lambda.Function(this, 'CorsUpdaterFunction', {
      functionName: `${props.acronym.toLowerCase()}-cors-updater`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/cors-updater')),
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        API_ID: this.api.restApiId,
        PASCAL_CASE_NAME: props.pascalCaseName,
      }
    });

    corsUpdaterFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'apigateway:GET',
        'apigateway:PUT',
        'apigateway:POST',
        'apigateway:PATCH',
        'ssm:GetParameter'
      ],
      resources: [
        `arn:aws:apigateway:${this.region}::/restapis/${this.api.restApiId}/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/Frontend/Url`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/Auth/*`
      ],
    }));

    // Add Cognito permissions for updating callback URLs
    corsUpdaterFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cognito-idp:DescribeUserPoolClient',
        'cognito-idp:UpdateUserPoolClient',
        'cognito-idp:ListIdentityProviders'
      ],
      resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/*`],
    }));

    // EventBridge rule to trigger CORS update when parameter changes
    const corsUpdateRule = new events.Rule(this, 'CorsUpdateRule', {
      ruleName: `${props.acronym.toLowerCase()}-cors-update`,
      eventPattern: {
        source: ['aws.ssm'],
        detailType: ['Parameter Store Change'],
        detail: {
          name: [`/${props.pascalCaseName}/Frontend/Url`],
          operation: ['Create', 'Update']
        }
      }
    });

    corsUpdateRule.addTarget(new targets.LambdaFunction(corsUpdaterFunction));

    // Create SSM parameters using CloudFormation resources to avoid synthesis-time resolution
    // Store API URL in SSM parameter for cross-stack references
    new ssm.StringParameter(this, 'ApiUrlParameter', {
      parameterName: `/${props.pascalCaseName}/Workstation/ApiUrl`,
      stringValue: this.api.url,
      description: 'API URL for workstation management'
    });

    // Create browser sessions enabled parameter with default value
    new ssm.StringParameter(this, 'BrowserSessionsEnabledParameter', {
      parameterName: `/${props.pascalCaseName}/DCV/BrowserSessionsEnabled`,
      stringValue: 'true',
      description: 'Whether browser-based DCV sessions are enabled for users'
    });

    // Store Software Library resource names for CodeBuild populate script
    new ssm.StringParameter(this, 'SoftwareLibraryTableNameParameter', {
      parameterName: `/${props.pascalCaseName}/SoftwareLibrary/TableName`,
      stringValue: props.softwareLibraryTable.tableName,
      description: 'DynamoDB table name for software library'
    });

    new ssm.StringParameter(this, 'SoftwareLibraryUploadsBucketParameter', {
      parameterName: `/${props.pascalCaseName}/SoftwareLibrary/UploadsBucket`,
      stringValue: props.imageBuilderUploadsBucket,
      description: 'S3 bucket name for software media uploads'
    });

    // ===========================================
    // OUTPUTS
    // ==========================================

    // Keep output for convenience (without export)
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'Workstation Management API URL',
    });
  }
}
