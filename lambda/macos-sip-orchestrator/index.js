// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * macOS SIP Orchestrator Lambda
 * 
 * This Lambda is triggered by Image Builder WaitForAction step. It:
 * 1. Gets the instance ID from the Image Builder workflow step outputs
 * 2. Calls the EC2 API to disable SIP using ec2-user credentials
 * 3. Stores the task info in DynamoDB for the poller to pick up
 * 4. Returns immediately (the poller Lambda will call RESUME when SIP completes)
 * 
 * IMPORTANT: On macOS Sequoia (15.x), the secure token for ec2-user is bootstrapped
 * at first boot via user data in the infrastructure configuration. This Lambda
 * assumes the token is already enabled and just calls the SIP disable API.
 * 
 * The WaitForAction step has a default timeout of 3 days (max 7 days),
 * so we don't need to poll here - the separate poller Lambda handles that.
 */

const { EC2Client, DescribeInstancesCommand, CreateMacSystemIntegrityProtectionModificationTaskCommand } = require('@aws-sdk/client-ec2');
const { ImagebuilderClient, SendWorkflowStepActionCommand, ListWorkflowStepExecutionsCommand, GetWorkflowStepExecutionCommand } = require('@aws-sdk/client-imagebuilder');
const { SSMClient, SendCommandCommand, GetCommandInvocationCommand } = require('@aws-sdk/client-ssm');
const { EventBridgeClient, EnableRuleCommand } = require('@aws-sdk/client-eventbridge');
const { DynamoDBDocumentClient, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const ec2 = new EC2Client();
const imagebuilder = new ImagebuilderClient();
const ssm = new SSMClient();
const eventbridge = new EventBridgeClient();
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient());
const secretsManager = new SecretsManagerClient();

// ec2-user credentials - password is retrieved from Secrets Manager at runtime
const EC2_USER = 'ec2-user';
let EC2_USER_PASSWORD = null; // Loaded lazily from Secrets Manager

// Retrieve the SIP admin password from Secrets Manager (cached for Lambda container lifetime)
async function getEc2UserPassword() {
  if (EC2_USER_PASSWORD) return EC2_USER_PASSWORD;
  
  const secretArn = process.env.SIP_ADMIN_PASSWORD_SECRET_ARN;
  if (!secretArn) {
    throw new Error('SIP_ADMIN_PASSWORD_SECRET_ARN environment variable not set');
  }
  
  const response = await secretsManager.send(new GetSecretValueCommand({
    SecretId: secretArn,
  }));
  
  EC2_USER_PASSWORD = response.SecretString;
  console.log('Retrieved SIP admin password from Secrets Manager');
  return EC2_USER_PASSWORD;
}

exports.handler = async (event) => {
  console.log('SIP Orchestrator triggered:', JSON.stringify(event, null, 2));
  
  // Load the SIP admin password from Secrets Manager (cached after first call)
  await getEc2UserPassword();
  
  let imageBuildVersionArn;
  
  try {
    // Parse event - can come from WaitForAction step (direct invocation)
    let stepExecutionId, workflowExecutionId, instanceId;
    
    if (event.detail) {
      // EventBridge event format (legacy)
      const detail = event.detail;
      imageBuildVersionArn = detail['image-build-version-arn'];
      stepExecutionId = detail['workflow-step-metadata']?.['step-execution-id'];
      workflowExecutionId = detail['workflow-execution-id'];
    } else if (event.imageArn) {
      // Direct Lambda invocation from WaitForAction step
      imageBuildVersionArn = event.imageArn;
      stepExecutionId = event.workflowStepExecutionId;
      workflowExecutionId = event.workflowExecutionId;
    } else {
      throw new Error('Unknown event format - missing both detail and imageArn');
    }
    
    if (!imageBuildVersionArn || !stepExecutionId) {
      throw new Error(`Missing required fields: imageBuildVersionArn=${imageBuildVersionArn}, stepExecutionId=${stepExecutionId}`);
    }
    
    console.log(`Processing workflow step: ${stepExecutionId} for image: ${imageBuildVersionArn}`);
    
    // Get the instance ID from the LaunchBuildInstance step output via Image Builder API
    // This is the reliable way to get the correct instance ID for the current workflow
    console.log('Getting instance ID from Image Builder workflow step outputs...');
    instanceId = await getInstanceIdFromWorkflow(workflowExecutionId);
    
    if (!instanceId) {
      // Fallback to EC2 tag search (legacy behavior, less reliable)
      console.log('WARNING: Could not get instance ID from workflow, falling back to EC2 tag search');
      instanceId = await getInstanceIdFromEC2Tags();
    }
    
    console.log(`Using instance ID: ${instanceId}`);
    
    // Update pipeline status
    await updatePipelineStatus('sip-disable-starting', `Disabling SIP on instance ${instanceId}`, imageBuildVersionArn);
    
    // Verify secure token is enabled (should be from user data at boot)
    console.log('Verifying secure token status for ec2-user...');
    await verifySecureToken(instanceId);
    
    // Create SIP disable task using ec2-user credentials
    console.log('Creating SIP modification task...');
    const taskId = await createSIPDisableTask(instanceId);
    console.log(`SIP modification task created: ${taskId}`);
    
    // Store task info in DynamoDB for the poller to pick up
    await storeSIPTask({
      taskId,
      instanceId,
      imageBuildVersionArn,
      stepExecutionId,
      workflowExecutionId,
      status: 'in-progress',
      createdAt: new Date().toISOString()
    });
    
    // Enable the poller schedule (it starts disabled)
    await enablePollerSchedule();
    
    await updatePipelineStatus('sip-disable-in-progress', `SIP disable task: ${taskId} - poller will monitor completion`, imageBuildVersionArn);
    
    console.log('SIP task started successfully. Poller Lambda will monitor and call RESUME when complete.');
    return { 
      statusCode: 200, 
      body: 'SIP disable task started. Poller will handle completion.',
      taskId,
      instanceId
    };
    
  } catch (error) {
    console.error('SIP Orchestrator error:', error);
    
    await updatePipelineStatus('sip-disable-failed', error.message, imageBuildVersionArn);
    
    // Stop the workflow on failure
    try {
      let failImageArn, failStepId;
      if (event.detail) {
        failImageArn = event.detail['image-build-version-arn'];
        failStepId = event.detail['workflow-step-metadata']?.['step-execution-id'];
      } else if (event.imageArn) {
        failImageArn = event.imageArn;
        failStepId = event.workflowStepExecutionId;
      }
      if (failImageArn && failStepId) {
        await stopWorkflow(failImageArn, failStepId, error.message);
      }
    } catch (stopError) {
      console.error('Failed to stop workflow:', stopError);
    }
    
    throw error;
  }
};

/**
 * Get the instance ID from the LaunchBuildInstance step output using Image Builder API.
 * This is the reliable way to get the correct instance ID for the current workflow,
 * even when Image Builder retries with multiple instances.
 */
async function getInstanceIdFromWorkflow(workflowExecutionId) {
  if (!workflowExecutionId) {
    console.log('No workflowExecutionId provided, cannot query workflow steps');
    return null;
  }
  
  try {
    // List all step executions for this workflow
    console.log(`Listing workflow step executions for: ${workflowExecutionId}`);
    const listResponse = await imagebuilder.send(new ListWorkflowStepExecutionsCommand({
      workflowExecutionId
    }));
    
    console.log(`Found ${listResponse.steps?.length || 0} workflow steps`);
    
    // Find the LaunchBuildInstance step
    const launchStep = listResponse.steps?.find(step => step.name === 'LaunchBuildInstance');
    
    if (!launchStep) {
      console.log('LaunchBuildInstance step not found in workflow');
      console.log('Available steps:', listResponse.steps?.map(s => s.name).join(', '));
      return null;
    }
    
    console.log(`Found LaunchBuildInstance step: ${launchStep.stepExecutionId}`);
    
    // Get the detailed step execution to retrieve outputs
    const stepResponse = await imagebuilder.send(new GetWorkflowStepExecutionCommand({
      stepExecutionId: launchStep.stepExecutionId
    }));
    
    // Extract instance ID from outputs
    // The outputs field contains the step outputs as a JSON string
    if (stepResponse.outputs) {
      console.log('Step outputs:', stepResponse.outputs);
      const outputs = JSON.parse(stepResponse.outputs);
      if (outputs.instanceId) {
        console.log(`SUCCESS: Found instanceId in step outputs: ${outputs.instanceId}`);
        return outputs.instanceId;
      }
    }
    
    console.log('instanceId not found in step outputs');
    return null;
    
  } catch (error) {
    console.error('Error getting instance ID from workflow:', error);
    return null;
  }
}

/**
 * Fallback: Find the Image Builder instance via EC2 tags.
 * This is less reliable when multiple builds are running or when Image Builder retries.
 */
async function getInstanceIdFromEC2Tags() {
  const instancesResponse = await ec2.send(new DescribeInstancesCommand({
    Filters: [
      { Name: 'tag:CreatedBy', Values: ['EC2 Image Builder'] },
      { Name: 'instance-state-name', Values: ['running'] },
      { Name: 'instance-type', Values: ['mac2.metal', 'mac2-m2.metal', 'mac2-m2pro.metal'] }
    ]
  }));
  
  const instances = instancesResponse.Reservations?.flatMap(r => r.Instances) || [];
  
  if (instances.length === 0) {
    throw new Error('No running macOS Image Builder instance found');
  }
  
  // Return the most recently launched instance
  instances.sort((a, b) => new Date(b.LaunchTime) - new Date(a.LaunchTime));
  console.log(`Found ${instances.length} running macOS instances, using most recent: ${instances[0].InstanceId}`);
  return instances[0].InstanceId;
}

/**
 * Verify that ec2-user has a secure token enabled.
 * The token should have been bootstrapped at first boot via user data.
 */
async function verifySecureToken(instanceId) {
  const checkTokenCommand = await ssm.send(new SendCommandCommand({
    InstanceIds: [instanceId],
    DocumentName: 'AWS-RunShellScript',
    Parameters: {
      commands: [
        `echo "Checking secure token status for ${EC2_USER}..."`,
        `sysadminctl -secureTokenStatus ${EC2_USER} 2>&1`,
        `echo "Verifying password authentication..."`,
        `dscl /Local/Default -authonly ${EC2_USER} '${EC2_USER_PASSWORD}' 2>&1 && echo "Password auth: SUCCESS" || echo "Password auth: FAILED"`
      ]
    }
  }));
  
  const result = await waitForSSMCommand(instanceId, checkTokenCommand.Command.CommandId);
  console.log('Secure token verification output:', result.StandardOutputContent);
  
  if (!result.StandardOutputContent.includes('ENABLED')) {
    throw new Error(`Secure token is NOT enabled for ${EC2_USER}. User data may not have run correctly. Output: ${result.StandardOutputContent}`);
  }
  
  if (result.StandardOutputContent.includes('Password auth: FAILED')) {
    throw new Error(`Password authentication failed for ${EC2_USER}. Output: ${result.StandardOutputContent}`);
  }
  
  console.log(`Secure token verified for ${EC2_USER}`);
}

async function createSIPDisableTask(instanceId) {
  // Use ec2-user credentials (which has a secure token from user data bootstrap)
  // MacCredentials must be a JSON string - note lowercase 'p' in rootVolumepassword per AWS API docs:
  // https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_CreateMacSystemIntegrityProtectionModificationTask.html
  const macCredentials = JSON.stringify({
    internalDiskPassword: '',
    rootVolumeUsername: EC2_USER,
    rootVolumepassword: EC2_USER_PASSWORD  // lowercase 'p' is required!
  });
  
  console.log(`Creating SIP disable task for instance ${instanceId}`);
  console.log(`MacCredentials: {"internalDiskPassword":"","rootVolumeUsername":"${EC2_USER}","rootVolumepassword":"***"}`);
  
  const response = await ec2.send(new CreateMacSystemIntegrityProtectionModificationTaskCommand({
    InstanceId: instanceId,
    MacSystemIntegrityProtectionStatus: 'disabled',
    MacCredentials: macCredentials
  }));
  
  return response.MacModificationTask.MacModificationTaskId;
}

async function storeSIPTask(taskInfo) {
  // Store in DynamoDB for the poller to pick up
  const tableName = process.env.SIP_TASKS_TABLE_NAME;
  
  await dynamodb.send(new PutCommand({
    TableName: tableName,
    Item: {
      taskId: taskInfo.taskId,
      instanceId: taskInfo.instanceId,
      imageBuildVersionArn: taskInfo.imageBuildVersionArn,
      stepExecutionId: taskInfo.stepExecutionId,
      workflowExecutionId: taskInfo.workflowExecutionId,
      status: taskInfo.status,
      createdAt: taskInfo.createdAt,
      ttl: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60) // 7 day TTL
    }
  }));
  
  console.log(`Stored SIP task ${taskInfo.taskId} in DynamoDB`);
}

async function enablePollerSchedule() {
  const ruleName = process.env.SIP_POLLER_RULE_NAME;
  if (!ruleName) {
    console.warn('SIP_POLLER_RULE_NAME not set, skipping rule enable');
    return;
  }
  
  try {
    await eventbridge.send(new EnableRuleCommand({ Name: ruleName }));
    console.log(`Enabled poller schedule rule: ${ruleName}`);
  } catch (error) {
    console.warn(`Could not enable poller rule: ${error.message}`);
  }
}

async function stopWorkflow(imageBuildVersionArn, stepExecutionId, reason) {
  if (!imageBuildVersionArn || !stepExecutionId) {
    console.warn('Cannot stop workflow: missing ARN or step ID');
    return;
  }
  
  await imagebuilder.send(new SendWorkflowStepActionCommand({
    action: 'STOP',
    imageBuildVersionArn,
    stepExecutionId,
    clientToken: `stop-${Date.now()}`,
    reason: `SIP orchestration failed: ${reason}`
  }));
}

async function waitForSSMCommand(instanceId, commandId, maxWaitMs = 120000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await ssm.send(new GetCommandInvocationCommand({
        CommandId: commandId,
        InstanceId: instanceId
      }));
      
      if (response.Status === 'Success') {
        return response;
      } else if (['Failed', 'Cancelled', 'TimedOut'].includes(response.Status)) {
        throw new Error(`SSM command failed: ${response.Status} - ${response.StandardErrorContent || response.StandardOutputContent}`);
      }
    } catch (error) {
      if (error.name !== 'InvocationDoesNotExist') {
        throw error;
      }
    }
    
    await sleep(5000);
  }
  
  throw new Error('SSM command timed out');
}

async function updatePipelineStatus(status, message, imageBuildVersionArn) {
  // Extract pipeline ID from the image ARN
  // ARN format: arn:aws:imagebuilder:region:account:image/MediaResourceManager-macOS-Tahoe-DCV-Ready-Pipeline/1.0.0/1
  let pipelineId = null;
  
  if (imageBuildVersionArn) {
    const arnParts = imageBuildVersionArn.split('/');
    if (arnParts.length >= 2) {
      const imageName = arnParts[1].toLowerCase();
      if (imageName.includes('tahoe')) {
        pipelineId = 'system-macos-tahoe-dcv-ready';
      } else if (imageName.includes('sonoma')) {
        pipelineId = 'system-macos-sonoma-dcv-ready';
      } else if (imageName.includes('sequoia')) {
        pipelineId = 'system-macos-sequoia-dcv-ready';
      }
    }
  }
  
  if (!pipelineId) {
    console.warn(`Could not determine pipeline ID from ARN: ${imageBuildVersionArn}`);
    return;
  }
  
  try {
    await dynamodb.send(new UpdateCommand({
      TableName: process.env.PIPELINES_TABLE_NAME,
      Key: { pipelineId },
      UpdateExpression: 'SET #status = :status, statusMessage = :message, updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': status,
        ':message': message,
        ':updatedAt': new Date().toISOString()
      }
    }));
    console.log(`Updated pipeline ${pipelineId} status to ${status}`);
  } catch (error) {
    console.warn('Failed to update pipeline status:', error.message);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
