// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

interface DataSyncStackProps extends cdk.StackProps {
  storageTable: dynamodb.Table;
  pascalCaseName: string;
  acronym: string;
  dataEncryptionKey?: kms.IKey;
}

export class DataSyncStack extends cdk.Stack {
  public readonly dataSyncTable: dynamodb.Table;
  public readonly dataSyncRole: iam.Role;
  public readonly functions: {
    listLocations: lambda.Function;
    createLocation: lambda.Function;
    deleteLocation: lambda.Function;
    listTasks: lambda.Function;
    createTask: lambda.Function;
    updateTask: lambda.Function;
    deleteTask: lambda.Function;
    startExecution: lambda.Function;
    getExecutions: lambda.Function;
    listS3Buckets: lambda.Function;
  };
  public readonly executionStateMachine: stepfunctions.StateMachine;

  constructor(scope: Construct, id: string, props: DataSyncStackProps) {
    super(scope, id, {
      ...props,
      description: "DataSync integration infrastructure with Lambda functions and Step Functions for data transfer management"
    });

    // Initialize functions object
    this.functions = {} as any;

    // Use customer-managed KMS key if provided
    const encryptionConfig = props.dataEncryptionKey
      ? { encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED, encryptionKey: props.dataEncryptionKey }
      : { encryption: dynamodb.TableEncryption.AWS_MANAGED };

    // DataSync DynamoDB table with single-table design
    // pk: LOCATION#{locationId} or TASK#{taskId}
    // sk: METADATA or EXECUTION#{timestamp}
    this.dataSyncTable = new dynamodb.Table(this, 'DataSyncTable', {
      tableName: `${props.acronym.toLowerCase()}-datasync`,
      partitionKey: {
        name: 'pk',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'sk',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      ...encryptionConfig,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // GSI for querying by type (LOCATION, TASK, EXECUTION)
    this.dataSyncTable.addGlobalSecondaryIndex({
      indexName: 'type-index',
      partitionKey: {
        name: 'type',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // IAM Role for DataSync to access S3 buckets
    this.dataSyncRole = new iam.Role(this, 'DataSyncS3AccessRole', {
      roleName: `${props.acronym}-DataSync-S3-Access`,
      assumedBy: new iam.ServicePrincipal('datasync.amazonaws.com'),
      description: 'IAM role for DataSync to access S3 buckets',
    });

    // S3 permissions for DataSync role (same-account buckets)
    this.dataSyncRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetBucketLocation',
        's3:ListBucket',
        's3:ListBucketMultipartUploads',
      ],
      resources: ['arn:aws:s3:::*'],
      conditions: {
        StringEquals: {
          'aws:ResourceAccount': this.account,
        },
      },
    }));

    this.dataSyncRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:GetObjectTagging',
        's3:GetObjectVersion',
        's3:GetObjectVersionTagging',
        's3:ListMultipartUploadParts',
        's3:PutObject',
        's3:PutObjectTagging',
        's3:DeleteObject',
      ],
      resources: ['arn:aws:s3:::*/*'],
      conditions: {
        StringEquals: {
          'aws:ResourceAccount': this.account,
        },
      },
    }));

    // S3 permissions for cross-account buckets (requires bucket policy on external bucket)
    // These permissions allow DataSync to access buckets in other accounts when
    // the external bucket has a policy granting access to this role
    this.dataSyncRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetBucketLocation',
        's3:ListBucket',
        's3:ListBucketMultipartUploads',
      ],
      resources: ['arn:aws:s3:::*'],
    }));

    this.dataSyncRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:GetObjectTagging',
        's3:GetObjectVersion',
        's3:GetObjectVersionTagging',
        's3:ListMultipartUploadParts',
      ],
      resources: ['arn:aws:s3:::*/*'],
    }));

    // KMS permissions for DataSync to access encrypted objects in cross-account S3 buckets
    // When the remote account grants a root trust on their KMS key, this IAM policy
    // allows the DataSync role to actually use that key for decrypt/encrypt operations
    this.dataSyncRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'kms:Decrypt',
        'kms:GenerateDataKey',
        'kms:DescribeKey',
      ],
      resources: ['*'],
    }));

    // EC2 permissions for DataSync to create ENIs when transferring to/from FSx
    this.dataSyncRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:CreateNetworkInterface',
        'ec2:CreateNetworkInterfacePermission',
        'ec2:DeleteNetworkInterface',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DescribeSecurityGroups',
        'ec2:DescribeSubnets',
        'ec2:DescribeVpcs',
        'ec2:ModifyNetworkInterfaceAttribute',
      ],
      resources: ['*'],
    }));

    // CloudWatch Log Group for DataSync task logging
    const dataSyncLogGroup = new logs.LogGroup(this, 'DataSyncLogGroup', {
      logGroupName: `/aws/datasync/${props.acronym.toLowerCase()}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Grant DataSync permission to write to the log group
    dataSyncLogGroup.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('datasync.amazonaws.com')],
      actions: [
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'logs:PutLogEventsBatch',
      ],
      resources: [`${dataSyncLogGroup.logGroupArn}:*`],
      conditions: {
        ArnLike: {
          'aws:SourceArn': `arn:aws:datasync:${this.region}:${this.account}:task/*`,
        },
        StringEquals: {
          'aws:SourceAccount': this.account,
        },
      },
    }));

    // Store DataSync role ARN in SSM for Lambda access
    new ssm.StringParameter(this, 'DataSyncRoleArnParameter', {
      parameterName: `/${props.pascalCaseName}/DataSync/RoleArn`,
      stringValue: this.dataSyncRole.roleArn,
      description: 'IAM role ARN for DataSync S3 access',
    });

    // Store DataSync table name in SSM for cross-stack access
    new ssm.StringParameter(this, 'DataSyncTableNameParameter', {
      parameterName: `/${props.pascalCaseName}/DataSync/TableName`,
      stringValue: this.dataSyncTable.tableName,
      description: 'DynamoDB table name for DataSync configurations',
    });

    // Common Lambda environment variables
    const commonEnv = {
      DATASYNC_TABLE_NAME: this.dataSyncTable.tableName,
      STORAGE_TABLE_NAME: props.storageTable.tableName,
      DATASYNC_ROLE_ARN: this.dataSyncRole.roleArn,
      DATASYNC_LOG_GROUP_ARN: dataSyncLogGroup.logGroupArn,
      PRODUCT_NAME: props.pascalCaseName,
      ACRONYM: props.acronym,
      AWS_ACCOUNT_ID: this.account,
    };

    // List DataSync Locations Function
    this.functions.listLocations = new lambda.Function(this, 'ListLocationsFunction', {
      functionName: `${props.acronym.toLowerCase()}-datasync-list-locations`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/datasync-list-locations'),
      description: 'List DataSync locations',
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: commonEnv,
    });

    // Create DataSync Location Function
    this.functions.createLocation = new lambda.Function(this, 'CreateLocationFunction', {
      functionName: `${props.acronym.toLowerCase()}-datasync-create-location`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/datasync-create-location'),
      description: 'Create DataSync location (S3 or FSx)',
      timeout: cdk.Duration.seconds(60),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        ...commonEnv,
        AD_DOMAIN_PARAMETER_NAME: `/${props.pascalCaseName}/Identity/ActiveDirectoryDomainName`,
        AD_CREDENTIALS_SECRET_ARN: `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/${props.pascalCaseName}/Identity/ResourceAdminActiveDirectoryLoginCredentials`, // pragma: allowlist secret
      },
    });

    // Grant createLocation Lambda permission to read AD credentials
    this.functions.createLocation.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/Identity/ActiveDirectoryDomainName`],
    }));
    this.functions.createLocation.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:/${props.pascalCaseName}/Identity/ResourceAdminActiveDirectoryLoginCredentials*`],
    }));

    // Delete DataSync Location Function
    this.functions.deleteLocation = new lambda.Function(this, 'DeleteLocationFunction', {
      functionName: `${props.acronym.toLowerCase()}-datasync-delete-location`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/datasync-delete-location'),
      description: 'Delete DataSync location',
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: commonEnv,
    });

    // List DataSync Tasks Function
    this.functions.listTasks = new lambda.Function(this, 'ListTasksFunction', {
      functionName: `${props.acronym.toLowerCase()}-datasync-list-tasks`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/datasync-list-tasks'),
      description: 'List DataSync tasks',
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: commonEnv,
    });

    // Create DataSync Task Function
    this.functions.createTask = new lambda.Function(this, 'CreateTaskFunction', {
      functionName: `${props.acronym.toLowerCase()}-datasync-create-task`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/datasync-create-task'),
      description: 'Create DataSync task',
      timeout: cdk.Duration.seconds(60),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: commonEnv,
    });

    // Update DataSync Task Function
    this.functions.updateTask = new lambda.Function(this, 'UpdateTaskFunction', {
      functionName: `${props.acronym.toLowerCase()}-datasync-update-task`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/datasync-update-task'),
      description: 'Update DataSync task',
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: commonEnv,
    });

    // Delete DataSync Task Function
    this.functions.deleteTask = new lambda.Function(this, 'DeleteTaskFunction', {
      functionName: `${props.acronym.toLowerCase()}-datasync-delete-task`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/datasync-delete-task'),
      description: 'Delete DataSync task',
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: commonEnv,
    });

    // Start DataSync Execution Function
    this.functions.startExecution = new lambda.Function(this, 'StartExecutionFunction', {
      functionName: `${props.acronym.toLowerCase()}-datasync-start-execution`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/datasync-start-execution'),
      description: 'Start DataSync task execution',
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: commonEnv,
    });

    // Get DataSync Executions Function
    this.functions.getExecutions = new lambda.Function(this, 'GetExecutionsFunction', {
      functionName: `${props.acronym.toLowerCase()}-datasync-get-executions`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/datasync-get-executions'),
      description: 'Get DataSync task execution history',
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: commonEnv,
    });

    // List S3 Buckets Function (for same-account bucket dropdown)
    // Also handles /config endpoint for cross-account bucket policy generation
    this.functions.listS3Buckets = new lambda.Function(this, 'ListS3BucketsFunction', {
      functionName: `${props.acronym.toLowerCase()}-datasync-list-s3-buckets`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/datasync-list-s3-buckets'),
      description: 'List S3 buckets in the account for DataSync location creation',
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PRODUCT_NAME: props.pascalCaseName,
        ACRONYM: props.acronym,
        DATASYNC_ROLE_ARN: this.dataSyncRole.roleArn,
        AWS_ACCOUNT_ID: this.account,
      },
    });

    // Grant DynamoDB permissions to all Lambda functions
    Object.values(this.functions).forEach(fn => {
      this.dataSyncTable.grantReadWriteData(fn);
    });

    // Grant storage table read access to relevant functions
    props.storageTable.grantReadData(this.functions.createLocation);
    props.storageTable.grantReadData(this.functions.listLocations);

    // Grant DataSync API permissions
    const dataSyncPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'datasync:CreateLocationS3',
        'datasync:CreateLocationFsxOntap',
        'datasync:CreateLocationFsxWindows',
        'datasync:DeleteLocation',
        'datasync:DescribeLocation*',
        'datasync:ListLocations',
        'datasync:CreateTask',
        'datasync:UpdateTask',
        'datasync:DeleteTask',
        'datasync:DescribeTask',
        'datasync:ListTasks',
        'datasync:StartTaskExecution',
        'datasync:DescribeTaskExecution',
        'datasync:ListTaskExecutions',
        'datasync:CancelTaskExecution',
      ],
      resources: ['*'],
    });

    this.functions.createLocation.addToRolePolicy(dataSyncPolicy);
    this.functions.deleteLocation.addToRolePolicy(dataSyncPolicy);
    this.functions.listLocations.addToRolePolicy(dataSyncPolicy);
    this.functions.createTask.addToRolePolicy(dataSyncPolicy);
    this.functions.updateTask.addToRolePolicy(dataSyncPolicy);
    this.functions.deleteTask.addToRolePolicy(dataSyncPolicy);
    this.functions.listTasks.addToRolePolicy(dataSyncPolicy);
    this.functions.startExecution.addToRolePolicy(dataSyncPolicy);
    this.functions.getExecutions.addToRolePolicy(dataSyncPolicy);

    // Grant comprehensive EC2 permissions required by DataSync for FSx locations
    // DataSync needs these to validate network configuration when creating FSx locations and tasks
    const ec2PermissionsForDataSync = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:DescribeNetworkInterfaces',
        'ec2:DescribeSubnets',
        'ec2:DescribeSecurityGroups',
        'ec2:DescribeVpcs',
        'ec2:CreateNetworkInterface',
        'ec2:CreateNetworkInterfacePermission',
        'ec2:DeleteNetworkInterface',
      ],
      resources: ['*'],
    });
    this.functions.createLocation.addToRolePolicy(ec2PermissionsForDataSync);
    this.functions.createTask.addToRolePolicy(ec2PermissionsForDataSync);

    // Grant S3 list buckets permission
    this.functions.listS3Buckets.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListAllMyBuckets', 's3:GetBucketLocation'],
      resources: ['*'],
    }));

    // Grant IAM PassRole for DataSync role
    this.functions.createLocation.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [this.dataSyncRole.roleArn],
    }));

    // Grant FSx describe permissions for FSx location creation
    this.functions.createLocation.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'fsx:DescribeFileSystems',
        'fsx:DescribeStorageVirtualMachines',
      ],
      resources: ['*'],
    }));

    // Grant CloudWatch Logs permissions for DataSync task creation with logging enabled
    // DataSync needs to verify the log group exists when CloudWatchLogGroupArn is specified
    // Note: logs:DescribeLogGroups requires wildcard resource, but we scope DescribeLogStreams
    this.functions.createTask.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:DescribeLogGroups',
      ],
      resources: ['*'],
    }));

    this.functions.createTask.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:DescribeLogStreams',
      ],
      resources: [
        dataSyncLogGroup.logGroupArn,
        `${dataSyncLogGroup.logGroupArn}:*`,
        `arn:aws:logs:*:${this.account}:log-group:/aws/datasync/${props.acronym.toLowerCase()}:*`,
        `arn:aws:logs:*:${this.account}:log-group:/aws/datasync/${props.acronym}:*`,
      ],
    }));

    // Grant SSM permissions to read regional log group ARN parameters
    // This allows the createTask Lambda to look up log group ARNs in regional hubs
    this.functions.createTask.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:*:${this.account}:parameter/${props.pascalCaseName}/RegionalHub/*/DataSync/LogGroupArn`],
    }));


    // Step Functions State Machine for Task Execution
    const executionStateMachineDefinition = {
      Comment: "DataSync Task Execution State Machine",
      StartAt: "UpdateStatusToRunning",
      States: {
        UpdateStatusToRunning: {
          Type: "Task",
          Resource: "arn:aws:states:::dynamodb:updateItem",
          Parameters: {
            TableName: this.dataSyncTable.tableName,
            Key: {
              pk: { "S.$": "$.taskPk" },
              sk: { "S": "METADATA" }
            },
            UpdateExpression: "SET #status = :status, #updatedAt = :updatedAt, lastExecutionId = :execId, lastExecutionStatus = :execStatus, lastExecutionTime = :execTime",
            ExpressionAttributeNames: {
              "#status": "status",
              "#updatedAt": "updatedAt"
            },
            ExpressionAttributeValues: {
              ":status": { "S": "running" },
              ":updatedAt": { "S.$": "$$.State.EnteredTime" },
              ":execId": { "S.$": "$.executionId" },
              ":execStatus": { "S": "LAUNCHING" },
              ":execTime": { "S.$": "$$.State.EnteredTime" }
            }
          },
          ResultPath: null,
          Next: "StartTaskExecution",
          Retry: [{ ErrorEquals: ["States.ALL"], IntervalSeconds: 2, MaxAttempts: 3, BackoffRate: 2.0 }]
        },
        StartTaskExecution: {
          Type: "Task",
          Resource: "arn:aws:states:::aws-sdk:datasync:startTaskExecution",
          Parameters: {
            "TaskArn.$": "$.taskArn"
          },
          ResultPath: "$.dataSyncExecution",
          Next: "StoreExecutionRecord",
          Retry: [{ ErrorEquals: ["States.ALL"], IntervalSeconds: 5, MaxAttempts: 3, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ["States.ALL"], Next: "UpdateStatusToFailed", ResultPath: "$.error" }]
        },
        StoreExecutionRecord: {
          Type: "Task",
          Resource: "arn:aws:states:::dynamodb:putItem",
          Parameters: {
            TableName: this.dataSyncTable.tableName,
            Item: {
              pk: { "S.$": "$.taskPk" },
              sk: { "S.$": "States.Format('EXECUTION#{}', $.startTime)" },
              type: { "S": "EXECUTION" },
              executionId: { "S.$": "$.executionId" },
              executionArn: { "S.$": "$.dataSyncExecution.TaskExecutionArn" },
              taskId: { "S.$": "$.taskId" },
              status: { "S": "LAUNCHING" },
              startTime: { "S.$": "$.startTime" }
            }
          },
          ResultPath: null,
          Next: "WaitForExecution",
          Retry: [{ ErrorEquals: ["States.ALL"], IntervalSeconds: 2, MaxAttempts: 3, BackoffRate: 2.0 }]
        },
        WaitForExecution: {
          Type: "Wait",
          Seconds: 30,
          Next: "CheckExecutionStatus"
        },
        CheckExecutionStatus: {
          Type: "Task",
          Resource: "arn:aws:states:::aws-sdk:datasync:describeTaskExecution",
          Parameters: {
            "TaskExecutionArn.$": "$.dataSyncExecution.TaskExecutionArn"
          },
          ResultPath: "$.executionStatus",
          Next: "EvaluateExecutionStatus",
          Retry: [{ ErrorEquals: ["States.ALL"], IntervalSeconds: 10, MaxAttempts: 3, BackoffRate: 2.0 }]
        },
        EvaluateExecutionStatus: {
          Type: "Choice",
          Choices: [
            {
              Variable: "$.executionStatus.Status",
              StringEquals: "SUCCESS",
              Next: "UpdateStatusToSuccess"
            },
            {
              Variable: "$.executionStatus.Status",
              StringEquals: "ERROR",
              Next: "UpdateStatusToFailed"
            },
            {
              Or: [
                { Variable: "$.executionStatus.Status", StringEquals: "QUEUED" },
                { Variable: "$.executionStatus.Status", StringEquals: "LAUNCHING" },
                { Variable: "$.executionStatus.Status", StringEquals: "PREPARING" },
                { Variable: "$.executionStatus.Status", StringEquals: "TRANSFERRING" },
                { Variable: "$.executionStatus.Status", StringEquals: "VERIFYING" }
              ],
              Next: "UpdateExecutionProgress"
            }
          ],
          Default: "UpdateStatusToFailed"
        },
        UpdateExecutionProgress: {
          Type: "Task",
          Resource: "arn:aws:states:::dynamodb:updateItem",
          Parameters: {
            TableName: this.dataSyncTable.tableName,
            Key: {
              pk: { "S.$": "$.taskPk" },
              sk: { "S": "METADATA" }
            },
            UpdateExpression: "SET lastExecutionStatus = :status",
            ExpressionAttributeValues: {
              ":status": { "S.$": "$.executionStatus.Status" }
            }
          },
          ResultPath: null,
          Next: "WaitForExecution",
          Retry: [{ ErrorEquals: ["States.ALL"], IntervalSeconds: 2, MaxAttempts: 3, BackoffRate: 2.0 }]
        },
        UpdateStatusToSuccess: {
          Type: "Task",
          Resource: "arn:aws:states:::dynamodb:updateItem",
          Parameters: {
            TableName: this.dataSyncTable.tableName,
            Key: {
              pk: { "S.$": "$.taskPk" },
              sk: { "S": "METADATA" }
            },
            UpdateExpression: "SET #status = :status, #updatedAt = :updatedAt, lastExecutionStatus = :execStatus",
            ExpressionAttributeNames: {
              "#status": "status",
              "#updatedAt": "updatedAt"
            },
            ExpressionAttributeValues: {
              ":status": { "S": "available" },
              ":updatedAt": { "S.$": "$$.State.EnteredTime" },
              ":execStatus": { "S": "SUCCESS" }
            }
          },
          ResultPath: null,
          Next: "UpdateExecutionRecordSuccess",
          Retry: [{ ErrorEquals: ["States.ALL"], IntervalSeconds: 2, MaxAttempts: 3, BackoffRate: 2.0 }]
        },
        UpdateExecutionRecordSuccess: {
          Type: "Task",
          Resource: "arn:aws:states:::dynamodb:updateItem",
          Parameters: {
            TableName: this.dataSyncTable.tableName,
            Key: {
              pk: { "S.$": "$.taskPk" },
              sk: { "S.$": "States.Format('EXECUTION#{}', $.startTime)" }
            },
            UpdateExpression: "SET #status = :status, endTime = :endTime, bytesTransferred = :bytes, filesTransferred = :files, #duration = :duration",
            ExpressionAttributeNames: {
              "#status": "status",
              "#duration": "duration"
            },
            ExpressionAttributeValues: {
              ":status": { "S": "SUCCESS" },
              ":endTime": { "S.$": "$$.State.EnteredTime" },
              ":bytes": { "N.$": "States.Format('{}', $.executionStatus.BytesTransferred)" },
              ":files": { "N.$": "States.Format('{}', $.executionStatus.FilesTransferred)" },
              ":duration": { "N.$": "States.Format('{}', $.executionStatus.EstimatedFilesToTransfer)" }
            }
          },
          End: true,
          Retry: [{ ErrorEquals: ["States.ALL"], IntervalSeconds: 2, MaxAttempts: 3, BackoffRate: 2.0 }]
        },
        UpdateStatusToFailed: {
          Type: "Task",
          Resource: "arn:aws:states:::dynamodb:updateItem",
          Parameters: {
            TableName: this.dataSyncTable.tableName,
            Key: {
              pk: { "S.$": "$.taskPk" },
              sk: { "S": "METADATA" }
            },
            UpdateExpression: "SET #status = :status, #updatedAt = :updatedAt, lastExecutionStatus = :execStatus",
            ExpressionAttributeNames: {
              "#status": "status",
              "#updatedAt": "updatedAt"
            },
            ExpressionAttributeValues: {
              ":status": { "S": "available" },
              ":updatedAt": { "S.$": "$$.State.EnteredTime" },
              ":execStatus": { "S": "ERROR" }
            }
          },
          End: true,
          Retry: [{ ErrorEquals: ["States.ALL"], IntervalSeconds: 2, MaxAttempts: 3, BackoffRate: 2.0 }]
        }
      }
    };

    this.executionStateMachine = new stepfunctions.StateMachine(this, 'ExecutionStateMachine', {
      stateMachineName: `${props.acronym.toLowerCase()}-datasync-execution`,
      definitionBody: stepfunctions.DefinitionBody.fromString(JSON.stringify(executionStateMachineDefinition)),
      timeout: cdk.Duration.hours(24),
    });

    // Grant Step Functions permissions to DynamoDB
    this.dataSyncTable.grantReadWriteData(this.executionStateMachine);

    // Grant Step Functions permissions to DataSync
    this.executionStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'datasync:StartTaskExecution',
        'datasync:DescribeTaskExecution',
      ],
      resources: ['*'],
    }));

    // Grant Step Functions EC2 permissions required by DataSync for FSx locations
    // DataSync needs ec2:DescribeNetworkInterfaces when describing task executions that use ENIs
    this.executionStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:DescribeNetworkInterfaces',
      ],
      resources: ['*'],
    }));

    // Grant Step Functions FSx permissions required by DataSync for FSx locations
    // DataSync needs fsx:DescribeFileSystems when starting task executions involving FSx
    this.executionStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'fsx:DescribeFileSystems',
      ],
      resources: ['*'],
    }));

    // Grant start execution Lambda permission to start Step Functions
    this.functions.startExecution.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['states:StartExecution'],
      resources: [this.executionStateMachine.stateMachineArn],
    }));

    // Add state machine ARN to start execution Lambda environment
    this.functions.startExecution.addEnvironment('EXECUTION_STATE_MACHINE_ARN', this.executionStateMachine.stateMachineArn);

    // Outputs
    new cdk.CfnOutput(this, 'DataSyncTableName', {
      value: this.dataSyncTable.tableName,
      description: 'DynamoDB DataSync Table Name',
    });

    new cdk.CfnOutput(this, 'DataSyncRoleArn', {
      value: this.dataSyncRole.roleArn,
      description: 'IAM Role ARN for DataSync S3 access',
    });

    new cdk.CfnOutput(this, 'ExecutionStateMachineArn', {
      value: this.executionStateMachine.stateMachineArn,
      description: 'Step Functions State Machine ARN for DataSync execution',
    });
  }
}
