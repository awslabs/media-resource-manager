// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,OPTIONS'
};

exports.handler = async (event) => {
  console.log('ListDataSyncTasks event:', JSON.stringify(event, null, 2));
  
  try {
    // Query tasks using the type-index GSI
    const result = await dynamodb.send(new QueryCommand({
      TableName: process.env.DATASYNC_TABLE_NAME,
      IndexName: 'type-index',
      KeyConditionExpression: '#type = :type',
      ExpressionAttributeNames: {
        '#type': 'type'
      },
      ExpressionAttributeValues: {
        ':type': 'TASK'
      },
      ScanIndexForward: false // Most recent first
    }));
    
    console.log('Tasks found:', result.Items?.length || 0);
    
    // Map to response format
    const tasks = (result.Items || []).map(item => ({
      taskId: item.taskId,
      taskArn: item.taskArn,
      name: item.name,
      status: item.status,
      sourceLocationId: item.sourceLocationId,
      sourceLocationArn: item.sourceLocationArn,
      sourceLocationName: item.sourceLocationName,
      destinationLocationId: item.destinationLocationId,
      destinationLocationArn: item.destinationLocationArn,
      destinationLocationName: item.destinationLocationName,
      options: item.options,
      lastExecutionId: item.lastExecutionId,
      lastExecutionStatus: item.lastExecutionStatus,
      lastExecutionTime: item.lastExecutionTime,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }));
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(tasks)
    };
  } catch (error) {
    console.error('Error listing DataSync tasks:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Failed to retrieve DataSync tasks',
        details: error.message
      })
    };
  }
};
