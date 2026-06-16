// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
const crypto = require('crypto');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);
const sfnClient = new SFNClient({ region: process.env.AWS_REGION });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

exports.handler = async (event) => {
  console.log('StartDataSyncExecution event:', JSON.stringify(event, null, 2));
  
  try {
    const taskId = event.pathParameters?.taskId;
    
    if (!taskId) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'Task ID is required'
        })
      };
    }
    
    // Get the task from DynamoDB
    const taskResult = await dynamodb.send(new GetCommand({
      TableName: process.env.DATASYNC_TABLE_NAME,
      Key: {
        pk: `TASK#${taskId}`,
        sk: 'METADATA'
      }
    }));
    
    if (!taskResult.Item) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'TASK_NOT_FOUND',
          message: 'The specified task does not exist.'
        })
      };
    }
    
    const task = taskResult.Item;
    
    // Check if task is in a runnable state
    if (task.status === 'running') {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'TASK_RUNNING',
          message: 'A task execution is already in progress.'
        })
      };
    }
    
    if (task.status === 'invalid') {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'TASK_NOT_AVAILABLE',
          message: 'The task is not in a runnable state. One or more locations may have been deleted.'
        })
      };
    }
    
    const executionId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    
    // Start Step Functions execution
    const sfnResponse = await sfnClient.send(new StartExecutionCommand({
      stateMachineArn: process.env.EXECUTION_STATE_MACHINE_ARN,
      name: `datasync-${taskId}-${Date.now()}`,
      input: JSON.stringify({
        taskId,
        taskPk: `TASK#${taskId}`,
        taskArn: task.taskArn,
        executionId,
        startTime: timestamp
      })
    }));
    
    // Update task status to running
    await dynamodb.send(new UpdateCommand({
      TableName: process.env.DATASYNC_TABLE_NAME,
      Key: {
        pk: `TASK#${taskId}`,
        sk: 'METADATA'
      },
      UpdateExpression: 'SET #status = :status, #updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#updatedAt': 'updatedAt'
      },
      ExpressionAttributeValues: {
        ':status': 'running',
        ':updatedAt': timestamp
      }
    }));
    
    console.log('Execution started successfully:', executionId);
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        data: {
          executionId,
          executionArn: sfnResponse.executionArn,
          status: 'LAUNCHING',
          startTime: timestamp
        }
      })
    };
  } catch (error) {
    console.error('Error starting DataSync execution:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Failed to start DataSync execution',
        details: error.message
      })
    };
  }
};
