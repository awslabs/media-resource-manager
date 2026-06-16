// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cancel Install Script Lambda
 * 
 * Stops workflow execution and terminates any running test instances.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { EC2Client, TerminateInstancesCommand, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const ec2Client = new EC2Client({ region: process.env.AWS_REGION });

const EXECUTION_STATE_TABLE = process.env.EXECUTION_STATE_TABLE_NAME;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    // Handle OPTIONS preflight
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: corsHeaders, body: '' };
    }

    // Support both path parameter (for /software/{softwareId}/cancel-generation)
    // and query parameter (for /software/cancel-generation?executionId=xxx)
    const softwareId = event.pathParameters?.softwareId;
    const body = JSON.parse(event.body || '{}');
    let executionId = body.executionId || event.queryStringParameters?.executionId;

    if (!executionId) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'executionId is required' })
      };
    }

    // Get execution state
    const executionState = await getExecutionState(executionId);
    if (!executionState) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Execution not found' })
      };
    }

    // If softwareId is provided, verify it matches (for the non-draft endpoint)
    if (softwareId && executionState.softwareId && executionState.softwareId !== softwareId) {
      return {
        statusCode: 403,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Execution does not belong to this software' })
      };
    }

    // Check if already completed
    if (['completed', 'failed', 'cancelled'].includes(executionState.status)) {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          message: 'Execution already finished',
          status: executionState.status
        })
      };
    }

    const cleanupResults = {
      instancesTerminated: [],
      errors: []
    };

    // Terminate any running test instances
    if (executionState.testInstanceId) {
      try {
        await terminateInstance(executionState.testInstanceId);
        cleanupResults.instancesTerminated.push(executionState.testInstanceId);
      } catch (error) {
        cleanupResults.errors.push(`Failed to terminate instance ${executionState.testInstanceId}: ${error.message}`);
      }
    }

    // Also find and terminate any orphaned instances for this execution
    try {
      const orphanedInstances = await findOrphanedInstances(executionId);
      for (const instanceId of orphanedInstances) {
        try {
          await terminateInstance(instanceId);
          cleanupResults.instancesTerminated.push(instanceId);
        } catch (error) {
          cleanupResults.errors.push(`Failed to terminate orphaned instance ${instanceId}: ${error.message}`);
        }
      }
    } catch (error) {
      cleanupResults.errors.push(`Failed to find orphaned instances: ${error.message}`);
    }

    // Update execution state to cancelled
    await updateExecutionState(executionId, {
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      cancelReason: body.reason || 'User requested cancellation'
    });

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        message: 'Execution cancelled',
        executionId,
        cleanup: cleanupResults
      })
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message })
    };
  }
};

async function getExecutionState(executionId) {
  const result = await docClient.send(new GetCommand({
    TableName: EXECUTION_STATE_TABLE,
    Key: { executionId }
  }));
  return result.Item;
}

async function updateExecutionState(executionId, updates) {
  const updateExpressions = [];
  const expressionAttributeNames = {};
  const expressionAttributeValues = {};

  for (const [key, value] of Object.entries(updates)) {
    const attrName = `#${key}`;
    const attrValue = `:${key}`;
    updateExpressions.push(`${attrName} = ${attrValue}`);
    expressionAttributeNames[attrName] = key;
    expressionAttributeValues[attrValue] = value;
  }

  await docClient.send(new UpdateCommand({
    TableName: EXECUTION_STATE_TABLE,
    Key: { executionId },
    UpdateExpression: `SET ${updateExpressions.join(', ')}`,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues
  }));
}

async function terminateInstance(instanceId) {
  console.log(`Terminating instance: ${instanceId}`);
  await ec2Client.send(new TerminateInstancesCommand({
    InstanceIds: [instanceId]
  }));
}

async function findOrphanedInstances(executionId) {
  // Find instances tagged with this execution ID
  const response = await ec2Client.send(new DescribeInstancesCommand({
    Filters: [
      { Name: 'tag:Purpose', Values: ['InstallScriptTest'] },
      { Name: 'tag:ExecutionId', Values: [executionId] },
      { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping'] }
    ]
  }));

  const instanceIds = [];
  for (const reservation of response.Reservations || []) {
    for (const instance of reservation.Instances || []) {
      if (instance.InstanceId) {
        instanceIds.push(instance.InstanceId);
      }
    }
  }

  return instanceIds;
}
