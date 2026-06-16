// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as path from 'path';
import { Construct } from 'constructs';

export interface WorkstationStartStackProps extends cdk.StackProps {
  productName: string;
  pascalCaseName: string;
  acronym: string;
  workstationTableName: string;
  storageTableName: string;
  progressTableName: string;
  checkDCVReadinessFunction: lambda.Function;
  checkInstanceStatusFunction: lambda.Function;
  checkSessionStatusFunction: lambda.Function;
  deleteTestSessionFunction: lambda.Function;
  verifySessionDeletedFunction: lambda.Function;
  dataEncryptionKey?: kms.IKey;
  vpc: ec2.IVpc;
  workstationSecurityGroup: ec2.ISecurityGroup;
}

export class WorkstationStartStack extends cdk.Stack {
  public readonly stateMachineArn: string;

  constructor(scope: Construct, id: string, props: WorkstationStartStackProps) {
    super(scope, id, {
      ...props,
      description: "Step Functions workflow for workstation startup and initialization processes"
    });

    // Lambda function to start instance and update DCV status
    const startInstanceFunction = new lambda.Function(this, 'StartInstanceFunction', {
      functionName: `${props.acronym.toLowerCase()}-start-instance`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/start-instance')),
      environment: {
        WORKSTATION_TABLE_NAME: props.workstationTableName,
      },
      timeout: cdk.Duration.minutes(2),
    });

    // Grant permissions
    startInstanceFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ec2:StartInstances', 'ec2:DescribeInstances'],
      resources: ['*'],
    }));

    startInstanceFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:UpdateItem', 'dynamodb:GetItem'],
      resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTableName}`],
    }));

    // Create the publish progress function
    const publishProgressFunction = new lambda.Function(this, 'PublishProgressFunction', {
      functionName: `${props.acronym.toLowerCase()}-publish-progress`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'publish-progress.lambda_handler',
      code: lambda.Code.fromAsset('lambda/publish-progress'),
      reservedConcurrentExecutions: 20,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PROGRESS_TABLE_NAME: props.progressTableName,
        WORKSTATION_TABLE_NAME: props.workstationTableName,
      },
    });

    // Grant DynamoDB permissions
    const progressTable = dynamodb.Table.fromTableName(this, 'ProgressTable', props.progressTableName);
    const workstationTable = dynamodb.Table.fromTableName(this, 'WorkstationTable', props.workstationTableName);
    progressTable.grantWriteData(publishProgressFunction);
    workstationTable.grantWriteData(publishProgressFunction);

    // Grant KMS permissions if tables use customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(publishProgressFunction);
      props.dataEncryptionKey.grantEncryptDecrypt(startInstanceFunction);
    }

    // ============================================
    // LINUX AUTOLOGIN LAMBDA FUNCTIONS
    // ============================================

    const configureLinuxAutologinFunction = new lambda.Function(this, 'ConfigureLinuxAutologinFunction', {
      functionName: `${props.acronym.toLowerCase()}-autologin-configure-linux`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/autologin-configure-linux')),
      timeout: cdk.Duration.seconds(30),
    });

    configureLinuxAutologinFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:SendCommand'],
      resources: ['*'],
    }));

    const checkLinuxAutologinStatusFunction = new lambda.Function(this, 'CheckLinuxAutologinStatusFunction', {
      functionName: `${props.acronym.toLowerCase()}-autologin-status-check-linux`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/autologin-status-check-linux')),
      timeout: cdk.Duration.seconds(30),
    });

    checkLinuxAutologinStatusFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetCommandInvocation'],
      resources: ['*'],
    }));

    // ============================================
    // WINDOWS AUTOLOGIN LAMBDA FUNCTION (reuses existing autologin-configure with SSM document)
    // ============================================

    const configureWindowsAutologinFunction = new lambda.Function(this, 'ConfigureWindowsAutologinFunction', {
      functionName: `${props.acronym.toLowerCase()}-autologin-configure-windows-start`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/autologin-configure')),
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
      },
      timeout: cdk.Duration.seconds(30),
    });

    configureWindowsAutologinFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:SendCommand'],
      resources: ['*'],
    }));

    // ============================================
    // MACOS AUTOLOGIN LAMBDA FUNCTIONS
    // ============================================

    const configureMacosAutologinFunction = new lambda.Function(this, 'ConfigureMacosAutologinFunction', {
      functionName: `${props.acronym.toLowerCase()}-autologin-configure-macos`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/autologin-configure-macos')),
      timeout: cdk.Duration.seconds(30),
    });

    configureMacosAutologinFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:SendCommand'],
      resources: ['*'],
    }));

    const checkMacosAutologinStatusFunction = new lambda.Function(this, 'CheckMacosAutologinStatusFunction', {
      functionName: `${props.acronym.toLowerCase()}-autologin-status-check-macos`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/autologin-status-check-macos')),
      timeout: cdk.Duration.seconds(30),
    });

    checkMacosAutologinStatusFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetCommandInvocation'],
      resources: ['*'],
    }));

    // ============================================
    // SSM READINESS CHECK FUNCTION (for Linux/macOS)
    // ============================================

    const checkSSMReadinessFunction = new lambda.Function(this, 'CheckSSMReadinessFunction', {
      functionName: `${props.acronym.toLowerCase()}-ssm-readiness-check-start`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/ssm-readiness-check-macos')),
      timeout: cdk.Duration.seconds(30),
    });

    checkSSMReadinessFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:DescribeInstanceInformation'],
      resources: ['*'],
    }));

    // ============================================
    // PLATFORM-SPECIFIC DCV READINESS CHECK FUNCTIONS
    // ============================================

    // Linux DCV readiness check - doesn't create test sessions
    const checkDCVReadinessLinuxFunction = new lambda.Function(this, 'CheckDCVReadinessLinuxFunction', {
      functionName: `${props.acronym.toLowerCase()}-dcv-readiness-check-linux-start`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/dcv-readiness-check-linux')),
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
        WORKSTATION_TABLE_NAME: props.workstationTableName,
        ACRONYM: props.acronym,
      },
      timeout: cdk.Duration.minutes(2),
      vpc: props.vpc,
      vpcSubnets: { subnets: props.vpc.privateSubnets },
      securityGroups: [props.workstationSecurityGroup],
    });

    checkDCVReadinessLinuxFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/*`],
    }));

    checkDCVReadinessLinuxFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:UpdateItem'],
      resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTableName}`],
    }));

    // Grant permission to invoke regional DCV readiness check Lambda for satellite regions
    checkDCVReadinessLinuxFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:*:${this.account}:function:${props.acronym.toLowerCase()}-regional-dcv-readiness-check-linux`],
    }));

    // macOS DCV readiness check - doesn't create test sessions
    const checkDCVReadinessMacosFunction = new lambda.Function(this, 'CheckDCVReadinessMacosFunction', {
      functionName: `${props.acronym.toLowerCase()}-dcv-readiness-check-macos-start`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/dcv-readiness-check-macos')),
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
        WORKSTATION_TABLE_NAME: props.workstationTableName,
        ACRONYM: props.acronym,
      },
      timeout: cdk.Duration.minutes(2),
      vpc: props.vpc,
      vpcSubnets: { subnets: props.vpc.privateSubnets },
      securityGroups: [props.workstationSecurityGroup],
    });

    checkDCVReadinessMacosFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/*`],
    }));

    checkDCVReadinessMacosFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:UpdateItem'],
      resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTableName}`],
    }));

    // Grant permission to invoke regional DCV readiness check Lambda for satellite regions
    checkDCVReadinessMacosFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:*:${this.account}:function:${props.acronym.toLowerCase()}-regional-dcv-readiness-check-macos`],
    }));

    // Grant read access to regional-hubs table for satellite region endpoint lookup
    checkDCVReadinessMacosFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:GetItem'],
      resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/regional-hubs`],
    }));

    // Grant cross-region SSM access for satellite region DCV credentials
    checkDCVReadinessMacosFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:*:${this.account}:parameter/${props.pascalCaseName}/DCV/*`],
    }));

    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(checkDCVReadinessLinuxFunction);
      props.dataEncryptionKey.grantEncryptDecrypt(checkDCVReadinessMacosFunction);
    }

    // ============================================
    // SHARED TASKS
    // ============================================

    const publishStartingTask = new tasks.LambdaInvoke(this, 'PublishStarting', {
      lambdaFunction: publishProgressFunction,
      resultPath: '$.progressResult',
      payload: sfn.TaskInput.fromObject({
        'instanceId.$': '$.instanceId',
        'stage': 'starting-instance',
        'status': 'in-progress',
        'message': 'Starting EC2 instance...',
        'progress': 10
      }),
    });

    const startInstanceTask = new tasks.LambdaInvoke(this, 'StartInstance', {
      lambdaFunction: startInstanceFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false, // We'll add custom retry
    });

    // Add throttling retry to startInstanceTask
    startInstanceTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    const publishRunningTask = new tasks.LambdaInvoke(this, 'PublishRunning', {
      lambdaFunction: publishProgressFunction,
      resultPath: '$.progressResult',
      payload: sfn.TaskInput.fromObject({
        'instanceId.$': '$.instanceId',
        'stage': 'instance-running',
        'status': 'completed',
        'message': 'EC2 instance is running',
        'progress': 20
      }),
    });

    const checkInstanceStatusTask = new tasks.LambdaInvoke(this, 'CheckInstanceStatus', {
      lambdaFunction: props.checkInstanceStatusFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });

    // Add throttling retry to checkInstanceStatusTask
    checkInstanceStatusTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    const publishConfiguringAutologinTask = new tasks.LambdaInvoke(this, 'PublishConfiguringAutologin', {
      lambdaFunction: publishProgressFunction,
      resultPath: '$.progressResult',
      payload: sfn.TaskInput.fromObject({
        'instanceId.$': '$.instanceId',
        'stage': 'configuring-autologin',
        'status': 'in-progress',
        'message': 'Configuring auto-login settings...',
        'progress': 25
      }),
    });

    // ============================================
    // AUTOLOGIN CONFIGURATION TASKS
    // ============================================

    // Windows autologin task - uses Lambda for cross-region SSM support
    const configureAutologinWindowsTask = new tasks.LambdaInvoke(this, 'ConfigureAutologinWindows', {
      lambdaFunction: configureWindowsAutologinFunction,
      resultPath: '$.autologinResult',
      retryOnServiceExceptions: false,
    });

    // Add retry logic for SSM commands when instance is rebooting AND throttling
    configureAutologinWindowsTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });
    configureAutologinWindowsTask.addRetry({
      errors: ['States.TaskFailed'],
      interval: cdk.Duration.seconds(30),
      maxAttempts: 6,
      backoffRate: 1.5,
    });

    const configureAutologinLinuxTask = new tasks.LambdaInvoke(this, 'ConfigureAutologinLinux', {
      lambdaFunction: configureLinuxAutologinFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });

    // Add throttling retry
    configureAutologinLinuxTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    const checkLinuxAutologinStatusTask = new tasks.LambdaInvoke(this, 'CheckLinuxAutologinStatus', {
      lambdaFunction: checkLinuxAutologinStatusFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });

    // Add throttling retry
    checkLinuxAutologinStatusTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    const configureAutologinMacosTask = new tasks.LambdaInvoke(this, 'ConfigureAutologinMacos', {
      lambdaFunction: configureMacosAutologinFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });

    // Add throttling retry
    configureAutologinMacosTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    const checkMacosAutologinStatusTask = new tasks.LambdaInvoke(this, 'CheckMacosAutologinStatus', {
      lambdaFunction: checkMacosAutologinStatusFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });

    // Add throttling retry
    checkMacosAutologinStatusTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    // ============================================
    // SSM READINESS CHECK TASK (for Linux/macOS)
    // ============================================

    const checkSSMReadinessTask = new tasks.LambdaInvoke(this, 'CheckSSMReadiness', {
      lambdaFunction: checkSSMReadinessFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });

    // Add throttling retry
    checkSSMReadinessTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    // ============================================
    // PLATFORM-SPECIFIC DCV READINESS TASKS
    // ============================================

    // Windows DCV readiness check (creates test session, needs cleanup)
    const checkDCVReadinessWindowsTask = new tasks.LambdaInvoke(this, 'CheckDCVReadinessWindows', {
      lambdaFunction: props.checkDCVReadinessFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });

    // Add throttling retry
    checkDCVReadinessWindowsTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    // Linux DCV readiness check (no test session, no cleanup needed)
    const checkDCVReadinessLinuxTask = new tasks.LambdaInvoke(this, 'CheckDCVReadinessLinux', {
      lambdaFunction: checkDCVReadinessLinuxFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });

    // Add throttling retry
    checkDCVReadinessLinuxTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    // macOS DCV readiness check (no test session, no cleanup needed)
    const checkDCVReadinessMacosTask = new tasks.LambdaInvoke(this, 'CheckDCVReadinessMacos', {
      lambdaFunction: checkDCVReadinessMacosFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });

    // Add throttling retry
    checkDCVReadinessMacosTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    // ============================================
    // PROGRESS PUBLISH TASKS (platform-specific to avoid CDK state reuse issues)
    // ============================================

    const publishStartingDcvWindowsTask = new tasks.LambdaInvoke(this, 'PublishStartingDcvWindows', {
      lambdaFunction: publishProgressFunction,
      resultPath: '$.progressResult',
      payload: sfn.TaskInput.fromObject({
        'instanceId.$': '$.instanceId',
        'stage': 'starting-dcv-agents',
        'status': 'in-progress',
        'message': 'Starting DCV server agents...',
        'progress': 30
      }),
    });

    const publishStartingDcvLinuxTask = new tasks.LambdaInvoke(this, 'PublishStartingDcvLinux', {
      lambdaFunction: publishProgressFunction,
      resultPath: '$.progressResult',
      payload: sfn.TaskInput.fromObject({
        'instanceId.$': '$.instanceId',
        'stage': 'starting-dcv-agents',
        'status': 'in-progress',
        'message': 'Starting DCV server agents...',
        'progress': 30
      }),
    });

    const publishStartingDcvMacosTask = new tasks.LambdaInvoke(this, 'PublishStartingDcvMacos', {
      lambdaFunction: publishProgressFunction,
      resultPath: '$.progressResult',
      payload: sfn.TaskInput.fromObject({
        'instanceId.$': '$.instanceId',
        'stage': 'starting-dcv-agents',
        'status': 'in-progress',
        'message': 'Starting DCV server agents...',
        'progress': 30
      }),
    });

    const publishDcvReadyWindowsTask = new tasks.LambdaInvoke(this, 'PublishDcvReadyWindows', {
      lambdaFunction: publishProgressFunction,
      resultPath: '$.progressResult',
      payload: sfn.TaskInput.fromObject({
        'instanceId.$': '$.instanceId',
        'stage': 'dcv-ready',
        'status': 'completed',
        'message': 'DCV server is ready',
        'progress': 40
      }),
    });

    const publishCompleteLinuxTask = new tasks.LambdaInvoke(this, 'PublishCompleteLinux', {
      lambdaFunction: publishProgressFunction,
      resultPath: '$.progressResult',
      payload: sfn.TaskInput.fromObject({
        'instanceId.$': '$.instanceId',
        'stage': 'complete',
        'status': 'completed',
        'message': 'Workstation is ready to connect!',
        'progress': 100
      }),
    });

    const publishCompleteMacosTask = new tasks.LambdaInvoke(this, 'PublishCompleteMacos', {
      lambdaFunction: publishProgressFunction,
      resultPath: '$.progressResult',
      payload: sfn.TaskInput.fromObject({
        'instanceId.$': '$.instanceId',
        'stage': 'complete',
        'status': 'completed',
        'message': 'Workstation is ready to connect!',
        'progress': 100
      }),
    });

    const publishCompleteWindowsTask = new tasks.LambdaInvoke(this, 'PublishCompleteWindows', {
      lambdaFunction: publishProgressFunction,
      resultPath: '$.progressResult',
      payload: sfn.TaskInput.fromObject({
        'instanceId.$': '$.instanceId',
        'stage': 'complete',
        'status': 'completed',
        'message': 'Workstation is ready to connect!',
        'progress': 100
      }),
    });

    // Separate task for Windows no-cleanup path (CDK requires unique state instances)
    const publishCompleteWindowsNoCleanupTask = new tasks.LambdaInvoke(this, 'PublishCompleteWindowsNoCleanup', {
      lambdaFunction: publishProgressFunction,
      resultPath: '$.progressResult',
      payload: sfn.TaskInput.fromObject({
        'instanceId.$': '$.instanceId',
        'stage': 'complete',
        'status': 'completed',
        'message': 'Workstation is ready to connect!',
        'progress': 100
      }),
    });

    // ============================================
    // WINDOWS CLEANUP TASKS (only Windows needs cleanup)
    // ============================================

    const publishTestingTask = new tasks.LambdaInvoke(this, 'PublishTesting', {
      lambdaFunction: publishProgressFunction,
      resultPath: '$.progressResult',
      payload: sfn.TaskInput.fromObject({
        'instanceId.$': '$.instanceId',
        'stage': 'testing-dcv',
        'status': 'in-progress',
        'message': 'Testing DCV connection...',
        'progress': 50
      }),
    });

    const checkSessionStatusTask = new tasks.LambdaInvoke(this, 'CheckSessionStatus', {
      lambdaFunction: props.checkSessionStatusFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });

    // Add throttling retry
    checkSessionStatusTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    const publishSessionCreatedTask = new tasks.LambdaInvoke(this, 'PublishSessionCreated', {
      lambdaFunction: publishProgressFunction,
      resultPath: '$.progressResult',
      payload: sfn.TaskInput.fromObject({
        'instanceId.$': '$.instanceId',
        'stage': 'dcv-session-created',
        'status': 'completed',
        'message': 'DCV session created successfully',
        'progress': 70
      }),
    });

    const publishCleanupTask = new tasks.LambdaInvoke(this, 'PublishCleanup', {
      lambdaFunction: publishProgressFunction,
      resultPath: '$.progressResult',
      payload: sfn.TaskInput.fromObject({
        'instanceId.$': '$.instanceId',
        'stage': 'cleaning-up',
        'status': 'in-progress',
        'message': 'Cleaning up test session...',
        'progress': 80
      }),
    });

    const deleteTestSessionTask = new tasks.LambdaInvoke(this, 'DeleteTestSession', {
      lambdaFunction: props.deleteTestSessionFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });

    // Add throttling retry
    deleteTestSessionTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    const verifySessionDeletedTask = new tasks.LambdaInvoke(this, 'VerifySessionDeleted', {
      lambdaFunction: props.verifySessionDeletedFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });

    // Add throttling retry
    verifySessionDeletedTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    // ============================================
    // FAILURE HANDLING
    // ============================================

    const publishStartFailureTask = new tasks.LambdaInvoke(this, 'PublishStartFailure', {
      lambdaFunction: publishProgressFunction,
      resultPath: '$.progressResult',
      payload: sfn.TaskInput.fromObject({
        'instanceId.$': '$.instanceId',
        'stage': 'failed',
        'status': 'failed',
        'message.$': '$.error',
        'progress': 0
      }),
    });

    const publishTerminatedFailureTask = new tasks.LambdaInvoke(this, 'PublishTerminatedFailure', {
      lambdaFunction: publishProgressFunction,
      resultPath: '$.progressResult',
      payload: sfn.TaskInput.fromObject({
        'instanceId.$': '$.instanceId',
        'stage': 'failed',
        'status': 'failed',
        'message': 'Instance was terminated',
        'progress': 0
      }),
    });

    const updateStartFailureStatusTask = new tasks.DynamoUpdateItem(this, 'UpdateStartFailureStatus', {
      table: workstationTable,
      key: {
        instanceId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.instanceId'))
      },
      updateExpression: 'SET dcvStatus = :status, errorMessage = :error, updatedAt = :updatedAt',
      expressionAttributeValues: {
        ':status': tasks.DynamoAttributeValue.fromString('failed'),
        ':error': tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.error')),
        ':updatedAt': tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$$.State.EnteredTime'))
      },
      resultPath: sfn.JsonPath.DISCARD,
    });

    const updateTerminatedFailureStatusTask = new tasks.DynamoUpdateItem(this, 'UpdateTerminatedFailureStatus', {
      table: workstationTable,
      key: {
        instanceId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.instanceId'))
      },
      updateExpression: 'SET dcvStatus = :status, errorMessage = :error, updatedAt = :updatedAt',
      expressionAttributeValues: {
        ':status': tasks.DynamoAttributeValue.fromString('failed'),
        ':error': tasks.DynamoAttributeValue.fromString('Instance was terminated'),
        ':updatedAt': tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$$.State.EnteredTime'))
      },
      resultPath: sfn.JsonPath.DISCARD,
    });

    // ============================================
    // WAIT STATES
    // ============================================

    const waitForInstance = new sfn.Wait(this, 'WaitForInstance', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const waitForDCVWindows = new sfn.Wait(this, 'WaitForDCVWindows', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const waitForDCVLinux = new sfn.Wait(this, 'WaitForDCVLinux', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const waitForDCVMacos = new sfn.Wait(this, 'WaitForDCVMacos', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const waitForSessionReady = new sfn.Wait(this, 'WaitForSessionReady', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const waitForSessionDeleted = new sfn.Wait(this, 'WaitForSessionDeleted', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(10)),
    });

    const waitForLinuxAutologinPoll = new sfn.Wait(this, 'WaitForLinuxAutologinPoll', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(15)),
    });

    const waitForMacosAutologinPoll = new sfn.Wait(this, 'WaitForMacosAutologinPoll', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(15)),
    });

    const waitForMacosAutologinRetry = new sfn.Wait(this, 'WaitForMacosAutologinRetry', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const waitForSSMReadiness = new sfn.Wait(this, 'WaitForSSMReadiness', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(15)),
    });

    // ============================================
    // SUCCESS/FAILURE STATES
    // ============================================

    const successState = new sfn.Succeed(this, 'WorkstationStarted');
    const failureState = new sfn.Fail(this, 'WorkstationStartFailed', {
      cause: 'Failed to start workstation',
      error: 'WorkstationStartError',
    });

    // ============================================
    // STATE MACHINE FLOW DEFINITION
    // ============================================

    // WINDOWS DCV FLOW - with test session cleanup
    const windowsCleanupFlow = publishTestingTask
      .next(waitForSessionReady)
      .next(checkSessionStatusTask)
      .next(new sfn.Choice(this, 'IsSessionReady?')
        .when(sfn.Condition.booleanEquals('$.sessionReady', true),
          publishSessionCreatedTask
            .next(publishCleanupTask)
            .next(deleteTestSessionTask)
            .next(waitForSessionDeleted)
            .next(verifySessionDeletedTask)
            .next(new sfn.Choice(this, 'IsSessionDeleted?')
              .when(sfn.Condition.booleanEquals('$.sessionDeleted', true),
                publishCompleteWindowsTask.next(successState)
              )
              .otherwise(waitForSessionDeleted)
            )
        )
        .otherwise(waitForSessionReady)
      );

    const windowsDcvReadyFlow = publishDcvReadyWindowsTask
      .next(new sfn.Choice(this, 'WindowsNeedsCleanup?')
        .when(sfn.Condition.booleanEquals('$.needsCleanup', true), windowsCleanupFlow)
        .otherwise(publishCompleteWindowsNoCleanupTask.next(successState))
      );

    const windowsDcvReadinessLoop = waitForDCVWindows
      .next(checkDCVReadinessWindowsTask)
      .next(new sfn.Choice(this, 'IsWindowsDCVReady?')
        .when(sfn.Condition.booleanEquals('$.dcvReady', true), windowsDcvReadyFlow)
        .otherwise(waitForDCVWindows)
      );

    const windowsPostAutologinFlow = publishStartingDcvWindowsTask.next(windowsDcvReadinessLoop);

    // LINUX DCV FLOW - no cleanup needed
    const linuxDcvReadinessLoop = waitForDCVLinux
      .next(checkDCVReadinessLinuxTask)
      .next(new sfn.Choice(this, 'IsLinuxDCVReady?')
        .when(sfn.Condition.booleanEquals('$.dcvReady', true),
          publishCompleteLinuxTask.next(successState)
        )
        .otherwise(waitForDCVLinux)
      );

    const linuxPostAutologinFlow = publishStartingDcvLinuxTask.next(linuxDcvReadinessLoop);

    // MACOS DCV FLOW - no cleanup needed
    const macosDcvReadinessLoop = waitForDCVMacos
      .next(checkDCVReadinessMacosTask)
      .next(new sfn.Choice(this, 'IsMacosDCVReady?')
        .when(sfn.Condition.booleanEquals('$.dcvReady', true),
          publishCompleteMacosTask.next(successState)
        )
        .otherwise(waitForDCVMacos)
      );

    const macosPostAutologinFlow = publishStartingDcvMacosTask.next(macosDcvReadinessLoop);

    // ============================================
    // PLATFORM-SPECIFIC AUTOLOGIN PATHS
    // ============================================

    // Windows autologin path -> Windows DCV flow
    const windowsAutologinPath = configureAutologinWindowsTask.next(windowsPostAutologinFlow);

    // Linux autologin path -> poll for completion -> Linux DCV flow
    const linuxAutologinPollLoop = waitForLinuxAutologinPoll
      .next(checkLinuxAutologinStatusTask)
      .next(new sfn.Choice(this, 'IsLinuxAutologinComplete?')
        .when(sfn.Condition.booleanEquals('$.autoLoginComplete', true), linuxPostAutologinFlow)
        .when(sfn.Condition.booleanEquals('$.autoLoginInProgress', true), waitForLinuxAutologinPoll)
        .otherwise(linuxPostAutologinFlow) // Continue on failure (best effort)
      );

    const linuxAutologinPath = configureAutologinLinuxTask.next(linuxAutologinPollLoop);

    // macOS autologin path -> poll for completion -> macOS DCV flow (with retry support and max retry limit)
    const macosAutologinPollLoop = waitForMacosAutologinPoll
      .next(checkMacosAutologinStatusTask)
      .next(new sfn.Choice(this, 'IsMacosAutologinComplete?')
        .when(sfn.Condition.booleanEquals('$.autoLoginComplete', true), macosPostAutologinFlow)
        .when(sfn.Condition.booleanEquals('$.autoLoginInProgress', true), waitForMacosAutologinPoll)
        .when(sfn.Condition.booleanEquals('$.autoLoginNeedsRetry', true), 
          waitForMacosAutologinRetry.next(configureAutologinMacosTask))
        .otherwise(macosPostAutologinFlow) // Continue on failure (best effort)
      );

    // Check if max retries exceeded after configure attempt - if so, skip to DCV flow
    const macosAutologinRetryCheck = new sfn.Choice(this, 'MacosAutologinMaxRetriesExceeded?')
      .when(sfn.Condition.booleanEquals('$.autoLoginMaxRetriesExceeded', true), macosPostAutologinFlow)
      .otherwise(macosAutologinPollLoop);

    const macosAutologinPath = configureAutologinMacosTask.next(macosAutologinRetryCheck);

    // ============================================
    // SSM READINESS CHECK LOOP (for Linux/macOS)
    // ============================================

    // SSM readiness loop - check if SSM agent is ready before attempting autologin
    const ssmReadinessLoop = waitForSSMReadiness
      .next(checkSSMReadinessTask)
      .next(new sfn.Choice(this, 'IsSSMReady?')
        .when(sfn.Condition.booleanEquals('$.isSSMReady', true), 
          new sfn.Choice(this, 'SelectPlatformAfterSSMReady')
            .when(sfn.Condition.stringEquals('$.platform', 'Linux'), linuxAutologinPath)
            .when(sfn.Condition.stringEquals('$.platform', 'macOS'), macosAutologinPath)
            .otherwise(windowsAutologinPath)
        )
        .otherwise(waitForSSMReadiness)
      );

    // Platform selection for autologin - Windows goes direct, Linux/macOS wait for SSM
    const platformAutologinChoice = new sfn.Choice(this, 'SelectPlatformAutologin')
      .when(sfn.Condition.stringEquals('$.platform', 'Linux'), ssmReadinessLoop)
      .when(sfn.Condition.stringEquals('$.platform', 'macOS'), ssmReadinessLoop)
      .otherwise(windowsAutologinPath); // Windows has its own retry logic

    // Autologin flow - branch by platform (SSM readiness check is now per-platform)
    const autologinFlow = publishConfiguringAutologinTask
      .next(platformAutologinChoice);

    // Domain-joined workstations skip autologin - use Windows DCV flow (they're always Windows)
    const autologinDecision = new sfn.Choice(this, 'NeedsAutologinConfig?')
      .when(sfn.Condition.or(
        sfn.Condition.booleanEquals('$.joinDomain', false),
        sfn.Condition.not(sfn.Condition.isPresent('$.joinDomain'))
      ), autologinFlow)
      .otherwise(windowsPostAutologinFlow);

    // ============================================
    // INSTANCE STATUS CHECK LOOP
    // ============================================

    const instanceRunningCheck = new sfn.Choice(this, 'IsInstanceRunning?')
      .when(sfn.Condition.booleanEquals('$.isRunning', true),
        publishRunningTask.next(autologinDecision)
      )
      .when(sfn.Condition.stringEquals('$.instanceState', 'terminated'),
        publishTerminatedFailureTask
          .next(updateTerminatedFailureStatusTask)
          .next(failureState)
      )
      .otherwise(waitForInstance);

    const instanceStatusLoop = waitForInstance
      .next(checkInstanceStatusTask)
      .next(instanceRunningCheck);

    // ============================================
    // MAIN STATE MACHINE DEFINITION
    // ============================================

    const definition = publishStartingTask
      .next(startInstanceTask)
      .next(new sfn.Choice(this, 'InstanceStartSuccessful?')
        .when(sfn.Condition.booleanEquals('$.instanceStarted', false),
          publishStartFailureTask
            .next(updateStartFailureStatusTask)
            .next(failureState)
        )
        .otherwise(instanceStatusLoop)
      );

    const stateMachine = new sfn.StateMachine(this, 'WorkstationStartStateMachine', {
      stateMachineName: `${props.acronym.toLowerCase()}-workstation-start`,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.minutes(45),
    });

    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(stateMachine);
    }

    this.stateMachineArn = stateMachine.stateMachineArn;

    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: this.stateMachineArn,
      description: 'Workstation Start State Machine ARN',
    });
  }
}
