// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as path from 'path';
import { Construct } from 'constructs';

interface RegionalHubStackProps extends cdk.StackProps {
  regionalHubsTable: dynamodb.Table;
  amiTable: dynamodb.Table;
  workstationTable: dynamodb.Table;
  pascalCaseName: string;
  acronym: string;
  dataEncryptionKey?: kms.IKey;
}

export class RegionalHubStack extends cdk.Stack {
  public readonly creationStateMachine: stepfunctions.StateMachine;
  public readonly deletionStateMachine: stepfunctions.StateMachine;
  public readonly generateTemplateFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: RegionalHubStackProps) {
    super(scope, id, {
      ...props,
      description: "Regional hub infrastructure with state machines for cross-region CloudFormation deployment"
    });

    // S3 bucket for CloudFormation templates (large templates need S3)
    const templateBucket = new s3.Bucket(this, 'RegionalHubTemplateBucket', {
      bucketName: `${props.acronym.toLowerCase()}-regional-hub-templates-${this.account}-${this.region}`,
      encryption: props.dataEncryptionKey 
        ? s3.BucketEncryption.KMS 
        : s3.BucketEncryption.S3_MANAGED,
      encryptionKey: props.dataEncryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: 'DeleteOldTemplates',
          expiration: cdk.Duration.days(90),
          noncurrentVersionExpiration: cdk.Duration.days(30),
        }
      ],
    });

    // Create S3 assets for Lambda code that needs to be deployed to regional hubs
    // These Lambdas need to run in the regional hub VPC to access the DCV Session Manager API
    // or FSx ONTAP management endpoints
    const regionalLambdaAssets: { [key: string]: s3assets.Asset } = {};
    const regionalLambdaNames = [
      'dcv-session-manager',
      'dcv-readiness-check-windows',
      'dcv-readiness-check-linux',
      'dcv-readiness-check-macos',
      'dcv-session-cleanup',
      'configure-ontap-cifs',
    ];

    for (const lambdaName of regionalLambdaNames) {
      regionalLambdaAssets[lambdaName] = new s3assets.Asset(this, `RegionalLambdaAsset-${lambdaName}`, {
        path: path.join(__dirname, `../lambda/${lambdaName}`),
      });
    }

    // Build environment variables for Lambda asset locations
    // Format: LAMBDA_ASSET_<NAME>_BUCKET and LAMBDA_ASSET_<NAME>_KEY
    const lambdaAssetEnvVars: { [key: string]: string } = {};
    for (const lambdaName of regionalLambdaNames) {
      const envKey = lambdaName.toUpperCase().replace(/-/g, '_');
      lambdaAssetEnvVars[`LAMBDA_ASSET_${envKey}_BUCKET`] = regionalLambdaAssets[lambdaName].s3BucketName;
      lambdaAssetEnvVars[`LAMBDA_ASSET_${envKey}_KEY`] = regionalLambdaAssets[lambdaName].s3ObjectKey;
    }

    // Generate Regional Hub Template Function
    this.generateTemplateFunction = new lambda.Function(this, 'GenerateRegionalHubTemplateFunction', {
      functionName: `${props.acronym.toLowerCase()}-generate-regional-hub-template`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/generate-regional-hub-template'),
      description: 'Generate CloudFormation template for regional hub infrastructure',
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PRODUCT_NAME: props.pascalCaseName,
        ACRONYM: props.acronym,
        TEMPLATE_BUCKET_NAME: templateBucket.bucketName,
        PRIMARY_REGION: this.region,
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
        ...(props.dataEncryptionKey && { DYNAMODB_KMS_KEY_ARN: props.dataEncryptionKey.keyArn }),
        ...lambdaAssetEnvVars,
      },
    });

    // Grant S3 permissions to template generator
    templateBucket.grantReadWrite(this.generateTemplateFunction);

    // Grant permissions to read from CDK asset buckets (source Lambda code)
    for (const lambdaName of regionalLambdaNames) {
      regionalLambdaAssets[lambdaName].grantRead(this.generateTemplateFunction);
    }

    // Grant permissions to create and write to regional Lambda asset buckets
    // These buckets are created dynamically in target regions
    this.generateTemplateFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:CreateBucket',
        's3:PutEncryptionConfiguration',
        's3:PutBucketPublicAccessBlock',
        's3:PutObject',
        's3:GetObject',
        's3:HeadBucket',
        's3:ListBucket'
      ],
      resources: [
        `arn:aws:s3:::${props.acronym.toLowerCase()}-lambda-assets-${this.account}-*`,
        `arn:aws:s3:::${props.acronym.toLowerCase()}-lambda-assets-${this.account}-*/*`
      ]
    }));

    // Grant SSM permissions to read primary region config
    this.generateTemplateFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters'
      ],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/*`]
    }));

    // ===========================================
    // CROSS-REGION LAMBDA FUNCTIONS
    // ===========================================

    // CloudFormation Service Role for creating regional hub stacks
    // This role is assumed by CloudFormation to create resources in target regions
    const cfnServiceRole = new iam.Role(this, 'RegionalHubCfnServiceRole', {
      roleName: `${props.pascalCaseName}-RegionalHub-CFN-Role`,
      assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
      description: 'Role assumed by CloudFormation to create regional hub infrastructure',
    });

    // TODO: Lock down permissions after regional hub deployment is working
    // For now, grant admin access to bypass permission issues during development
    cfnServiceRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'));

    // Lambda to create CloudFormation stack in target region (used by state machine)
    const createRegionalHubCfnFunction = new lambda.Function(this, 'CreateRegionalHubCfnFunction', {
      functionName: `${props.acronym.toLowerCase()}-create-regional-hub-cfn`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/create-regional-hub-cfn'),
      description: 'Creates CloudFormation stack in target region for regional hub',
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PRODUCT_NAME: props.pascalCaseName,
        CFN_SERVICE_ROLE_ARN: cfnServiceRole.roleArn,
      },
    });

    // Lambda to update CloudFormation stack in target region (used by API)
    const updateRegionalHubCfnFunction = new lambda.Function(this, 'UpdateRegionalHubCfnFunction', {
      functionName: `${props.acronym.toLowerCase()}-update-regional-hub-cfn`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/update-regional-hub-cfn'),
      description: 'Updates CloudFormation stack in target region for regional hub',
      timeout: cdk.Duration.seconds(120),
      memorySize: 256,
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PRODUCT_NAME: props.pascalCaseName,
        ACRONYM: props.acronym,
        CFN_SERVICE_ROLE_ARN: cfnServiceRole.roleArn,
        REGIONAL_HUBS_TABLE_NAME: props.regionalHubsTable.tableName,
      },
    });

    // Grant DynamoDB permissions to update function
    props.regionalHubsTable.grantReadWriteData(updateRegionalHubCfnFunction);

    // Lambda to check CloudFormation stack status in target region (used by state machine)
    const checkRegionalHubCfnStatusFunction = new lambda.Function(this, 'CheckRegionalHubCfnStatusFunction', {
      functionName: `${props.acronym.toLowerCase()}-check-regional-hub-cfn-status`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/check-regional-hub-cfn-status'),
      description: 'Checks CloudFormation stack status in target region',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      reservedConcurrentExecutions: 10,
      environmentEncryption: props.dataEncryptionKey,
    });

    // Lambda to delete CloudFormation stack in target region (used by state machine)
    const deleteRegionalHubCfnFunction = new lambda.Function(this, 'DeleteRegionalHubCfnFunction', {
      functionName: `${props.acronym.toLowerCase()}-delete-regional-hub-cfn`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/delete-regional-hub-cfn'),
      description: 'Deletes CloudFormation stack in target region',
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
    });

    // Grant cross-region CloudFormation permissions to the Lambda functions
    const cfnCrossRegionPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudformation:CreateStack',
        'cloudformation:UpdateStack',
        'cloudformation:DeleteStack',
        'cloudformation:DescribeStacks',
        'cloudformation:DescribeStackEvents'
      ],
      resources: ['*'] // Cross-region stacks require wildcard
    });

    createRegionalHubCfnFunction.addToRolePolicy(cfnCrossRegionPolicy);
    updateRegionalHubCfnFunction.addToRolePolicy(cfnCrossRegionPolicy);
    checkRegionalHubCfnStatusFunction.addToRolePolicy(cfnCrossRegionPolicy);
    deleteRegionalHubCfnFunction.addToRolePolicy(cfnCrossRegionPolicy);

    // Grant Lambda permission to pass the CFN service role
    createRegionalHubCfnFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [cfnServiceRole.roleArn],
    }));

    updateRegionalHubCfnFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [cfnServiceRole.roleArn],
    }));

    // Grant S3 read permissions for template access (cross-region)
    templateBucket.grantRead(createRegionalHubCfnFunction);
    templateBucket.grantRead(updateRegionalHubCfnFunction);

    // ===========================================
    // REGIONAL HUB CREATION STATE MACHINE
    // ===========================================

    const creationStateMachineDefinition = {
      Comment: "Regional Hub Creation State Machine - Deploys DCV infrastructure to satellite regions",
      StartAt: "UpdateStatusToValidating",
      States: {
        UpdateStatusToValidating: {
          Type: "Task",
          Resource: "arn:aws:states:::dynamodb:updateItem",
          Parameters: {
            TableName: props.regionalHubsTable.tableName,
            Key: {
              region: { "S.$": "$.region" }
            },
            UpdateExpression: "SET #status = :status, #updatedAt = :updatedAt",
            ExpressionAttributeNames: {
              "#status": "status",
              "#updatedAt": "updatedAt"
            },
            ExpressionAttributeValues: {
              ":status": { S: "validating" },
              ":updatedAt": { "S.$": "$$.State.EnteredTime" }
            }
          },
          ResultPath: null,
          Next: "GenerateCloudFormationTemplate",
          Retry: [
            {
              ErrorEquals: ["States.ALL"],
              IntervalSeconds: 2,
              MaxAttempts: 3,
              BackoffRate: 2.0
            }
          ]
        },
        GenerateCloudFormationTemplate: {
          Type: "Task",
          Resource: this.generateTemplateFunction.functionArn,
          ResultPath: "$.templateData",
          Next: "UpdateStatusToCreating",
          Retry: [
            {
              ErrorEquals: ["States.ALL"],
              IntervalSeconds: 5,
              MaxAttempts: 3,
              BackoffRate: 2.0
            }
          ],
          Catch: [
            {
              ErrorEquals: ["States.ALL"],
              Next: "PrepareFailureFromError",
              ResultPath: "$.error"
            }
          ]
        },
        UpdateStatusToCreating: {
          Type: "Task",
          Resource: "arn:aws:states:::dynamodb:updateItem",
          Parameters: {
            TableName: props.regionalHubsTable.tableName,
            Key: {
              region: { "S.$": "$.region" }
            },
            UpdateExpression: "SET #status = :status, #updatedAt = :updatedAt, cloudFormationStackName = :stackName",
            ExpressionAttributeNames: {
              "#status": "status",
              "#updatedAt": "updatedAt"
            },
            ExpressionAttributeValues: {
              ":status": { S: "creating" },
              ":updatedAt": { "S.$": "$$.State.EnteredTime" },
              ":stackName": { "S.$": "$.templateData.stackName" }
            }
          },
          ResultPath: null,
          Next: "CreateCloudFormationStack",
          Retry: [
            {
              ErrorEquals: ["States.ALL"],
              IntervalSeconds: 2,
              MaxAttempts: 3,
              BackoffRate: 2.0
            }
          ]
        },
        CreateCloudFormationStack: {
          Type: "Task",
          Resource: createRegionalHubCfnFunction.functionArn,
          Parameters: {
            "region.$": "$.region",
            "stackName.$": "$.templateData.stackName",
            "templateUrl.$": "$.templateData.templateUrl",
            "parameters.$": "$.templateData.parameters"
          },
          ResultPath: "$.stackResult",
          Next: "WaitForStackCreation",
          Retry: [
            {
              ErrorEquals: ["States.ALL"],
              IntervalSeconds: 30,
              MaxAttempts: 3,
              BackoffRate: 2.0
            }
          ],
          Catch: [
            {
              ErrorEquals: ["States.ALL"],
              Next: "PrepareFailureFromError",
              ResultPath: "$.error"
            }
          ]
        },
        WaitForStackCreation: {
          Type: "Wait",
          Seconds: 60,
          Next: "CheckStackStatus"
        },
        CheckStackStatus: {
          Type: "Task",
          Resource: checkRegionalHubCfnStatusFunction.functionArn,
          Parameters: {
            "region.$": "$.region",
            "stackName.$": "$.templateData.stackName"
          },
          ResultPath: "$.stackStatus",
          Next: "EvaluateStackStatus",
          Retry: [
            {
              ErrorEquals: ["States.ALL"],
              IntervalSeconds: 10,
              MaxAttempts: 3,
              BackoffRate: 2.0
            }
          ]
        },
        EvaluateStackStatus: {
          Type: "Choice",
          Choices: [
            {
              Variable: "$.stackStatus.status",
              StringEquals: "CREATE_COMPLETE",
              Next: "ExtractStackOutputs"
            },
            {
              Variable: "$.stackStatus.status",
              StringMatches: "*_FAILED",
              Next: "PrepareFailureFromStack"
            },
            {
              Variable: "$.stackStatus.status",
              StringEquals: "ROLLBACK_COMPLETE",
              Next: "PrepareFailureFromStack"
            },
            {
              Variable: "$.stackStatus.status",
              StringMatches: "*_IN_PROGRESS",
              Next: "WaitForStackCreation"
            }
          ],
          Default: "PrepareFailureFromStack"
        },
        ExtractStackOutputs: {
          Type: "Pass",
          Parameters: {
            "region.$": "$.region",
            "templateData.$": "$.templateData",
            "outputs.$": "$.stackStatus.outputs"
          },
          Next: "CheckMacOSOutputs"
        },
        CheckMacOSOutputs: {
          Type: "Choice",
          Choices: [
            {
              Variable: "$.outputs.HostResourceGroupArn",
              IsPresent: true,
              Next: "UpdateStatusWithMacOS"
            }
          ],
          Default: "UpdateStatusToAvailable"
        },
        UpdateStatusWithMacOS: {
          Type: "Task",
          Resource: "arn:aws:states:::dynamodb:updateItem",
          Parameters: {
            TableName: props.regionalHubsTable.tableName,
            Key: {
              region: { "S.$": "$.region" }
            },
            UpdateExpression: "SET #status = :status, #updatedAt = :updatedAt, vpcId = :vpcId, connectionGatewayEndpoint = :cgEndpoint, workstationSecurityGroupId = :sgId, sessionManagerEndpoint = :smEndpoint, privateSubnet1Id = :ps1Id, privateSubnet2Id = :ps2Id, subnetIds = :subnetIds, launchTemplateId = :ltId, hostResourceGroupArn = :hrgArn, licenseConfigurationArn = :licArn, instanceProfileName = :ipName",
            ExpressionAttributeNames: {
              "#status": "status",
              "#updatedAt": "updatedAt"
            },
            ExpressionAttributeValues: {
              ":status": { S: "available" },
              ":updatedAt": { "S.$": "$$.State.EnteredTime" },
              ":vpcId": { "S.$": "$.outputs.VpcId" },
              ":cgEndpoint": { "S.$": "$.outputs.ConnectionGatewayEndpoint" },
              ":sgId": { "S.$": "$.outputs.WorkstationSecurityGroupId" },
              ":smEndpoint": { "S.$": "$.outputs.SessionManagerEndpoint" },
              ":ps1Id": { "S.$": "$.outputs.PrivateSubnet1Id" },
              ":ps2Id": { "S.$": "$.outputs.PrivateSubnet2Id" },
              ":subnetIds": { "S.$": "$.outputs.PrivateSubnetIds" },
              ":ltId": { "S.$": "$.outputs.LaunchTemplateId" },
              ":hrgArn": { "S.$": "$.outputs.HostResourceGroupArn" },
              ":licArn": { "S.$": "$.outputs.LicenseConfigurationArn" },
              ":ipName": { "S.$": "$.outputs.WorkstationInstanceProfileName" }
            }
          },
          End: true,
          Retry: [
            {
              ErrorEquals: ["States.ALL"],
              IntervalSeconds: 2,
              MaxAttempts: 3,
              BackoffRate: 2.0
            }
          ]
        },
        UpdateStatusToAvailable: {
          Type: "Task",
          Resource: "arn:aws:states:::dynamodb:updateItem",
          Parameters: {
            TableName: props.regionalHubsTable.tableName,
            Key: {
              region: { "S.$": "$.region" }
            },
            UpdateExpression: "SET #status = :status, #updatedAt = :updatedAt, vpcId = :vpcId, connectionGatewayEndpoint = :cgEndpoint, workstationSecurityGroupId = :sgId, sessionManagerEndpoint = :smEndpoint, privateSubnet1Id = :ps1Id, privateSubnet2Id = :ps2Id, subnetIds = :subnetIds, launchTemplateId = :ltId, instanceProfileName = :ipName",
            ExpressionAttributeNames: {
              "#status": "status",
              "#updatedAt": "updatedAt"
            },
            ExpressionAttributeValues: {
              ":status": { S: "available" },
              ":updatedAt": { "S.$": "$$.State.EnteredTime" },
              ":vpcId": { "S.$": "$.outputs.VpcId" },
              ":cgEndpoint": { "S.$": "$.outputs.ConnectionGatewayEndpoint" },
              ":sgId": { "S.$": "$.outputs.WorkstationSecurityGroupId" },
              ":smEndpoint": { "S.$": "$.outputs.SessionManagerEndpoint" },
              ":ps1Id": { "S.$": "$.outputs.PrivateSubnet1Id" },
              ":ps2Id": { "S.$": "$.outputs.PrivateSubnet2Id" },
              ":subnetIds": { "S.$": "$.outputs.PrivateSubnetIds" },
              ":ltId": { "S.$": "$.outputs.LaunchTemplateId" },
              ":ipName": { "S.$": "$.outputs.WorkstationInstanceProfileName" }
            }
          },
          End: true,
          Retry: [
            {
              ErrorEquals: ["States.ALL"],
              IntervalSeconds: 2,
              MaxAttempts: 3,
              BackoffRate: 2.0
            }
          ]
        },
        PrepareFailureFromStack: {
          Type: "Pass",
          Parameters: {
            "region.$": "$.region",
            "templateData.$": "$.templateData",
            "errorMessage.$": "States.Format('CloudFormation stack failed with status: {}', $.stackStatus.status)"
          },
          Next: "UpdateStatusToFailed"
        },
        PrepareFailureFromError: {
          Type: "Pass",
          Parameters: {
            "region.$": "$.region",
            "templateData.$": "$.templateData",
            "errorMessage.$": "States.Format('Error: {}', $.error.Cause)"
          },
          Next: "UpdateStatusToFailed"
        },
        UpdateStatusToFailed: {
          Type: "Task",
          Resource: "arn:aws:states:::dynamodb:updateItem",
          Parameters: {
            TableName: props.regionalHubsTable.tableName,
            Key: {
              region: { "S.$": "$.region" }
            },
            UpdateExpression: "SET #status = :status, #updatedAt = :updatedAt, errorMessage = :error",
            ExpressionAttributeNames: {
              "#status": "status",
              "#updatedAt": "updatedAt"
            },
            ExpressionAttributeValues: {
              ":status": { S: "failed" },
              ":updatedAt": { "S.$": "$$.State.EnteredTime" },
              ":error": { "S.$": "$.errorMessage" }
            }
          },
          End: true,
          Retry: [
            {
              ErrorEquals: ["States.ALL"],
              IntervalSeconds: 2,
              MaxAttempts: 3,
              BackoffRate: 2.0
            }
          ]
        }
      }
    };

    this.creationStateMachine = new stepfunctions.StateMachine(this, 'RegionalHubCreationStateMachine', {
      stateMachineName: `${props.acronym.toLowerCase()}-regional-hub-creation`,
      definitionBody: stepfunctions.DefinitionBody.fromString(JSON.stringify(creationStateMachineDefinition)),
      timeout: cdk.Duration.hours(2),
    });


    // ===========================================
    // REGIONAL HUB DELETION STATE MACHINE
    // ===========================================

    const deletionStateMachineDefinition = {
      Comment: "Regional Hub Deletion State Machine - Removes DCV infrastructure from satellite regions",
      StartAt: "UpdateStatusToDeleting",
      States: {
        UpdateStatusToDeleting: {
          Type: "Task",
          Resource: "arn:aws:states:::dynamodb:updateItem",
          Parameters: {
            TableName: props.regionalHubsTable.tableName,
            Key: {
              region: { "S.$": "$.region" }
            },
            UpdateExpression: "SET #status = :status, #updatedAt = :updatedAt",
            ExpressionAttributeNames: {
              "#status": "status",
              "#updatedAt": "updatedAt"
            },
            ExpressionAttributeValues: {
              ":status": { S: "deleting" },
              ":updatedAt": { "S.$": "$$.State.EnteredTime" }
            }
          },
          ResultPath: null,
          Next: "DeleteCloudFormationStack",
          Retry: [
            {
              ErrorEquals: ["States.ALL"],
              IntervalSeconds: 2,
              MaxAttempts: 3,
              BackoffRate: 2.0
            }
          ]
        },
        DeleteCloudFormationStack: {
          Type: "Task",
          Resource: deleteRegionalHubCfnFunction.functionArn,
          Parameters: {
            "region.$": "$.region",
            "stackName.$": "$.cloudFormationStackName"
          },
          ResultPath: "$.deleteResult",
          Next: "WaitForStackDeletion",
          Retry: [
            {
              ErrorEquals: ["States.ALL"],
              IntervalSeconds: 30,
              MaxAttempts: 3,
              BackoffRate: 2.0
            }
          ],
          Catch: [
            {
              ErrorEquals: ["States.ALL"],
              Next: "UpdateStatusToDeleteFailed",
              ResultPath: "$.error"
            }
          ]
        },
        WaitForStackDeletion: {
          Type: "Wait",
          Seconds: 60,
          Next: "CheckStackDeletionStatus"
        },
        CheckStackDeletionStatus: {
          Type: "Task",
          Resource: checkRegionalHubCfnStatusFunction.functionArn,
          Parameters: {
            "region.$": "$.region",
            "stackName.$": "$.cloudFormationStackName"
          },
          ResultPath: "$.stackStatus",
          Next: "EvaluateStackDeletionStatus",
          Retry: [
            {
              ErrorEquals: ["States.ALL"],
              IntervalSeconds: 10,
              MaxAttempts: 3,
              BackoffRate: 2.0
            }
          ],
          Catch: [
            {
              // Stack not found means deletion complete
              ErrorEquals: ["States.ALL"],
              Next: "DeleteDynamoDBRecord",
              ResultPath: null
            }
          ]
        },
        EvaluateStackDeletionStatus: {
          Type: "Choice",
          Choices: [
            {
              Variable: "$.stackStatus.status",
              StringEquals: "DELETE_COMPLETE",
              Next: "DeleteDynamoDBRecord"
            },
            {
              Variable: "$.stackStatus.status",
              StringEquals: "DELETED",
              Next: "DeleteDynamoDBRecord"
            },
            {
              Variable: "$.stackStatus.status",
              StringMatches: "*_FAILED",
              Next: "UpdateStatusToDeleteFailed"
            },
            {
              Variable: "$.stackStatus.status",
              StringMatches: "*_IN_PROGRESS",
              Next: "WaitForStackDeletion"
            }
          ],
          Default: "UpdateStatusToDeleteFailed"
        },
        DeleteDynamoDBRecord: {
          Type: "Task",
          Resource: "arn:aws:states:::dynamodb:deleteItem",
          Parameters: {
            TableName: props.regionalHubsTable.tableName,
            Key: {
              region: { "S.$": "$.region" }
            }
          },
          End: true,
          Retry: [
            {
              ErrorEquals: ["States.ALL"],
              IntervalSeconds: 2,
              MaxAttempts: 3,
              BackoffRate: 2.0
            }
          ]
        },
        UpdateStatusToDeleteFailed: {
          Type: "Task",
          Resource: "arn:aws:states:::dynamodb:updateItem",
          Parameters: {
            TableName: props.regionalHubsTable.tableName,
            Key: {
              region: { "S.$": "$.region" }
            },
            UpdateExpression: "SET #status = :status, #updatedAt = :updatedAt, errorMessage = :error",
            ExpressionAttributeNames: {
              "#status": "status",
              "#updatedAt": "updatedAt"
            },
            ExpressionAttributeValues: {
              ":status": { S: "delete-failed" },
              ":updatedAt": { "S.$": "$$.State.EnteredTime" },
              ":error": { "S.$": "States.Format('Stack deletion failed: {}', $.error.Cause)" }
            }
          },
          End: true,
          Retry: [
            {
              ErrorEquals: ["States.ALL"],
              IntervalSeconds: 2,
              MaxAttempts: 3,
              BackoffRate: 2.0
            }
          ]
        }
      }
    };

    this.deletionStateMachine = new stepfunctions.StateMachine(this, 'RegionalHubDeletionStateMachine', {
      stateMachineName: `${props.acronym.toLowerCase()}-regional-hub-deletion`,
      definitionBody: stepfunctions.DefinitionBody.fromString(JSON.stringify(deletionStateMachineDefinition)),
      timeout: cdk.Duration.hours(1),
    });

    // ===========================================
    // IAM PERMISSIONS FOR STATE MACHINES
    // ===========================================

    // Creation State Machine Permissions
    this.creationStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:UpdateItem'],
      resources: [props.regionalHubsTable.tableArn]
    }));

    this.creationStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [
        this.generateTemplateFunction.functionArn,
        createRegionalHubCfnFunction.functionArn,
        checkRegionalHubCfnStatusFunction.functionArn
      ]
    }));

    // Cross-region CloudFormation permissions
    this.creationStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudformation:CreateStack',
        'cloudformation:DescribeStacks',
        'cloudformation:DescribeStackEvents'
      ],
      resources: ['*'] // Cross-region stacks
    }));

    // S3 permissions for template access
    this.creationStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: [`${templateBucket.bucketArn}/*`]
    }));

    // IAM permissions for CloudFormation to create resources
    this.creationStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'iam:CreateRole',
        'iam:DeleteRole',
        'iam:AttachRolePolicy',
        'iam:DetachRolePolicy',
        'iam:PutRolePolicy',
        'iam:DeleteRolePolicy',
        'iam:GetRole',
        'iam:PassRole',
        'iam:CreateInstanceProfile',
        'iam:DeleteInstanceProfile',
        'iam:AddRoleToInstanceProfile',
        'iam:RemoveRoleFromInstanceProfile',
        'iam:GetInstanceProfile'
      ],
      resources: ['*']
    }));

    // EC2 permissions for VPC and networking resources
    this.creationStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:CreateVpc',
        'ec2:DeleteVpc',
        'ec2:CreateSubnet',
        'ec2:DeleteSubnet',
        'ec2:CreateInternetGateway',
        'ec2:DeleteInternetGateway',
        'ec2:AttachInternetGateway',
        'ec2:DetachInternetGateway',
        'ec2:CreateNatGateway',
        'ec2:DeleteNatGateway',
        'ec2:CreateRouteTable',
        'ec2:DeleteRouteTable',
        'ec2:CreateRoute',
        'ec2:DeleteRoute',
        'ec2:AssociateRouteTable',
        'ec2:DisassociateRouteTable',
        'ec2:CreateSecurityGroup',
        'ec2:DeleteSecurityGroup',
        'ec2:AuthorizeSecurityGroupIngress',
        'ec2:AuthorizeSecurityGroupEgress',
        'ec2:RevokeSecurityGroupIngress',
        'ec2:RevokeSecurityGroupEgress',
        'ec2:CreateLaunchTemplate',
        'ec2:DeleteLaunchTemplate',
        'ec2:AllocateAddress',
        'ec2:ReleaseAddress',
        'ec2:CreateTags',
        'ec2:DescribeVpcs',
        'ec2:DescribeSubnets',
        'ec2:DescribeInternetGateways',
        'ec2:DescribeNatGateways',
        'ec2:DescribeRouteTables',
        'ec2:DescribeSecurityGroups',
        'ec2:DescribeAddresses',
        'ec2:DescribeAvailabilityZones',
        'ec2:ModifyVpcAttribute'
      ],
      resources: ['*']
    }));

    // ELB permissions for NLB
    this.creationStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'elasticloadbalancing:CreateLoadBalancer',
        'elasticloadbalancing:DeleteLoadBalancer',
        'elasticloadbalancing:CreateTargetGroup',
        'elasticloadbalancing:DeleteTargetGroup',
        'elasticloadbalancing:CreateListener',
        'elasticloadbalancing:DeleteListener',
        'elasticloadbalancing:RegisterTargets',
        'elasticloadbalancing:DeregisterTargets',
        'elasticloadbalancing:DescribeLoadBalancers',
        'elasticloadbalancing:DescribeTargetGroups',
        'elasticloadbalancing:DescribeListeners',
        'elasticloadbalancing:AddTags'
      ],
      resources: ['*']
    }));

    // Auto Scaling permissions for DCV ASGs
    this.creationStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'autoscaling:CreateAutoScalingGroup',
        'autoscaling:DeleteAutoScalingGroup',
        'autoscaling:UpdateAutoScalingGroup',
        'autoscaling:DescribeAutoScalingGroups',
        'autoscaling:CreateLaunchConfiguration',
        'autoscaling:DeleteLaunchConfiguration'
      ],
      resources: ['*']
    }));

    // SSM permissions for parameter storage
    this.creationStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:PutParameter',
        'ssm:DeleteParameter',
        'ssm:GetParameter',
        'ssm:AddTagsToResource'
      ],
      resources: ['*']
    }));

    // Deletion State Machine Permissions
    this.deletionStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem'
      ],
      resources: [props.regionalHubsTable.tableArn]
    }));

    // Lambda invoke permissions for cross-region operations
    this.deletionStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [
        deleteRegionalHubCfnFunction.functionArn,
        checkRegionalHubCfnStatusFunction.functionArn
      ]
    }));

    this.deletionStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudformation:DeleteStack',
        'cloudformation:DescribeStacks'
      ],
      resources: ['*']
    }));

    // EC2 cleanup permissions
    this.deletionStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:DeleteVpc',
        'ec2:DeleteSubnet',
        'ec2:DeleteInternetGateway',
        'ec2:DetachInternetGateway',
        'ec2:DeleteNatGateway',
        'ec2:DeleteRouteTable',
        'ec2:DeleteRoute',
        'ec2:DeleteSecurityGroup',
        'ec2:DeleteLaunchTemplate',
        'ec2:ReleaseAddress',
        'ec2:DescribeVpcs',
        'ec2:DescribeSubnets',
        'ec2:DescribeInternetGateways',
        'ec2:DescribeNatGateways',
        'ec2:DescribeRouteTables',
        'ec2:DescribeSecurityGroups',
        'ec2:DescribeAddresses',
        'ec2:DescribeNetworkInterfaces'
      ],
      resources: ['*']
    }));

    // ELB cleanup permissions
    this.deletionStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'elasticloadbalancing:DeleteLoadBalancer',
        'elasticloadbalancing:DeleteTargetGroup',
        'elasticloadbalancing:DeleteListener',
        'elasticloadbalancing:DescribeLoadBalancers',
        'elasticloadbalancing:DescribeTargetGroups'
      ],
      resources: ['*']
    }));

    // Auto Scaling cleanup permissions
    this.deletionStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'autoscaling:DeleteAutoScalingGroup',
        'autoscaling:DescribeAutoScalingGroups',
        'autoscaling:UpdateAutoScalingGroup'
      ],
      resources: ['*']
    }));

    // IAM cleanup permissions
    this.deletionStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'iam:DeleteRole',
        'iam:DetachRolePolicy',
        'iam:DeleteRolePolicy',
        'iam:DeleteInstanceProfile',
        'iam:RemoveRoleFromInstanceProfile',
        'iam:GetRole',
        'iam:GetInstanceProfile'
      ],
      resources: ['*']
    }));

    // SSM cleanup permissions
    this.deletionStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:DeleteParameter',
        'ssm:GetParameter'
      ],
      resources: ['*']
    }));

    // Lambda permissions for regional cleanup functions
    this.creationStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'lambda:CreateFunction',
        'lambda:DeleteFunction',
        'lambda:GetFunction',
        'lambda:UpdateFunctionCode',
        'lambda:UpdateFunctionConfiguration',
        'lambda:AddPermission',
        'lambda:RemovePermission',
        'lambda:TagResource'
      ],
      resources: ['*']
    }));

    // EventBridge permissions for regional cleanup rules
    this.creationStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'events:PutRule',
        'events:DeleteRule',
        'events:PutTargets',
        'events:RemoveTargets',
        'events:DescribeRule',
        'events:TagResource'
      ],
      resources: ['*']
    }));

    // S3 permissions for NLB access logs bucket
    this.creationStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:CreateBucket',
        's3:DeleteBucket',
        's3:PutBucketPolicy',
        's3:DeleteBucketPolicy',
        's3:PutBucketVersioning',
        's3:PutBucketEncryption',
        's3:PutBucketPublicAccessBlock',
        's3:PutLifecycleConfiguration',
        's3:GetBucketPolicy',
        's3:GetBucketVersioning'
      ],
      resources: ['*']
    }));

    // Lambda cleanup permissions for deletion
    this.deletionStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'lambda:DeleteFunction',
        'lambda:GetFunction',
        'lambda:RemovePermission'
      ],
      resources: ['*']
    }));

    // EventBridge cleanup permissions for deletion
    this.deletionStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'events:DeleteRule',
        'events:RemoveTargets',
        'events:DescribeRule'
      ],
      resources: ['*']
    }));

    // S3 cleanup permissions for deletion
    this.deletionStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:DeleteBucket',
        's3:DeleteBucketPolicy',
        's3:GetBucketPolicy',
        's3:ListBucket',
        's3:DeleteObject',
        's3:DeleteObjectVersion'
      ],
      resources: ['*']
    }));

    // Grant KMS permissions if using customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(this.creationStateMachine);
      props.dataEncryptionKey.grantEncryptDecrypt(this.deletionStateMachine);
      props.dataEncryptionKey.grantEncryptDecrypt(this.generateTemplateFunction);
      props.dataEncryptionKey.grantEncryptDecrypt(updateRegionalHubCfnFunction);
    }

    // ===========================================
    // AMI REPLICATION INFRASTRUCTURE
    // ===========================================

    // AMI Replication Handler Lambda
    const amiReplicationHandler = new lambda.Function(this, 'AmiReplicationHandlerFunction', {
      functionName: `${props.acronym.toLowerCase()}-ami-replication-handler`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/ami-replication-handler'),
      description: 'Handles AMI replication to satellite regions',
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PRODUCT_NAME: props.pascalCaseName,
        REGIONAL_HUBS_TABLE_NAME: props.regionalHubsTable.tableName,
        AMI_TABLE_NAME: props.amiTable.tableName,
      },
    });

    // Grant DynamoDB permissions
    props.regionalHubsTable.grantReadWriteData(amiReplicationHandler);
    props.amiTable.grantReadWriteData(amiReplicationHandler);

    // Grant EC2 permissions for AMI operations
    amiReplicationHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:CopyImage',
        'ec2:DescribeImages',
        'ec2:CreateTags'
      ],
      resources: ['*']
    }));

    // Grant KMS permissions for encrypted AMI copies
    amiReplicationHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'kms:CreateGrant',
        'kms:DescribeKey',
        'kms:ReEncrypt*'
      ],
      resources: ['*']
    }));

    // Grant KMS permissions if using customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(amiReplicationHandler);
    }

    // EventBridge rule to trigger AMI replication when new AMIs are created
    const amiCreationRule = new cdk.aws_events.Rule(this, 'AmiCreationRule', {
      ruleName: `${props.acronym.toLowerCase()}-ami-replication-trigger`,
      description: 'Triggers AMI replication when new AMIs are created',
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['EC2 AMI State Change'],
        detail: {
          state: ['available']
        }
      }
    });

    amiCreationRule.addTarget(new cdk.aws_events_targets.LambdaFunction(amiReplicationHandler));

    // ===========================================
    // DISTRIBUTION CONFIG SYNC (for macOS system pipelines)
    // ===========================================
    // When regional hubs are created/deleted, automatically update the
    // macOS system pipeline distribution configs to include/exclude the region.
    // This ensures AMIs are distributed to all active satellite regions.

    const syncDistConfigFunction = new lambda.Function(this, 'SyncDistributionConfigsFunction', {
      functionName: `${props.acronym.toLowerCase()}-sync-distribution-configs`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/sync-distribution-configs'),
      description: 'Syncs macOS system pipeline distribution configs when regional hubs change',
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
        REGIONAL_HUBS_TABLE_NAME: props.regionalHubsTable.tableName,
      },
    });

    // Grant DynamoDB read permissions
    props.regionalHubsTable.grantReadData(syncDistConfigFunction);

    // Grant Image Builder permissions to update distribution configs
    syncDistConfigFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'imagebuilder:ListDistributionConfigurations',
        'imagebuilder:GetDistributionConfiguration',
        'imagebuilder:UpdateDistributionConfiguration',
      ],
      resources: ['*'],
    }));

    // Grant KMS permissions if using customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantDecrypt(syncDistConfigFunction);
    }

    // Enable DynamoDB Streams on the regional hubs table if not already enabled
    // Note: The table must have streams enabled. If it doesn't, this will fail.
    // The stream should be enabled in the infrastructure stack where the table is created.

    // EventBridge rule to trigger sync when regional hub status changes
    // We use EventBridge Pipes or a custom approach since DynamoDB Streams require
    // the table to have streams enabled at creation time.
    // 
    // Alternative: Use EventBridge with a custom event pattern.
    // The state machines already update DynamoDB, so we can trigger on state machine completion.

    // Trigger sync when creation state machine completes successfully
    const creationCompleteRule = new cdk.aws_events.Rule(this, 'RegionalHubCreationCompleteRule', {
      ruleName: `${props.acronym.toLowerCase()}-regional-hub-creation-complete`,
      description: 'Triggers distribution config sync when a regional hub is created',
      eventPattern: {
        source: ['aws.states'],
        detailType: ['Step Functions Execution Status Change'],
        detail: {
          stateMachineArn: [this.creationStateMachine.stateMachineArn],
          status: ['SUCCEEDED'],
        },
      },
    });
    creationCompleteRule.addTarget(new cdk.aws_events_targets.LambdaFunction(syncDistConfigFunction));

    // Trigger sync when deletion state machine completes successfully
    const deletionCompleteRule = new cdk.aws_events.Rule(this, 'RegionalHubDeletionCompleteRule', {
      ruleName: `${props.acronym.toLowerCase()}-regional-hub-deletion-complete`,
      description: 'Triggers distribution config sync when a regional hub is deleted',
      eventPattern: {
        source: ['aws.states'],
        detailType: ['Step Functions Execution Status Change'],
        detail: {
          stateMachineArn: [this.deletionStateMachine.stateMachineArn],
          status: ['SUCCEEDED'],
        },
      },
    });
    deletionCompleteRule.addTarget(new cdk.aws_events_targets.LambdaFunction(syncDistConfigFunction));

    // ===========================================
    // OUTPUTS
    // ===========================================

    // Store state machine ARNs in SSM for Lambda functions to look up
    new cdk.aws_ssm.StringParameter(this, 'CreationStateMachineArnParameter', {
      parameterName: `/${props.pascalCaseName}/RegionalHub/CreationStateMachineArn`,
      stringValue: this.creationStateMachine.stateMachineArn,
      description: 'Regional Hub Creation State Machine ARN',
    });

    new cdk.aws_ssm.StringParameter(this, 'DeletionStateMachineArnParameter', {
      parameterName: `/${props.pascalCaseName}/RegionalHub/DeletionStateMachineArn`,
      stringValue: this.deletionStateMachine.stateMachineArn,
      description: 'Regional Hub Deletion State Machine ARN',
    });

    new cdk.CfnOutput(this, 'RegionalHubCreationStateMachineArn', {
      value: this.creationStateMachine.stateMachineArn,
      description: 'Regional Hub Creation State Machine ARN',
    });

    new cdk.CfnOutput(this, 'RegionalHubDeletionStateMachineArn', {
      value: this.deletionStateMachine.stateMachineArn,
      description: 'Regional Hub Deletion State Machine ARN',
    });

    new cdk.CfnOutput(this, 'GenerateRegionalHubTemplateFunctionArn', {
      value: this.generateTemplateFunction.functionArn,
      description: 'Generate Regional Hub Template Function ARN',
    });

    new cdk.CfnOutput(this, 'RegionalHubTemplateBucketName', {
      value: templateBucket.bucketName,
      description: 'S3 bucket for regional hub CloudFormation templates',
    });

    new cdk.CfnOutput(this, 'AmiReplicationHandlerArn', {
      value: amiReplicationHandler.functionArn,
      description: 'AMI Replication Handler Function ARN',
    });
  }
}
