// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, DeleteCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { DataSyncClient, DeleteLocationCommand } = require('@aws-sdk/client-datasync');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);
const dataSyncClient = new DataSyncClient({ region: process.env.AWS_REGION });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'DELETE,OPTIONS'
};

exports.handler = async (event) => {
  console.log('DeleteDataSyncLocation event:', JSON.stringify(event, null, 2));
  
  try {
    const locationId = event.pathParameters?.locationId;
    
    if (!locationId) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'Location ID is required'
        })
      };
    }
    
    // Get the location from DynamoDB
    const locationResult = await dynamodb.send(new GetCommand({
      TableName: process.env.DATASYNC_TABLE_NAME,
      Key: {
        pk: `LOCATION#${locationId}`,
        sk: 'METADATA'
      }
    }));
    
    if (!locationResult.Item) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'LOCATION_NOT_FOUND',
          message: 'The specified location does not exist.'
        })
      };
    }
    
    const location = locationResult.Item;
    
    // Check if any tasks reference this location
    const tasksResult = await dynamodb.send(new QueryCommand({
      TableName: process.env.DATASYNC_TABLE_NAME,
      IndexName: 'type-index',
      KeyConditionExpression: '#type = :type',
      FilterExpression: 'sourceLocationId = :locationId OR destinationLocationId = :locationId',
      ExpressionAttributeNames: {
        '#type': 'type'
      },
      ExpressionAttributeValues: {
        ':type': 'TASK',
        ':locationId': locationId
      }
    }));
    
    if (tasksResult.Items && tasksResult.Items.length > 0) {
      const dependentTaskNames = tasksResult.Items.map(task => task.name).join(', ');
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'LOCATION_IN_USE',
          message: `Cannot delete location. It is referenced by tasks: ${dependentTaskNames}`,
          dependentTasks: tasksResult.Items.map(task => ({
            taskId: task.taskId,
            name: task.name
          }))
        })
      };
    }
    
    // Delete from DataSync
    if (location.locationArn) {
      try {
        await dataSyncClient.send(new DeleteLocationCommand({
          LocationArn: location.locationArn
        }));
        console.log('Deleted DataSync location:', location.locationArn);
      } catch (dataSyncError) {
        // If location doesn't exist in DataSync, continue with DynamoDB deletion
        if (dataSyncError.name !== 'InvalidRequestException') {
          throw dataSyncError;
        }
        console.log('Location not found in DataSync, continuing with DynamoDB deletion');
      }
    }
    
    // Delete from DynamoDB
    await dynamodb.send(new DeleteCommand({
      TableName: process.env.DATASYNC_TABLE_NAME,
      Key: {
        pk: `LOCATION#${locationId}`,
        sk: 'METADATA'
      }
    }));
    
    console.log('Location deleted successfully:', locationId);
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        message: 'Location deleted successfully'
      })
    };
  } catch (error) {
    console.error('Error deleting DataSync location:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Failed to delete DataSync location',
        details: error.message
      })
    };
  }
};
