// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface ObservabilityStackProps extends cdk.StackProps {
  pascalCaseName: string;
  acronym: string;
  encryptionKey?: kms.IKey;
}

export class ObservabilityStack extends cdk.Stack {
  public readonly loggingBucket: s3.Bucket;
  public readonly modelInvocationLogGroup: logs.LogGroup;
  public readonly agentLogGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, {
      ...props,
      description: 'Observability infrastructure for AI Install Script Agent including Bedrock logging and X-Ray tracing',
    });

    const tablePrefix = props.acronym.toLowerCase();

    // S3 bucket for Bedrock model invocation logs
    this.loggingBucket = new s3.Bucket(this, 'BedrockLoggingBucket', {
      bucketName: `${tablePrefix}-bedrock-logs-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Bucket policy for Bedrock service
    this.loggingBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AmazonBedrockLogsWrite',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('bedrock.amazonaws.com')],
      actions: ['s3:PutObject'],
      resources: [`${this.loggingBucket.bucketArn}/bedrock-logs/AWSLogs/${this.account}/BedrockModelInvocationLogs/*`],
      conditions: {
        StringEquals: { 'aws:SourceAccount': this.account },
        ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:${this.region}:${this.account}:*` }
      }
    }));

    // CloudWatch log group for model invocations
    this.modelInvocationLogGroup = new logs.LogGroup(this, 'ModelInvocationLogGroup', {
      logGroupName: `/${props.pascalCaseName}/Bedrock/ModelInvocations`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // CloudWatch Log Group for agent execution
    this.agentLogGroup = new logs.LogGroup(this, 'AgentLogGroup', {
      logGroupName: `/${props.pascalCaseName}/Agent/InstallScriptAgent`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // CloudWatch log group for X-Ray traces (with leading slash - our naming convention)
    new logs.LogGroup(this, 'XRaySpansLogGroup', {
      logGroupName: '/aws/spans/default',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Note: The 'aws/spans' log group (without leading slash) is managed by AWS/X-Ray
    // and will be created automatically when Transaction Search is enabled

    // Service-linked role for Application Signals (X-Ray Transaction Search)
    new iam.CfnServiceLinkedRole(this, 'ApplicationSignalsServiceLinkedRole', {
      awsServiceName: 'application-signals.cloudwatch.amazonaws.com',
      description: 'Service-linked role for CloudWatch Application Signals (X-Ray Transaction Search)',
    });

    // CloudWatch Logs resource policy for X-Ray Transaction Search
    // Note: aws/spans (no leading slash) and /aws/application-signals/data (with leading slash)
    new logs.CfnResourcePolicy(this, 'XRayTransactionSearchPolicy', {
      policyName: `${props.pascalCaseName}-XRayTransactionSearch`,
      policyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'TransactionSearchXRayAccess',
            Effect: 'Allow',
            Principal: {
              Service: 'xray.amazonaws.com'
            },
            Action: 'logs:PutLogEvents',
            Resource: [
              `arn:aws:logs:${this.region}:${this.account}:log-group:aws/spans:*`,
              `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/application-signals/data:*`
            ],
            Condition: {
              ArnLike: {
                'aws:SourceArn': `arn:aws:xray:${this.region}:${this.account}:*`
              },
              StringEquals: {
                'aws:SourceAccount': this.account
              }
            }
          }
        ]
      })
    });

    // IAM role for Bedrock CloudWatch logging
    const loggingRole = new iam.Role(this, 'BedrockLoggingRole', {
      roleName: `${props.pascalCaseName}-BedrockLoggingRole`,
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      inlinePolicies: {
        LoggingPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
              resources: [
                `${this.modelInvocationLogGroup.logGroupArn}`,
                `${this.modelInvocationLogGroup.logGroupArn}:*`
              ]
            })
          ]
        })
      }
    });

    // NOTE: CloudWatch Logs resource policy for Transaction Search is skipped
    // due to AWS limit of 10 resource policies per region. The Lambda function
    // will configure X-Ray Transaction Search settings directly via API.

    // Lambda function to configure Bedrock logging and Transaction Search
    const configureLoggingFunction = new lambda.Function(this, 'ConfigureBedrockLogging', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
# Version: 3.0 - Transaction Search only (V2 delivery moved to AgentCore construct)
import boto3
import json
import cfnresponse

def handler(event, context):
    try:
        bedrock = boto3.client('bedrock')
        xray = boto3.client('xray')
        logs = boto3.client('logs')
        
        if event['RequestType'] == 'Create' or event['RequestType'] == 'Update':
            # Configure Bedrock logging
            bedrock.put_model_invocation_logging_configuration(
                loggingConfig={
                    'textDataDeliveryEnabled': True,
                    'imageDataDeliveryEnabled': True,
                    'embeddingDataDeliveryEnabled': True,
                    's3Config': {
                        'bucketName': event['ResourceProperties']['BucketName'],
                        'keyPrefix': 'bedrock-logs'
                    },
                    'cloudWatchConfig': {
                        'logGroupName': event['ResourceProperties']['LogGroupName'],
                        'roleArn': event['ResourceProperties']['RoleArn']
                    }
                }
            )
            print("Configured Bedrock logging")
            
            # Enable Transaction Search (check if already enabled first)
            try:
                current_destination = xray.get_trace_segment_destination()
                if current_destination.get('Destination') != 'CloudWatchLogs':
                    xray.update_trace_segment_destination(Destination='CloudWatchLogs')
                    print("Enabled Transaction Search destination")
                else:
                    print("Transaction Search destination already enabled")
            except Exception as e:
                print(f"Transaction Search setup: {e}")
            
            # Set sampling percentage to 10%
            try:
                xray.update_indexing_rule(
                    Name='Default',
                    Rule={'Probabilistic': {'DesiredSamplingPercentage': 10}}
                )
                print("Configured Transaction Search sampling")
            except Exception as e:
                print(f"Transaction Search sampling: {e}")
            
            # Create shared log group and resource policy
            account_id = event['ResourceProperties']['AccountId']
            region = event['ResourceProperties']['Region']
            app_logs_group = '/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS'  # pragma: allowlist secret
            
            try:
                logs.create_log_group(logGroupName=app_logs_group)
                print(f"Created shared log group")
            except logs.exceptions.ResourceAlreadyExistsException:
                print(f"Shared log group exists")
            
            try:
                logs.put_resource_policy(
                    policyName='AgentCoreV2DeliveryPolicy',
                    policyDocument=json.dumps({
                        'Version': '2012-10-17',
                        'Statement': [{
                            'Sid': 'AgentCoreDeliveryAccess',
                            'Effect': 'Allow',
                            'Principal': {'Service': 'delivery.logs.amazonaws.com'},
                            'Action': ['logs:CreateLogStream', 'logs:PutLogEvents'],
                            'Resource': f'arn:aws:logs:{region}:{account_id}:log-group:{app_logs_group}:*',
                            'Condition': {
                                'StringEquals': {'aws:SourceAccount': account_id},
                                'ArnLike': {'aws:SourceArn': f'arn:aws:logs:{region}:{account_id}:delivery-source:*'}
                            }
                        }]
                    })
                )
                print("Created resource policy")
            except Exception as e:
                print(f"Resource policy: {e}")
            
        elif event['RequestType'] == 'Delete':
            try:
                bedrock.delete_model_invocation_logging_configuration()
                print("Deleted Bedrock logging")
            except Exception as e:
                print(f"Error: {e}")
        
        cfnresponse.send(event, context, cfnresponse.SUCCESS, {})
        
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        cfnresponse.send(event, context, cfnresponse.FAILED, {})
      `),
      timeout: cdk.Duration.minutes(5),
    });

    // Grant permissions to the Lambda function
    configureLoggingFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:PutModelInvocationLoggingConfiguration',
        'bedrock:DeleteModelInvocationLoggingConfiguration',
        'bedrock:GetModelInvocationLoggingConfiguration',
        'xray:UpdateTraceSegmentDestination',
        'xray:UpdateIndexingRule',
        'xray:GetTraceSegmentDestination',
        'xray:PutResourcePolicy',
        'xray:ListResourcePolicies',
        'application-signals:StartDiscovery',
        'cloudtrail:CreateServiceLinkedChannel',
        'logs:PutDeliverySource',
        'logs:PutDeliveryDestination',
        'logs:CreateDelivery',
        'logs:GetDelivery',
        'logs:GetDeliverySource',
        'logs:GetDeliveryDestination',
        'logs:DeleteDelivery',
        'logs:DeleteDeliverySource',
        'logs:DeleteDeliveryDestination',
        'logs:DescribeDeliveries',
        'logs:DescribeDeliverySources',
        'logs:DescribeDeliveryDestinations',
        'logs:PutResourcePolicy',
        'logs:DescribeResourcePolicies',
        'logs:CreateLogGroup',
        'logs:PutRetentionPolicy'
      ],
      resources: ['*']
    }));

    configureLoggingFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [loggingRole.roleArn]
    }));

    // Permission to create service-linked role for Application Signals (X-Ray Transaction Search)
    configureLoggingFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:CreateServiceLinkedRole'],
      resources: ['arn:aws:iam::*:role/aws-service-role/application-signals.amazonaws.com/*'],
      conditions: {
        StringEquals: {
          'iam:AWSServiceName': 'application-signals.amazonaws.com'
        }
      }
    }));

    // Custom resource to trigger the Lambda function
    const loggingConfig = new cdk.CustomResource(this, 'BedrockLoggingConfig', {
      serviceToken: configureLoggingFunction.functionArn,
      properties: {
        BucketName: this.loggingBucket.bucketName,
        LogGroupName: this.modelInvocationLogGroup.logGroupName,
        RoleArn: loggingRole.roleArn,
        AccountId: this.account,
        Region: this.region,
        Version: '7.0'
      }
    });

    // Ensure IAM policy is fully updated before invoking the custom resource
    loggingConfig.node.addDependency(configureLoggingFunction.role!.node.findChild('DefaultPolicy'));

    // Store SSM parameters for discovery
    new ssm.StringParameter(this, 'LoggingBucketParameter', {
      parameterName: `/${props.pascalCaseName}/Observability/LoggingBucketName`,
      stringValue: this.loggingBucket.bucketName,
      description: 'S3 bucket for Bedrock model invocation logs',
    });

    new ssm.StringParameter(this, 'ModelInvocationLogGroupParameter', {
      parameterName: `/${props.pascalCaseName}/Observability/ModelInvocationLogGroup`,
      stringValue: this.modelInvocationLogGroup.logGroupName,
      description: 'CloudWatch Log Group for Bedrock model invocations',
    });

    new ssm.StringParameter(this, 'AgentLogGroupParameter', {
      parameterName: `/${props.pascalCaseName}/Observability/AgentLogGroup`,
      stringValue: this.agentLogGroup.logGroupName,
      description: 'CloudWatch Log Group for Install Script Agent',
    });

    // Outputs
    new cdk.CfnOutput(this, 'LoggingBucketName', {
      value: this.loggingBucket.bucketName,
      description: 'S3 bucket for Bedrock logs',
    });

    new cdk.CfnOutput(this, 'ModelInvocationLogGroupName', {
      value: this.modelInvocationLogGroup.logGroupName,
      description: 'CloudWatch Log Group for model invocations',
    });

    new cdk.CfnOutput(this, 'AgentLogGroupName', {
      value: this.agentLogGroup.logGroupName,
      description: 'CloudWatch Log Group for agent execution',
    });

    new cdk.CfnOutput(this, 'TransactionSearchEnabled', {
      value: 'true',
      description: 'CloudWatch Transaction Search fully enabled for AgentCore observability'
    });
  }
}
