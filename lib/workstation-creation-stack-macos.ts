// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as path from 'path';
import { Construct } from 'constructs';

interface MacOSWorkstationCreationStackProps extends cdk.StackProps {
  productName: string;
  pascalCaseName: string;
  acronym: string;
  workstationTable: dynamodb.Table;
  imagePipelinesTable: dynamodb.Table;
  amiTable: dynamodb.Table;
  hostnameCounterTable: dynamodb.Table;
  regionalHubsTable: dynamodb.Table;
  vpc: ec2.IVpc;
  workstationSecurityGroup: ec2.SecurityGroup;
  sessionCleanupFunction: lambda.IFunction;
  dataEncryptionKey?: kms.IKey;
}
const macosPhase1ConfigureDcvContent = require('../ssm-documents/macos-phase1-configure-dcv.js');
const macosPhase2AutoLoginContent = require('../ssm-documents/macos-phase2-auto-login.js');

export class MacOSWorkstationCreationStack extends cdk.Stack {
  public readonly stateMachine: stepfunctions.StateMachine;

  constructor(scope: Construct, id: string, props: MacOSWorkstationCreationStackProps) {
    super(scope, id, {
      ...props,
      description: "Step Functions workflow for automated macOS workstation provisioning with DCV"
    });

    // ============================================
    // IAM ROLE FOR macOS WORKSTATIONS
    // ============================================

    // Create IAM role for macOS workstations with minimal permissions
    const macOSWorkstationRole = new iam.Role(this, 'MacOSWorkstationRole', {
      roleName: `${props.pascalCaseName}-MacOS-Workstation-Role`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'IAM role for macOS workstations to access Secrets Manager and SSM',
    });

    // Allow reading the standalone admin password secret
    macOSWorkstationRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:/${props.pascalCaseName}/Workstation/StandaloneAdminPassword*`],
    }));

    // Allow DCV Server to access license bucket in S3
    macOSWorkstationRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: [
        `arn:aws:s3:::dcv-license.${this.region}/*`,
        `arn:aws:s3:::dcv-license.${this.region}`
      ],
    }));

    // Allow SSM agent to function
    macOSWorkstationRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
    );

    // Create instance profile
    const macOSInstanceProfile = new iam.InstanceProfile(this, 'MacOSInstanceProfile', {
      instanceProfileName: `${props.pascalCaseName}-MacOS-Workstation-Profile`,
      role: macOSWorkstationRole,
    });

    // ============================================
    // SSM DOCUMENTS FOR macOS
    // ============================================

    // Phase 1: Configure DCV Server and Session Manager Agent
    // V2: Updated config paths to correct macOS locations
    const phase1ConfigureDcvDoc = new ssm.CfnDocument(this, 'MacOSPhase1ConfigureDCVV2', {
      name: `${props.pascalCaseName}-MacOS-Phase1-ConfigureDCV-V2`,
      documentType: 'Command',
      documentFormat: 'YAML',
      content: macosPhase1ConfigureDcvContent,
    });

    // Phase 2: Configure Auto-Login
    const phase2AutoLoginDoc = new ssm.CfnDocument(this, 'MacOSPhase2AutoLogin', {
      name: `${props.pascalCaseName}-MacOS-Phase2-AutoLogin`,
      documentType: 'Command',
      documentFormat: 'YAML',
      updateMethod: 'NewVersion',
      content: macosPhase2AutoLoginContent,
    });

    // ============================================
    // LAMBDA FUNCTIONS
    // ============================================

    // Lambda: Allocate or find Dedicated Host for macOS
    const allocateDedicatedHostFunction = new lambda.Function(this, 'AllocateDedicatedHostFunction', {
      functionName: `${props.acronym.toLowerCase()}-dedicated-host-allocate-macos`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        AVAILABILITY_ZONES: props.vpc.availabilityZones.join(','),
        PASCAL_CASE_NAME: props.pascalCaseName,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/dedicated-host-allocate-macos')),
      timeout: cdk.Duration.minutes(2),
    });

    // Lambda: Create macOS EC2 instance on Dedicated Host
    const createInstanceFunction = new lambda.Function(this, 'CreateMacOSInstanceFunction', {
      functionName: `${props.acronym.toLowerCase()}-instance-create-macos`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
        IMAGE_PIPELINES_TABLE_NAME: props.imagePipelinesTable.tableName,
        IMAGES_TABLE_NAME: props.amiTable.tableName,
        HOSTNAME_COUNTER_TABLE_NAME: props.hostnameCounterTable.tableName,
        PASCAL_CASE_NAME: props.pascalCaseName,
        SECURITY_GROUP_ID: props.workstationSecurityGroup.securityGroupId,
        VPC_ID: props.vpc.vpcId,
        SUBNET_IDS: props.vpc.privateSubnets.map(s => `${s.subnetId}:${s.availabilityZone}`).join(','),
        INSTANCE_PROFILE_NAME: macOSInstanceProfile.instanceProfileName!,
        AWS_ACCOUNT_ID: this.account,
        // Host Resource Group ARN for launching instances with license-configured AMIs
        HOST_RESOURCE_GROUP_ARN: `arn:aws:resource-groups:${this.region}:${this.account}:group/${props.pascalCaseName}-Mac-Host-Resource-Group`,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/instance-create-macos')),
      timeout: cdk.Duration.minutes(2),
    });

    // Lambda: Check instance status
    const checkInstanceStatusFunction = new lambda.Function(this, 'CheckMacOSInstanceStatusFunction', {
      functionName: `${props.acronym.toLowerCase()}-instance-status-check-macos`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/instance-status-check-macos')),
      timeout: cdk.Duration.seconds(30),
    });

    // Lambda: Check SSM readiness
    const checkSSMReadinessFunction = new lambda.Function(this, 'CheckMacOSSSMReadinessFunction', {
      functionName: `${props.acronym.toLowerCase()}-ssm-readiness-check-macos`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/ssm-readiness-check-macos')),
      timeout: cdk.Duration.seconds(30),
    });

    // Lambda: Set hostname on macOS workstation
    const setHostnameFunction = new lambda.Function(this, 'SetMacOSHostnameFunction', {
      functionName: `${props.acronym.toLowerCase()}-hostname-set-macos`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/hostname-set-macos')),
      timeout: cdk.Duration.minutes(1),
    });

    // Lambda: Run SSM command
    const runSSMCommandFunction = new lambda.Function(this, 'RunMacOSSSMCommandFunction', {
      functionName: `${props.acronym.toLowerCase()}-ssm-command-run-macos`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/ssm-command-run-macos')),
      timeout: cdk.Duration.minutes(1),
    });

    // Lambda: Check SSM command status
    const checkSSMCommandFunction = new lambda.Function(this, 'CheckMacOSSSMCommandFunction', {
      functionName: `${props.acronym.toLowerCase()}-ssm-command-check-macos`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/ssm-command-check-macos')),
      timeout: cdk.Duration.seconds(30),
    });


    // Lambda: Check DCV readiness
    const checkDCVReadinessFunction = new lambda.Function(this, 'CheckMacOSDCVReadinessFunction', {
      functionName: `${props.acronym.toLowerCase()}-dcv-readiness-check-macos`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      reservedConcurrentExecutions: 20,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
        REGIONAL_HUBS_TABLE_NAME: props.regionalHubsTable.tableName,
        ACRONYM: props.acronym,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/dcv-readiness-check-macos')),
      vpc: props.vpc,
      vpcSubnets: { subnets: props.vpc.privateSubnets },
      securityGroups: [props.workstationSecurityGroup],
      timeout: cdk.Duration.minutes(2),
    });

    // Lambda: Reboot instance (required after auto-login configuration)
    const rebootInstanceFunction = new lambda.Function(this, 'RebootMacOSInstanceFunction', {
      functionName: `${props.acronym.toLowerCase()}-macos-instance-restart`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/macos-instance-restart')),
      timeout: cdk.Duration.seconds(30),
    });

    // ============================================
    // IAM PERMISSIONS
    // ============================================

    allocateDedicatedHostFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ec2:DescribeHosts', 'ec2:AllocateHosts', 'ec2:CreateTags'],
      resources: ['*'],
    }));

    createInstanceFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ec2:RunInstances', 'ec2:CreateTags', 'ec2:DescribeImages', 'ec2:DescribeSubnets'],
      resources: ['*'],
    }));
    
    // Permissions for Host Resource Group - required for launching into the resource group
    // and for adding orphaned hosts to the group (cross-region for satellite regions)
    createInstanceFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'resource-groups:ListGroupResources',
        'resource-groups:GetGroupConfiguration',
        'resource-groups:GroupResources',
      ],
      resources: ['*'], // Cross-region access needed for satellite regions
    }));
    
    // Permissions for License Manager - required for launching AMIs with license configurations
    createInstanceFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'license-manager:UpdateLicenseSpecificationsForResource',
        'license-manager:GetLicenseConfiguration',
      ],
      resources: ['*'],
    }));
    
    // Permission to allocate/modify hosts (Host Resource Group may auto-allocate)
    createInstanceFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ec2:AllocateHosts', 'ec2:ModifyHosts', 'ec2:DescribeHosts'],
      resources: ['*'],
    }));
    
    createInstanceFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [
        macOSWorkstationRole.roleArn,
        // Allow passing regional workstation roles for satellite region deployments
        `arn:aws:iam::${this.account}:role/${props.pascalCaseName}-Regional-Workstation-Role`,
      ],
    }));
    props.workstationTable.grantReadWriteData(createInstanceFunction);
    props.imagePipelinesTable.grantReadData(createInstanceFunction);
    props.amiTable.grantReadData(createInstanceFunction);
    props.hostnameCounterTable.grantReadWriteData(createInstanceFunction);

    // Grant SSM permissions for hostname configuration
    createInstanceFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/Workstation/HostnamePrefix`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/Workstation/HostnameDigits`,
      ],
    }));
    if (props.dataEncryptionKey) props.dataEncryptionKey.grantEncryptDecrypt(createInstanceFunction);

    checkInstanceStatusFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ec2:DescribeInstances'],
      resources: ['*'],
    }));

    checkSSMReadinessFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:DescribeInstanceInformation'],
      resources: ['*'],
    }));

    // Grant permissions to hostname-set function
    setHostnameFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:SendCommand'],
      resources: ['*'],
    }));
    props.workstationTable.grantReadWriteData(setHostnameFunction);
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(setHostnameFunction);
    }

    runSSMCommandFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:SendCommand', 'ssm:GetParameter'],
      resources: ['*'],
    }));
    if (props.dataEncryptionKey) props.dataEncryptionKey.grantDecrypt(runSSMCommandFunction);

    checkSSMCommandFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetCommandInvocation'],
      resources: ['*'],
    }));

    checkDCVReadinessFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: ['*'],
    }));
    // Allow invoking regional Lambda for satellite region workstations
    checkDCVReadinessFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:*:${this.account}:function:${props.acronym.toLowerCase()}-regional-dcv-readiness-check-macos`],
    }));
    props.workstationTable.grantWriteData(checkDCVReadinessFunction);
    props.regionalHubsTable.grantReadData(checkDCVReadinessFunction);
    if (props.dataEncryptionKey) props.dataEncryptionKey.grantEncryptDecrypt(checkDCVReadinessFunction);

    // Use SSM SendCommand instead of EC2 RebootInstances for proper macOS auto-login activation
    // EC2 RebootInstances API may not trigger the same boot sequence that activates auto-login
    rebootInstanceFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:SendCommand'],
      resources: ['*'],
    }));

    // ============================================
    // STEP FUNCTIONS TASKS
    // ============================================

    // NOTE: allocateDedicatedHostTask is no longer used - Host Resource Group handles
    // automatic host allocation. Keeping the Lambda for potential future fallback use.
    // const allocateDedicatedHostTask = new tasks.LambdaInvoke(this, 'AllocateDedicatedHost', {
    //   lambdaFunction: allocateDedicatedHostFunction,
    //   outputPath: '$.Payload',
    // });

    const createInstanceTask = new tasks.LambdaInvoke(this, 'CreateMacOSInstance', {
      lambdaFunction: createInstanceFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    createInstanceTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    const checkInstanceStatusTask = new tasks.LambdaInvoke(this, 'CheckMacOSInstanceStatus', {
      lambdaFunction: checkInstanceStatusFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    checkInstanceStatusTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    const checkSSMReadinessTask = new tasks.LambdaInvoke(this, 'CheckMacOSSSMReadiness', {
      lambdaFunction: checkSSMReadinessFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    checkSSMReadinessTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    // Task to set hostname on the workstation
    const setHostnameTask = new tasks.LambdaInvoke(this, 'SetMacOSHostname', {
      lambdaFunction: setHostnameFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    setHostnameTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    const checkSSMCommandPhase1 = new tasks.LambdaInvoke(this, 'CheckSSMCommandPhase1', {
      lambdaFunction: checkSSMCommandFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    checkSSMCommandPhase1.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    const checkSSMCommandPhase2 = new tasks.LambdaInvoke(this, 'CheckSSMCommandPhase2', {
      lambdaFunction: checkSSMCommandFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    checkSSMCommandPhase2.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    const checkDCVReadinessTask = new tasks.LambdaInvoke(this, 'CheckMacOSDCVReadiness', {
      lambdaFunction: checkDCVReadinessFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    checkDCVReadinessTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    const rebootInstanceTask = new tasks.LambdaInvoke(this, 'RebootMacOSInstance', {
      lambdaFunction: rebootInstanceFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    rebootInstanceTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    const runPhase1Task = new tasks.LambdaInvoke(this, 'RunPhase1ConfigureDCV', {
      lambdaFunction: runSSMCommandFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
      payload: stepfunctions.TaskInput.fromObject({
        'instanceId.$': '$.instanceId',
        'assignedUserId.$': '$.assignedUserId',
        'amiId.$': '$.amiId',
        'instanceType.$': '$.instanceType',
        'platform.$': '$.platform',
        'region.$': '$.region',
        'documentName': phase1ConfigureDcvDoc.ref,
        'phase': 1
      }),
    });
    runPhase1Task.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    const runPhase2Task = new tasks.LambdaInvoke(this, 'RunPhase2AutoLogin', {
      lambdaFunction: runSSMCommandFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
      payload: stepfunctions.TaskInput.fromObject({
        'instanceId.$': '$.instanceId',
        'assignedUserId.$': '$.assignedUserId',
        'amiId.$': '$.amiId',
        'instanceType.$': '$.instanceType',
        'platform.$': '$.platform',
        'region.$': '$.region',
        'documentName': phase2AutoLoginDoc.ref,
        'phase': 2
      }),
    });
    runPhase2Task.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    // Wait states
    const waitForInstance = new stepfunctions.Wait(this, 'WaitForMacOSInstance', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(60)),
    });

    const waitForSSM = new stepfunctions.Wait(this, 'WaitForMacOSSSM', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const waitForPhase1 = new stepfunctions.Wait(this, 'WaitForPhase1', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(60)),
    });

    const waitForPhase2 = new stepfunctions.Wait(this, 'WaitForPhase2', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const waitForDCV = new stepfunctions.Wait(this, 'WaitForMacOSDCV', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    // Wait for reboot to complete (macOS takes ~60-90 seconds to reboot)
    const waitForReboot = new stepfunctions.Wait(this, 'WaitForMacOSReboot', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(90)),
    });

    // Wait for SSM to come back online after reboot
    const waitForSSMAfterReboot = new stepfunctions.Wait(this, 'WaitForSSMAfterReboot', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    // DynamoDB status updates
    const updateStatusSettingHostname = new tasks.CallAwsService(this, 'UpdateStatusSettingHostname', {
      service: 'dynamodb',
      action: 'updateItem',
      parameters: {
        'TableName': props.workstationTable.tableName,
        'Key': { 'instanceId': { 'S.$': '$.instanceId' } },
        'UpdateExpression': 'SET #status = :status, dcvStatus = :dcvStatus',
        'ExpressionAttributeNames': { '#status': 'status' },
        'ExpressionAttributeValues': {
          ':status': { 'S': 'setting-hostname' },
          ':dcvStatus': { 'S': 'setting-hostname' }
        }
      },
      resultPath: stepfunctions.JsonPath.DISCARD,
      iamResources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTable.tableName}`]
    });

    const updateStatusPhase1 = new tasks.CallAwsService(this, 'UpdateStatusPhase1', {
      service: 'dynamodb',
      action: 'updateItem',
      parameters: {
        'TableName': props.workstationTable.tableName,
        'Key': { 'instanceId': { 'S.$': '$.instanceId' } },
        'UpdateExpression': 'SET #status = :status, dcvStatus = :dcvStatus',
        'ExpressionAttributeNames': { '#status': 'status' },
        'ExpressionAttributeValues': {
          ':status': { 'S': 'configuring-dcv' },
          ':dcvStatus': { 'S': 'phase1-configure-dcv' }
        }
      },
      resultPath: stepfunctions.JsonPath.DISCARD,
      iamResources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTable.tableName}`]
    });

    const updateStatusPhase2 = new tasks.CallAwsService(this, 'UpdateStatusPhase2', {
      service: 'dynamodb',
      action: 'updateItem',
      parameters: {
        'TableName': props.workstationTable.tableName,
        'Key': { 'instanceId': { 'S.$': '$.instanceId' } },
        'UpdateExpression': 'SET #status = :status, dcvStatus = :dcvStatus',
        'ExpressionAttributeNames': { '#status': 'status' },
        'ExpressionAttributeValues': {
          ':status': { 'S': 'configuring-autologin' },
          ':dcvStatus': { 'S': 'phase2-auto-login' }
        }
      },
      resultPath: stepfunctions.JsonPath.DISCARD,
      iamResources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTable.tableName}`]
    });

    const updateStatusRebooting = new tasks.CallAwsService(this, 'UpdateStatusRebooting', {
      service: 'dynamodb',
      action: 'updateItem',
      parameters: {
        'TableName': props.workstationTable.tableName,
        'Key': { 'instanceId': { 'S.$': '$.instanceId' } },
        'UpdateExpression': 'SET #status = :status, dcvStatus = :dcvStatus',
        'ExpressionAttributeNames': { '#status': 'status' },
        'ExpressionAttributeValues': {
          ':status': { 'S': 'rebooting' },
          ':dcvStatus': { 'S': 'rebooting-for-autologin' }
        }
      },
      resultPath: stepfunctions.JsonPath.DISCARD,
      iamResources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTable.tableName}`]
    });

    const updateStatusComplete = new tasks.CallAwsService(this, 'UpdateStatusComplete', {
      service: 'dynamodb',
      action: 'updateItem',
      parameters: {
        'TableName': props.workstationTable.tableName,
        'Key': { 'instanceId': { 'S.$': '$.instanceId' } },
        'UpdateExpression': 'SET #status = :status, dcvStatus = :dcvStatus',
        'ExpressionAttributeNames': { '#status': 'status' },
        'ExpressionAttributeValues': {
          ':status': { 'S': 'Complete' },
          ':dcvStatus': { 'S': 'ready' }
        }
      },
      resultPath: stepfunctions.JsonPath.DISCARD,
      iamResources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTable.tableName}`]
    });

    // Success/Failure states
    const successState = new stepfunctions.Succeed(this, 'MacOSWorkstationCreated');
    const failureState = new stepfunctions.Fail(this, 'MacOSWorkstationCreationFailed', {
      cause: 'macOS workstation creation failed',
      error: 'WorkstationCreationError'
    });

    // Helper to create unique failure update states
    const createFailureUpdate = (id: string) => new tasks.CallAwsService(this, id, {
      service: 'dynamodb',
      action: 'updateItem',
      parameters: {
        'TableName': props.workstationTable.tableName,
        'Key': { 'instanceId': { 'S.$': '$.instanceId' } },
        'UpdateExpression': 'SET #status = :status, dcvStatus = :dcvStatus',
        'ExpressionAttributeNames': { '#status': 'status' },
        'ExpressionAttributeValues': {
          ':status': { 'S': 'failed' },
          ':dcvStatus': { 'S': 'failed' }
        }
      },
      resultPath: stepfunctions.JsonPath.DISCARD,
      iamResources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTable.tableName}`]
    }).next(failureState);


    // ============================================
    // STATE MACHINE DEFINITION
    // ============================================

    // Retry counters
    const initPhase1Retry = new stepfunctions.Pass(this, 'InitPhase1Retry', {
      parameters: {
        'instanceId.$': '$.instanceId',
        'assignedUserId.$': '$.assignedUserId',
        'amiId.$': '$.amiId',
        'instanceType.$': '$.instanceType',
        'platform.$': '$.platform',
        'region.$': '$.region',
        'ssmCommandId.$': '$.ssmCommandId',
        'commandPhase.$': '$.commandPhase',
        'retryCount': 0
      }
    });

    const incPhase1Retry = new stepfunctions.Pass(this, 'IncPhase1Retry', {
      parameters: {
        'instanceId.$': '$.instanceId',
        'assignedUserId.$': '$.assignedUserId',
        'amiId.$': '$.amiId',
        'instanceType.$': '$.instanceType',
        'platform.$': '$.platform',
        'region.$': '$.region',
        'ssmCommandId.$': '$.ssmCommandId',
        'commandPhase.$': '$.commandPhase',
        'retryCount.$': 'States.MathAdd($.retryCount, 1)'
      }
    });

    const initPhase2Retry = new stepfunctions.Pass(this, 'InitPhase2Retry', {
      parameters: {
        'instanceId.$': '$.instanceId',
        'assignedUserId.$': '$.assignedUserId',
        'amiId.$': '$.amiId',
        'instanceType.$': '$.instanceType',
        'platform.$': '$.platform',
        'region.$': '$.region',
        'ssmCommandId.$': '$.ssmCommandId',
        'commandPhase.$': '$.commandPhase',
        'retryCount': 0
      }
    });

    const incPhase2Retry = new stepfunctions.Pass(this, 'IncPhase2Retry', {
      parameters: {
        'instanceId.$': '$.instanceId',
        'assignedUserId.$': '$.assignedUserId',
        'amiId.$': '$.amiId',
        'instanceType.$': '$.instanceType',
        'platform.$': '$.platform',
        'region.$': '$.region',
        'ssmCommandId.$': '$.ssmCommandId',
        'commandPhase.$': '$.commandPhase',
        'retryCount.$': 'States.MathAdd($.retryCount, 1)'
      }
    });

    const initDcvRetry = new stepfunctions.Pass(this, 'InitDcvRetry', {
      parameters: {
        'instanceId.$': '$.instanceId',
        'assignedUserId.$': '$.assignedUserId',
        'amiId.$': '$.amiId',
        'instanceType.$': '$.instanceType',
        'platform.$': '$.platform',
        'region.$': '$.region',
        'retryCount': 0
      }
    });

    const incDcvRetry = new stepfunctions.Pass(this, 'IncDcvRetry', {
      parameters: {
        'instanceId.$': '$.instanceId',
        'assignedUserId.$': '$.assignedUserId',
        'amiId.$': '$.amiId',
        'instanceType.$': '$.instanceType',
        'platform.$': '$.platform',
        'region.$': '$.region',
        'retryCount.$': 'States.MathAdd($.retryCount, 1)'
      }
    });

    // Retry counter for SSM readiness after reboot
    const initRebootRetry = new stepfunctions.Pass(this, 'InitRebootRetry', {
      parameters: {
        'instanceId.$': '$.instanceId',
        'assignedUserId.$': '$.assignedUserId',
        'amiId.$': '$.amiId',
        'instanceType.$': '$.instanceType',
        'platform.$': '$.platform',
        'region.$': '$.region',
        'retryCount': 0
      }
    });

    const incRebootRetry = new stepfunctions.Pass(this, 'IncRebootRetry', {
      parameters: {
        'instanceId.$': '$.instanceId',
        'assignedUserId.$': '$.assignedUserId',
        'amiId.$': '$.amiId',
        'instanceType.$': '$.instanceType',
        'platform.$': '$.platform',
        'region.$': '$.region',
        'retryCount.$': 'States.MathAdd($.retryCount, 1)'
      }
    });

    // SSM readiness check task for after reboot (reuses the same Lambda)
    const checkSSMReadinessAfterReboot = new tasks.LambdaInvoke(this, 'CheckSSMReadinessAfterReboot', {
      lambdaFunction: checkSSMReadinessFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    checkSSMReadinessAfterReboot.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    // Instance status check task for after reboot (reuses the same Lambda)
    const checkInstanceStatusAfterReboot = new tasks.LambdaInvoke(this, 'CheckInstanceStatusAfterReboot', {
      lambdaFunction: checkInstanceStatusFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    checkInstanceStatusAfterReboot.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    // Additional wait state for SSM retry loop (each state can only have one next)
    const waitForSSMAfterRebootRetry = new stepfunctions.Wait(this, 'WaitForSSMAfterRebootRetry', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    // Additional wait state for reboot retry loop
    const waitForRebootRetry = new stepfunctions.Wait(this, 'WaitForRebootRetry', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(90)),
    });

    // Post-reboot flow: Wait for instance → Wait for SSM → DCV readiness check
    const postRebootSSMLoop = checkSSMReadinessAfterReboot
      .next(new stepfunctions.Choice(this, 'SSMReadyAfterReboot?')
        .when(stepfunctions.Condition.booleanEquals('$.isSSMReady', true),
          // SSM is ready, now check DCV readiness
          initDcvRetry
            .next(waitForDCV)
            .next(checkDCVReadinessTask)
            .next(new stepfunctions.Choice(this, 'DcvReady?')
              .when(stepfunctions.Condition.booleanEquals('$.dcvReady', true),
                updateStatusComplete.next(successState)
              )
              .otherwise(
                incDcvRetry
                  .next(new stepfunctions.Choice(this, 'DcvRetryLimit?')
                    .when(stepfunctions.Condition.numberGreaterThan('$.retryCount', 30),
                      createFailureUpdate('FailDcvTimeout')
                    )
                    .otherwise(waitForDCV)
                  )
              )
            )
        )
        .otherwise(
          incRebootRetry
            .next(new stepfunctions.Choice(this, 'RebootSSMRetryLimit?')
              .when(stepfunctions.Condition.numberGreaterThan('$.retryCount', 20),
                createFailureUpdate('FailSSMAfterReboot')
              )
              .otherwise(waitForSSMAfterRebootRetry.next(checkSSMReadinessAfterReboot))
            )
        )
      );

    // Post-reboot instance running check
    const postRebootInstanceLoop = checkInstanceStatusAfterReboot
      .next(new stepfunctions.Choice(this, 'InstanceRunningAfterReboot?')
        .when(stepfunctions.Condition.booleanEquals('$.isRunning', true),
          initRebootRetry.next(waitForSSMAfterReboot).next(postRebootSSMLoop)
        )
        .otherwise(waitForRebootRetry.next(checkInstanceStatusAfterReboot))
      );

    // Phase 1 polling loop: Configure DCV → Phase 2 Auto-Login → Reboot → DCV Ready
    const phase1PollLoop = checkSSMCommandPhase1
      .next(new stepfunctions.Choice(this, 'Phase1Complete?')
        .when(stepfunctions.Condition.booleanEquals('$.commandSucceeded', true),
          // Phase 1 done → Phase 2 (Auto-Login)
          updateStatusPhase2
            .next(runPhase2Task)
            .next(initPhase2Retry)
            .next(waitForPhase2)
            .next(checkSSMCommandPhase2)
            .next(new stepfunctions.Choice(this, 'Phase2Complete?')
              .when(stepfunctions.Condition.booleanEquals('$.commandSucceeded', true),
                // Phase 2 done → Reboot to activate auto-login
                updateStatusRebooting
                  .next(rebootInstanceTask)
                  .next(waitForReboot)
                  .next(postRebootInstanceLoop)
              )
              .when(stepfunctions.Condition.booleanEquals('$.commandFailed', true),
                createFailureUpdate('FailPhase2Command')
              )
              .otherwise(
                incPhase2Retry
                  .next(new stepfunctions.Choice(this, 'Phase2RetryLimit?')
                    .when(stepfunctions.Condition.numberGreaterThan('$.retryCount', 10),
                      createFailureUpdate('FailPhase2Timeout')
                    )
                    .otherwise(waitForPhase2)
                  )
              )
            )
        )
        .when(stepfunctions.Condition.booleanEquals('$.commandFailed', true),
          createFailureUpdate('FailPhase1Command')
        )
        .otherwise(
          incPhase1Retry
            .next(new stepfunctions.Choice(this, 'Phase1RetryLimit?')
              .when(stepfunctions.Condition.numberGreaterThan('$.retryCount', 15),
                createFailureUpdate('FailPhase1Timeout')
              )
              .otherwise(waitForPhase1)
            )
        )
      );

    // Initial SSM readiness loop
    const ssmReadinessLoop = checkSSMReadinessTask
      .next(new stepfunctions.Choice(this, 'SSMReady?')
        .when(stepfunctions.Condition.booleanEquals('$.isSSMReady', true),
          // Set hostname before Phase 1
          updateStatusSettingHostname
            .next(setHostnameTask)
            .next(updateStatusPhase1)
            .next(runPhase1Task)
            .next(initPhase1Retry)
            .next(waitForPhase1)
            .next(phase1PollLoop)
        )
        .otherwise(waitForSSM.next(checkSSMReadinessTask))
      );

    // Separate wait state for initial SSM check
    const waitForSSMInitial = new stepfunctions.Wait(this, 'WaitForMacOSSSMInitial', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    // Instance running check loop
    const instanceRunningLoop = checkInstanceStatusTask
      .next(new stepfunctions.Choice(this, 'InstanceRunning?')
        .when(stepfunctions.Condition.booleanEquals('$.isRunning', true),
          waitForSSMInitial.next(ssmReadinessLoop)
        )
        .otherwise(waitForInstance.next(checkInstanceStatusTask))
      );

    // Separate wait state for initial instance check (macOS takes longer to boot)
    const waitForInstanceInitial = new stepfunctions.Wait(this, 'WaitForMacOSInstanceInitial', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(120)),
    });

    // Main flow - go directly to instance creation
    // Host Resource Group handles automatic dedicated host allocation
    // No need for manual host allocation step - the HRG will:
    // 1. Find an available host with capacity
    // 2. Or automatically allocate a new host if needed
    const definition = createInstanceTask
      .next(waitForInstanceInitial)
      .next(instanceRunningLoop);

    // Create state machine
    this.stateMachine = new stepfunctions.StateMachine(this, 'MacOSWorkstationCreationStateMachine', {
      stateMachineName: `${props.acronym.toLowerCase()}-workstation-creation-macos`,
      definitionBody: stepfunctions.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.hours(2), // macOS takes longer due to Dedicated Host allocation
      tracingEnabled: true,
    });

    props.workstationTable.grantReadWriteData(this.stateMachine);

    // Store state machine ARN in SSM Parameter Store for cross-stack reference
    // This avoids CloudFormation export dependencies that prevent stack updates
    new ssm.StringParameter(this, 'MacOSStateMachineArnParameter', {
      parameterName: `/${props.pascalCaseName}/Workstation/MacOSStateMachineArn`,
      stringValue: this.stateMachine.stateMachineArn,
      description: 'macOS Workstation Creation State Machine ARN',
    });

    // Outputs
    new cdk.CfnOutput(this, 'MacOSStateMachineArn', {
      value: this.stateMachine.stateMachineArn,
      description: 'macOS Workstation Creation State Machine ARN',
    });
  }
}
