// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { DataSyncClient, UpdateTaskCommand } = require('@aws-sdk/client-datasync');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);
const dataSyncClient = new DataSyncClient({ region: process.env.AWS_REGION });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'PUT,OPTIONS'
};

exports.handler = async (event) => {
  console.log('UpdateDataSyncTask event:', JSON.stringify(event, null, 2));
  
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
    
    const body = JSON.parse(event.body || '{}');
    const { name, options } = body;
    
    // Get existing task
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
    
    const existingTask = taskResult.Item;
    
    // Validate bandwidth limit if specified
    if (options?.bytesPerSecond !== undefined) {
      const bandwidth = parseInt(options.bytesPerSecond, 10);
      if (isNaN(bandwidth) || bandwidth <= 0) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({
            success: false,
            error: 'INVALID_BANDWIDTH',
            message: 'Bandwidth limit must be a positive integer.'
          })
        };
      }
    }
    
    const timestamp = new Date().toISOString();
    
    // Merge options - preserve existing, update only provided fields
    // IMPORTANT: Source and destination locations are NEVER changed
    const updatedOptions = options ? {
      ...existingTask.options,
      ...options
    } : existingTask.options;
    
    // Update DataSync task (only options can be updated)
    if (options) {
      const dataSyncOptions = {
        TransferMode: updatedOptions.transferMode,
        VerifyMode: updatedOptions.verifyMode,
        OverwriteMode: updatedOptions.overwriteMode,
        PreserveDeletedFiles: updatedOptions.preserveDeletedFiles,
        LogLevel: updatedOptions.logLevel
      };
      
      if (updatedOptions.bytesPerSecond) {
        dataSyncOptions.BytesPerSecond = parseInt(updatedOptions.bytesPerSecond, 10);
      }
      
      await dataSyncClient.send(new UpdateTaskCommand({
        TaskArn: existingTask.taskArn,
        Options: dataSyncOptions
      }));
    }
    
    // Build update expression
    const updateExpressions = ['#updatedAt = :updatedAt'];
    const expressionAttributeNames = { '#updatedAt': 'updatedAt' };
    const expressionAttributeValues = { ':updatedAt': timestamp };
    
    if (name) {
      updateExpressions.push('#name = :name');
      expressionAttributeNames['#name'] = 'name';
      expressionAttributeValues[':name'] = name;
    }
    
    if (options) {
      updateExpressions.push('#options = :options');
      expressionAttributeNames['#options'] = 'options';
      expressionAttributeValues[':options'] = updatedOptions;
    }
    
    // Update DynamoDB
    await dynamodb.send(new UpdateCommand({
      TableName: process.env.DATASYNC_TABLE_NAME,
      Key: {
        pk: `TASK#${taskId}`,
        sk: 'METADATA'
      },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues
    }));
    
    console.log('Task updated successfully:', taskId);
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        data: {
          taskId,
          name: name || existingTask.name,
          // Source and destination are NEVER changed - return original values
          sourceLocationId: existingTask.sourceLocationId,
          destinationLocationId: existingTask.destinationLocationId,
          options: updatedOptions,
          updatedAt: timestamp
        }
      })
    };
  } catch (error) {
    console.error('Error updating DataSync task:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Failed to update DataSync task',
        details: error.message
      })
    };
  }
};
