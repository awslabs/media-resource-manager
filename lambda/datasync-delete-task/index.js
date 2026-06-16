// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, DeleteCommand, QueryCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { DataSyncClient, DeleteTaskCommand } = require('@aws-sdk/client-datasync');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);
const dataSyncClient = new DataSyncClient({ region: process.env.AWS_REGION });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'DELETE,OPTIONS'
};

exports.handler = async (event) => {
  console.log('DeleteDataSyncTask event:', JSON.stringify(event, null, 2));
  
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
    
    // Delete from DataSync
    if (task.taskArn) {
      try {
        await dataSyncClient.send(new DeleteTaskCommand({
          TaskArn: task.taskArn
        }));
        console.log('Deleted DataSync task:', task.taskArn);
      } catch (dataSyncError) {
        // If task doesn't exist in DataSync, continue with DynamoDB deletion
        if (dataSyncError.name !== 'InvalidRequestException') {
          throw dataSyncError;
        }
        console.log('Task not found in DataSync, continuing with DynamoDB deletion');
      }
    }
    
    // Query and delete all execution records for this task
    const executionsResult = await dynamodb.send(new QueryCommand({
      TableName: process.env.DATASYNC_TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': `TASK#${taskId}`,
        ':skPrefix': 'EXECUTION#'
      }
    }));
    
    // Delete executions in batches of 25 (DynamoDB limit)
    if (executionsResult.Items && executionsResult.Items.length > 0) {
      const deleteRequests = executionsResult.Items.map(item => ({
        DeleteRequest: {
          Key: {
            pk: item.pk,
            sk: item.sk
          }
        }
      }));
      
      // Process in batches of 25
      for (let i = 0; i < deleteRequests.length; i += 25) {
        const batch = deleteRequests.slice(i, i + 25);
        await dynamodb.send(new BatchWriteCommand({
          RequestItems: {
            [process.env.DATASYNC_TABLE_NAME]: batch
          }
        }));
      }
      console.log(`Deleted ${executionsResult.Items.length} execution records`);
    }
    
    // Delete task metadata from DynamoDB
    await dynamodb.send(new DeleteCommand({
      TableName: process.env.DATASYNC_TABLE_NAME,
      Key: {
        pk: `TASK#${taskId}`,
        sk: 'METADATA'
      }
    }));
    
    console.log('Task deleted successfully:', taskId);
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        message: 'Task deleted successfully'
      })
    };
  } catch (error) {
    console.error('Error deleting DataSync task:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Failed to delete DataSync task',
        details: error.message
      })
    };
  }
};
