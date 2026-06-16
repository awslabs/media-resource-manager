// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

interface StorageStackProps extends cdk.StackProps {
  storageTable: dynamodb.Table;
  workstationTable: dynamodb.Table;
  regionalHubsTable: dynamodb.Table;
  pascalCaseName: string;
  acronym: string;
  dataEncryptionKey?: kms.IKey;
  authenticatedRoleArn?: string;
}

export class StorageStack extends cdk.Stack {
  public readonly functions: {
    listStorage: lambda.Function;
    createStorage: lambda.Function;
    updateStorage: lambda.Function;
    deleteStorage: lambda.Function;
    getStorage: lambda.Function;
    generateFsxTemplate: lambda.Function;
    parseStackOutputs: lambda.Function;
    configureOntapCifs: lambda.Function;
    s3MountManager: lambda.Function;
    nfsMountManager: lambda.Function;
    storageCfnWorker: lambda.Function;
    listS3Buckets: lambda.Function;
  };
  public readonly stateMachine: stepfunctions.StateMachine;
  public readonly deletionStateMachine: stepfunctions.StateMachine;
  public readonly mediaBucket: s3.Bucket;
  public readonly mediaLogsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, {
      ...props,
      description: "Storage management infrastructure with Lambda functions and Step Functions for FSx provisioning"
    });

    // Initialize functions object
    this.functions = {} as any;

    // Ensure FSx service-linked role exists.
    // FSx requires this role to manage ENIs and resources in the VPC.
    // Without it, CreateFileSystem fails with AccessDenied.
    // Uses AwsCustomResource so it succeeds even if the role already exists.
    new cr.AwsCustomResource(this, 'FsxServiceLinkedRole', {
      onCreate: {
        service: 'IAM',
        action: 'createServiceLinkedRole',
        parameters: { AWSServiceName: 'fsx.amazonaws.com' },
        physicalResourceId: cr.PhysicalResourceId.of('fsx-slr'),
        ignoreErrorCodesMatching: 'InvalidInput', // Already exists
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['iam:CreateServiceLinkedRole'],
          resources: ['arn:aws:iam::*:role/aws-service-role/fsx.amazonaws.com/*'],
        }),
      ]),
    });

    // Import VPC and subnet from SSM parameters for Lambda VPC access
    const vpcId = ssm.StringParameter.valueForStringParameter(
      this,
      `/${props.pascalCaseName}/Network/VpcId`
    );

    // Get first private subnet for Lambda placement
    const privateSubnet1Id = ssm.StringParameter.valueForStringParameter(
      this,
      `/${props.pascalCaseName}/Network/PrivateSubnet1/SubnetID`
    );

    // Import subnet directly - Lambda only needs one subnet for outbound access
    const privateSubnet1 = ec2.Subnet.fromSubnetId(this, 'PrivateSubnet1', privateSubnet1Id);

    // Import VPC for security group creation
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedVpc', {
      vpcId: vpcId,
      availabilityZones: [cdk.Fn.select(0, cdk.Fn.getAzs())], // Use first AZ in region
    });

    // Security group for CIFS configurator Lambda to SSH to FSxN SVMs
    const cifsConfiguratorSg = new ec2.SecurityGroup(this, 'CifsConfiguratorSG', {
      vpc,
      securityGroupName: `${props.pascalCaseName}-CIFS-Configurator-SG`,
      description: 'Security group for CIFS configurator Lambda to access FSxN SVMs',
      allowAllOutbound: true,
    });

    // S3 bucket for media access logs
    this.mediaLogsBucket = new s3.Bucket(this, 'MediaLogsBucket', {
      bucketName: `${props.acronym.toLowerCase()}-media-logs-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [
        {
          id: 'DeleteOldLogs',
          expiration: cdk.Duration.days(90),
          noncurrentVersionExpiration: cdk.Duration.days(30),
        }
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // S3 bucket for media storage - accessible via Storage Browser and S3 Watchfolder app
    this.mediaBucket = new s3.Bucket(this, 'MediaBucket', {
      bucketName: `${props.acronym.toLowerCase()}-media-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      serverAccessLogsBucket: this.mediaLogsBucket,
      serverAccessLogsPrefix: 'media-bucket-access-logs/',
      cors: [
        {
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.PUT,
            s3.HttpMethods.POST,
            s3.HttpMethods.DELETE,
            s3.HttpMethods.HEAD,
          ],
          allowedOrigins: ['*'], // Will be restricted by Cognito Identity Pool
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag', 'x-amz-meta-custom-header'],
          maxAge: 3000,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Keep media files on stack deletion
    });

    // Grant authenticated Cognito users access to the media bucket
    if (props.authenticatedRoleArn) {
      const authenticatedRole = iam.Role.fromRoleArn(
        this,
        'ImportedAuthenticatedRole',
        props.authenticatedRoleArn
      );
      
      // Grant full access to the media bucket for authenticated users
      this.mediaBucket.grantReadWrite(authenticatedRole);
      
      // Also grant list bucket permission for Storage Browser
      this.mediaBucket.grantRead(authenticatedRole);
    }

    // Store media bucket name in SSM for frontend config and other services
    new ssm.StringParameter(this, 'MediaBucketNameParameter', {
      parameterName: `/${props.pascalCaseName}/Storage/MediaBucketName`,
      stringValue: this.mediaBucket.bucketName,
      description: 'S3 bucket name for media storage',
    });

    new ssm.StringParameter(this, 'MediaBucketArnParameter', {
      parameterName: `/${props.pascalCaseName}/Storage/MediaBucketArn`,
      stringValue: this.mediaBucket.bucketArn,
      description: 'S3 bucket ARN for media storage',
    });

    // Generate FSx Template Function
    this.functions.generateFsxTemplate = new lambda.Function(this, 'GenerateFsxTemplateFunction', {
      functionName: `${props.acronym.toLowerCase()}-generate-fsx-template`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/generate-fsx-template'),
      description: 'Generate CloudFormation template for FSx',
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PRODUCT_NAME: props.pascalCaseName,
        ACRONYM: props.acronym,
        REGIONAL_HUBS_TABLE_NAME: props.regionalHubsTable.tableName,
      },
    });

    // Grant SSM permissions to template generator (for primary region network config)
    this.functions.generateFsxTemplate.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters'
      ],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/*`]
    }));

    // Grant Secrets Manager permissions to template generator (for AD credentials for FSx Windows)
    this.functions.generateFsxTemplate.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:GetSecretValue'
      ],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:/${props.pascalCaseName}/Identity/*`]
    }));

    // Grant KMS decrypt permissions to template generator (for decrypting AD credentials secret)
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantDecrypt(this.functions.generateFsxTemplate);
    }

    // Grant DynamoDB read permissions to template generator (for regional hub network config)
    props.regionalHubsTable.grantReadData(this.functions.generateFsxTemplate);

    // Storage CloudFormation Worker Function - handles cross-region CloudFormation operations
    this.functions.storageCfnWorker = new lambda.Function(this, 'StorageCfnWorkerFunction', {
      functionName: `${props.acronym.toLowerCase()}-storage-cfn-worker`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/storage-cfn-worker'),
      description: 'Handle cross-region CloudFormation operations for storage resources',
      timeout: cdk.Duration.seconds(60),
      reservedConcurrentExecutions: 15,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PRODUCT_NAME: props.pascalCaseName,
        ACRONYM: props.acronym,
      },
    });

    // Grant cross-region CloudFormation permissions to storage-cfn-worker
    this.functions.storageCfnWorker.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudformation:CreateStack',
        'cloudformation:DescribeStacks',
        'cloudformation:DeleteStack',
        'cloudformation:DescribeStackEvents'
      ],
      resources: ['*'] // Cross-region requires wildcard
    }));

    // Grant cross-region SSM permissions for reading network parameters in regional hubs
    this.functions.storageCfnWorker.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters'
      ],
      resources: ['*'] // Cross-region requires wildcard
    }));

    // Grant cross-region FSx permissions for storage creation in regional hubs
    this.functions.storageCfnWorker.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'fsx:CreateFileSystem',
        'fsx:DescribeFileSystems',
        'fsx:DeleteFileSystem',
        'fsx:TagResource',
        'fsx:CreateStorageVirtualMachine',
        'fsx:DescribeStorageVirtualMachines',
        'fsx:DeleteStorageVirtualMachine',
        'fsx:CreateVolume',
        'fsx:DescribeVolumes',
        'fsx:DeleteVolume'
      ],
      resources: ['*'] // Cross-region requires wildcard
    }));

    // Grant cross-region EC2 permissions for security group creation in regional hubs
    this.functions.storageCfnWorker.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:CreateSecurityGroup',
        'ec2:DescribeSecurityGroups',
        'ec2:AuthorizeSecurityGroupIngress',
        'ec2:AuthorizeSecurityGroupEgress',
        'ec2:RevokeSecurityGroupEgress',
        'ec2:DeleteSecurityGroup',
        'ec2:CreateTags',
        'ec2:DescribeVpcs'
      ],
      resources: ['*'] // Cross-region requires wildcard
    }));

    // Grant cross-region Secrets Manager permissions for ONTAP credentials in regional hubs
    this.functions.storageCfnWorker.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:CreateSecret',
        'secretsmanager:DeleteSecret',
        'secretsmanager:TagResource',
        'secretsmanager:GetSecretValue'
      ],
      resources: ['*'] // Cross-region requires wildcard
    }));

    // Parse Stack Outputs Function
    this.functions.parseStackOutputs = new lambda.Function(this, 'ParseStackOutputsFunction', {
      functionName: `${props.acronym.toLowerCase()}-parse-stack-outputs`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/parse-stack-outputs'),
      description: 'Parse CloudFormation stack outputs for storage resources',
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
    });

    // Configure ONTAP CIFS Function - enables SMB for non-domain-joined Windows workstations
    // Needs VPC access to SSH to FSxN SVM management endpoint
    // For regional hubs, this Lambda routes to a regional Lambda deployed in the hub's VPC
    this.functions.configureOntapCifs = new lambda.Function(this, 'ConfigureOntapCifsFunction', {
      functionName: `${props.acronym.toLowerCase()}-configure-ontap-cifs`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/configure-ontap-cifs'),
      description: 'Configure CIFS/SMB on FSxN SVM for Windows workstation access',
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      vpc: vpc,
      vpcSubnets: { subnets: [privateSubnet1] },
      securityGroups: [cifsConfiguratorSg],
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
        ACRONYM: props.acronym,
        REGIONAL_HUBS_TABLE_NAME: props.regionalHubsTable.tableName,
        AWS_ACCOUNT_ID: this.account,
      },
    });

    // Grant CIFS configurator permissions to read regional hubs table (for routing)
    props.regionalHubsTable.grantReadData(this.functions.configureOntapCifs);

    // Grant CIFS configurator permissions to invoke regional Lambdas
    this.functions.configureOntapCifs.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:*:${this.account}:function:${props.acronym.toLowerCase()}-regional-configure-ontap-cifs`]
    }));

    // Grant CIFS configurator permissions to read and update secrets
    this.functions.configureOntapCifs.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:GetSecretValue',
        'secretsmanager:UpdateSecret',
      ],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:/${props.pascalCaseName}/Storage/*`]
    }));

    // Grant FSx permissions to describe SVMs
    this.functions.configureOntapCifs.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'fsx:DescribeStorageVirtualMachines',
      ],
      resources: ['*']
    }));

    // List Storage Function
    this.functions.listStorage = new lambda.Function(this, 'ListStorageFunction', {
      functionName: `${props.acronym.toLowerCase()}-list-storage`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/list-storage'),
      description: 'List storage resources',
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        STORAGE_TABLE_NAME: props.storageTable.tableName,
      },
    });

    // Get Storage Function
    this.functions.getStorage = new lambda.Function(this, 'GetStorageFunction', {
      functionName: `${props.acronym.toLowerCase()}-get-storage`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/get-storage'),
      description: 'Get storage resource details',
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        STORAGE_TABLE_NAME: props.storageTable.tableName,
      },
    });

    // Create Storage Function
    this.functions.createStorage = new lambda.Function(this, 'CreateStorageFunction', {
      functionName: `${props.acronym.toLowerCase()}-create-storage`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/create-storage'),
      description: 'Create storage resources',
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        STORAGE_TABLE_NAME: props.storageTable.tableName,
      },
    });

    // Update Storage Function
    this.functions.updateStorage = new lambda.Function(this, 'UpdateStorageFunction', {
      functionName: `${props.acronym.toLowerCase()}-update-storage`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/update-storage'),
      description: 'Update storage resources',
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        STORAGE_TABLE_NAME: props.storageTable.tableName,
      },
    });

    // Delete Storage Function
    this.functions.deleteStorage = new lambda.Function(this, 'DeleteStorageFunction', {
      functionName: `${props.acronym.toLowerCase()}-delete-storage`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/delete-storage'),
      description: 'Delete storage resources',
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        STORAGE_TABLE_NAME: props.storageTable.tableName,
        // SSM parameter path for DataSync table name - Lambda reads at runtime
        // This avoids synth-time dependency on the DataSync stack
        DATASYNC_TABLE_SSM_PATH: `/${props.pascalCaseName}/DataSync/TableName`,
      },
    });

    // S3 Mount Manager Function (for Mountpoint for S3 on Linux)
    this.functions.s3MountManager = new lambda.Function(this, 'S3MountManagerFunction', {
      functionName: `${props.acronym.toLowerCase()}-s3-mount-manager`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/s3-mount-manager'),
      description: 'Manage Mountpoint for S3 on Linux workstations',
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 15,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        STORAGE_TABLE_NAME: props.storageTable.tableName,
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
      },
    });

    // Grant S3 Mount Manager permissions
    props.storageTable.grantReadData(this.functions.s3MountManager);
    props.workstationTable.grantReadData(this.functions.s3MountManager);

    // SSM permissions for running commands on instances
    this.functions.s3MountManager.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:SendCommand',
        'ssm:GetCommandInvocation',
      ],
      resources: ['*'],
    }));

    // EC2 permissions for describing instances
    this.functions.s3MountManager.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:DescribeInstances',
      ],
      resources: ['*'],
    }));

    // FSx NFS Mount Manager Function (for FSx for NetApp ONTAP on Linux/macOS)
    // Note: Keep construct ID as 'NfsMountManagerFunction' to preserve CloudFormation logical ID
    this.functions.nfsMountManager = new lambda.Function(this, 'NfsMountManagerFunction', {
      functionName: `${props.acronym.toLowerCase()}-nfs-mount-manager`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/fsx-nfs-mount-manager'),
      description: 'Manage NFS mounts for FSx for NetApp ONTAP on Linux and macOS workstations',
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 15,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        STORAGE_TABLE_NAME: props.storageTable.tableName,
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
      },
    });

    // Grant NFS Mount Manager permissions
    props.storageTable.grantReadData(this.functions.nfsMountManager);
    props.workstationTable.grantReadData(this.functions.nfsMountManager);

    // SSM permissions for running commands on instances
    this.functions.nfsMountManager.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:SendCommand',
        'ssm:GetCommandInvocation',
      ],
      resources: ['*'],
    }));

    // EC2 permissions for describing instances
    this.functions.nfsMountManager.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:DescribeInstances',
      ],
      resources: ['*'],
    }));

    // FSx permissions for describing SVMs to get NFS endpoints
    this.functions.nfsMountManager.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'fsx:DescribeStorageVirtualMachines',
      ],
      resources: ['*'],
    }));

    // List S3 Buckets Function (for Mountpoint S3 storage creation)
    // Also handles /storage/config endpoint for cross-account bucket policy generation
    this.functions.listS3Buckets = new lambda.Function(this, 'ListS3BucketsFunction', {
      functionName: `${props.acronym.toLowerCase()}-storage-list-s3-buckets`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/storage-list-s3-buckets'),
      description: 'List S3 buckets and provide config for Mountpoint S3 storage creation',
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PRODUCT_NAME: props.pascalCaseName,
        ACRONYM: props.acronym,
        WORKSTATION_ROLE_ARN: ssm.StringParameter.valueForStringParameter(
          this, `/${props.pascalCaseName}/DCV/InstanceRoleArn`
        ),
        AWS_ACCOUNT_ID: this.account,
      },
    });

    // Grant S3 list buckets permission
    this.functions.listS3Buckets.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListAllMyBuckets', 's3:GetBucketLocation'],
      resources: ['*'],
    }));
    const stateMachineDefinition = {
      Comment: "FSx Storage Creation State Machine with Native Service Integrations",
      StartAt: "UpdateStatusToValidating",
      States: {
        UpdateStatusToValidating: {
          Type: "Task",
          Resource: "arn:aws:states:::dynamodb:updateItem",
          Parameters: {
            TableName: props.storageTable.tableName,
            Key: {
              storageId: {
                "S.$": "$.storageId"
              }
            },
            UpdateExpression: "SET #status = :status, #updatedAt = :updatedAt",
            ExpressionAttributeNames: {
              "#status": "status",
              "#updatedAt": "updatedAt"
            },
            ExpressionAttributeValues: {
              ":status": {
                S: "validating"
              },
              ":updatedAt": {
                "S.$": "$$.State.EnteredTime"
              }
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
          Resource: this.functions.generateFsxTemplate.functionArn,
          ResultPath: "$.templateData",
          Next: "UpdateStatusToCreating",
          Retry: [
            {
              ErrorEquals: ["States.ALL"],
              IntervalSeconds: 2,
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
            TableName: props.storageTable.tableName,
            Key: {
              storageId: {
                "S.$": "$.storageId"
              }
            },
            UpdateExpression: "SET #status = :status, #updatedAt = :updatedAt, cloudFormationStackName = :stackName, #region = :region",
            ExpressionAttributeNames: {
              "#status": "status",
              "#updatedAt": "updatedAt",
              "#region": "region"
            },
            ExpressionAttributeValues: {
              ":status": {
                S: "creating"
              },
              ":updatedAt": {
                "S.$": "$$.State.EnteredTime"
              },
              ":stackName": {
                "S.$": "$.templateData.stackName"
              },
              ":region": {
                "S.$": "$.region"
              }
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
          Resource: this.functions.storageCfnWorker.functionArn,
          Parameters: {
            action: "createStack",
            "region.$": "$.region",
            "stackName.$": "$.templateData.stackName",
            "templateBody.$": "$.templateData.template",
            "parameters.$": "$.templateData.parameters"
          },
          ResultPath: "$.StackId",
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
          Resource: this.functions.storageCfnWorker.functionArn,
          Parameters: {
            action: "describeStacks",
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
              Variable: "$.stackStatus.Stacks[0].StackStatus",
              StringEquals: "CREATE_COMPLETE",
              Next: "ParseStackOutputs"
            },
            {
              Variable: "$.stackStatus.Stacks[0].StackStatus",
              StringMatches: "*_FAILED",
              Next: "PrepareFailureFromStack"
            },
            {
              Variable: "$.stackStatus.Stacks[0].StackStatus",
              StringEquals: "ROLLBACK_COMPLETE",
              Next: "PrepareFailureFromStack"
            },
            {
              Variable: "$.stackStatus.Stacks[0].StackStatus",
              StringMatches: "*_IN_PROGRESS",
              Next: "WaitForStackCreation"
            }
          ],
          Default: "PrepareFailureFromStack"
        },
        ParseStackOutputs: {
          Type: "Task",
          Resource: this.functions.parseStackOutputs.functionArn,
          Parameters: {
            "storageType.$": "$.type",
            "stackStatus.$": "$.stackStatus"
          },
          ResultPath: "$.parsedOutputs",
          Next: "ConfigureOntapCifs",
          Retry: [
            {
              ErrorEquals: ["States.ALL"],
              IntervalSeconds: 2,
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
        ConfigureOntapCifs: {
          Type: "Task",
          Resource: this.functions.configureOntapCifs.functionArn,
          Parameters: {
            "storageId.$": "$.storageId",
            "type.$": "$.type",
            "parsedOutputs.$": "$.parsedOutputs",
            "region.$": "$.region"
          },
          ResultPath: "$.cifsConfig",
          Next: "UpdateStatusToAvailable",
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
              Comment: "CIFS configuration failure is non-fatal - storage is still usable via NFS",
              Next: "UpdateStatusToAvailable",
              ResultPath: "$.cifsError"
            }
          ]
        },
        PrepareFailureFromStack: {
          Type: "Pass",
          Parameters: {
            "storageId.$": "$.storageId",
            "templateData.$": "$.templateData",
            "errorMessage.$": "States.Format('CloudFormation stack failed with status: {}', $.stackStatus.Stacks[0].StackStatus)"
          },
          Next: "UpdateStatusToFailed"
        },
        UpdateStatusToAvailable: {
          Type: "Task",
          Resource: "arn:aws:states:::dynamodb:updateItem",
          Parameters: {
            TableName: props.storageTable.tableName,
            Key: {
              storageId: {
                "S.$": "$.storageId"
              }
            },
            UpdateExpression: "SET #status = :status, #updatedAt = :updatedAt, cloudFormationStackName = :stackName, fsxFileSystemId = :fsxId, fsxDnsName = :fsxDns, fsxResourceArn = :fsxArn, parsedOutputs = :outputs",
            ExpressionAttributeNames: {
              "#status": "status",
              "#updatedAt": "updatedAt"
            },
            ExpressionAttributeValues: {
              ":status": {
                S: "available"
              },
              ":updatedAt": {
                "S.$": "$$.State.EnteredTime"
              },
              ":stackName": {
                "S.$": "$.templateData.stackName"
              },
              ":fsxId": {
                "S.$": "$.parsedOutputs.fsxFileSystemId"
              },
              ":fsxDns": {
                "S.$": "$.parsedOutputs.fsxDnsName"
              },
              ":fsxArn": {
                "S.$": "$.parsedOutputs.fsxResourceArn"
              },
              ":outputs": {
                "S.$": "States.JsonToString($.parsedOutputs)"
              }
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
        PrepareFailureFromError: {
          Type: "Pass",
          Parameters: {
            "storageId.$": "$.storageId",
            "templateData.$": "$.templateData",
            "errorMessage.$": "States.Format('Error: {}', $.error.Cause)"
          },
          Next: "UpdateStatusToFailed"
        },
        UpdateStatusToFailed: {
          Type: "Task",
          Resource: "arn:aws:states:::dynamodb:updateItem",
          Parameters: {
            TableName: props.storageTable.tableName,
            Key: {
              storageId: {
                "S.$": "$.storageId"
              }
            },
            UpdateExpression: "SET #status = :status, #updatedAt = :updatedAt, errorMessage = :error",
            ExpressionAttributeNames: {
              "#status": "status",
              "#updatedAt": "updatedAt"
            },
            ExpressionAttributeValues: {
              ":status": {
                S: "failed"
              },
              ":updatedAt": {
                "S.$": "$$.State.EnteredTime"
              },
              ":error": {
                "S.$": "$.errorMessage"
              }
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

    this.stateMachine = new stepfunctions.StateMachine(this, 'StorageCreationStateMachine', {
      stateMachineName: `${props.acronym.toLowerCase()}-storage-creation`,
      definitionBody: stepfunctions.DefinitionBody.fromString(JSON.stringify(stateMachineDefinition)),
      timeout: cdk.Duration.hours(2),
    });

    // Storage Deletion State Machine
    const deletionStateMachineDefinition = {
      Comment: "FSx Storage Deletion State Machine with Native Service Integrations",
      StartAt: "UpdateStatusToDeleting",
      States: {
        UpdateStatusToDeleting: {
          Type: "Task",
          Resource: "arn:aws:states:::dynamodb:updateItem",
          Parameters: {
            TableName: props.storageTable.tableName,
            Key: {
              storageId: {
                "S.$": "$.storageId"
              }
            },
            UpdateExpression: "SET #status = :status, #updatedAt = :updatedAt",
            ExpressionAttributeNames: {
              "#status": "status",
              "#updatedAt": "updatedAt"
            },
            ExpressionAttributeValues: {
              ":status": {
                S: "deleting"
              },
              ":updatedAt": {
                "S.$": "$$.State.EnteredTime"
              }
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
          Resource: this.functions.storageCfnWorker.functionArn,
          Parameters: {
            action: "deleteStack",
            "region.$": "$.region",
            "stackName.$": "$.cloudFormationStackName"
          },
          ResultPath: "$.StackId",
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
          Resource: this.functions.storageCfnWorker.functionArn,
          Parameters: {
            action: "describeStacks",
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
              ErrorEquals: ["States.ALL"],
              Comment: "Stack not found means it's deleted",
              Next: "UpdateStatusToDeleted",
              ResultPath: null
            }
          ]
        },
        EvaluateStackDeletionStatus: {
          Type: "Choice",
          Choices: [
            {
              Variable: "$.stackStatus.Stacks[0].StackStatus",
              StringEquals: "DELETE_COMPLETE",
              Next: "UpdateStatusToDeleted"
            },
            {
              Variable: "$.stackStatus.Stacks[0].StackStatus",
              StringMatches: "*_FAILED",
              Next: "UpdateStatusToDeleteFailed"
            },
            {
              Variable: "$.stackStatus.Stacks[0].StackStatus",
              StringMatches: "*_IN_PROGRESS",
              Next: "WaitForStackDeletion"
            }
          ],
          Default: "UpdateStatusToDeleteFailed"
        },
        UpdateStatusToDeleted: {
          Type: "Task",
          Resource: "arn:aws:states:::dynamodb:deleteItem",
          Parameters: {
            TableName: props.storageTable.tableName,
            Key: {
              storageId: {
                "S.$": "$.storageId"
              }
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
            TableName: props.storageTable.tableName,
            Key: {
              storageId: {
                "S.$": "$.storageId"
              }
            },
            UpdateExpression: "SET #status = :status, #updatedAt = :updatedAt, errorMessage = :error",
            ExpressionAttributeNames: {
              "#status": "status",
              "#updatedAt": "updatedAt"
            },
            ExpressionAttributeValues: {
              ":status": {
                S: "delete-failed"
              },
              ":updatedAt": {
                "S.$": "$$.State.EnteredTime"
              },
              ":error": {
                "S.$": "States.JsonToString($)"
              }
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

    this.deletionStateMachine = new stepfunctions.StateMachine(this, 'StorageDeletionStateMachine', {
      stateMachineName: `${props.acronym.toLowerCase()}-storage-deletion`,
      definitionBody: stepfunctions.DefinitionBody.fromString(JSON.stringify(deletionStateMachineDefinition)),
      timeout: cdk.Duration.hours(1),
    });

    // Grant permissions to Step Functions (Creation)
    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:UpdateItem'
      ],
      resources: [props.storageTable.tableArn]
    }));

    // Grant permissions to Step Functions (Deletion)
    this.deletionStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem'
      ],
      resources: [props.storageTable.tableArn]
    }));

    this.deletionStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudformation:DeleteStack',
        'cloudformation:DescribeStacks'
      ],
      resources: ['*']
    }));

    this.deletionStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'fsx:DeleteFileSystem',
        'fsx:DescribeFileSystems',
        // FSxN-specific permissions for SVM and Volume deletion
        'fsx:DeleteStorageVirtualMachine',
        'fsx:DescribeStorageVirtualMachines',
        'fsx:DeleteVolume',
        'fsx:DescribeVolumes'
      ],
      resources: ['*']
    }));

    this.deletionStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:DeleteSecurityGroup',
        'ec2:DescribeSecurityGroups'
      ],
      resources: ['*']
    }));

    this.deletionStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:GetSecretValue'
      ],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:/${props.pascalCaseName}/Identity/*`]
    }));

    // Permissions for deleting ONTAP admin credentials secrets
    this.deletionStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:DeleteSecret'
      ],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:/${props.pascalCaseName}/Storage/*`]
    }));

    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudformation:CreateStack',
        'cloudformation:DescribeStacks',
        'cloudformation:DescribeStackEvents'
      ],
      resources: ['*']
    }));

    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters'
      ],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/*`]
    }));

    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:CreateSecurityGroup',
        'ec2:DescribeSecurityGroups',
        'ec2:AuthorizeSecurityGroupIngress',
        'ec2:AuthorizeSecurityGroupEgress',
        'ec2:RevokeSecurityGroupEgress',
        'ec2:DeleteSecurityGroup',
        'ec2:CreateTags',
        'ec2:DescribeVpcs'
      ],
      resources: ['*']
    }));

    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:GetSecretValue'
      ],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:/${props.pascalCaseName}/Identity/*`]
    }));

    // Permissions for creating and managing ONTAP admin credentials secrets
    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:CreateSecret',
        'secretsmanager:DeleteSecret',
        'secretsmanager:TagResource',
        'secretsmanager:GetSecretValue'
      ],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:/${props.pascalCaseName}/Storage/*`]
    }));

    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'fsx:CreateFileSystem',
        'fsx:DescribeFileSystems',
        'fsx:DeleteFileSystem',
        'fsx:TagResource',
        // FSxN-specific permissions for SVM and Volume creation
        'fsx:CreateStorageVirtualMachine',
        'fsx:DescribeStorageVirtualMachines',
        'fsx:DeleteStorageVirtualMachine',
        'fsx:CreateVolume',
        'fsx:DescribeVolumes',
        'fsx:DeleteVolume'
      ],
      resources: ['*']
    }));

    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'iam:PassRole'
      ],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'iam:PassedToService': ['cloudformation.amazonaws.com']
        }
      }
    }));

    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'iam:CreateServiceLinkedRole'
      ],
      resources: ['arn:aws:iam::*:role/aws-service-role/fsx.amazonaws.com/AWSServiceRoleForAmazonFSx']
    }));

    this.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'lambda:InvokeFunction'
      ],
      resources: [
        this.functions.generateFsxTemplate.functionArn,
        this.functions.parseStackOutputs.functionArn,
        this.functions.configureOntapCifs.functionArn,
        this.functions.storageCfnWorker.functionArn
      ]
    }));

    // Grant deletion state machine permission to invoke storage-cfn-worker Lambda
    this.deletionStateMachine.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'lambda:InvokeFunction'
      ],
      resources: [
        this.functions.storageCfnWorker.functionArn
      ]
    }));

    // Update CreateStorageFunction environment to include Step Functions ARN and Regional Hubs table
    this.functions.createStorage.addEnvironment('STORAGE_CREATION_STATE_MACHINE_ARN', this.stateMachine.stateMachineArn);
    this.functions.createStorage.addEnvironment('REGIONAL_HUBS_TABLE_NAME', props.regionalHubsTable.tableName);

    // Grant CreateStorageFunction permission to read regional hubs table for region validation
    props.regionalHubsTable.grantReadData(this.functions.createStorage);

    // Update DeleteStorageFunction environment to include Step Functions ARN
    this.functions.deleteStorage.addEnvironment('STORAGE_DELETION_STATE_MACHINE_ARN', this.deletionStateMachine.stateMachineArn);

    // Grant CreateStorageFunction permission to start Step Functions execution
    this.functions.createStorage.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'states:StartExecution'
      ],
      resources: [this.stateMachine.stateMachineArn]
    }));

    // Grant DeleteStorageFunction permission to start Step Functions execution
    this.functions.deleteStorage.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'states:StartExecution'
      ],
      resources: [this.deletionStateMachine.stateMachineArn]
    }));

    // Grant DeleteStorageFunction permission to describe and delete CloudFormation stacks.
    // The wildcard region is intentional: storage stacks can be deployed in any region,
    // so the Lambda must be able to call CloudFormation across all regions in this account.
    this.functions.deleteStorage.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudformation:DescribeStacks',
        'cloudformation:DeleteStack'
      ],
      resources: [`arn:aws:cloudformation:*:${this.account}:stack/${props.acronym}-Storage-*`]
    }));

    // Grant DynamoDB permissions to functions
    props.storageTable.grantReadData(this.functions.listStorage);
    props.storageTable.grantReadData(this.functions.getStorage);
    props.storageTable.grantWriteData(this.functions.createStorage);
    props.storageTable.grantReadWriteData(this.functions.updateStorage);
    props.storageTable.grantReadWriteData(this.functions.deleteStorage);

    // Grant delete-storage permission to read/write DataSync table.
    // It needs to query locations/tasks by storageId, delete task EXECUTION#
    // rows in batches, and delete LOCATION/TASK metadata rows as part of
    // the cascade cleanup that runs before CloudFormation stack deletion.
    this.functions.deleteStorage.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:Query',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:BatchWriteItem',
      ],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${props.acronym.toLowerCase()}-datasync`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${props.acronym.toLowerCase()}-datasync/index/*`,
      ],
    }));

    // Grant delete-storage permission to delete DataSync tasks and locations
    // in AWS. Without this, the FSx security group can't be deleted because
    // DataSync keeps ENIs attached to it as long as the location exists.
    this.functions.deleteStorage.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'datasync:DeleteTask',
        'datasync:DeleteLocation',
      ],
      resources: [
        `arn:aws:datasync:${this.region}:${this.account}:task/*`,
        `arn:aws:datasync:${this.region}:${this.account}:location/*`,
      ],
    }));

    // Grant delete-storage permission to read DataSync table name from SSM
    this.functions.deleteStorage.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/DataSync/*`,
      ],
    }));

    // Grant S3 HeadBucket permission to create-storage for bucket validation
    this.functions.createStorage.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListBucket', 's3:GetBucketLocation'],
      resources: ['arn:aws:s3:::*'],
    }));

    // Grant KMS permissions if tables use customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantDecrypt(this.functions.listStorage);
      props.dataEncryptionKey.grantDecrypt(this.functions.getStorage);
      props.dataEncryptionKey.grantEncryptDecrypt(this.functions.createStorage);
      props.dataEncryptionKey.grantEncryptDecrypt(this.functions.updateStorage);
      props.dataEncryptionKey.grantEncryptDecrypt(this.functions.deleteStorage);
      props.dataEncryptionKey.grantDecrypt(this.functions.s3MountManager);
      props.dataEncryptionKey.grantDecrypt(this.functions.nfsMountManager);
      // Grant KMS permissions to state machines for DynamoDB access
      props.dataEncryptionKey.grantEncryptDecrypt(this.stateMachine);
      props.dataEncryptionKey.grantEncryptDecrypt(this.deletionStateMachine);
    }

    // Outputs
    new cdk.CfnOutput(this, 'StorageCreationStateMachineArn', {
      value: this.stateMachine.stateMachineArn,
      description: 'Storage Creation State Machine ARN',
    });

    new cdk.CfnOutput(this, 'StorageDeletionStateMachineArn', {
      value: this.deletionStateMachine.stateMachineArn,
      description: 'Storage Deletion State Machine ARN',
    });

    new cdk.CfnOutput(this, 'GenerateFsxTemplateFunctionArn', {
      value: this.functions.generateFsxTemplate.functionArn,
      description: 'Generate FSx Template Function ARN',
    });

    new cdk.CfnOutput(this, 'S3MountManagerFunctionArn', {
      value: this.functions.s3MountManager.functionArn,
      description: 'S3 Mount Manager Function ARN',
    });

    // Store Lambda ARNs in SSM Parameter Store for loose cross-stack coupling
    // This avoids CloudFormation export dependencies that prevent updates
    new ssm.StringParameter(this, 'NfsMountManagerArnParam', {
      parameterName: `/${props.pascalCaseName}/Storage/NfsMountManagerFunctionArn`,
      stringValue: this.functions.nfsMountManager.functionArn,
      description: 'NFS Mount Manager Lambda ARN for cross-stack reference',
    });
  }
}
