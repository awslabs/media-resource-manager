// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';
import { Construct } from 'constructs';

export interface ImageBuilderConstructProps {
  pascalCaseName: string;
  acronym: string;
  vpc: ec2.IVpc;
  privateSubnets: ec2.ISubnet[];
  encryptionKey?: kms.IKey;
}

export class ImageBuilderConstruct extends Construct {
  public readonly uploadsBucket: s3.Bucket;
  public readonly logsBucket: s3.Bucket;
  public readonly serviceRole: iam.Role;
  public readonly instanceProfile: iam.InstanceProfile;
  public readonly notificationTopic: sns.Topic;
  public readonly buildSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: ImageBuilderConstructProps) {
    super(scope, id);

    // S3 bucket for logs (CKV_AWS_18: enable access logging, CKV_AWS_21: enable versioning)
    this.logsBucket = new s3.Bucket(this, 'LogsBucket', {
      bucketName: `${props.acronym.toLowerCase()}-image-builder-logs-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
      encryption: props.encryptionKey ? s3.BucketEncryption.KMS : s3.BucketEncryption.S3_MANAGED,
      encryptionKey: props.encryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
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

    // S3 bucket for user uploads (CKV_AWS_18: enable access logging, CKV_AWS_21: enable versioning)
    this.uploadsBucket = new s3.Bucket(this, 'UploadsBucket', {
      bucketName: `${props.acronym.toLowerCase()}-image-builder-uploads-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
      encryption: props.encryptionKey ? s3.BucketEncryption.KMS : s3.BucketEncryption.S3_MANAGED,
      encryptionKey: props.encryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
      serverAccessLogsBucket: this.logsBucket,
      serverAccessLogsPrefix: 'uploads-access-logs/',
      lifecycleRules: [
        {
          id: 'DeleteOldUploads',
          expiration: cdk.Duration.days(30),
          noncurrentVersionExpiration: cdk.Duration.days(7),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7)
        }
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.POST, s3.HttpMethods.PUT],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3000
        }
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // SNS topic for build notifications (CKV_AWS_26: enable encryption)
    this.notificationTopic = new sns.Topic(this, 'BuildNotifications', {
      topicName: `${props.pascalCaseName}-ImageBuilder-Notifications`,
      displayName: 'Image Builder Build Notifications',
      masterKey: props.encryptionKey,
    });

    // Security group for build instances
    this.buildSecurityGroup = new ec2.SecurityGroup(this, 'BuildSecurityGroup', {
      vpc: props.vpc,
      securityGroupName: `${props.pascalCaseName}-ImageBuilder-Build-SG`,
      description: 'Security group for Image Builder build instances',
      allowAllOutbound: true
    });

    // Image Builder service role
    this.serviceRole = new iam.Role(this, 'ServiceRole', {
      roleName: `${props.pascalCaseName}-ImageBuilder-ServiceRole`,
      assumedBy: new iam.ServicePrincipal('imagebuilder.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('EC2InstanceProfileForImageBuilder'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('EC2InstanceProfileForImageBuilderECRContainerBuilds')
      ],
      inlinePolicies: {
        S3Access: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:ListBucket'],
              resources: [
                this.uploadsBucket.bucketArn,
                this.logsBucket.bucketArn,
                'arn:aws:s3:::ec2-windows-nvidia-drivers'
              ]
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:GetObject', 's3:HeadObject'],
              resources: [
                `${this.uploadsBucket.bucketArn}/*`,
                'arn:aws:s3:::ec2-windows-nvidia-drivers/*'
              ]
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                's3:PutObject',
                's3:PutObjectAcl',
                's3:GetObject'
              ],
              resources: [
                `${this.logsBucket.bucketArn}/*`
              ]
            })
          ]
        }),
        SNSPublish: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['sns:Publish'],
              resources: [this.notificationTopic.topicArn]
            })
          ]
        }),
        ImageBuilderAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['imagebuilder:GetComponent'],
              resources: [`arn:aws:imagebuilder:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:component/*`]
            })
          ]
        }),
        // EC2 permissions - split into read-only (can use *) and write (need conditions)
        EC2ReadPermissions: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'EC2DescribeActions',
              effect: iam.Effect.ALLOW,
              actions: [
                'ec2:DescribeTags',
                'ec2:DescribeInstances',
                'ec2:DescribeInstanceTypes',
                'ec2:DescribeInstanceTypeOfferings',
                'ec2:DescribeImages',
                'ec2:DescribeSnapshots',
                'ec2:DescribeVolumes',
                'ec2:DescribeImageAttribute',
                'ec2:DescribeInstanceStatus'
              ],
              resources: ['*']
            })
          ]
        }),
        // EC2 write permissions - constrained to this account/region
        // Note: ImageBuilder requires broad EC2 permissions for build orchestration
        EC2WritePermissions: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'EC2BuildOperations',
              effect: iam.Effect.ALLOW,
              actions: [
                'ec2:RunInstances',
                'ec2:StopInstances',
                'ec2:TerminateInstances',
                'ec2:ModifyInstanceAttribute',
                'ec2:CreateImage',
                'ec2:CopyImage',
                'ec2:ModifyImageAttribute',
                'ec2:CreateTags'
              ],
              resources: [
                `arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:instance/*`,
                `arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:volume/*`,
                `arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:network-interface/*`,
                `arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:security-group/*`,
                `arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:subnet/*`,
                `arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:image/*`,
                `arn:aws:ec2:${cdk.Stack.of(this).region}::image/*`,
                `arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:key-pair/*`,
                `arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:launch-template/*`,
                `arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:snapshot/*`,
                `arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:dedicated-host/*`
              ]
            })
          ]
        }),
        CloudWatchLogs: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
                'logs:DescribeLogGroups',
                'logs:DescribeLogStreams'
              ],
              resources: [`arn:aws:logs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:log-group:/aws/imagebuilder/*`]
            })
          ]
        }),
        WorkflowExecution: new iam.PolicyDocument({
          statements: [
            // SSM commands for Image Builder
            new iam.PolicyStatement({
              sid: 'SSMCommands',
              effect: iam.Effect.ALLOW,
              actions: [
                'ssm:SendCommand',
                'ssm:ListCommandInvocations',
                'ssm:DescribeInstanceInformation',
                'ssm:GetCommandInvocation'
              ],
              resources: [
                `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:*`,
                `arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:instance/*`,
                `arn:aws:ssm:${cdk.Stack.of(this).region}::document/AWS-RunPowerShellScript`,
                `arn:aws:ssm:${cdk.Stack.of(this).region}::document/AWS-RunShellScript`
              ]
            }),
            // PassRole only to this service role
            new iam.PolicyStatement({
              sid: 'PassRoleToSelf',
              effect: iam.Effect.ALLOW,
              actions: ['iam:PassRole'],
              resources: [`arn:aws:iam::${cdk.Stack.of(this).account}:role/${props.pascalCaseName}-ImageBuilder-ServiceRole`],
              conditions: {
                StringEquals: {
                  'iam:PassedToService': 'ec2.amazonaws.com'
                }
              }
            })
          ]
        }),
        // Host Resource Group permissions for macOS dedicated host placement
        HostResourceGroupAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'ResourceGroupsAccess',
              effect: iam.Effect.ALLOW,
              actions: [
                'resource-groups:GetGroup',
                'resource-groups:ListGroupResources'
              ],
              resources: [`arn:aws:resource-groups:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:group/${props.pascalCaseName}-Mac-Host-Resource-Group`]
            }),
            // EC2 Dedicated Host permissions for macOS builds
            new iam.PolicyStatement({
              sid: 'DedicatedHostAccess',
              effect: iam.Effect.ALLOW,
              actions: [
                'ec2:DescribeHosts',
                'ec2:AllocateHosts'
              ],
              resources: ['*']
            })
          ]
        })
      }
    });

    // Instance profile for build instances
    this.instanceProfile = new iam.InstanceProfile(this, 'InstanceProfile', {
      instanceProfileName: `${props.pascalCaseName}-ImageBuilder-InstanceProfile`,
      role: this.serviceRole
    });

    // Add S3 logging permissions directly to the service role for the instance profile
    this.serviceRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:PutObject',
        's3:PutObjectAcl',
        's3:GetBucketLocation'
      ],
      resources: [
        this.logsBucket.bucketArn,
        `${this.logsBucket.bucketArn}/*`
      ]
    }));

    // Add KMS permissions if encryption key is provided
    if (props.encryptionKey) {
      this.serviceRole.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:DescribeKey'
        ],
        resources: [props.encryptionKey.keyArn]
      }));
    }

    // Build the policy statements for SSM Default Host Management role
    const ssmRolePolicyStatements: any[] = [{
      Effect: 'Allow',
      Action: 'imagebuilder:GetComponent',
      Resource: `arn:aws:imagebuilder:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:component/*`
    }, {
      Effect: 'Allow',
      Action: [
        's3:PutObject',
        's3:PutObjectAcl',
        's3:GetBucketLocation'
      ],
      Resource: [
        this.logsBucket.bucketArn,
        `${this.logsBucket.bucketArn}/*`
      ]
    }, {
      Effect: 'Allow',
      Action: ['s3:ListBucket'],
      Resource: [
        this.logsBucket.bucketArn,
        this.uploadsBucket.bucketArn,
        'arn:aws:s3:::ec2-windows-nvidia-drivers'
      ]
    }, {
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:HeadObject'],
      Resource: [
        `${this.logsBucket.bucketArn}/*`,
        `${this.uploadsBucket.bucketArn}/*`,
        'arn:aws:s3:::ec2-windows-nvidia-drivers/*'
      ]
    }, {
      Effect: 'Allow',
      Action: ['s3:PutObject', 's3:PutObjectAcl'],
      Resource: [
        `${this.logsBucket.bucketArn}/*`
      ]
    }];

    // Add KMS permissions if encryption key is provided
    if (props.encryptionKey) {
      ssmRolePolicyStatements.push({
        Effect: 'Allow',
        Action: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:DescribeKey'
        ],
        Resource: props.encryptionKey.keyArn
      });
    }

    // Add permission to SSM Default Host Management role if it exists
    // This handles accounts with Default Host Management Configuration enabled
    // We target both the standard AWS role name and custom Epoxy role name
    const ssmRoleNames = [
      'AWSSystemsManagerDefaultEC2InstanceManagementRole',
      'EpoxyAWSSystemsManagerDefaultEC2InstanceManagementRole'
    ];
    
    new cdk.CustomResource(this, 'SSMDefaultRolePolicy', {
      serviceToken: cdk.CustomResourceProvider.getOrCreate(this, 'SSMRolePolicyProvider', {
        codeDirectory: 'lambda/iam-role-policy',
        runtime: cdk.CustomResourceProviderRuntime.NODEJS_22_X,
        policyStatements: [{
          Effect: 'Allow',
          Action: ['iam:PutRolePolicy', 'iam:GetRole', 'iam:DeleteRolePolicy'],
          // Include both root path and /service-role/ path for SSM Default Host Management role
          Resource: ssmRoleNames.flatMap(name => [
            `arn:aws:iam::${cdk.Stack.of(this).account}:role/${name}`,
            `arn:aws:iam::${cdk.Stack.of(this).account}:role/service-role/${name}`
          ])
        }]
      }),
      properties: {
        RoleNames: ssmRoleNames,
        PolicyName: 'ImageBuilderSSMRoleAccess',
        PolicyDocument: JSON.stringify({
          Version: '2012-10-17',
          Statement: ssmRolePolicyStatements
        }),
        // Re-apply policy on every deployment to handle cases where AWS automation
        // strips inline policies from managed roles (e.g., Epoxy DHMC role)
        PolicyVersion: new Date().toISOString().split('T')[0]
      }
    });

    // EventBridge rule to automatically apply policy when SSM Default Host Management roles are created
    // This handles the case where the role is created after this stack is deployed
    const ssmRolePolicyLambda = new lambda.Function(this, 'SSMRolePolicyEventHandler', {
      functionName: `${props.pascalCaseName}-SSMRolePolicyHandler`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/iam-role-policy-event')),
      timeout: cdk.Duration.seconds(30),
      environment: {
        POLICY_NAME: 'ImageBuilderSSMRoleAccess',
        POLICY_DOCUMENT: JSON.stringify({
          Version: '2012-10-17',
          Statement: ssmRolePolicyStatements
        }),
        TARGET_ROLE_NAMES: JSON.stringify(ssmRoleNames)
      }
    });

    // Grant the Lambda permission to manage IAM role policies
    ssmRolePolicyLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PutRolePolicy', 'iam:GetRole'],
      resources: ssmRoleNames.flatMap(name => [
        `arn:aws:iam::${cdk.Stack.of(this).account}:role/${name}`,
        `arn:aws:iam::${cdk.Stack.of(this).account}:role/service-role/${name}`
      ])
    }));

    // EventBridge rule to trigger on IAM CreateRole events for the target roles
    new events.Rule(this, 'SSMRoleCreatedRule', {
      ruleName: `${props.pascalCaseName}-SSMRoleCreated`,
      description: 'Triggers when SSM Default Host Management role is created to apply ImageBuilder permissions',
      eventPattern: {
        source: ['aws.iam'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['iam.amazonaws.com'],
          eventName: ['CreateRole', 'DeleteRolePolicy'],
          requestParameters: {
            roleName: ssmRoleNames
          }
        }
      },
      targets: [new targets.LambdaFunction(ssmRolePolicyLambda)]
    });
  }
}
