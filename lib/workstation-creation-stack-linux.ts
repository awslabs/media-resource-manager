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

interface LinuxWorkstationCreationStackProps extends cdk.StackProps {
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
  workstationLaunchTemplate: ec2.LaunchTemplate;
  sessionCleanupFunction: lambda.IFunction;
  dataEncryptionKey?: kms.IKey;
}

const linuxPhase1BaseInstallContent = require('../ssm-documents/linux-phase1-base-install');
const linuxPhase2GpuSetupContent = require('../ssm-documents/linux-phase2-gpu-setup');
const linuxPhase3StartServicesContent = require('../ssm-documents/linux-phase3-start-services');

export class LinuxWorkstationCreationStack extends cdk.Stack {
  public readonly stateMachine: stepfunctions.StateMachine;

  constructor(scope: Construct, id: string, props: LinuxWorkstationCreationStackProps) {
    super(scope, id, {
      ...props,
      description: "Step Functions workflow for automated Linux workstation provisioning with DCV (multi-phase)"
    });

    // ============================================
    // SSM DOCUMENTS - Split into 3 phases (distro-aware)
    // ============================================

    // Phase 1: Base Install - Desktop environment, DCV Server, SM Agent, configs
    // Auto-detects Ubuntu vs Rocky Linux and runs appropriate commands
    const phase1BaseInstallDoc = new ssm.CfnDocument(this, 'LinuxPhase1BaseInstall', {
      name: `${props.pascalCaseName}-Linux-Phase1-BaseInstall`,
      documentType: 'Command',
      documentFormat: 'YAML',
      updateMethod: 'NewVersion',
      content: linuxPhase1BaseInstallContent,
    });

    // Phase 2: GPU Setup - NVIDIA drivers (only for GPU instances, distro-aware)
    const phase2GpuSetupDoc = new ssm.CfnDocument(this, 'LinuxPhase2GpuSetup', {
      name: `${props.pascalCaseName}-Linux-Phase2-GpuSetup`,
      documentType: 'Command',
      documentFormat: 'YAML',
      updateMethod: 'NewVersion',
      content: linuxPhase2GpuSetupContent,
    });

    // Phase 3: Start Services - Start GDM, DCV Server, Session Manager Agent (distro-aware)
    const phase3StartServicesDoc = new ssm.CfnDocument(this, 'LinuxPhase3StartServices', {
      name: `${props.pascalCaseName}-Linux-Phase3-StartServices`,
      documentType: 'Command',
      documentFormat: 'YAML',
      updateMethod: 'NewVersion',
      content: linuxPhase3StartServicesContent,
    });


    // ============================================
    // LAMBDA FUNCTIONS
    // ============================================

    // Lambda: Create EC2 instance
    const createInstanceFunction = new lambda.Function(this, 'CreateLinuxInstanceFunction', {
      functionName: `${props.acronym.toLowerCase()}-instance-create-linux`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/instance-create-linux')),
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
        IMAGE_PIPELINES_TABLE_NAME: props.imagePipelinesTable.tableName,
        IMAGES_TABLE_NAME: props.amiTable.tableName,
        HOSTNAME_COUNTER_TABLE_NAME: props.hostnameCounterTable.tableName,
        PASCAL_CASE_NAME: props.pascalCaseName,
        LAUNCH_TEMPLATE_ID: props.workstationLaunchTemplate.launchTemplateId!,
        SUBNET_IDS: props.vpc.privateSubnets.map(s => s.subnetId).join(','),
      },
      timeout: cdk.Duration.minutes(2),
    });

    // Lambda: Check instance status
    const checkInstanceStatusFunction = new lambda.Function(this, 'CheckLinuxInstanceStatusFunction', {
      functionName: `${props.acronym.toLowerCase()}-instance-status-check-linux`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/instance-status-check-linux')),
      timeout: cdk.Duration.seconds(30),
    });

    // Lambda: Check SSM readiness
    const checkSSMReadinessFunction = new lambda.Function(this, 'CheckLinuxSSMReadinessFunction', {
      functionName: `${props.acronym.toLowerCase()}-ssm-readiness-check-linux`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/ssm-readiness-check-linux')),
      timeout: cdk.Duration.seconds(30),
    });

    // Lambda: Set hostname on Linux workstation
    const setHostnameFunction = new lambda.Function(this, 'SetLinuxHostnameFunction', {
      functionName: `${props.acronym.toLowerCase()}-hostname-set-linux`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/hostname-set-linux')),
      timeout: cdk.Duration.minutes(1),
    });

    // Lambda: Run SSM command (generic for all phases)
    const runSSMCommandFunction = new lambda.Function(this, 'RunLinuxSSMCommandFunction', {
      functionName: `${props.acronym.toLowerCase()}-ssm-command-run-linux`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
        REGIONAL_HUBS_TABLE_NAME: props.regionalHubsTable.tableName,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/ssm-command-run-linux')),
      timeout: cdk.Duration.minutes(1),
    });

    // Lambda: Check SSM command status
    const checkSSMCommandFunction = new lambda.Function(this, 'CheckLinuxSSMCommandFunction', {
      functionName: `${props.acronym.toLowerCase()}-ssm-command-check-linux`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/ssm-command-check-linux')),
      timeout: cdk.Duration.seconds(30),
    });

    // Lambda: Reboot instance
    const rebootInstanceFunction = new lambda.Function(this, 'RebootLinuxInstanceFunction', {
      functionName: `${props.acronym.toLowerCase()}-instance-restart-linux`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/instance-restart-linux')),
      timeout: cdk.Duration.seconds(30),
    });


    // Lambda: Check DCV readiness
    const checkDCVReadinessFunction = new lambda.Function(this, 'CheckLinuxDCVReadinessFunction', {
      functionName: `${props.acronym.toLowerCase()}-dcv-readiness-check-linux`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      reservedConcurrentExecutions: 20,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
        ACRONYM: props.acronym,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/dcv-readiness-check-linux')),
      vpc: props.vpc,
      vpcSubnets: { subnets: props.vpc.privateSubnets },
      securityGroups: [props.workstationSecurityGroup],
      timeout: cdk.Duration.minutes(2),
    });

    // ============================================
    // IAM PERMISSIONS
    // ============================================

    createInstanceFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ec2:RunInstances', 'ec2:CreateTags', 'ec2:DescribeImages'],
      resources: ['*'],
    }));
    createInstanceFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [
        props.workstationLaunchTemplate.role!.roleArn,
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
    // Grant read access to regional hubs table for looking up satellite region Session Manager endpoints
    props.regionalHubsTable.grantReadData(runSSMCommandFunction);
    if (props.dataEncryptionKey) props.dataEncryptionKey.grantDecrypt(runSSMCommandFunction);

    checkSSMCommandFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetCommandInvocation'],
      resources: ['*'],
    }));

    rebootInstanceFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ec2:RebootInstances'],
      resources: ['*'],
    }));

    checkDCVReadinessFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: ['*'],
    }));
    
    // Grant permission to invoke regional DCV readiness check Lambda for satellite regions
    checkDCVReadinessFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:*:${this.account}:function:${props.acronym.toLowerCase()}-regional-dcv-readiness-check-linux`],
    }));
    
    props.workstationTable.grantWriteData(checkDCVReadinessFunction);
    if (props.dataEncryptionKey) props.dataEncryptionKey.grantEncryptDecrypt(checkDCVReadinessFunction);


    // ============================================
    // STEP FUNCTIONS TASKS
    // ============================================

    const createInstanceTask = new tasks.LambdaInvoke(this, 'CreateLinuxInstance', {
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

    const checkInstanceStatusTask = new tasks.LambdaInvoke(this, 'CheckLinuxInstanceStatus', {
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

    const checkSSMReadinessTask = new tasks.LambdaInvoke(this, 'CheckLinuxSSMReadiness', {
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
    const setHostnameTask = new tasks.LambdaInvoke(this, 'SetLinuxHostname', {
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


    // Separate check SSM command tasks for each phase (each state can only have one .next())
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

    const checkSSMCommandPhase3 = new tasks.LambdaInvoke(this, 'CheckSSMCommandPhase3', {
      lambdaFunction: checkSSMCommandFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    checkSSMCommandPhase3.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    // Separate SSM readiness checks
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

    // Separate DCV readiness checks
    const checkDCVReadinessGpu = new tasks.LambdaInvoke(this, 'CheckDCVReadinessGpu', {
      lambdaFunction: checkDCVReadinessFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    checkDCVReadinessGpu.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    const rebootInstanceTask = new tasks.LambdaInvoke(this, 'RebootLinuxInstance', {
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

    // Phase-specific SSM command tasks
    const runPhase1Task = new tasks.LambdaInvoke(this, 'RunPhase1BaseInstall', {
      lambdaFunction: runSSMCommandFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
      payload: stepfunctions.TaskInput.fromObject({
        'instanceId.$': '$.instanceId',
        'assignedUserId.$': '$.assignedUserId',
        'amiId.$': '$.amiId',
        'instanceType.$': '$.instanceType',
        'platform.$': '$.platform',
        'hasGpu.$': '$.hasGpu',
        'region.$': '$.region',
        'documentName': phase1BaseInstallDoc.ref,
        'phase': 1
      }),
    });
    runPhase1Task.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    const runPhase2Task = new tasks.LambdaInvoke(this, 'RunPhase2GpuSetup', {
      lambdaFunction: runSSMCommandFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
      payload: stepfunctions.TaskInput.fromObject({
        'instanceId.$': '$.instanceId',
        'assignedUserId.$': '$.assignedUserId',
        'amiId.$': '$.amiId',
        'instanceType.$': '$.instanceType',
        'platform.$': '$.platform',
        'hasGpu.$': '$.hasGpu',
        'region.$': '$.region',
        'documentName': phase2GpuSetupDoc.ref,
        'phase': 2
      }),
    });
    runPhase2Task.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    const runPhase3Task = new tasks.LambdaInvoke(this, 'RunPhase3StartServices', {
      lambdaFunction: runSSMCommandFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
      payload: stepfunctions.TaskInput.fromObject({
        'instanceId.$': '$.instanceId',
        'assignedUserId.$': '$.assignedUserId',
        'amiId.$': '$.amiId',
        'instanceType.$': '$.instanceType',
        'platform.$': '$.platform',
        'hasGpu.$': '$.hasGpu',
        'region.$': '$.region',
        'documentName': phase3StartServicesDoc.ref,
        'phase': 3
      }),
    });
    runPhase3Task.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    // Wait states
    const waitForInstance = new stepfunctions.Wait(this, 'WaitForLinuxInstance', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const waitForSSM = new stepfunctions.Wait(this, 'WaitForLinuxSSM', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(20)),
    });

    const waitForPhase1 = new stepfunctions.Wait(this, 'WaitForPhase1', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(60)),
    });

    const waitForPhase2 = new stepfunctions.Wait(this, 'WaitForPhase2', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const waitForReboot = new stepfunctions.Wait(this, 'WaitForReboot', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(90)),
    });

    const waitForPhase3 = new stepfunctions.Wait(this, 'WaitForPhase3', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const waitForDCV = new stepfunctions.Wait(this, 'WaitForLinuxDCV', {
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
          ':status': { 'S': 'installing-base' },
          ':dcvStatus': { 'S': 'phase1-base-install' }
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
          ':status': { 'S': 'installing-gpu' },
          ':dcvStatus': { 'S': 'phase2-gpu-setup' }
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
          ':dcvStatus': { 'S': 'rebooting-for-gpu' }
        }
      },
      resultPath: stepfunctions.JsonPath.DISCARD,
      iamResources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTable.tableName}`]
    });

    const updateStatusPhase3 = new tasks.CallAwsService(this, 'UpdateStatusPhase3', {
      service: 'dynamodb',
      action: 'updateItem',
      parameters: {
        'TableName': props.workstationTable.tableName,
        'Key': { 'instanceId': { 'S.$': '$.instanceId' } },
        'UpdateExpression': 'SET #status = :status, dcvStatus = :dcvStatus',
        'ExpressionAttributeNames': { '#status': 'status' },
        'ExpressionAttributeValues': {
          ':status': { 'S': 'starting-services' },
          ':dcvStatus': { 'S': 'phase3-start-services' }
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
    const successState = new stepfunctions.Succeed(this, 'LinuxWorkstationCreated');
    const failureState = new stepfunctions.Fail(this, 'LinuxWorkstationCreationFailed', {
      cause: 'Linux workstation creation failed',
      error: 'WorkstationCreationError'
    });

    // Helper to create unique failure update states (each state can only have one .next())
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
        'hasGpu.$': '$.hasGpu',
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
        'hasGpu.$': '$.hasGpu',
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
        'hasGpu.$': '$.hasGpu',
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
        'hasGpu.$': '$.hasGpu',
        'region.$': '$.region',
        'ssmCommandId.$': '$.ssmCommandId',
        'commandPhase.$': '$.commandPhase',
        'retryCount.$': 'States.MathAdd($.retryCount, 1)'
      }
    });

    const initPhase3Retry = new stepfunctions.Pass(this, 'InitPhase3Retry', {
      parameters: {
        'instanceId.$': '$.instanceId',
        'assignedUserId.$': '$.assignedUserId',
        'amiId.$': '$.amiId',
        'instanceType.$': '$.instanceType',
        'platform.$': '$.platform',
        'hasGpu.$': '$.hasGpu',
        'region.$': '$.region',
        'ssmCommandId.$': '$.ssmCommandId',
        'commandPhase.$': '$.commandPhase',
        'retryCount': 0
      }
    });

    const incPhase3Retry = new stepfunctions.Pass(this, 'IncPhase3Retry', {
      parameters: {
        'instanceId.$': '$.instanceId',
        'assignedUserId.$': '$.assignedUserId',
        'amiId.$': '$.amiId',
        'instanceType.$': '$.instanceType',
        'platform.$': '$.platform',
        'hasGpu.$': '$.hasGpu',
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
        'hasGpu.$': '$.hasGpu',
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
        'hasGpu.$': '$.hasGpu',
        'region.$': '$.region',
        'retryCount.$': 'States.MathAdd($.retryCount, 1)'
      }
    });

    // Phase 1 polling loop - LINEAR FLOW (assumes all instances have GPU)
    // Phase 1 → Phase 2 → Reboot → Phase 3 → DCV Ready
    const phase1PollLoop = checkSSMCommandPhase1
      .next(new stepfunctions.Choice(this, 'Phase1Complete?')
        .when(stepfunctions.Condition.booleanEquals('$.commandSucceeded', true),
          // Phase 1 done → Phase 2 (GPU setup)
          updateStatusPhase2
            .next(runPhase2Task)
            .next(initPhase2Retry)
            .next(waitForPhase2)
            .next(checkSSMCommandPhase2)
            .next(new stepfunctions.Choice(this, 'Phase2Complete?')
              .when(stepfunctions.Condition.booleanEquals('$.commandSucceeded', true),
                // Phase 2 done → Reboot
                updateStatusRebooting
                  .next(rebootInstanceTask)
                  .next(waitForReboot)
                  .next(checkSSMReadinessAfterReboot)
                  .next(new stepfunctions.Choice(this, 'SSMReadyAfterReboot?')
                    .when(stepfunctions.Condition.booleanEquals('$.isSSMReady', true),
                      // SSM ready → Phase 3
                      updateStatusPhase3
                        .next(runPhase3Task)
                        .next(initPhase3Retry)
                        .next(waitForPhase3)
                        .next(checkSSMCommandPhase3)
                        .next(new stepfunctions.Choice(this, 'Phase3Complete?')
                          .when(stepfunctions.Condition.booleanEquals('$.commandSucceeded', true),
                            // Phase 3 done → DCV readiness check
                            initDcvRetry
                              .next(waitForDCV)
                              .next(checkDCVReadinessGpu)
                              .next(new stepfunctions.Choice(this, 'DcvReady?')
                                .when(stepfunctions.Condition.booleanEquals('$.dcvReady', true),
                                  updateStatusComplete.next(successState)
                                )
                                .otherwise(
                                  incDcvRetry
                                    .next(new stepfunctions.Choice(this, 'DcvRetryLimit?')
                                      .when(stepfunctions.Condition.numberGreaterThan('$.retryCount', 20),
                                        createFailureUpdate('FailDcvTimeout')
                                      )
                                      .otherwise(waitForDCV)
                                    )
                                )
                              )
                          )
                          .when(stepfunctions.Condition.booleanEquals('$.commandFailed', true),
                            createFailureUpdate('FailPhase3Command')
                          )
                          .otherwise(
                            incPhase3Retry
                              .next(new stepfunctions.Choice(this, 'Phase3RetryLimit?')
                                .when(stepfunctions.Condition.numberGreaterThan('$.retryCount', 10),
                                  createFailureUpdate('FailPhase3Timeout')
                                )
                                .otherwise(waitForPhase3)
                              )
                          )
                        )
                    )
                    .otherwise(waitForReboot)
                  )
              )
              .when(stepfunctions.Condition.booleanEquals('$.commandFailed', true),
                createFailureUpdate('FailPhase2Command')
              )
              .otherwise(
                incPhase2Retry
                  .next(new stepfunctions.Choice(this, 'Phase2RetryLimit?')
                    .when(stepfunctions.Condition.numberGreaterThan('$.retryCount', 20),
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
              .when(stepfunctions.Condition.numberGreaterThan('$.retryCount', 30),
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

    // Separate wait state for initial SSM check (each state can only have one .next())
    const waitForSSMInitial = new stepfunctions.Wait(this, 'WaitForLinuxSSMInitial', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(20)),
    });

    // Instance running check loop
    const instanceRunningLoop = checkInstanceStatusTask
      .next(new stepfunctions.Choice(this, 'InstanceRunning?')
        .when(stepfunctions.Condition.booleanEquals('$.isRunning', true),
          waitForSSMInitial.next(ssmReadinessLoop)
        )
        .otherwise(waitForInstance.next(checkInstanceStatusTask))
      );

    // Separate wait state for initial instance check (each state can only have one .next())
    const waitForInstanceInitial = new stepfunctions.Wait(this, 'WaitForLinuxInstanceInitial', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    // Main flow - starts with instance creation
    const definition = createInstanceTask
      .next(new stepfunctions.Choice(this, 'InstanceCreated?')
        .when(stepfunctions.Condition.isPresent('$.error'),
          new stepfunctions.Choice(this, 'RetryCapacity?')
            .when(stepfunctions.Condition.booleanEquals('$.shouldRetry', true),
              new stepfunctions.Wait(this, 'WaitBeforeRetry', {
                time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(10)),
              }).next(createInstanceTask)
            )
            .otherwise(failureState)
        )
        .otherwise(
          waitForInstanceInitial.next(instanceRunningLoop)
        )
      );

    // Create state machine
    this.stateMachine = new stepfunctions.StateMachine(this, 'LinuxWorkstationCreationStateMachine', {
      stateMachineName: `${props.acronym.toLowerCase()}-workstation-creation-linux`,
      definitionBody: stepfunctions.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.hours(1),
      tracingEnabled: true,
    });

    props.workstationTable.grantReadWriteData(this.stateMachine);

    // Outputs
    new cdk.CfnOutput(this, 'LinuxStateMachineArn', {
      value: this.stateMachine.stateMachineArn,
      description: 'Linux Workstation Creation State Machine ARN',
    });
  }
}
