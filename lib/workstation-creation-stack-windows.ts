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
import * as path from 'path';
import { Construct } from 'constructs';

interface WorkstationCreationStackProps extends cdk.StackProps {
  productName: string;
  pascalCaseName: string;
  acronym: string;
  workstationTable: dynamodb.Table;
  imagePipelinesTable: dynamodb.Table;
  amiTable: dynamodb.Table;
  hostnameCounterTable: dynamodb.Table;
  vpc: ec2.IVpc;
  workstationSecurityGroup: ec2.SecurityGroup;
  workstationLaunchTemplate: ec2.LaunchTemplate;
  sessionCleanupFunction: lambda.IFunction;
  dataEncryptionKey?: kms.IKey;
}

export class WindowsWorkstationCreationStack extends cdk.Stack {
  public readonly stateMachine: stepfunctions.StateMachine;
  public readonly checkDCVReadinessFunction: lambda.Function;
  public readonly checkInstanceStatusFunction: lambda.Function;
  public readonly checkSessionStatusFunction: lambda.Function;
  public readonly deleteTestSessionFunction: lambda.Function;
  public readonly verifySessionDeletedFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: WorkstationCreationStackProps) {
    super(scope, id, {
      ...props,
      description: "Step Functions workflow for automated workstation provisioning and configuration"
    });

    // Lambda function to create EC2 instance with retry logic for different subnets
    const createInstanceFunction = new lambda.Function(this, 'CreateInstanceFunction', {
      functionName: `${props.acronym.toLowerCase()}-instance-create-windows`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/instance-create-windows')),
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
        IMAGE_PIPELINES_TABLE_NAME: props.imagePipelinesTable.tableName,
        IMAGES_TABLE_NAME: props.amiTable.tableName,
        HOSTNAME_COUNTER_TABLE_NAME: props.hostnameCounterTable.tableName,
        PASCAL_CASE_NAME: props.pascalCaseName,
        LAUNCH_TEMPLATE_ID: props.workstationLaunchTemplate.launchTemplateId!,
        SUBNET_IDS: props.vpc.privateSubnets.map(subnet => subnet.subnetId).join(','),
      },
      timeout: cdk.Duration.minutes(2),
    });

    // Lambda function to wait for instance to be running
    const checkInstanceStatusFunction = new lambda.Function(this, 'CheckInstanceStatusFunction', {
      functionName: `${props.acronym.toLowerCase()}-instance-status-check-windows`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/instance-status-check-windows')),
      timeout: cdk.Duration.seconds(30),
    });

    // Lambda function to check SSM readiness
    const checkSSMReadinessFunction = new lambda.Function(this, 'CheckSSMReadinessFunction', {
      functionName: `${props.acronym.toLowerCase()}-ssm-readiness-check-windows`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/ssm-readiness-check-windows')),
      timeout: cdk.Duration.seconds(30),
    });

    // Lambda function to set hostname on Windows workstation
    const setHostnameFunction = new lambda.Function(this, 'SetHostnameFunction', {
      functionName: `${props.acronym.toLowerCase()}-hostname-set-windows`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/hostname-set-windows')),
      timeout: cdk.Duration.minutes(1),
    });

    const installSoftwareFunction = new lambda.Function(this, 'InstallSoftwareFunction', {
      functionName: `${props.acronym.toLowerCase()}-software-install-windows`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/software-install-windows')),
      timeout: cdk.Duration.minutes(1),
    });

    // Lambda function to run SSM commands in the correct region (for cross-region workstations)
    const runSSMCommandFunction = new lambda.Function(this, 'RunSSMCommandFunction', {
      functionName: `${props.acronym.toLowerCase()}-ssm-command-run-windows`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/ssm-command-run-windows')),
      timeout: cdk.Duration.minutes(1),
    });

    // Grant SSM permissions to run commands in any region
    runSSMCommandFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:SendCommand'],
      resources: ['*'],
    }));

    // Lambda function to check SSM command status
    const checkSSMCommandFunction = new lambda.Function(this, 'CheckSSMCommandFunction', {
      functionName: `${props.acronym.toLowerCase()}-ssm-command-check-windows`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/ssm-command-check-windows')),
      timeout: cdk.Duration.seconds(30),
    });

    checkSSMCommandFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetCommandInvocation'],
      resources: ['*'],
    }));

    // Lambda function to check DCV readiness
    const checkDCVReadinessFunction = new lambda.Function(this, 'CheckDCVReadinessFunction', {
      functionName: `${props.acronym.toLowerCase()}-dcv-readiness-check-windows`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      reservedConcurrentExecutions: 20,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
        ACRONYM: props.acronym,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/dcv-readiness-check-windows')),
      vpc: props.vpc,
      vpcSubnets: {
        subnets: props.vpc.privateSubnets,
      },
      securityGroups: [props.workstationSecurityGroup],
      timeout: cdk.Duration.minutes(2),
    });

    // Grant permissions
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

    // Grant KMS permissions if tables use customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(createInstanceFunction);
    }

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

    installSoftwareFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:SendCommand', 'ssm:GetParameter'],
      resources: ['*'],
    }));

    // Grant KMS permissions for environment variable decryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantDecrypt(installSoftwareFunction);
    }

    checkDCVReadinessFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: ['*'],
    }));

    // Grant permission to invoke regional DCV readiness check Lambda for satellite regions
    checkDCVReadinessFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:*:${this.account}:function:${props.acronym.toLowerCase()}-regional-dcv-readiness-check-windows`],
    }));

    props.workstationTable.grantWriteData(checkDCVReadinessFunction);
    // Also grant read access to look up workstation region
    props.workstationTable.grantReadData(checkDCVReadinessFunction);

    // Grant KMS permissions if tables use customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(checkDCVReadinessFunction);
    }

    // Lambda function to check session status
    const checkSessionStatusFunction = new lambda.Function(this, 'CheckSessionStatusFunction', {
      functionName: `${props.acronym.toLowerCase()}-session-status-check-windows`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      reservedConcurrentExecutions: 20,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/session-status-check-windows')),
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: {
        subnets: props.vpc.privateSubnets,
      },
      securityGroups: [props.workstationSecurityGroup],
    });

    // Lambda function to delete test session
    const deleteTestSessionFunction = new lambda.Function(this, 'DeleteTestSessionFunction', {
      functionName: `${props.acronym.toLowerCase()}-test-session-delete-windows`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      reservedConcurrentExecutions: 20,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/test-session-delete-windows')),
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: {
        subnets: props.vpc.privateSubnets,
      },
      securityGroups: [props.workstationSecurityGroup],
    });

    // Lambda function to verify session is deleted
    const verifySessionDeletedFunction = new lambda.Function(this, 'VerifySessionDeletedFunction', {
      functionName: `${props.acronym.toLowerCase()}-session-deleted-verify-windows`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      reservedConcurrentExecutions: 20,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/session-deleted-verify-windows')),
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: {
        subnets: props.vpc.privateSubnets,
      },
      securityGroups: [props.workstationSecurityGroup],
    });

    // Grant SSM permissions to new functions
    [checkSessionStatusFunction, deleteTestSessionFunction, verifySessionDeletedFunction].forEach(func => {
      func.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: ['*'],
      }));
    });

    // Grant KMS permissions for environment variable decryption
    if (props.dataEncryptionKey) {
      [checkSessionStatusFunction, deleteTestSessionFunction, verifySessionDeletedFunction].forEach(func => {
        props.dataEncryptionKey!.grantDecrypt(func);
      });
    }

    // Step Functions tasks
    const createInstanceTask = new tasks.LambdaInvoke(this, 'CreateInstance', {
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

    const checkInstanceStatusTask = new tasks.LambdaInvoke(this, 'CheckInstanceStatus', {
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

    const checkSSMReadinessTask = new tasks.LambdaInvoke(this, 'CheckSSMReadiness', {
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
    const setHostnameTask = new tasks.LambdaInvoke(this, 'SetHostname', {
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

    const installSoftwareTask = new tasks.LambdaInvoke(this, 'InstallSoftware', {
      lambdaFunction: installSoftwareFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    installSoftwareTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    const checkSSMCommandTask = new tasks.LambdaInvoke(this, 'CheckSSMCommand', {
      lambdaFunction: checkSSMCommandFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    checkSSMCommandTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    const checkDCVReadinessTask = new tasks.LambdaInvoke(this, 'CheckDCVReadiness', {
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

    // Separate task for checking DCV readiness after cleanup
    const checkDCVReadinessAfterCleanupTask = new tasks.LambdaInvoke(this, 'CheckDCVReadinessAfterCleanup', {
      lambdaFunction: checkDCVReadinessFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    checkDCVReadinessAfterCleanupTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    const checkSessionStatusTask = new tasks.LambdaInvoke(this, 'CheckSessionStatus', {
      lambdaFunction: checkSessionStatusFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    checkSessionStatusTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    const deleteTestSessionTask = new tasks.LambdaInvoke(this, 'DeleteTestSession', {
      lambdaFunction: deleteTestSessionFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    deleteTestSessionTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    const verifySessionDeletedTask = new tasks.LambdaInvoke(this, 'VerifySessionDeleted', {
      lambdaFunction: verifySessionDeletedFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    verifySessionDeletedTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    // Task to cleanup orphaned sessions when DCV readiness fails
    const cleanupOrphanedSessionsTask = new tasks.LambdaInvoke(this, 'CleanupOrphanedSessions', {
      lambdaFunction: props.sessionCleanupFunction,
      payload: stepfunctions.TaskInput.fromObject({
        'detail': {
          'instance-id': stepfunctions.JsonPath.stringAt('$.instanceId'),
          'state': 'stopped'
        }
      }),
      resultPath: '$.cleanupResult',
      retryOnServiceExceptions: false,
    });
    cleanupOrphanedSessionsTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    // Wait state - longer wait for SSM agent to be ready
    const waitForInstance = new stepfunctions.Wait(this, 'WaitForInstance', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(60)),
    });

    const waitForSSM = new stepfunctions.Wait(this, 'WaitForSSM', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const waitForDCV = new stepfunctions.Wait(this, 'WaitForDCV', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(60)),
    });

    // Wait states for SSM install polling loop (DCV install takes ~10-20 minutes)
    const waitForSsmInstall = new stepfunctions.Wait(this, 'WaitForSsmInstall', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(60)),
    });

    // Separate wait state for retry loop (each state can only have one .next())
    const waitForSsmInstallRetry = new stepfunctions.Wait(this, 'WaitForSsmInstallRetry', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(60)),
    });

    // SSM install check task (separate from other SSM check tasks)
    const checkSsmInstallTask = new tasks.LambdaInvoke(this, 'CheckSsmInstall', {
      lambdaFunction: checkSSMCommandFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    checkSsmInstallTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    // Initialize SSM install retry counter
    const initSsmInstallRetry = new stepfunctions.Pass(this, 'InitSsmInstallRetry', {
      parameters: {
        'instanceId.$': '$.instanceId',
        'assignedUserId.$': '$.assignedUserId',
        'amiId.$': '$.amiId',
        'instanceType.$': '$.instanceType',
        'status.$': '$.status',
        'subnetId.$': '$.subnetId',
        'joinDomain.$': '$.joinDomain',
        'region.$': '$.region',
        'ssmCommandId.$': '$.ssmCommandId',
        'ssmInstallRetryCount': 0
      }
    });

    // Increment SSM install retry counter
    const incSsmInstallRetry = new stepfunctions.Pass(this, 'IncSsmInstallRetry', {
      parameters: {
        'instanceId.$': '$.instanceId',
        'assignedUserId.$': '$.assignedUserId',
        'amiId.$': '$.amiId',
        'instanceType.$': '$.instanceType',
        'status.$': '$.status',
        'subnetId.$': '$.subnetId',
        'joinDomain.$': '$.joinDomain',
        'region.$': '$.region',
        'ssmCommandId.$': '$.ssmCommandId',
        'ssmInstallRetryCount.$': 'States.MathAdd($.ssmInstallRetryCount, 1)'
      }
    });

    // Task to update status to failed when SSM install command fails
    const updateStatusSsmInstallFailed = new tasks.CallAwsService(this, 'UpdateStatusSsmInstallFailed', {
      service: 'dynamodb',
      action: 'updateItem',
      parameters: {
        'TableName': props.workstationTable.tableName,
        'Key': {
          'instanceId': {
            'S.$': '$.instanceId'
          }
        },
        'UpdateExpression': 'SET #status = :status, dcvStatus = :dcvStatus, errorMessage = :errorMessage, updatedAt = :updatedAt',
        'ExpressionAttributeNames': {
          '#status': 'status'
        },
        'ExpressionAttributeValues': {
          ':status': {
            'S': 'failed'
          },
          ':dcvStatus': {
            'S': 'install-failed'
          },
          ':errorMessage': {
            'S': 'DCV installation SSM command failed'
          },
          ':updatedAt': {
            'S.$': '$$.State.EnteredTime'
          }
        }
      },
      resultPath: '$.updateResult',
      iamResources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTable.tableName}`]
    });

    // Task to update status to failed when SSM install times out
    const updateStatusSsmInstallTimeout = new tasks.CallAwsService(this, 'UpdateStatusSsmInstallTimeout', {
      service: 'dynamodb',
      action: 'updateItem',
      parameters: {
        'TableName': props.workstationTable.tableName,
        'Key': {
          'instanceId': {
            'S.$': '$.instanceId'
          }
        },
        'UpdateExpression': 'SET #status = :status, dcvStatus = :dcvStatus, errorMessage = :errorMessage, updatedAt = :updatedAt',
        'ExpressionAttributeNames': {
          '#status': 'status'
        },
        'ExpressionAttributeValues': {
          ':status': {
            'S': 'failed'
          },
          ':dcvStatus': {
            'S': 'install-timeout'
          },
          ':errorMessage': {
            'S': 'DCV installation timed out after 30 minutes'
          },
          ':updatedAt': {
            'S.$': '$$.State.EnteredTime'
          }
        }
      },
      resultPath: '$.updateResult',
      iamResources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTable.tableName}`]
    });

    // Failure states for SSM install
    const failSsmInstallCommand = new stepfunctions.Fail(this, 'FailSsmInstallCommand', {
      cause: 'DCV Install SSM command failed',
      error: 'SsmInstallCommandFailed'
    });

    const failSsmInstallTimeout = new stepfunctions.Fail(this, 'FailSsmInstallTimeout', {
      cause: 'DCV Install SSM command timed out after 30 retries (~30 minutes)',
      error: 'SsmInstallTimeout'
    });

    // Pass state to increment DCV retry counter
    const incrementDCVRetryCounter = new stepfunctions.Pass(this, 'IncrementDCVRetryCounter', {
      parameters: {
        'instanceId.$': '$.instanceId',
        'assignedUserId.$': '$.assignedUserId',
        'amiId.$': '$.amiId',
        'instanceType.$': '$.instanceType',
        'status.$': '$.status',
        'dcvStatus.$': '$.dcvStatus',
        'instanceStatus.$': '$.instanceStatus',
        'subnetId.$': '$.subnetId',
        'joinDomain.$': '$.joinDomain',
        'region.$': '$.region',
        'dcvRetryCount.$': 'States.MathAdd($.dcvRetryCount, 1)',
        'dcvReady': false
      },
    });

    // Pass state to initialize DCV retry counter if not present
    // Note: dcvStatus and instanceStatus may not exist at this point (coming from SSM check)
    // so we initialize them with defaults
    const initializeDCVRetryCounter = new stepfunctions.Pass(this, 'InitializeDCVRetryCounter', {
      parameters: {
        'instanceId.$': '$.instanceId',
        'assignedUserId.$': '$.assignedUserId',
        'amiId.$': '$.amiId',
        'instanceType.$': '$.instanceType',
        'status.$': '$.status',
        'subnetId.$': '$.subnetId',
        'joinDomain.$': '$.joinDomain',
        'region.$': '$.region',
        'dcvRetryCount': 0,
        'dcvReady': false,
        'dcvStatus': 'checking',
        'instanceStatus': 'running'
      },
    });

    // Task to update status to failed when DCV readiness fails after cleanup
    const updateStatusDCVFailed = new tasks.CallAwsService(this, 'UpdateStatusDCVFailed', {
      service: 'dynamodb',
      action: 'updateItem',
      parameters: {
        'TableName': props.workstationTable.tableName,
        'Key': {
          'instanceId': {
            'S.$': '$.instanceId'
          }
        },
        'UpdateExpression': 'SET #status = :status, dcvStatus = :dcvStatus, errorMessage = :errorMessage, updatedAt = :updatedAt',
        'ExpressionAttributeNames': {
          '#status': 'status'
        },
        'ExpressionAttributeValues': {
          ':status': {
            'S': 'failed'
          },
          ':dcvStatus': {
            'S': 'failed'
          },
          ':errorMessage': {
            'S': 'DCV readiness check failed after session cleanup - server not becoming available'
          },
          ':updatedAt': {
            'S.$': '$$.State.EnteredTime'
          }
        }
      },
      resultPath: '$.updateResult',
      iamResources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTable.tableName}`]
    });

    // Task to update status to failed when DCV readiness times out
    const updateStatusDCVTimeout = new tasks.CallAwsService(this, 'UpdateStatusDCVTimeout', {
      service: 'dynamodb',
      action: 'updateItem',
      parameters: {
        'TableName': props.workstationTable.tableName,
        'Key': {
          'instanceId': {
            'S.$': '$.instanceId'
          }
        },
        'UpdateExpression': 'SET #status = :status, dcvStatus = :dcvStatus, errorMessage = :errorMessage, updatedAt = :updatedAt',
        'ExpressionAttributeNames': {
          '#status': 'status'
        },
        'ExpressionAttributeValues': {
          ':status': {
            'S': 'failed'
          },
          ':dcvStatus': {
            'S': 'failed'
          },
          ':errorMessage': {
            'S': 'DCV readiness check timed out after 10 minutes'
          },
          ':updatedAt': {
            'S.$': '$$.State.EnteredTime'
          }
        }
      },
      resultPath: '$.updateResult',
      iamResources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTable.tableName}`]
    });

    // Lambda function to configure auto-login for standalone workstations
    const configureAutoLoginFunction = new lambda.Function(this, 'ConfigureAutoLoginFunction', {
      functionName: `${props.acronym.toLowerCase()}-autologin-configure-windows`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/autologin-configure'),
      reservedConcurrentExecutions: 20,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
      },
      timeout: cdk.Duration.minutes(2),
    });

    // Lambda function to check auto-login configuration status
    const checkAutoLoginStatusFunction = new lambda.Function(this, 'CheckAutoLoginStatusFunction', {
      functionName: `${props.acronym.toLowerCase()}-autologin-status-check-windows`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/autologin-status-check'),
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 20,
    });

    // Grant permissions to auto-login functions
    configureAutoLoginFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:SendCommand'],
      resources: ['*'],
    }));

    // Grant KMS permissions for environment variable decryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantDecrypt(configureAutoLoginFunction);
    }

    checkAutoLoginStatusFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetCommandInvocation'],
      resources: ['*'],
    }));

    // Lambda function to join workstation to domain
    const joinDomainFunction = new lambda.Function(this, 'JoinDomainFunction', {
      functionName: `${props.acronym.toLowerCase()}-domain-join-windows`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/domain-join-windows')),
      timeout: cdk.Duration.minutes(2),
    });

    // Lambda function to check domain join status
    const checkDomainJoinStatusFunction = new lambda.Function(this, 'CheckDomainJoinStatusFunction', {
      functionName: `${props.acronym.toLowerCase()}-domain-join-status-check-windows`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/domain-join-status-check-windows')),
      timeout: cdk.Duration.seconds(30),
    });

    // Lambda function to restart instance after domain join
    const restartInstanceFunction = new lambda.Function(this, 'RestartInstanceFunction', {
      functionName: `${props.acronym.toLowerCase()}-instance-restart-windows`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 20,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/instance-restart-windows')),
      timeout: cdk.Duration.seconds(30),
    });

    // Grant permissions
    checkDomainJoinStatusFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetCommandInvocation'],
      resources: ['*'],
    }));

    restartInstanceFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ec2:RebootInstances'],
      resources: ['*'],
    }));

    // Grant permissions to join domain function
    joinDomainFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:SendCommand', 'ssm:GetParametersByPath', 'cloudformation:DescribeStacks'],
      resources: ['*'],
    }));

    // Grant KMS permissions for environment variable decryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantDecrypt(joinDomainFunction);
    }

    // Step Functions task for domain join
    const joinDomainTask = new tasks.LambdaInvoke(this, 'JoinDomainTask', {
      lambdaFunction: joinDomainFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    joinDomainTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    // Step Functions task for checking domain join status
    const checkDomainJoinStatusTask = new tasks.LambdaInvoke(this, 'CheckDomainJoinStatus', {
      lambdaFunction: checkDomainJoinStatusFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    checkDomainJoinStatusTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    // Step Functions task for configuring auto-login (standalone workstations)
    const configureAutoLoginTask = new tasks.LambdaInvoke(this, 'ConfigureAutoLogin', {
      lambdaFunction: configureAutoLoginFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    configureAutoLoginTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    // Step Functions task for checking auto-login status
    const checkAutoLoginStatusTask = new tasks.LambdaInvoke(this, 'CheckAutoLoginStatus', {
      lambdaFunction: checkAutoLoginStatusFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    checkAutoLoginStatusTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    // Wait state for auto-login configuration (PowerShell module loading takes time)
    const waitForAutoLogin = new stepfunctions.Wait(this, 'WaitForAutoLogin', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.minutes(2)),
    });

    // Step Functions task for restarting instance
    const restartInstanceTask = new tasks.LambdaInvoke(this, 'RestartInstance', {
      lambdaFunction: restartInstanceFunction,
      outputPath: '$.Payload',
      retryOnServiceExceptions: false,
    });
    restartInstanceTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    // SendCommand task to disable CTRL+ALT+DEL requirement for easier DCV login
    // Uses Lambda to invoke regional SSM document for cross-region support
    const disableCtrlAltDelTask = new tasks.LambdaInvoke(this, 'DisableCtrlAltDel', {
      lambdaFunction: runSSMCommandFunction,
      payload: stepfunctions.TaskInput.fromObject({
        'instanceId.$': '$.instanceId',
        'region.$': '$.region',
        'documentName': `${props.pascalCaseName}-Windows-DisableCtrlAltDel`,
      }),
      resultPath: '$.disableCtrlAltDelResult',
      retryOnServiceExceptions: false,
    });
    disableCtrlAltDelTask.addRetry({
      errors: ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6,
      backoffRate: 2,
    });

    // SendCommand task to setup FSx mount task scheduler
    // Uses Lambda to invoke regional SSM document for cross-region support
    const setupFsxTaskSchedulerTask = new tasks.LambdaInvoke(this, 'SetupFsxTaskScheduler', {
      lambdaFunction: runSSMCommandFunction,
      payload: stepfunctions.TaskInput.fromObject({
        'instanceId.$': '$.instanceId',
        'region.$': '$.region',
        'documentName': `${props.pascalCaseName}-Windows-SetupFsxScheduler`,
      }),
      resultPath: '$.setupFsxTaskSchedulerResult',
    });

    // Task to update status to setting-hostname
    const updateStatusSettingHostname = new tasks.CallAwsService(this, 'UpdateStatusSettingHostname', {
      service: 'dynamodb',
      action: 'updateItem',
      parameters: {
        'TableName': props.workstationTable.tableName,
        'Key': {
          'instanceId': {
            'S.$': '$.instanceId'
          }
        },
        'UpdateExpression': 'SET #status = :status, dcvStatus = :dcvStatus, updatedAt = :updatedAt',
        'ExpressionAttributeNames': {
          '#status': 'status'
        },
        'ExpressionAttributeValues': {
          ':status': {
            'S': 'setting-hostname'
          },
          ':dcvStatus': {
            'S': 'setting-hostname'
          },
          ':updatedAt': {
            'S.$': '$$.State.EnteredTime'
          }
        }
      },
      resultPath: '$.updateResult',
      iamResources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTable.tableName}`]
    });

    // Task to update status to installing-dcv
    const updateStatusInstallingDcv = new tasks.CallAwsService(this, 'UpdateStatusInstallingDcv', {
      service: 'dynamodb',
      action: 'updateItem',
      parameters: {
        'TableName': props.workstationTable.tableName,
        'Key': {
          'instanceId': {
            'S.$': '$.instanceId'
          }
        },
        'UpdateExpression': 'SET #status = :status, dcvStatus = :dcvStatus, updatedAt = :updatedAt',
        'ExpressionAttributeNames': {
          '#status': 'status'
        },
        'ExpressionAttributeValues': {
          ':status': {
            'S': 'installing-dcv'
          },
          ':dcvStatus': {
            'S': 'installing-dcv'
          },
          ':updatedAt': {
            'S.$': '$$.State.EnteredTime'
          }
        }
      },
      resultPath: '$.updateResult',
      iamResources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTable.tableName}`]
    });

    // Task to update status to configuring-dcv
    const updateStatusConfiguringDcv = new tasks.CallAwsService(this, 'UpdateStatusConfiguringDcv', {
      service: 'dynamodb',
      action: 'updateItem',
      parameters: {
        'TableName': props.workstationTable.tableName,
        'Key': {
          'instanceId': {
            'S.$': '$.instanceId'
          }
        },
        'UpdateExpression': 'SET #status = :status, dcvStatus = :dcvStatus, updatedAt = :updatedAt',
        'ExpressionAttributeNames': {
          '#status': 'status'
        },
        'ExpressionAttributeValues': {
          ':status': {
            'S': 'configuring-dcv'
          },
          ':dcvStatus': {
            'S': 'configuring-dcv'
          },
          ':updatedAt': {
            'S.$': '$$.State.EnteredTime'
          }
        }
      },
      resultPath: '$.updateResult',
      iamResources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTable.tableName}`]
    });

    // Task to update status to joining-domain
    const updateStatusJoiningDomain = new tasks.CallAwsService(this, 'UpdateStatusJoiningDomain', {
      service: 'dynamodb',
      action: 'updateItem',
      parameters: {
        'TableName': props.workstationTable.tableName,
        'Key': {
          'instanceId': {
            'S.$': '$.instanceId'
          }
        },
        'UpdateExpression': 'SET #status = :status, dcvStatus = :dcvStatus, updatedAt = :updatedAt',
        'ExpressionAttributeNames': {
          '#status': 'status'
        },
        'ExpressionAttributeValues': {
          ':status': {
            'S': 'joining-domain'
          },
          ':dcvStatus': {
            'S': 'setting-up-system'
          },
          ':updatedAt': {
            'S.$': '$$.State.EnteredTime'
          }
        }
      },
      resultPath: '$.updateResult',
      iamResources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTable.tableName}`]
    });

    // Task to update status to joining-domain (no cleanup path)
    const updateStatusJoiningDomainNoCleanup = new tasks.CallAwsService(this, 'UpdateStatusJoiningDomainNoCleanup', {
      service: 'dynamodb',
      action: 'updateItem',
      parameters: {
        'TableName': props.workstationTable.tableName,
        'Key': {
          'instanceId': {
            'S.$': '$.instanceId'
          }
        },
        'UpdateExpression': 'SET #status = :status, dcvStatus = :dcvStatus, updatedAt = :updatedAt',
        'ExpressionAttributeNames': {
          '#status': 'status'
        },
        'ExpressionAttributeValues': {
          ':status': {
            'S': 'joining-domain'
          },
          ':dcvStatus': {
            'S': 'setting-up-system'
          },
          ':updatedAt': {
            'S.$': '$$.State.EnteredTime'
          }
        }
      },
      resultPath: '$.updateResult',
      iamResources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTable.tableName}`]
    });

    // Task to update status to configuring-system
    const updateStatusConfiguringSystem = new tasks.CallAwsService(this, 'UpdateStatusConfiguringSystem', {
      service: 'dynamodb',
      action: 'updateItem',
      parameters: {
        'TableName': props.workstationTable.tableName,
        'Key': {
          'instanceId': {
            'S.$': '$.instanceId'
          }
        },
        'UpdateExpression': 'SET #status = :status, dcvStatus = :dcvStatus, updatedAt = :updatedAt',
        'ExpressionAttributeNames': {
          '#status': 'status'
        },
        'ExpressionAttributeValues': {
          ':status': {
            'S': 'configuring-system'
          },
          ':dcvStatus': {
            'S': 'setting-up-system'
          },
          ':updatedAt': {
            'S.$': '$$.State.EnteredTime'
          }
        }
      },
      resultPath: '$.updateResult',
      iamResources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTable.tableName}`]
    });

    // Task to update status to configuring-system (no cleanup path)
    const updateStatusConfiguringSystemNoCleanup = new tasks.CallAwsService(this, 'UpdateStatusConfiguringSystemNoCleanup', {
      service: 'dynamodb',
      action: 'updateItem',
      parameters: {
        'TableName': props.workstationTable.tableName,
        'Key': {
          'instanceId': {
            'S.$': '$.instanceId'
          }
        },
        'UpdateExpression': 'SET #status = :status, dcvStatus = :dcvStatus, updatedAt = :updatedAt',
        'ExpressionAttributeNames': {
          '#status': 'status'
        },
        'ExpressionAttributeValues': {
          ':status': {
            'S': 'configuring-system'
          },
          ':dcvStatus': {
            'S': 'setting-up-system'
          },
          ':updatedAt': {
            'S.$': '$$.State.EnteredTime'
          }
        }
      },
      resultPath: '$.updateResult',
      iamResources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTable.tableName}`]
    });

    // Task to update status to finalizing
    const updateStatusFinalizing = new tasks.CallAwsService(this, 'UpdateStatusFinalizing', {
      service: 'dynamodb',
      action: 'updateItem',
      parameters: {
        'TableName': props.workstationTable.tableName,
        'Key': {
          'instanceId': {
            'S.$': '$.instanceId'
          }
        },
        'UpdateExpression': 'SET #status = :status, dcvStatus = :dcvStatus, updatedAt = :updatedAt',
        'ExpressionAttributeNames': {
          '#status': 'status'
        },
        'ExpressionAttributeValues': {
          ':status': {
            'S': 'finalizing'
          },
          ':dcvStatus': {
            'S': 'finalizing-setup'
          },
          ':updatedAt': {
            'S.$': '$$.State.EnteredTime'
          }
        }
      },
      resultPath: '$.updateResult',
      iamResources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTable.tableName}`]
    });

    // Task to update status to finalizing (no cleanup path)
    const updateStatusFinalizingNoCleanup = new tasks.CallAwsService(this, 'UpdateStatusFinalizingNoCleanup', {
      service: 'dynamodb',
      action: 'updateItem',
      parameters: {
        'TableName': props.workstationTable.tableName,
        'Key': {
          'instanceId': {
            'S.$': '$.instanceId'
          }
        },
        'UpdateExpression': 'SET #status = :status, dcvStatus = :dcvStatus, updatedAt = :updatedAt',
        'ExpressionAttributeNames': {
          '#status': 'status'
        },
        'ExpressionAttributeValues': {
          ':status': {
            'S': 'finalizing'
          },
          ':dcvStatus': {
            'S': 'finalizing-setup'
          },
          ':updatedAt': {
            'S.$': '$$.State.EnteredTime'
          }
        }
      },
      resultPath: '$.updateResult',
      iamResources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTable.tableName}`]
    });

    // Task to update status to Complete
    const updateStatusReady = new tasks.CallAwsService(this, 'UpdateStatusComplete', {
      service: 'dynamodb',
      action: 'updateItem',
      parameters: {
        'TableName': props.workstationTable.tableName,
        'Key': {
          'instanceId': {
            'S.$': '$.instanceId'
          }
        },
        'UpdateExpression': 'SET #status = :status, dcvStatus = :dcvStatus, updatedAt = :updatedAt',
        'ExpressionAttributeNames': {
          '#status': 'status'
        },
        'ExpressionAttributeValues': {
          ':status': {
            'S': 'Complete'
          },
          ':dcvStatus': {
            'S': 'ready'
          },
          ':updatedAt': {
            'S.$': '$$.State.EnteredTime'
          }
        }
      },
      resultPath: '$.updateResult',
      iamResources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTable.tableName}`]
    });

    // Task to update status to Complete (no cleanup path)
    const updateStatusReadyNoCleanup = new tasks.CallAwsService(this, 'UpdateStatusCompleteNoCleanup', {
      service: 'dynamodb',
      action: 'updateItem',
      parameters: {
        'TableName': props.workstationTable.tableName,
        'Key': {
          'instanceId': {
            'S.$': '$.instanceId'
          }
        },
        'UpdateExpression': 'SET #status = :status, dcvStatus = :dcvStatus, updatedAt = :updatedAt',
        'ExpressionAttributeNames': {
          '#status': 'status'
        },
        'ExpressionAttributeValues': {
          ':status': {
            'S': 'Complete'
          },
          ':dcvStatus': {
            'S': 'ready'
          },
          ':updatedAt': {
            'S.$': '$$.State.EnteredTime'
          }
        }
      },
      resultPath: '$.updateResult',
      iamResources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.workstationTable.tableName}`]
    });

    // Wait state for domain join (longer wait)
    const waitForDomainJoin = new stepfunctions.Wait(this, 'WaitForDomainJoin', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.minutes(2)),
    });

    // Wait state for instance restart
    const waitForRestart = new stepfunctions.Wait(this, 'WaitForRestart', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.minutes(1)),
    });

    // Success and failure states
    const successState = new stepfunctions.Succeed(this, 'WorkstationCreated');
    const failureState = new stepfunctions.Fail(this, 'WorkstationCreationFailed');

    // Define the state machine with proper cleanup logic and retry handling
    // Define the state machine with proper cleanup logic and retry handling
    // 
    // Flow overview:
    // 1. Create instance → wait for running → wait for SSM
    // 2. Install DCV software → wait for DCV ready
    // 3. If DCV needs cleanup: wait for session → delete test session → verify deleted
    // 4. Branch: joinDomain=false → auto-login config, otherwise → domain join
    // 5. Shared configure system flow: disableCtrlAltDel → setupFsx → restart → complete

    // Define shared configure system chain (used by both domain join and auto-login paths)
    // Note: We need separate instances for cleanup vs no-cleanup paths due to Step Functions constraints
    
    const definition = createInstanceTask
      .next(new stepfunctions.Choice(this, 'CheckInstanceCreationResult')
        .when(stepfunctions.Condition.and(
          stepfunctions.Condition.isPresent('$.error'),
          stepfunctions.Condition.or(
            stepfunctions.Condition.stringEquals('$.error', 'InsufficientInstanceCapacity'),
            stepfunctions.Condition.stringEquals('$.error', 'Unsupported')
          )
        ),
          new stepfunctions.Choice(this, 'ShouldRetryDifferentSubnet?')
            .when(stepfunctions.Condition.booleanEquals('$.shouldRetry', true),
              new stepfunctions.Wait(this, 'WaitBeforeRetry', {
                time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(10)),
              }).next(createInstanceTask)
            )
            .otherwise(failureState)
        )
        .otherwise(
          waitForInstance
            .next(checkInstanceStatusTask)
            .next(new stepfunctions.Choice(this, 'IsInstanceRunning?')
              .when(stepfunctions.Condition.booleanEquals('$.isRunning', true), 
                waitForSSM
                  .next(checkSSMReadinessTask)
                  .next(new stepfunctions.Choice(this, 'IsSSMReady?')
                    .when(stepfunctions.Condition.booleanEquals('$.isSSMReady', true),
                      // Set hostname before installing DCV
                      updateStatusSettingHostname
                        .next(setHostnameTask)
                        .next(updateStatusInstallingDcv)
                        .next(installSoftwareTask)
                        // SSM install polling loop - wait for DCV install SSM command to complete
                        .next(initSsmInstallRetry)
                        .next(waitForSsmInstall)
                        .next(checkSsmInstallTask)
                        .next(new stepfunctions.Choice(this, 'IsSsmInstallComplete?')
                          .when(stepfunctions.Condition.booleanEquals('$.commandSucceeded', true),
                            // SSM command succeeded - proceed to DCV readiness check
                            updateStatusConfiguringDcv
                              .next(initializeDCVRetryCounter)
                              .next(waitForDCV)
                              .next(checkDCVReadinessTask)
                              .next(new stepfunctions.Choice(this, 'IsDCVReady?')
                                .when(stepfunctions.Condition.booleanEquals('$.dcvReady', true),
                                  new stepfunctions.Choice(this, 'NeedsCleanup?')
                                    // Path WITH cleanup needed
                                    .when(stepfunctions.Condition.booleanEquals('$.needsCleanup', true),
                                      new stepfunctions.Wait(this, 'WaitForSessionReady', {
                                        time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
                                })
                                  .next(checkSessionStatusTask)
                                  .next(new stepfunctions.Choice(this, 'IsSessionReady?')
                                    .when(stepfunctions.Condition.booleanEquals('$.sessionReady', true),
                                      deleteTestSessionTask
                                        .next(new stepfunctions.Wait(this, 'WaitForSessionDeleted', {
                                          time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(10)),
                                        }))
                                        .next(verifySessionDeletedTask)
                                        .next(new stepfunctions.Choice(this, 'IsSessionDeleted?')
                                          .when(stepfunctions.Condition.booleanEquals('$.sessionDeleted', true),
                                            // Branch: domain join vs auto-login
                                            new stepfunctions.Choice(this, 'ShouldJoinDomain?')
                                              .when(stepfunctions.Condition.booleanEquals('$.joinDomain', false),
                                                // STANDALONE PATH: Configure auto-login
                                                configureAutoLoginTask
                                                  .next(waitForAutoLogin)
                                                  .next(checkAutoLoginStatusTask)
                                                  .next(new stepfunctions.Choice(this, 'IsAutoLoginComplete?')
                                                    .when(stepfunctions.Condition.booleanEquals('$.autoLoginComplete', true),
                                                      // Auto-login done → shared configure system flow
                                                      updateStatusConfiguringSystem
                                                        .next(disableCtrlAltDelTask)
                                                        .next(setupFsxTaskSchedulerTask)
                                                        .next(updateStatusFinalizing)
                                                        .next(restartInstanceTask)
                                                        .next(waitForRestart)
                                                        .next(updateStatusReady)
                                                        .next(successState)
                                                    )
                                                    .when(stepfunctions.Condition.booleanEquals('$.autoLoginInProgress', true),
                                                      // Still in progress - wait and check again
                                                      new stepfunctions.Wait(this, 'WaitForAutoLoginRetry', {
                                                        time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
                                                      }).next(checkAutoLoginStatusTask)
                                                    )
                                                    .otherwise(
                                                      new stepfunctions.Fail(this, 'AutoLoginFailed', {
                                                        cause: 'Auto-login configuration failed',
                                                        error: 'AutoLoginError'
                                                      })
                                                    )
                                                  )
                                              )
                                              .otherwise(
                                                // DOMAIN JOIN PATH (default)
                                                updateStatusJoiningDomain
                                                  .next(joinDomainTask)
                                                  .next(waitForDomainJoin)
                                                  .next(checkDomainJoinStatusTask)
                                                  .next(new stepfunctions.Choice(this, 'IsDomainJoined?')
                                                    .when(stepfunctions.Condition.booleanEquals('$.domainJoinComplete', true),
                                                      // Domain join done → shared configure system flow
                                                      updateStatusConfiguringSystem
                                                    )
                                                    .otherwise(waitForDomainJoin)
                                                  )
                                              )
                                          )
                                          .otherwise(new stepfunctions.Wait(this, 'WaitForSessionDeleted2', {
                                            time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(10)),
                                          }).next(verifySessionDeletedTask))
                                        )
                                    )
                                    .otherwise(new stepfunctions.Wait(this, 'WaitForSessionReady2', {
                                      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
                                    }).next(checkSessionStatusTask))
                                  )
                              )
                              // Path WITHOUT cleanup needed
                              .otherwise(
                                // Branch: domain join vs auto-login (no cleanup path)
                                new stepfunctions.Choice(this, 'ShouldJoinDomainNoCleanup?')
                                  .when(stepfunctions.Condition.booleanEquals('$.joinDomain', false),
                                    // STANDALONE PATH (no cleanup): Configure auto-login
                                    new tasks.LambdaInvoke(this, 'ConfigureAutoLoginNoCleanup', {
                                      lambdaFunction: configureAutoLoginFunction,
                                      outputPath: '$.Payload',
                                    })
                                      .next(new stepfunctions.Wait(this, 'WaitForAutoLoginNoCleanup', {
                                        time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(60)),
                                      }))
                                      .next(new tasks.LambdaInvoke(this, 'CheckAutoLoginStatusNoCleanup', {
                                        lambdaFunction: checkAutoLoginStatusFunction,
                                        outputPath: '$.Payload',
                                      }))
                                      .next(new stepfunctions.Choice(this, 'IsAutoLoginCompleteNoCleanup?')
                                        .when(stepfunctions.Condition.booleanEquals('$.autoLoginComplete', true),
                                          // Auto-login done → configure system (no cleanup path)
                                          updateStatusConfiguringSystemNoCleanup
                                            .next(new tasks.LambdaInvoke(this, 'DisableCtrlAltDelNoCleanup', {
                                              lambdaFunction: runSSMCommandFunction,
                                              payload: stepfunctions.TaskInput.fromObject({
                                                'instanceId.$': '$.instanceId',
                                                'region.$': '$.region',
                                                'documentName': `${props.pascalCaseName}-Windows-DisableCtrlAltDel`,
                                              }),
                                              resultPath: '$.disableCtrlAltDelResult',
                                            }))
                                            .next(new tasks.LambdaInvoke(this, 'SetupFsxTaskSchedulerNoCleanup', {
                                              lambdaFunction: runSSMCommandFunction,
                                              payload: stepfunctions.TaskInput.fromObject({
                                                'instanceId.$': '$.instanceId',
                                                'region.$': '$.region',
                                                'documentName': `${props.pascalCaseName}-Windows-SetupFsxScheduler`,
                                              }),
                                              resultPath: '$.setupFsxResult',
                                            }))
                                            .next(updateStatusFinalizingNoCleanup)
                                            .next(new tasks.LambdaInvoke(this, 'RestartInstanceNoCleanup', {
                                              lambdaFunction: restartInstanceFunction,
                                              outputPath: '$.Payload',
                                            }))
                                            .next(new stepfunctions.Wait(this, 'WaitForRestartNoCleanup', {
                                              time: stepfunctions.WaitTime.duration(cdk.Duration.minutes(1)),
                                            }))
                                            .next(updateStatusReadyNoCleanup)
                                            .next(new stepfunctions.Succeed(this, 'WorkstationCreatedNoCleanup'))
                                        )
                                        .when(stepfunctions.Condition.booleanEquals('$.autoLoginInProgress', true),
                                          new stepfunctions.Wait(this, 'WaitForAutoLoginRetryNoCleanup', {
                                            time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
                                          }).next(new tasks.LambdaInvoke(this, 'CheckAutoLoginStatusNoCleanup2', {
                                            lambdaFunction: checkAutoLoginStatusFunction,
                                            outputPath: '$.Payload',
                                          })).next(new stepfunctions.Choice(this, 'IsAutoLoginCompleteNoCleanup2?')
                                            .when(stepfunctions.Condition.booleanEquals('$.autoLoginComplete', true),
                                              // Continue to system configuration
                                              updateStatusConfiguringSystemNoCleanup
                                            )
                                            .when(stepfunctions.Condition.booleanEquals('$.autoLoginInProgress', true),
                                              // Still in progress - one more retry
                                              new stepfunctions.Wait(this, 'WaitForAutoLoginRetryNoCleanup2', {
                                                time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
                                              }).next(new tasks.LambdaInvoke(this, 'CheckAutoLoginStatusNoCleanup3', {
                                                lambdaFunction: checkAutoLoginStatusFunction,
                                                outputPath: '$.Payload',
                                              })).next(new stepfunctions.Choice(this, 'IsAutoLoginCompleteNoCleanup3?')
                                                .when(stepfunctions.Condition.booleanEquals('$.autoLoginComplete', true),
                                                  updateStatusConfiguringSystemNoCleanup
                                                )
                                                .when(stepfunctions.Condition.booleanEquals('$.autoLoginInProgress', true),
                                                  // Still in progress - keep waiting with longer intervals
                                                  new stepfunctions.Wait(this, 'WaitForAutoLoginRetryNoCleanup3', {
                                                    time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(60)),
                                                  }).next(new tasks.LambdaInvoke(this, 'CheckAutoLoginStatusNoCleanup4', {
                                                    lambdaFunction: checkAutoLoginStatusFunction,
                                                    outputPath: '$.Payload',
                                                  })).next(new stepfunctions.Choice(this, 'IsAutoLoginCompleteNoCleanup4?')
                                                    .when(stepfunctions.Condition.booleanEquals('$.autoLoginComplete', true),
                                                      updateStatusConfiguringSystemNoCleanup
                                                    )
                                                    .when(stepfunctions.Condition.booleanEquals('$.autoLoginInProgress', true),
                                                      // Keep waiting - up to ~5 min total now
                                                      new stepfunctions.Wait(this, 'WaitForAutoLoginRetryNoCleanup4', {
                                                        time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(60)),
                                                      }).next(new tasks.LambdaInvoke(this, 'CheckAutoLoginStatusNoCleanup5', {
                                                        lambdaFunction: checkAutoLoginStatusFunction,
                                                        outputPath: '$.Payload',
                                                      })).next(new stepfunctions.Choice(this, 'IsAutoLoginCompleteNoCleanup5?')
                                                        .when(stepfunctions.Condition.booleanEquals('$.autoLoginComplete', true),
                                                          updateStatusConfiguringSystemNoCleanup
                                                        )
                                                        .when(stepfunctions.Condition.booleanEquals('$.autoLoginInProgress', true),
                                                          // Final wait - ~6 min total
                                                          new stepfunctions.Wait(this, 'WaitForAutoLoginRetryNoCleanup5', {
                                                            time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(60)),
                                                          }).next(new tasks.LambdaInvoke(this, 'CheckAutoLoginStatusNoCleanup6', {
                                                            lambdaFunction: checkAutoLoginStatusFunction,
                                                            outputPath: '$.Payload',
                                                          })).next(new stepfunctions.Choice(this, 'IsAutoLoginCompleteNoCleanup6?')
                                                            .when(stepfunctions.Condition.booleanEquals('$.autoLoginComplete', true),
                                                              updateStatusConfiguringSystemNoCleanup
                                                            )
                                                            .otherwise(
                                                              new stepfunctions.Fail(this, 'AutoLoginTimeoutNoCleanup', {
                                                                cause: 'Auto-login configuration timed out after 6 minutes',
                                                                error: 'AutoLoginTimeout'
                                                              })
                                                            )
                                                          )
                                                        )
                                                        .otherwise(
                                                          new stepfunctions.Fail(this, 'AutoLoginFailedNoCleanup5', {
                                                            cause: 'Auto-login configuration failed',
                                                            error: 'AutoLoginError'
                                                          })
                                                        )
                                                      )
                                                    )
                                                    .otherwise(
                                                      new stepfunctions.Fail(this, 'AutoLoginFailedNoCleanup4', {
                                                        cause: 'Auto-login configuration failed',
                                                        error: 'AutoLoginError'
                                                      })
                                                    )
                                                  )
                                                )
                                                .otherwise(
                                                  new stepfunctions.Fail(this, 'AutoLoginFailedNoCleanup3', {
                                                    cause: 'Auto-login configuration failed',
                                                    error: 'AutoLoginError'
                                                  })
                                                )
                                              )
                                            )
                                            .otherwise(
                                              new stepfunctions.Fail(this, 'AutoLoginFailedNoCleanup2', {
                                                cause: 'Auto-login configuration failed',
                                                error: 'AutoLoginError'
                                              })
                                            )
                                          )
                                        )
                                        .otherwise(
                                          new stepfunctions.Fail(this, 'AutoLoginFailedNoCleanup', {
                                            cause: 'Auto-login configuration failed',
                                            error: 'AutoLoginError'
                                          })
                                        )
                                      )
                                  )
                                  .otherwise(
                                    // DOMAIN JOIN PATH (no cleanup)
                                    updateStatusJoiningDomainNoCleanup
                                      .next(new tasks.LambdaInvoke(this, 'JoinDomainTaskNoCleanup', {
                                        lambdaFunction: joinDomainFunction,
                                        outputPath: '$.Payload',
                                      }))
                                      .next(new stepfunctions.Wait(this, 'WaitForDomainJoinNoCleanup', {
                                        time: stepfunctions.WaitTime.duration(cdk.Duration.minutes(2)),
                                      }))
                                      .next(new tasks.LambdaInvoke(this, 'CheckDomainJoinStatusNoCleanup', {
                                        lambdaFunction: checkDomainJoinStatusFunction,
                                        outputPath: '$.Payload',
                                      }))
                                      .next(new stepfunctions.Choice(this, 'IsDomainJoinedNoCleanup?')
                                        .when(stepfunctions.Condition.booleanEquals('$.domainJoinComplete', true),
                                          updateStatusConfiguringSystemNoCleanup
                                        )
                                        .otherwise(new stepfunctions.Wait(this, 'WaitForDomainJoinNoCleanup2', {
                                          time: stepfunctions.WaitTime.duration(cdk.Duration.minutes(2)),
                                        }).next(new tasks.LambdaInvoke(this, 'CheckDomainJoinStatusNoCleanup2', {
                                          lambdaFunction: checkDomainJoinStatusFunction,
                                          outputPath: '$.Payload',
                                        })))
                                      )
                                  )
                              )
                          )
                          .otherwise(
                            // DCV not ready - check retry count
                            incrementDCVRetryCounter
                              .next(new stepfunctions.Choice(this, 'ShouldCleanupSessions?')
                                // After 3 retries (3 minutes), try cleaning up orphaned sessions
                                .when(stepfunctions.Condition.numberEquals('$.dcvRetryCount', 3),
                                  cleanupOrphanedSessionsTask
                                    .next(new stepfunctions.Wait(this, 'WaitAfterCleanup', {
                                      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
                                    }))
                                    .next(checkDCVReadinessAfterCleanupTask)
                                    .next(new stepfunctions.Choice(this, 'IsDCVReadyAfterCleanup?')
                                      .when(stepfunctions.Condition.booleanEquals('$.dcvReady', true),
                                        // Success after cleanup - continue with normal flow
                                        new stepfunctions.Choice(this, 'NeedsCleanupAfterRetry?')
                                          .when(stepfunctions.Condition.booleanEquals('$.needsCleanup', true),
                                            new stepfunctions.Wait(this, 'WaitForSessionReadyAfterCleanup', {
                                              time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
                                            })
                                              .next(checkSessionStatusTask)
                                          )
                                          .otherwise(updateStatusJoiningDomainNoCleanup)
                                      )
                                      .otherwise(
                                        // Still not ready after cleanup - fail
                                        updateStatusDCVFailed
                                          .next(failureState)
                                      )
                                    )
                                )
                                // After 10 total retries (10 minutes), give up
                                .when(stepfunctions.Condition.numberGreaterThan('$.dcvRetryCount', 10),
                                  updateStatusDCVTimeout
                                    .next(failureState)
                                )
                                // Otherwise, keep retrying
                                .otherwise(waitForDCV)
                              )
                          )
                        )
                          )
                          .when(stepfunctions.Condition.booleanEquals('$.commandFailed', true),
                            // SSM command failed - update DynamoDB then fail
                            updateStatusSsmInstallFailed.next(failSsmInstallCommand)
                          )
                          .otherwise(
                            // SSM command still in progress - retry
                            incSsmInstallRetry
                              .next(new stepfunctions.Choice(this, 'SsmInstallRetryLimit?')
                                .when(stepfunctions.Condition.numberGreaterThan('$.ssmInstallRetryCount', 30),
                                  updateStatusSsmInstallTimeout.next(failSsmInstallTimeout)
                                )
                                .otherwise(
                                  waitForSsmInstallRetry.next(checkSsmInstallTask)
                                )
                              )
                          )
                        )
                    )
                    .otherwise(waitForSSM)
                  )
              )
              .when(stepfunctions.Condition.stringEquals('$.instanceState', 'terminated'),
                failureState)
              .otherwise(waitForInstance)
            )
        )
      );

    // Create the state machine
    this.stateMachine = new stepfunctions.StateMachine(this, 'WorkstationCreationStateMachine', {
      stateMachineName: `${props.acronym.toLowerCase()}-workstation-creation-windows`,
      definitionBody: stepfunctions.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.minutes(60),
    });

    // Grant KMS permissions to state machine role for DynamoDB access
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(this.stateMachine);
    }

    // Assign functions to public properties for reuse
    this.checkDCVReadinessFunction = checkDCVReadinessFunction;
    this.checkInstanceStatusFunction = checkInstanceStatusFunction;
    this.checkSessionStatusFunction = checkSessionStatusFunction;
    this.deleteTestSessionFunction = deleteTestSessionFunction;
    this.verifySessionDeletedFunction = verifySessionDeletedFunction;

    // Output
    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: this.stateMachine.stateMachineArn,
      description: 'Workstation Creation State Machine ARN',
    });
  }
}
