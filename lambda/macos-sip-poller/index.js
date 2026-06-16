// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * macOS SIP Poller Lambda
 * 
 * This Lambda runs on a schedule (every 2 minutes) to check the status of
 * SIP modification tasks. When a task completes (success or failure), it:
 * 1. Calls SendWorkflowStepAction to RESUME or STOP the Image Builder workflow
 * 2. Updates the task status in DynamoDB
 * 3. Updates the pipeline status
 * 
 * This architecture allows SIP tasks (which can take up to 90 minutes) to be
 * monitored without hitting Lambda's 15-minute timeout.
 */

const { EC2Client, DescribeMacModificationTasksCommand } = require('@aws-sdk/client-ec2');
const { ImagebuilderClient, SendWorkflowStepActionCommand } = require('@aws-sdk/client-imagebuilder');
const { EventBridgeClient, DisableRuleCommand } = require('@aws-sdk/client-eventbridge');
const { SSMClient, DescribeInstanceInformationCommand } = require('@aws-sdk/client-ssm');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');

const ec2 = new EC2Client();
const imagebuilder = new ImagebuilderClient();
const eventbridge = new EventBridgeClient();
const ssm = new SSMClient();
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient());

exports.handler = async (event) => {
  console.log('SIP Poller running...');
  
  try {
    // Get all pending SIP tasks from DynamoDB
    const pendingTasks = await getPendingTasks();
    
    if (pendingTasks.length === 0) {
      console.log('No pending SIP tasks - disabling poller schedule');
      await disablePollerSchedule();
      return { statusCode: 200, body: 'No pending tasks, poller disabled' };
    }
    
    console.log(`Found ${pendingTasks.length} pending SIP task(s)`);
    
    // Check each task
    let remainingTasks = 0;
    for (const task of pendingTasks) {
      const stillPending = await checkAndProcessTask(task);
      if (stillPending) remainingTasks++;
    }
    
    // If no tasks remain after processing, disable the poller
    if (remainingTasks === 0) {
      console.log('All tasks completed - disabling poller schedule');
      await disablePollerSchedule();
    }
    
    return { statusCode: 200, body: `Processed ${pendingTasks.length} tasks, ${remainingTasks} still pending` };
    
  } catch (error) {
    console.error('SIP Poller error:', error);
    throw error;
  }
};

async function getPendingTasks() {
  const tableName = process.env.SIP_TASKS_TABLE_NAME;
  
  const response = await dynamodb.send(new ScanCommand({
    TableName: tableName,
    FilterExpression: '#status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':status': 'in-progress' }
  }));
  
  return response.Items || [];
}

async function checkAndProcessTask(task) {
  console.log(`Checking SIP task ${task.taskId} for instance ${task.instanceId}`);
  
  try {
    // Get the current status of the SIP modification task
    const response = await ec2.send(new DescribeMacModificationTasksCommand({
      Filters: [
        { Name: 'instance-id', Values: [task.instanceId] }
      ]
    }));
    
    const sipTask = response.MacModificationTasks?.find(t => t.MacModificationTaskId === task.taskId);
    
    if (!sipTask) {
      console.warn(`Task ${task.taskId} not found in EC2 API response`);
      
      // Check if task is too old (> 2 hours) - might have been cleaned up
      const taskAge = Date.now() - new Date(task.createdAt).getTime();
      if (taskAge > 2 * 60 * 60 * 1000) {
        console.error(`Task ${task.taskId} not found and is over 2 hours old - marking as failed`);
        await handleTaskFailure(task, 'SIP task not found - may have been cleaned up');
        return false; // No longer pending
      }
      return true; // Still pending (might appear later)
    }
    
    console.log(`SIP task ${task.taskId} status: ${sipTask.TaskState}`);
    
    switch (sipTask.TaskState) {
      case 'successful':
        await handleTaskSuccess(task);
        return false; // No longer pending
      case 'failed':
        await handleTaskFailure(task, 'SIP modification task failed');
        return false; // No longer pending
      case 'in-progress':
      case 'pending':
        // Still running - log progress
        const elapsed = Math.round((Date.now() - new Date(task.createdAt).getTime()) / 60000);
        console.log(`Task ${task.taskId} still in progress (${elapsed} minutes elapsed)`);
        return true; // Still pending
      default:
        console.warn(`Unknown task state: ${sipTask.TaskState}`);
        return true; // Treat as still pending
    }
    
  } catch (error) {
    console.error('Error checking task', task.taskId + ':', error);
    // Don't fail the whole poller for one task error
    // The task will be retried on the next poll
    return true; // Treat as still pending
  }
}

async function handleTaskSuccess(task) {
  console.log(`SIP task ${task.taskId} completed successfully!`);
  
  // Update pipeline status (only for the specific pipeline)
  await updatePipelineStatus('sip-disable-complete', 'SIP disabled successfully, waiting for SSM readiness', task.imageBuildVersionArn);
  
  // Wait for SSM agent to be ready before resuming workflow
  // After SIP disable, the instance is restarted and SSM agent needs time to reconnect
  console.log(`Waiting for SSM agent readiness on instance ${task.instanceId}...`);
  const ssmReady = await waitForSSMReadiness(task.instanceId, 300000); // 5 minute timeout
  
  if (!ssmReady) {
    console.error(`SSM agent not ready after SIP disable for instance ${task.instanceId}`);
    await updatePipelineStatus('sip-disable-complete', 'SIP disabled but SSM agent not ready - resuming anyway', task.imageBuildVersionArn);
  } else {
    console.log(`SSM agent is ready on instance ${task.instanceId}`);
    await updatePipelineStatus('sip-disable-complete', 'SIP disabled successfully, resuming workflow', task.imageBuildVersionArn);
  }
  
  // Resume the Image Builder workflow
  try {
    await imagebuilder.send(new SendWorkflowStepActionCommand({
      action: 'RESUME',
      imageBuildVersionArn: task.imageBuildVersionArn,
      stepExecutionId: task.stepExecutionId,
      clientToken: `resume-${task.taskId}-${Date.now()}`,
      reason: 'SIP disabled successfully'
    }));
    console.log(`Workflow resumed for ${task.imageBuildVersionArn}`);
  } catch (error) {
    // Workflow might have already been resumed or timed out
    console.warn(`Could not resume workflow: ${error.message}`);
  }
  
  // Update task status in DynamoDB
  await updateTaskStatus(task.taskId, 'successful');
}

async function handleTaskFailure(task, reason) {
  console.error(`SIP task ${task.taskId} failed: ${reason}`);
  
  // Update pipeline status (only for the specific pipeline)
  await updatePipelineStatus('sip-disable-failed', reason, task.imageBuildVersionArn);
  
  // Stop the Image Builder workflow
  try {
    await imagebuilder.send(new SendWorkflowStepActionCommand({
      action: 'STOP',
      imageBuildVersionArn: task.imageBuildVersionArn,
      stepExecutionId: task.stepExecutionId,
      clientToken: `stop-${task.taskId}-${Date.now()}`,
      reason: `SIP orchestration failed: ${reason}`
    }));
    console.log(`Workflow stopped for ${task.imageBuildVersionArn}`);
  } catch (error) {
    console.warn(`Could not stop workflow: ${error.message}`);
  }
  
  // Update task status in DynamoDB
  await updateTaskStatus(task.taskId, 'failed', reason);
}

async function updateTaskStatus(taskId, status, errorMessage = null) {
  const tableName = process.env.SIP_TASKS_TABLE_NAME;
  
  const updateExpression = errorMessage
    ? 'SET #status = :status, completedAt = :completedAt, errorMessage = :errorMessage'
    : 'SET #status = :status, completedAt = :completedAt';
  
  const expressionAttributeValues = {
    ':status': status,
    ':completedAt': new Date().toISOString()
  };
  
  if (errorMessage) {
    expressionAttributeValues[':errorMessage'] = errorMessage;
  }
  
  await dynamodb.send(new UpdateCommand({
    TableName: tableName,
    Key: { taskId },
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: expressionAttributeValues
  }));
  
  console.log(`Updated task ${taskId} status to ${status}`);
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
    console.warn(`Could not update pipeline ${pipelineId}: ${error.message}`);
  }
}

async function disablePollerSchedule() {
  const ruleName = process.env.SIP_POLLER_RULE_NAME;
  if (!ruleName) {
    console.warn('SIP_POLLER_RULE_NAME not set, skipping rule disable');
    return;
  }
  
  try {
    await eventbridge.send(new DisableRuleCommand({ Name: ruleName }));
    console.log(`Disabled poller schedule rule: ${ruleName}`);
  } catch (error) {
    console.warn(`Could not disable poller rule: ${error.message}`);
  }
}

/**
 * Wait for SSM agent to be ready on the instance after SIP disable reboot.
 * The SIP disable process stops and restarts the instance, so we need to
 * wait for SSM agent to reconnect before resuming the Image Builder workflow.
 */
async function waitForSSMReadiness(instanceId, timeoutMs = 300000) {
  const startTime = Date.now();
  const pollInterval = 15000; // Check every 15 seconds
  
  console.log(`Waiting up to ${timeoutMs / 1000}s for SSM agent on ${instanceId}...`);
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await ssm.send(new DescribeInstanceInformationCommand({
        Filters: [
          { Key: 'InstanceIds', Values: [instanceId] }
        ]
      }));
      
      const instanceInfo = response.InstanceInformationList?.[0];
      
      if (instanceInfo && instanceInfo.PingStatus === 'Online') {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`SSM agent online after ${elapsed}s`);
        
        // Add a small buffer to ensure SSM is fully ready
        await sleep(10000);
        return true;
      }
      
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`SSM agent not ready yet (${elapsed}s elapsed), status: ${instanceInfo?.PingStatus || 'not found'}`);
      
    } catch (error) {
      console.warn(`Error checking SSM status: ${error.message}`);
    }
    
    await sleep(pollInterval);
  }
  
  console.warn(`SSM agent did not become ready within ${timeoutMs / 1000}s`);
  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
