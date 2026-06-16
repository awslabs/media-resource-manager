// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

export interface AgentCoreRuntimeProps {
  /**
   * Name of the agent (will be converted to underscore format)
   */
  readonly agentName: string;
  
  /**
   * Path to the agent source code directory
   */
  readonly sourceCodePath: string;
  
  /**
   * Memory execution role ARN (optional, will create if not provided)
   */
  readonly memoryExecutionRoleArn?: string;
  
  /**
   * Event expiry duration in days (default: 30, max: 365)
   */
  readonly eventExpiryDuration?: number;
  
  /**
   * Enable long-term memory (default: true)
   */
  readonly enableLongTermMemory?: boolean;

  /**
   * Additional environment variables for the runtime
   */
  readonly environmentVariables?: { [key: string]: string };

  /**
   * Additional IAM policy statements for the execution role
   */
  readonly additionalPolicies?: iam.PolicyStatement[];
}

/**
 * Construct that deploys an agent to Amazon Bedrock AgentCore Runtime.
 * 
 * This creates:
 * - ECR repository for the agent container
 * - CodeBuild project to build and push the container
 * - AgentCore Memory resource for agent state
 * - AgentCore Runtime resource to run the agent
 * - Observability configuration for logs and traces
 */
export class AgentCoreRuntime extends Construct {
  public readonly runtimeArn: string;
  public readonly ecrRepository: ecr.Repository;
  public readonly memoryId: string;
  public readonly executionRole: iam.IRole;
  
  constructor(scope: Construct, id: string, props: AgentCoreRuntimeProps) {
    super(scope, id);
    
    // Validate source code path exists
    const fs = require('fs');
    if (!fs.existsSync(props.sourceCodePath)) {
      throw new Error(`Source code path does not exist: ${props.sourceCodePath}`);
    }
    
    // Convert agent name to underscore format (like CLI does)
    const normalizedAgentName = props.agentName.replace(/-/g, '_');
    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;
    
    // Create or use existing execution role
    this.executionRole = props.memoryExecutionRoleArn ? 
      iam.Role.fromRoleArn(this, 'ExecutionRole', props.memoryExecutionRoleArn) :
      this.createExecutionRole(normalizedAgentName, region, account, props.additionalPolicies);

    // Create AgentCore Memory
    const memory = new cdk.CfnResource(this, 'Memory', {
      type: 'AWS::BedrockAgentCore::Memory',
      properties: {
        Name: `${normalizedAgentName}_memory`,
        Description: `Memory store for ${props.agentName} agent`,
        EventExpiryDuration: Math.min(props.eventExpiryDuration || 30, 365),
        MemoryExecutionRoleArn: this.executionRole.roleArn
      }
    });
    
    this.memoryId = memory.ref;
    
    // Store memory ID in SSM
    new ssm.StringParameter(this, 'MemoryIdParameter', {
      parameterName: `/agentcore/${normalizedAgentName}/memory-id`,
      stringValue: cdk.Fn.select(1, cdk.Fn.split('/', this.memoryId)),
      description: `AgentCore Memory ID for ${props.agentName}`
    });
    
    // Create ECR Repository
    this.ecrRepository = new ecr.Repository(this, 'ECRRepository', {
      repositoryName: `bedrock-agentcore-${normalizedAgentName}`,
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [{
        maxImageCount: 10,
        description: 'Keep only 10 most recent images'
      }]
    });
    
    // Create source asset
    const sourceAsset = new s3assets.Asset(this, 'SourceAsset', {
      path: props.sourceCodePath
    });

    // CodeBuild project to build and push container
    const codeBuildProject = new codebuild.Project(this, 'CodeBuildProject', {
      projectName: `bedrock-agentcore-${normalizedAgentName}-builder`,
      source: codebuild.Source.s3({
        bucket: sourceAsset.bucket,
        path: sourceAsset.s3ObjectKey
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_ARM_3,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: [
              'echo "Building Docker image..."',
              'docker build -t bedrock-agentcore-arm64 .',
              'echo "Authenticating with ECR..."',
              `aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin ${account}.dkr.ecr.${region}.amazonaws.com/${this.ecrRepository.repositoryName}`,
              'echo "Tagging image..."',
              `docker tag bedrock-agentcore-arm64:latest ${this.ecrRepository.repositoryUri}:latest`
            ]
          },
          post_build: {
            commands: [
              'echo "Pushing image to ECR..."',
              `docker push ${this.ecrRepository.repositoryUri}:latest`,
              'echo "Build completed at $(date)"'
            ]
          }
        }
      })
    });
    
    // Grant CodeBuild permissions
    this.ecrRepository.grantPullPush(codeBuildProject);
    sourceAsset.grantRead(codeBuildProject);

    // Create WaitCondition for build completion
    const buildWaitHandle = new cdk.CfnWaitConditionHandle(this, 'BuildWaitHandle');
    const buildWaitCondition = new cdk.CfnWaitCondition(this, 'BuildWaitCondition', {
      handle: buildWaitHandle.ref,
      timeout: '3600',
      count: 1
    });

    // Lambda to trigger CodeBuild
    const buildTrigger = new lambda.Function(this, 'BuildTriggerFunction', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(2),
      code: lambda.Code.fromInline(`
import json
import boto3
import urllib3

def handler(event, context):
    try:
        if event['RequestType'] == 'Create' or event['RequestType'] == 'Update':
            codebuild = boto3.client('codebuild')
            response = codebuild.start_build(projectName='${codeBuildProject.projectName}')
            build_id = response['build']['id']
            print(f"Started CodeBuild: {build_id}")
            send_response(event, context, 'SUCCESS', f'Build started: {build_id}')
        else:
            send_response(event, context, 'SUCCESS', 'No action needed')
    except Exception as e:
        print(f"Error: {str(e)}")
        send_response(event, context, 'FAILED', str(e))

def send_response(event, context, status, reason):
    response_body = {
        'Status': status,
        'Reason': reason,
        'PhysicalResourceId': context.log_stream_name,
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId']
    }
    http = urllib3.PoolManager()
    http.request('PUT', event['ResponseURL'], 
                body=json.dumps(response_body),
                headers={'Content-Type': 'application/json'})
`)
    });

    buildTrigger.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['codebuild:StartBuild'],
      resources: [codeBuildProject.projectArn]
    }));

    // Lambda to handle build completion
    const buildCompletionHandler = new lambda.Function(this, 'BuildCompletionHandler', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(2),
      environment: {
        WAIT_HANDLE_URL: buildWaitHandle.ref
      },
      code: lambda.Code.fromInline(`
import json
import urllib3
import os

def handler(event, context):
    try:
        build_status = event['detail']['build-status']
        project_name = event['detail']['project-name']
        build_id = event['detail']['build-id']
        wait_handle_url = os.environ['WAIT_HANDLE_URL']
        
        print(f"Build {project_name} ({build_id}) completed with status: {build_status}")
        
        if build_status == 'SUCCEEDED':
            response_body = json.dumps({
                "Status": "SUCCESS",
                "Reason": f"Build {build_id} completed successfully",
                "UniqueId": build_id,
                "Data": f"Build finished with status: {build_status}"
            })
        else:
            response_body = json.dumps({
                "Status": "FAILURE", 
                "Reason": f"Build {build_id} failed with status: {build_status}",
                "UniqueId": build_id,
                "Data": f"Build failed with status: {build_status}"
            })
        
        http = urllib3.PoolManager()
        response = http.request('PUT', wait_handle_url, 
                               body=response_body,
                               headers={'Content-Type': 'application/json'})
        print(f"WaitCondition signal sent, response: {response.status}")
        
    except Exception as e:
        print(f"Error in build completion handler: {str(e)}")
`)
    });

    // EventBridge rule for build completion
    new events.Rule(this, 'BuildCompletionRule', {
      eventPattern: {
        source: ['aws.codebuild'],
        detailType: ['CodeBuild Build State Change'],
        detail: {
          'project-name': [codeBuildProject.projectName],
          'build-status': ['SUCCEEDED', 'FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT']
        }
      },
      targets: [new targets.LambdaFunction(buildCompletionHandler)]
    });

    // Custom resource to trigger build - uses source asset hash to only rebuild when code changes
    const buildTriggerResource = new cdk.CustomResource(this, 'BuildTrigger', {
      serviceToken: buildTrigger.functionArn,
      properties: {
        ProjectName: codeBuildProject.projectName,
        SourceHash: sourceAsset.assetHash, // Only rebuild when source code changes
      }
    });
    buildTriggerResource.node.addDependency(sourceAsset);
    
    // Create AgentCore Runtime
    const runtimeSuffix = sourceAsset.assetHash.substring(0, 8);
    const agentRuntime = new cdk.CfnResource(this, 'AgentCoreRuntime', {
      type: 'AWS::BedrockAgentCore::Runtime',
      properties: {
        AgentRuntimeName: `${normalizedAgentName}_${runtimeSuffix}`,
        Description: `AgentCore Runtime for ${props.agentName}`,
        AgentRuntimeArtifact: {
          ContainerConfiguration: {
            ContainerUri: `${this.ecrRepository.repositoryUri}:latest`
          }
        },
        RoleArn: this.executionRole.roleArn,
        NetworkConfiguration: {
          NetworkMode: 'PUBLIC'
        },
        EnvironmentVariables: {
          AGENTCORE_MEMORY_ARN: this.memoryId,
          ...props.environmentVariables
        }
      }
    });

    // Runtime depends on memory, ECR, and build completion
    agentRuntime.addDependency(memory);
    agentRuntime.addDependency(this.ecrRepository.node.defaultChild as cdk.CfnResource);
    agentRuntime.addDependency(buildWaitCondition);

    this.runtimeArn = agentRuntime.getAtt('AgentRuntimeArn').toString();
    const runtimeId = agentRuntime.getAtt('AgentRuntimeId').toString();

    // Force runtime to refresh container image after creation/update
    const runtimeRefresher = new lambda.Function(this, 'RuntimeRefresher', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(5),
      code: lambda.Code.fromInline(`
import json
import boto3
import urllib3
import time

def handler(event, context):
    try:
        if event['RequestType'] == 'Delete':
            send_response(event, context, 'SUCCESS', 'No action needed for delete')
            return
        
        runtime_id = event['ResourceProperties']['RuntimeId']
        container_uri = event['ResourceProperties']['ContainerUri']
        role_arn = event['ResourceProperties']['RoleArn']
        region = event['ResourceProperties']['Region']
        env_vars = event['ResourceProperties'].get('EnvironmentVariables', {})
        
        print(f"Refreshing runtime {runtime_id} to pull latest image from {container_uri}")
        print(f"Environment variables: {list(env_vars.keys())}")
        
        client = boto3.client('bedrock-agentcore-control', region_name=region)
        
        # Wait for runtime to be READY first
        for i in range(30):
            response = client.get_agent_runtime(agentRuntimeId=runtime_id)
            status = response.get('status')
            print(f"Runtime status: {status}")
            if status == 'READY':
                break
            elif status in ['FAILED', 'DELETING']:
                raise Exception(f"Runtime in bad state: {status}")
            time.sleep(10)
        
        # Update runtime to force image refresh and update env vars
        update_params = {
            'agentRuntimeId': runtime_id,
            'agentRuntimeArtifact': {
                'containerConfiguration': {
                    'containerUri': container_uri
                }
            },
            'roleArn': role_arn,
            'networkConfiguration': {'networkMode': 'PUBLIC'},
            'description': f'Refreshed at {int(time.time())}'
        }
        
        # Include environment variables if provided
        if env_vars:
            update_params['environmentVariables'] = env_vars
        
        response = client.update_agent_runtime(**update_params)
        
        print(f"Update initiated, new version: {response.get('agentRuntimeVersion')}")
        
        # Wait for update to complete
        for i in range(30):
            response = client.get_agent_runtime(agentRuntimeId=runtime_id)
            status = response.get('status')
            print(f"Runtime status after update: {status}")
            if status == 'READY':
                send_response(event, context, 'SUCCESS', f'Runtime refreshed successfully')
                return
            elif status in ['FAILED']:
                raise Exception(f"Runtime update failed: {status}")
            time.sleep(10)
        
        send_response(event, context, 'SUCCESS', 'Runtime update initiated')
        
    except Exception as e:
        print(f"Error: {str(e)}")
        # Don't fail the deployment, just log the error
        send_response(event, context, 'SUCCESS', f'Warning: {str(e)}')

def send_response(event, context, status, reason):
    response_body = {
        'Status': status,
        'Reason': reason,
        'PhysicalResourceId': context.log_stream_name,
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId']
    }
    http = urllib3.PoolManager()
    http.request('PUT', event['ResponseURL'], 
                body=json.dumps(response_body),
                headers={'Content-Type': 'application/json'})
`)
    });

    runtimeRefresher.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock-agentcore:UpdateAgentRuntime',
        'bedrock-agentcore:GetAgentRuntime'
      ],
      resources: [`arn:aws:bedrock-agentcore:${region}:${account}:runtime/*`]
    }));

    runtimeRefresher.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [this.executionRole.roleArn]
    }));

    // Hash environment variables to detect config changes
    const envVarsHash = Buffer.from(JSON.stringify({
      AGENTCORE_MEMORY_ARN: 'memory-ref', // Use placeholder since actual ID isn't available at synth time
      ...props.environmentVariables
    })).toString('base64').substring(0, 32);

    const runtimeRefreshResource = new cdk.CustomResource(this, 'RuntimeRefresh', {
      serviceToken: runtimeRefresher.functionArn,
      properties: {
        RuntimeId: runtimeId,
        ContainerUri: `${this.ecrRepository.repositoryUri}:latest`,
        RoleArn: this.executionRole.roleArn,
        Region: region,
        EnvironmentVariables: {
          AGENTCORE_MEMORY_ARN: this.memoryId,
          ...props.environmentVariables
        },
        SourceHash: sourceAsset.assetHash, // Refresh when source code changes
        EnvVarsHash: envVarsHash, // Refresh when environment variables change
      }
    });
    runtimeRefreshResource.node.addDependency(agentRuntime);

    // Store runtime ARN in SSM
    new ssm.StringParameter(this, 'RuntimeArnParameter', {
      parameterName: `/agentcore/${normalizedAgentName}/runtime-arn`,
      stringValue: this.runtimeArn,
      description: `AgentCore Runtime ARN for ${props.agentName}`
    });

    // Configure observability
    this.configureObservability(normalizedAgentName, region, account);

    // Outputs
    new cdk.CfnOutput(this, 'RuntimeArn', {
      value: this.runtimeArn,
      description: `${props.agentName} AgentCore Runtime ARN`
    });

    new cdk.CfnOutput(this, 'MemoryId', {
      value: this.memoryId,
      description: `${props.agentName} AgentCore Memory ID`
    });

    new cdk.CfnOutput(this, 'ECRRepositoryUri', {
      value: this.ecrRepository.repositoryUri,
      description: `${props.agentName} ECR Repository URI`
    });
  }

  private createExecutionRole(
    normalizedAgentName: string,
    region: string,
    account: string,
    additionalPolicies?: iam.PolicyStatement[]
  ): iam.Role {
    const role = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: `Execution role for ${normalizedAgentName} AgentCore Runtime`
    });

    // ECR permissions
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ecr:GetAuthorizationToken',
        'ecr:BatchCheckLayerAvailability', 
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage'
      ],
      resources: ['*']
    }));

    // Bedrock permissions
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream'
      ],
      resources: [
        `arn:aws:bedrock:${region}::foundation-model/*`,
        `arn:aws:bedrock:${region}:${account}:*`
      ]
    }));

    // CloudWatch Logs permissions
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:DescribeLogStreams',
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents'
      ],
      resources: [
        `arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
        `arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`
      ]
    }));

    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['logs:DescribeLogGroups'],
      resources: [`arn:aws:logs:${region}:${account}:log-group:*`]
    }));

    // X-Ray permissions
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'xray:PutTraceSegments',
        'xray:PutTelemetryRecords',
        'xray:GetSamplingRules',
        'xray:GetSamplingTargets'
      ],
      resources: ['*']
    }));

    // CloudWatch Metrics
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'cloudwatch:namespace': 'bedrock-agentcore'
        }
      }
    }));

    // AgentCore Memory permissions
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock-agentcore:CreateEvent',
        'bedrock-agentcore:GetEvent',
        'bedrock-agentcore:ListEvents',
        'bedrock-agentcore:DeleteEvent',
        'bedrock-agentcore:AllowVendedLogDeliveryForResource'
      ],
      resources: [`arn:aws:bedrock-agentcore:${region}:${account}:*`]
    }));

    // Add any additional policies
    if (additionalPolicies) {
      additionalPolicies.forEach(policy => role.addToPolicy(policy));
    }

    return role;
  }

  private configureObservability(normalizedAgentName: string, region: string, account: string): void {
    const observabilityConfig = new lambda.Function(this, 'ObservabilityConfig', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(2),
      role: new iam.Role(this, 'ObservabilityConfigRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
          iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')
        ]
      }),
      code: lambda.Code.fromInline(`
import boto3
import cfnresponse

def handler(event, context):
    try:
        if event['RequestType'] == 'Delete':
            cfnresponse.send(event, context, cfnresponse.SUCCESS, {})
            return
        
        logs = boto3.client('logs')
        runtime_arn = event['ResourceProperties']['RuntimeArn']
        runtime_name = event['ResourceProperties']['RuntimeName']
        account_id = event['ResourceProperties']['AccountId']
        region = event['ResourceProperties']['Region']
        log_group = event['ResourceProperties']['LogGroup']
        
        # Helper to create or update delivery source
        def ensure_delivery_source(name, log_type, resource_arn):
            try:
                # Try to get existing source
                existing = logs.get_delivery_source(name=name)
                existing_arn = existing.get('deliverySource', {}).get('resourceArn', '')
                
                # If ARN changed, delete and recreate
                if existing_arn != resource_arn:
                    print(f"Delivery source {name} exists with different ARN, deleting...")
                    try:
                        # First delete any deliveries using this source
                        deliveries = logs.describe_deliveries()
                        for delivery in deliveries.get('deliveries', []):
                            if delivery.get('deliverySourceName') == name:
                                logs.delete_delivery(id=delivery['id'])
                                print(f"Deleted delivery {delivery['id']}")
                    except Exception as e:
                        print(f"Error deleting deliveries: {e}")
                    
                    logs.delete_delivery_source(name=name)
                    print(f"Deleted delivery source {name}")
                    
                    # Now create with new ARN
                    logs.put_delivery_source(
                        name=name,
                        logType=log_type,
                        resourceArn=resource_arn
                    )
                    print(f"Created delivery source {name} with new ARN")
                else:
                    print(f"Delivery source {name} already exists with correct ARN")
            except logs.exceptions.ResourceNotFoundException:
                # Source doesn't exist, create it
                logs.put_delivery_source(
                    name=name,
                    logType=log_type,
                    resourceArn=resource_arn
                )
                print(f"Created delivery source {name}")
            except Exception as e:
                print(f"Error with delivery source {name}: {e}")
                raise
        
        # Create/update delivery sources
        ensure_delivery_source(f"{runtime_name}-logs-source", "APPLICATION_LOGS", runtime_arn)
        ensure_delivery_source(f"{runtime_name}-traces-source", "TRACES", runtime_arn)
        
        # Create destinations (these are idempotent)
        try:
            logs_dest = logs.put_delivery_destination(
                name=f"{runtime_name}-logs-destination",
                deliveryDestinationType='CWL',
                deliveryDestinationConfiguration={
                    'destinationResourceArn': f'arn:aws:logs:{region}:{account_id}:log-group:{log_group}'
                }
            )
        except Exception as e:
            print(f"Error creating logs destination: {e}")
            # Try to get existing
            logs_dest = {'deliveryDestination': {'arn': f'arn:aws:logs:{region}:{account_id}:delivery-destination:{runtime_name}-logs-destination'}}
        
        try:
            traces_dest = logs.put_delivery_destination(
                name=f"{runtime_name}-traces-destination",
                deliveryDestinationType='XRAY'
            )
        except Exception as e:
            print(f"Error creating traces destination: {e}")
            traces_dest = {'deliveryDestination': {'arn': f'arn:aws:logs:{region}:{account_id}:delivery-destination:{runtime_name}-traces-destination'}}
        
        # Create deliveries (skip if already exists)
        try:
            logs.create_delivery(
                deliverySourceName=f"{runtime_name}-logs-source",
                deliveryDestinationArn=logs_dest['deliveryDestination']['arn']
            )
        except Exception as e:
            if 'ResourceAlreadyExistsException' not in str(type(e)):
                print(f"Error creating logs delivery: {e}")
        
        try:
            logs.create_delivery(
                deliverySourceName=f"{runtime_name}-traces-source",
                deliveryDestinationArn=traces_dest['deliveryDestination']['arn']
            )
        except Exception as e:
            if 'ResourceAlreadyExistsException' not in str(type(e)):
                print(f"Error creating traces delivery: {e}")
        
        cfnresponse.send(event, context, cfnresponse.SUCCESS, {})
    except Exception as e:
        print(f"Error: {e}")
        cfnresponse.send(event, context, cfnresponse.FAILED, {})
      `)
    });

    // Hash observability config inputs - only update when config changes
    const crypto = require('crypto');
    const observabilityHash = crypto.createHash('md5').update([
      normalizedAgentName,
      region,
      account,
      '/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS'
    ].join('|')).digest('hex').substring(0, 32);

    new cdk.CustomResource(this, 'RuntimeObservability', {
      serviceToken: observabilityConfig.functionArn,
      properties: {
        RuntimeArn: this.runtimeArn,
        RuntimeName: normalizedAgentName,
        AccountId: account,
        Region: region,
        LogGroup: '/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS',
        ConfigHash: observabilityHash, // Only update when observability config changes
      }
    });
  }
}
