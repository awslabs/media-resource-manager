// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as path from 'path';

interface EventBridgeStackProps extends cdk.StackProps {
  productName: string;
  pascalCaseName: string;
  acronym: string;
  workstationTable: dynamodb.Table;
  userTable: dynamodb.Table;
  dcvSessionManagerFunctionArn: string;
  imagePipelinesTable: dynamodb.Table;
  imagesTable: dynamodb.Table;
  instanceTypeCatalogTable: dynamodb.Table;
  regionalHubsTable: dynamodb.Table;
  startStateMachineArn: string;
  configGeneratorFunction?: lambda.Function;
  dataEncryptionKey?: kms.IKey;
}

export class EventBridgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EventBridgeStackProps) {
    super(scope, id, {
      ...props,
      description: "Event-driven automation for workstation monitoring and auto-shutdown policies"
    });

    // Lambda function to handle EC2 state changes
    const stateChangeHandler = new lambda.Function(this, 'StateChangeHandler', {
      functionName: `${props.acronym.toLowerCase()}-ec2-state-handler`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(2),
      reservedConcurrentExecutions: 15,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
        DCV_SESSION_MANAGER_FUNCTION_ARN: props.dcvSessionManagerFunctionArn,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/ec2-state-handler')),
    });

    // Grant DynamoDB permissions
    props.workstationTable.grantReadWriteData(stateChangeHandler);
    
    // Grant KMS permissions if tables use customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(stateChangeHandler);
    }
    
    // Grant permission to invoke DCV session manager
    stateChangeHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [props.dcvSessionManagerFunctionArn],
    }));

    // EventBridge rule for EC2 state changes
    const ec2StateChangeRule = new events.Rule(this, 'EC2StateChangeRule', {
      ruleName: `${props.acronym.toLowerCase()}-ec2-state-change`,
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['EC2 Instance State-change Notification'],
        detail: {
          state: ['pending', 'running', 'shutting-down', 'terminated', 'stopping', 'stopped']
        }
      },
    });

    // Add Lambda as target
    ec2StateChangeRule.addTarget(new targets.LambdaFunction(stateChangeHandler));

    // EventBridge rule for EC2 instance type changes via CloudTrail
    // Fires when ModifyInstanceAttribute is called with an instanceType parameter,
    // whether from the EC2 console, CLI, or SDK — keeping DynamoDB in sync.
    // Requires CloudTrail to be enabled in the account (management events).
    const ec2InstanceTypeChangeRule = new events.Rule(this, 'EC2InstanceTypeChangeRule', {
      ruleName: `${props.acronym.toLowerCase()}-ec2-instance-type-change`,
      description: 'Syncs instance type changes made outside MRM back to DynamoDB',
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['ec2.amazonaws.com'],
          eventName: ['ModifyInstanceAttribute'],
          requestParameters: {
            instanceType: { exists: [true] }
          }
        }
      },
    });

    ec2InstanceTypeChangeRule.addTarget(new targets.LambdaFunction(stateChangeHandler, {
      retryAttempts: 2,
    }));

    // Auto-shutdown Lambda function
    const autoShutdownHandler = new lambda.Function(this, 'AutoShutdownHandler', {
      functionName: `${props.acronym.toLowerCase()}-auto-shutdown`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
        PASCAL_CASE_NAME: props.pascalCaseName,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/auto-shutdown')),
      timeout: cdk.Duration.minutes(5),
    });

    // Grant permissions for auto-shutdown function
    props.workstationTable.grantReadData(autoShutdownHandler);
    
    // Grant KMS permissions if tables use customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantDecrypt(autoShutdownHandler);
    }
    
    autoShutdownHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ec2:StopInstances'],
      resources: ['*'],
    }));
    
    autoShutdownHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/DCV/*`,
      ],
    }));

    // EventBridge rule for auto-shutdown (every 5 minutes)
    const autoShutdownRule = new events.Rule(this, 'AutoShutdownRule', {
      ruleName: `${props.acronym.toLowerCase()}-auto-shutdown`,
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      description: 'Auto-shutdown disconnected workstations every 5 minutes',
    });

    // Add Lambda as target
    autoShutdownRule.addTarget(new targets.LambdaFunction(autoShutdownHandler));

    // Auto-start Lambda function
    const autoStartHandler = new lambda.Function(this, 'AutoStartHandler', {
      functionName: `${props.acronym.toLowerCase()}-auto-start`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        USER_TABLE_NAME: props.userTable.tableName,
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
        PASCAL_CASE_NAME: props.pascalCaseName,
        START_STATE_MACHINE_ARN: props.startStateMachineArn,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/auto-start')),
      timeout: cdk.Duration.minutes(5),
    });

    // Grant permissions for auto-start function
    props.userTable.grantReadData(autoStartHandler);
    props.workstationTable.grantReadData(autoStartHandler);
    
    // Grant KMS permissions if tables use customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantDecrypt(autoStartHandler);
    }
    
    // Grant permission to read SSM parameters
    autoStartHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/Settings/*`,
      ],
    }));
    
    // Grant permission to start Step Functions execution
    autoStartHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['states:StartExecution'],
      resources: [props.startStateMachineArn],
    }));

    // EventBridge rule for auto-start (every 5 minutes)
    const autoStartRule = new events.Rule(this, 'AutoStartRule', {
      ruleName: `${props.acronym.toLowerCase()}-auto-start`,
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      description: 'Auto-start workstations based on user schedules every 5 minutes',
    });

    // Add Lambda as target
    autoStartRule.addTarget(new targets.LambdaFunction(autoStartHandler));

    // ImageBuilder event handler
    const imageBuilderHandler = new lambda.Function(this, 'ImageBuilderHandler', {
      functionName: `${props.acronym.toLowerCase()}-imagebuilder-event-handler`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/imagebuilder-event-handler'),
      timeout: cdk.Duration.minutes(2),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PIPELINES_TABLE_NAME: props.imagePipelinesTable.tableName,
        IMAGES_TABLE_NAME: props.imagesTable.tableName,
        PASCAL_CASE_NAME: props.pascalCaseName,
        ACRONYM: props.acronym,
        REGIONAL_HUBS_TABLE_NAME: `${props.acronym.toLowerCase()}-regional-hubs`,
      },
    });

    props.imagePipelinesTable.grantReadWriteData(imageBuilderHandler);
    props.imagesTable.grantWriteData(imageBuilderHandler);

    // Grant read access to regional hubs table for multi-region AMI distribution
    imageBuilderHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:Scan', 'dynamodb:GetItem'],
      resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.acronym.toLowerCase()}-regional-hubs`],
    }));

    // Grant License Manager permissions for associating license configs with distributed macOS AMIs
    // This needs to work across all regions where AMIs are distributed
    imageBuilderHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'license-manager:UpdateLicenseSpecificationsForResource',
        'license-manager:ListLicenseSpecificationsForResource'
      ],
      resources: ['*'],
    }));

    // Grant KMS permissions if tables use customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(imageBuilderHandler);
    }

    // Grant ImageBuilder permissions for retry logic
    imageBuilderHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'imagebuilder:GetImage',
        'imagebuilder:GetInfrastructureConfiguration',
        'imagebuilder:UpdateInfrastructureConfiguration',
        'imagebuilder:StartImagePipelineExecution'
      ],
      resources: ['*'],
    }));

    // Grant EC2 permissions to find alternative subnets
    imageBuilderHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ec2:DescribeSubnets'],
      resources: ['*'],
    }));

    // Grant SSM permissions to read subnet parameters
    imageBuilderHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/Network/*`,
      ],
    }));

    // Grant IAM PassRole permission for Image Builder service role
    imageBuilderHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [
        `arn:aws:iam::${this.account}:role/MediaResourceManager-ImageBuilder-ServiceRole`,
        `arn:aws:iam::${this.account}:role/*ImageBuilder*`,
      ],
    }));

    // EventBridge rule for ImageBuilder state changes
    const imageBuilderRule = new events.Rule(this, 'ImageBuilderRule', {
      ruleName: `${props.acronym.toLowerCase()}-imagebuilder-state-change`,
      eventPattern: {
        source: ['aws.imagebuilder'],
        detailType: [
          'EC2 Image Builder Image State Change',
          'EC2 Image Builder Image Pipeline Execution State Change'
        ],
        detail: {
          state: {
            status: ['AVAILABLE', 'FAILED']
          }
        }
      },
    });

    imageBuilderRule.addTarget(new targets.LambdaFunction(imageBuilderHandler));

    // Config Generator trigger for auth mode changes
    if (props.configGeneratorFunction) {
      const configUpdateRule = new events.Rule(this, 'ConfigUpdateRule', {
        ruleName: `${props.acronym.toLowerCase()}-config-update`,
        eventPattern: {
          source: ['aws.ssm'],
          detailType: ['Parameter Store Change'],
          detail: {
            name: [`/${props.pascalCaseName}/Auth/UseCognitoAuth`],
            operation: ['Create', 'Update']
          }
        }
      });

      configUpdateRule.addTarget(new targets.LambdaFunction(props.configGeneratorFunction));
    }

    // Outputs
    new cdk.CfnOutput(this, 'StateChangeHandlerArn', {
      value: stateChangeHandler.functionArn,
      description: 'EC2 State Change Handler Lambda ARN',
    });
    
    new cdk.CfnOutput(this, 'AutoShutdownHandlerArn', {
      value: autoShutdownHandler.functionArn,
      description: 'Auto-Shutdown Handler Lambda ARN',
    });

    new cdk.CfnOutput(this, 'AutoStartHandlerArn', {
      value: autoStartHandler.functionArn,
      description: 'Auto-Start Handler Lambda ARN',
    });

    new cdk.CfnOutput(this, 'ImageBuilderHandlerArn', {
      value: imageBuilderHandler.functionArn,
      description: 'ImageBuilder Event Handler Lambda ARN',
    });

    // Instance Type Catalog Sync Lambda
    const instanceTypeCatalogSync = new lambda.Function(this, 'InstanceTypeCatalogSync', {
      functionName: `${props.acronym.toLowerCase()}-instance-type-catalog-sync`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/instance-type-catalog')),
      timeout: cdk.Duration.minutes(10),
      reservedConcurrentExecutions: 1,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        CATALOG_TABLE_NAME: props.instanceTypeCatalogTable.tableName,
        REGIONAL_HUBS_TABLE_NAME: props.regionalHubsTable.tableName,
      },
    });

    // Grant DynamoDB permissions
    props.instanceTypeCatalogTable.grantReadWriteData(instanceTypeCatalogSync);
    props.regionalHubsTable.grantReadData(instanceTypeCatalogSync);

    // Grant KMS permissions if tables use customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(instanceTypeCatalogSync);
    }

    // Grant EC2 DescribeInstanceTypes permission for all regions
    instanceTypeCatalogSync.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ec2:DescribeInstanceTypes'],
      resources: ['*'],
    }));

    // EventBridge rule to sync instance types daily
    const instanceTypeSyncRule = new events.Rule(this, 'InstanceTypeSyncRule', {
      ruleName: `${props.acronym.toLowerCase()}-instance-type-sync`,
      schedule: events.Schedule.rate(cdk.Duration.days(1)),
      description: 'Sync EC2 instance type catalog daily',
    });

    instanceTypeSyncRule.addTarget(new targets.LambdaFunction(instanceTypeCatalogSync));

    // Trigger initial sync on deploy so the catalog is populated immediately
    const initialSync = new cr.AwsCustomResource(this, 'InstanceTypeCatalogInitialSync', {
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: instanceTypeCatalogSync.functionName,
          InvocationType: 'Event', // async — don't block the deploy
        },
        physicalResourceId: cr.PhysicalResourceId.of('instance-type-catalog-initial-sync'),
      },
      onUpdate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: instanceTypeCatalogSync.functionName,
          InvocationType: 'Event',
        },
        physicalResourceId: cr.PhysicalResourceId.of('instance-type-catalog-initial-sync'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [instanceTypeCatalogSync.functionArn],
        }),
      ]),
    });

    new cdk.CfnOutput(this, 'InstanceTypeCatalogSyncArn', {
      value: instanceTypeCatalogSync.functionArn,
      description: 'Instance Type Catalog Sync Lambda ARN',
    });
  }
}
