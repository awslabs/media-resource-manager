// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import { AgentCoreRuntime } from './constructs/agentcore-runtime';
import { AgentTestInfrastructureConstruct } from './constructs/agent-test-infrastructure-construct';

export interface AgentCoreStackProps extends cdk.StackProps {
  pascalCaseName: string;
  acronym: string;
  encryptionKey?: kms.IKey;
  softwareLibraryTable: dynamodb.ITable;
  uploadsBucket: string;
  agentLogGroup: logs.ILogGroup;
}

export class AgentCoreStack extends cdk.Stack {
  public readonly agentExecutionRole: iam.Role;
  public readonly agentExecutionStateTable: dynamodb.Table;
  public readonly agentUsageTable: dynamodb.Table;
  public readonly agentProgressTable: dynamodb.Table;
  public readonly installScriptAgentRuntime?: AgentCoreRuntime;
  public readonly scriptGenerationStateMachine: stepfunctions.StateMachine;
  public readonly invokeAgentCoreFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: AgentCoreStackProps) {
    super(scope, id, {
      ...props,
      description: 'AgentCore infrastructure for AI Install Script Agent with Bedrock AgentCore Runtime',
    });

    const tablePrefix = props.acronym.toLowerCase();
    const region = this.region;
    const account = this.account;

    // Use customer-managed KMS key if provided
    const encryptionConfig = props.encryptionKey
      ? { encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED, encryptionKey: props.encryptionKey }
      : { encryption: dynamodb.TableEncryption.AWS_MANAGED };

    // Agent Execution State table - tracks ongoing agent executions
    this.agentExecutionStateTable = new dynamodb.Table(this, 'AgentExecutionStateTable', {
      tableName: `${tablePrefix}-agent-execution-state`,
      partitionKey: {
        name: 'executionId',
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

    // Add GSI for software lookup
    this.agentExecutionStateTable.addGlobalSecondaryIndex({
      indexName: 'softwareId-index',
      partitionKey: {
        name: 'softwareId',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Add GSI for status lookup
    this.agentExecutionStateTable.addGlobalSecondaryIndex({
      indexName: 'status-index',
      partitionKey: {
        name: 'status',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Agent Usage table - tracks daily/monthly usage for cost control
    this.agentUsageTable = new dynamodb.Table(this, 'AgentUsageTable', {
      tableName: `${tablePrefix}-agent-usage`,
      partitionKey: {
        name: 'date',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      ...encryptionConfig,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Agent Progress table - stores progress events for SSE streaming
    this.agentProgressTable = new dynamodb.Table(this, 'AgentProgressTable', {
      tableName: `${tablePrefix}-agent-progress`,
      partitionKey: {
        name: 'executionId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'eventId',
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

    // Import VPC and subnets using deploy-time SSM parameter resolution
    // This avoids synth-time lookups and inter-stack dependencies
    const vpcId = ssm.StringParameter.valueForStringParameter(
      this, `/${props.pascalCaseName}/Network/VpcId`
    );
    const vpcCidr = ssm.StringParameter.valueForStringParameter(
      this, `/${props.pascalCaseName}/Network/VpcCidr`
    );
    
    // Get individual subnet IDs and AZs from SSM (deploy-time resolution)
    const subnet1Id = ssm.StringParameter.valueForStringParameter(
      this, `/${props.pascalCaseName}/Network/PrivateSubnet1/SubnetID`
    );
    const subnet1Az = ssm.StringParameter.valueForStringParameter(
      this, `/${props.pascalCaseName}/Network/PrivateSubnet1/AZ`
    );
    const subnet2Id = ssm.StringParameter.valueForStringParameter(
      this, `/${props.pascalCaseName}/Network/PrivateSubnet2/SubnetID`
    );
    const subnet2Az = ssm.StringParameter.valueForStringParameter(
      this, `/${props.pascalCaseName}/Network/PrivateSubnet2/AZ`
    );

    // Import VPC with attributes (no synth-time lookup required)
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId: vpcId,
      vpcCidrBlock: vpcCidr,
      availabilityZones: [subnet1Az, subnet2Az],
      privateSubnetIds: [subnet1Id, subnet2Id],
    });

    // Import subnets individually for constructs that need ISubnet[]
    const privateSubnets = [
      ec2.Subnet.fromSubnetAttributes(this, 'PrivateSubnet1', {
        subnetId: subnet1Id,
        availabilityZone: subnet1Az,
      }),
      ec2.Subnet.fromSubnetAttributes(this, 'PrivateSubnet2', {
        subnetId: subnet2Id,
        availabilityZone: subnet2Az,
      }),
    ];

    // Create test infrastructure for EC2 test instances
    const testInfrastructure = new AgentTestInfrastructureConstruct(this, 'TestInfrastructure', {
      pascalCaseName: props.pascalCaseName,
      acronym: props.acronym,
      vpc,
      privateSubnets,
      uploadsBucketArn: `arn:aws:s3:::${props.uploadsBucket}`,
    });

    // IAM role for agent execution (used by both Lambda and AgentCore Runtime)
    this.agentExecutionRole = new iam.Role(this, 'AgentExecutionRole', {
      roleName: `${props.pascalCaseName}-AgentExecutionRole`,
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lambda.amazonaws.com'),
        new iam.ServicePrincipal('bedrock.amazonaws.com'),
        new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      ),
      description: 'Execution role for Install Script Agent with permissions for EC2, SSM, S3, DynamoDB, Secrets Manager, and Image Builder',
    });

    // CloudWatch Logs permissions
    this.agentExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchLogs',
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [
        props.agentLogGroup.logGroupArn,
        `${props.agentLogGroup.logGroupArn}:*`,
        `arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
      ],
    }));

    // Bedrock permissions
    this.agentExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockInvoke',
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: [
        `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-*`,
        `arn:aws:bedrock:${region}::foundation-model/amazon.titan-*`,
        `arn:aws:bedrock:${region}::foundation-model/amazon.nova-*`,
        // Cross-region inference profiles
        `arn:aws:bedrock:${region}:${account}:inference-profile/*`,
        `arn:aws:bedrock:us:${account}:inference-profile/*`,
        `arn:aws:bedrock:*::foundation-model/*`,
      ],
    }));

    // EC2 permissions for test instances
    this.agentExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EC2TestInstances',
      actions: [
        'ec2:RunInstances',
        'ec2:TerminateInstances',
        'ec2:DescribeInstances',
        'ec2:DescribeInstanceStatus',
        'ec2:CreateTags',
        'ec2:DescribeImages',
        'ec2:DescribeSubnets',
        'ec2:DescribeSecurityGroups',
      ],
      resources: ['*'],
    }));

    // SSM permissions for script execution
    this.agentExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SSMCommands',
      actions: [
        'ssm:SendCommand',
        'ssm:GetCommandInvocation',
        'ssm:ListCommandInvocations',
        'ssm:CancelCommand',
        'ssm:DescribeInstanceInformation',
      ],
      resources: ['*'],
    }));

    // SSM Parameter Store permissions
    this.agentExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SSMParameters',
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters',
        'ssm:PutParameter',
      ],
      resources: [
        `arn:aws:ssm:${region}:${account}:parameter/${props.pascalCaseName}/*`,
        `arn:aws:ssm:${region}:${account}:parameter/agentcore/*`,
        // AWS public parameters for AMI lookups
        `arn:aws:ssm:${region}::parameter/aws/service/*`,
      ],
    }));

    // S3 permissions for media bucket
    this.agentExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3MediaAccess',
      actions: [
        's3:GetObject',
        's3:PutObject',
        's3:ListBucket',
      ],
      resources: [
        `arn:aws:s3:::${props.uploadsBucket}`,
        `arn:aws:s3:::${props.uploadsBucket}/*`,
      ],
    }));

    // DynamoDB permissions for software library and agent tables
    this.agentExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DynamoDBAccess',
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:Query',
        'dynamodb:Scan',
      ],
      resources: [
        props.softwareLibraryTable.tableArn,
        `${props.softwareLibraryTable.tableArn}/index/*`,
        this.agentExecutionStateTable.tableArn,
        `${this.agentExecutionStateTable.tableArn}/index/*`,
        this.agentUsageTable.tableArn,
        this.agentProgressTable.tableArn,
      ],
    }));

    // Secrets Manager permissions for license keys
    this.agentExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SecretsManagerAccess',
      actions: [
        'secretsmanager:CreateSecret',
        'secretsmanager:GetSecretValue',
        'secretsmanager:PutSecretValue',
        'secretsmanager:DeleteSecret',
      ],
      resources: [
        `arn:aws:secretsmanager:${region}:${account}:secret:/${props.pascalCaseName}/Software/*`,
      ],
    }));

    // Image Builder permissions
    this.agentExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ImageBuilderAccess',
      actions: [
        'imagebuilder:CreateComponent',
        'imagebuilder:GetComponent',
        'imagebuilder:DeleteComponent',
        'imagebuilder:ListComponents',
      ],
      resources: ['*'],
    }));

    // ECR permissions for AgentCore Runtime
    this.agentExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ECRAccess',
      actions: [
        'ecr:GetAuthorizationToken',
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
      ],
      resources: ['*'],
    }));

    // X-Ray permissions
    this.agentExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'XRayAccess',
      actions: [
        'xray:PutTraceSegments',
        'xray:PutTelemetryRecords',
        'xray:GetSamplingRules',
        'xray:GetSamplingTargets',
      ],
      resources: ['*'],
    }));

    // AgentCore Memory permissions
    this.agentExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCoreMemory',
      actions: [
        'bedrock-agentcore:CreateEvent',
        'bedrock-agentcore:GetEvent',
        'bedrock-agentcore:ListEvents',
        'bedrock-agentcore:DeleteEvent',
        'bedrock-agentcore:AllowVendedLogDeliveryForResource',
      ],
      resources: [`arn:aws:bedrock-agentcore:${region}:${account}:*`],
    }));

    // Step Functions callback permissions (for agent to send task success/failure)
    this.agentExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'StepFunctionsCallback',
      actions: [
        'states:SendTaskSuccess',
        'states:SendTaskFailure',
      ],
      resources: ['*'],
    }));

    // KMS permissions if using customer-managed key
    if (props.encryptionKey) {
      this.agentExecutionRole.addToPolicy(new iam.PolicyStatement({
        sid: 'KMSAccess',
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:GenerateDataKey',
        ],
        resources: [props.encryptionKey.keyArn],
      }));
    }

    // IAM PassRole for EC2 instance profile
    this.agentExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'IAMPassRole',
      actions: ['iam:PassRole'],
      resources: [
        `arn:aws:iam::${account}:role/${props.pascalCaseName}-TestInstanceRole`,
      ],
    }));

    // Deploy the Install Script Agent as an AgentCore Runtime
    // Check if the agent source code exists before deploying
    const fs = require('fs');
    const agentSourcePath = './agents/install-script-agent-python';
    
    if (fs.existsSync(agentSourcePath)) {
      this.installScriptAgentRuntime = new AgentCoreRuntime(this, 'InstallScriptAgentRuntime', {
        agentName: 'install-script-agent',
        sourceCodePath: agentSourcePath,
        memoryExecutionRoleArn: this.agentExecutionRole.roleArn,
        eventExpiryDuration: 30,
        enableLongTermMemory: true,
        environmentVariables: {
          AWS_REGION: region,
          PASCAL_CASE_NAME: props.pascalCaseName,
          SOFTWARE_LIBRARY_TABLE_NAME: props.softwareLibraryTable.tableName,
          AGENT_EXECUTION_STATE_TABLE: this.agentExecutionStateTable.tableName,
          AGENT_USAGE_TABLE: this.agentUsageTable.tableName,
          AGENT_PROGRESS_TABLE: this.agentProgressTable.tableName,
          UPLOADS_BUCKET: props.uploadsBucket,
          AGENT_LOG_GROUP: props.agentLogGroup.logGroupName,
        },
      });
    }

    // ===========================================
    // STEP FUNCTIONS STATE MACHINE FOR SCRIPT GENERATION
    // ===========================================

    // Lambda to invoke AgentCore with TaskToken
    this.invokeAgentCoreFunction = new lambda.Function(this, 'InvokeAgentCoreFunction', {
      functionName: `${props.acronym.toLowerCase()}-invoke-agentcore-with-token`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/invoke-agentcore-with-token'),
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
    });

    // CloudWatch Logs permissions (basic Lambda execution)
    this.invokeAgentCoreFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [`arn:aws:logs:${region}:${account}:log-group:/aws/lambda/${props.acronym.toLowerCase()}-invoke-agentcore-with-token:*`],
    }));

    // Grant permissions to invoke AgentCore
    this.invokeAgentCoreFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [`arn:aws:bedrock-agentcore:${region}:${account}:runtime/*`],
    }));

    // Grant permissions to read SSM parameters
    this.invokeAgentCoreFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${region}:${account}:parameter/agentcore/*`],
    }));

    // Grant permissions to send task failure to Step Functions
    this.invokeAgentCoreFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['states:SendTaskFailure'],
      resources: ['*'],
    }));

    // Step Functions state machine definition using JSONata
    const stateMachineDefinition = {
      Comment: 'Script Generation State Machine - Invokes AgentCore and waits for completion',
      QueryLanguage: 'JSONata',
      StartAt: 'InitializeExecution',
      States: {
        InitializeExecution: {
          Type: 'Task',
          Resource: 'arn:aws:states:::dynamodb:updateItem',
          Arguments: {
            TableName: this.agentExecutionStateTable.tableName,
            Key: {
              executionId: { S: '{% $states.input.executionId %}' }
            },
            UpdateExpression: 'SET #status = :status, startedAt = :startedAt, softwareId = :softwareId, softwareName = :softwareName, platform = :platform, isDraftMode = :isDraftMode',
            ExpressionAttributeNames: {
              '#status': 'status'
            },
            ExpressionAttributeValues: {
              ':status': { S: 'in_progress' },
              ':startedAt': { S: '{% $now() %}' },
              ':softwareId': { S: '{% $states.input.softwareId %}' },
              ':softwareName': { S: '{% $states.input.softwareName %}' },
              ':platform': { S: '{% $states.input.platform %}' },
              ':isDraftMode': { BOOL: '{% $states.input.isDraftMode %}' }
            }
          },
          Assign: {
            executionId: '{% $states.input.executionId %}',
            softwareId: '{% $states.input.softwareId %}',
            softwareName: '{% $states.input.softwareName %}',
            platform: '{% $states.input.platform %}',
            isDraftMode: '{% $states.input.isDraftMode %}',
            sessionId: '{% $states.input.sessionId %}',
            mediaS3Uri: '{% $states.input.mediaS3Uri %}',
            testAutomatically: '{% $states.input.testAutomatically %}',
            maxAttempts: '{% $states.input.maxAttempts %}'
          },
          Next: 'InvokeAgentCore'
        },
        InvokeAgentCore: {
          Type: 'Task',
          Resource: 'arn:aws:states:::lambda:invoke.waitForTaskToken',
          Arguments: {
            FunctionName: this.invokeAgentCoreFunction.functionArn,
            Payload: {
              TaskToken: '{% $states.context.Task.Token %}',
              requestData: {
                executionId: '{% $executionId %}',
                softwareId: '{% $softwareId %}',
                softwareName: '{% $softwareName %}',
                platform: '{% $platform %}',
                isDraftMode: '{% $isDraftMode %}',
                sessionId: '{% $sessionId %}',
                mediaS3Uri: '{% $mediaS3Uri %}',
                testAutomatically: '{% $testAutomatically %}',
                maxAttempts: '{% $maxAttempts %}'
              }
            }
          },
          TimeoutSeconds: 1800, // 30 minutes - EC2 launch + SSM + script execution can take 15-25 min
          HeartbeatSeconds: 300, // 5 minute heartbeat to keep task alive
          Assign: {
            agentResult: '{% $states.result %}'
          },
          Catch: [
            {
              ErrorEquals: ['States.ALL'],
              Next: 'HandleFailure',
              Assign: {
                errorCause: '{% $states.errorOutput.Cause ? $states.errorOutput.Cause : "Unknown error" %}'
              }
            }
          ],
          Next: 'SaveResults'
        },
        SaveResults: {
          Type: 'Task',
          Resource: 'arn:aws:states:::dynamodb:updateItem',
          Arguments: {
            TableName: this.agentExecutionStateTable.tableName,
            Key: {
              executionId: { S: '{% $executionId %}' }
            },
            UpdateExpression: 'SET #status = :status, script = :script, #result = :result, completedAt = :completedAt, suggestedCategory = :category, suggestedDescription = :description, verified = :verified',
            ExpressionAttributeNames: {
              '#status': 'status',
              '#result': 'result'
            },
            ExpressionAttributeValues: {
              ':status': { S: 'completed' },
              ':script': { S: '{% $agentResult.script ? $agentResult.script : "" %}' },
              ':result': { S: '{% $string($agentResult) %}' },
              ':completedAt': { S: '{% $now() %}' },
              ':category': { S: '{% $agentResult.suggestedCategory ? $agentResult.suggestedCategory : "" %}' },
              ':description': { S: '{% $agentResult.suggestedDescription ? $agentResult.suggestedDescription : "" %}' },
              ':verified': { BOOL: '{% $agentResult.verified ? $agentResult.verified : false %}' }
            }
          },
          End: true
        },
        HandleFailure: {
          Type: 'Task',
          Resource: 'arn:aws:states:::dynamodb:updateItem',
          Arguments: {
            TableName: this.agentExecutionStateTable.tableName,
            Key: {
              executionId: { S: '{% $executionId %}' }
            },
            UpdateExpression: 'SET #status = :status, #error = :error, completedAt = :completedAt',
            ExpressionAttributeNames: {
              '#status': 'status',
              '#error': 'error'
            },
            ExpressionAttributeValues: {
              ':status': { S: 'failed' },
              ':error': { S: '{% $errorCause %}' },
              ':completedAt': { S: '{% $now() %}' }
            }
          },
          End: true
        }
      }
    };

    // Create the state machine
    this.scriptGenerationStateMachine = new stepfunctions.StateMachine(this, 'ScriptGenerationStateMachine', {
      stateMachineName: `${props.acronym.toLowerCase()}-script-generation`,
      definitionBody: stepfunctions.DefinitionBody.fromString(JSON.stringify(stateMachineDefinition)),
      timeout: cdk.Duration.minutes(20),
    });

    // Grant the state machine permissions to invoke the Lambda
    this.invokeAgentCoreFunction.grantInvoke(this.scriptGenerationStateMachine.role);

    // Grant the state machine permissions to update DynamoDB
    this.agentExecutionStateTable.grantReadWriteData(this.scriptGenerationStateMachine.role);

    // Explicit DynamoDB permissions for Step Functions direct integration
    (this.scriptGenerationStateMachine.role as iam.Role).addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
      ],
      resources: [this.agentExecutionStateTable.tableArn],
    }));

    // Store state machine ARN in SSM
    new ssm.StringParameter(this, 'ScriptGenerationStateMachineArnParameter', {
      parameterName: `/${props.pascalCaseName}/Agent/ScriptGenerationStateMachineArn`,
      stringValue: this.scriptGenerationStateMachine.stateMachineArn,
      description: 'ARN of the Script Generation State Machine',
    });

    // Store SSM parameters for runtime ARN discovery
    new ssm.StringParameter(this, 'AgentExecutionRoleArnParameter', {
      parameterName: `/${props.pascalCaseName}/Agent/ExecutionRoleArn`,
      stringValue: this.agentExecutionRole.roleArn,
      description: 'ARN of the Install Script Agent execution role',
    });

    new ssm.StringParameter(this, 'AgentExecutionStateTableParameter', {
      parameterName: `/${props.pascalCaseName}/Agent/ExecutionStateTableName`,
      stringValue: this.agentExecutionStateTable.tableName,
      description: 'DynamoDB table for agent execution state',
    });

    new ssm.StringParameter(this, 'AgentUsageTableParameter', {
      parameterName: `/${props.pascalCaseName}/Agent/UsageTableName`,
      stringValue: this.agentUsageTable.tableName,
      description: 'DynamoDB table for agent usage tracking',
    });

    new ssm.StringParameter(this, 'AgentProgressTableParameter', {
      parameterName: `/${props.pascalCaseName}/Agent/ProgressTableName`,
      stringValue: this.agentProgressTable.tableName,
      description: 'DynamoDB table for agent progress events',
    });

    // Cost control SSM parameters with defaults
    new ssm.StringParameter(this, 'MaxDailyGenerationsParameter', {
      parameterName: `/${props.pascalCaseName}/Agent/MaxDailyGenerations`,
      stringValue: '50',
      description: 'Maximum daily script generations (cost control)',
    });

    new ssm.StringParameter(this, 'MaxMonthlyGenerationsParameter', {
      parameterName: `/${props.pascalCaseName}/Agent/MaxMonthlyGenerations`,
      stringValue: '500',
      description: 'Maximum monthly script generations (cost control)',
    });

    new ssm.StringParameter(this, 'MaxAttemptsPerSoftwareParameter', {
      parameterName: `/${props.pascalCaseName}/Agent/MaxAttemptsPerSoftware`,
      stringValue: '3',
      description: 'Maximum iteration attempts per software',
    });

    new ssm.StringParameter(this, 'TestInstanceTimeoutParameter', {
      parameterName: `/${props.pascalCaseName}/Agent/TestInstanceTimeout`,
      stringValue: '30',
      description: 'Test instance timeout in minutes',
    });

    new ssm.StringParameter(this, 'AgentEnabledParameter', {
      parameterName: `/${props.pascalCaseName}/Agent/Enabled`,
      stringValue: 'true',
      description: 'Enable/disable the Install Script Agent',
    });

    // Outputs
    new cdk.CfnOutput(this, 'AgentExecutionRoleArn', {
      value: this.agentExecutionRole.roleArn,
      description: 'ARN of the agent execution role',
    });

    new cdk.CfnOutput(this, 'AgentExecutionStateTableName', {
      value: this.agentExecutionStateTable.tableName,
      description: 'DynamoDB table for execution state',
    });

    new cdk.CfnOutput(this, 'AgentUsageTableName', {
      value: this.agentUsageTable.tableName,
      description: 'DynamoDB table for usage tracking',
    });

    new cdk.CfnOutput(this, 'AgentProgressTableName', {
      value: this.agentProgressTable.tableName,
      description: 'DynamoDB table for progress events',
    });

    if (this.installScriptAgentRuntime) {
      new cdk.CfnOutput(this, 'InstallScriptAgentRuntimeArn', {
        value: this.installScriptAgentRuntime.runtimeArn,
        description: 'Install Script Agent AgentCore Runtime ARN',
      });
    }

    new cdk.CfnOutput(this, 'ScriptGenerationStateMachineArn', {
      value: this.scriptGenerationStateMachine.stateMachineArn,
      description: 'Script Generation State Machine ARN',
    });
  }
}
