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

// Maximum number of executions to return
const MAX_EXECUTIONS = 10;

exports.handler = async (event) => {
  console.log('GetDataSyncExecutions event:', JSON.stringify(event, null, 2));
  
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
    
    // Query execution records for this task
    // Sort key begins with EXECUTION# and we want most recent first
    const result = await dynamodb.send(new QueryCommand({
      TableName: process.env.DATASYNC_TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': `TASK#${taskId}`,
        ':skPrefix': 'EXECUTION#'
      },
      ScanIndexForward: false, // Most recent first (descending order)
      Limit: MAX_EXECUTIONS
    }));
    
    console.log('Executions found:', result.Items?.length || 0);
    
    // Map to response format
    const executions = (result.Items || []).map(item => ({
      executionId: item.executionId,
      executionArn: item.executionArn,
      taskId: item.taskId,
      status: item.status,
      startTime: item.startTime,
      endTime: item.endTime,
      bytesTransferred: item.bytesTransferred,
      filesTransferred: item.filesTransferred,
      bytesVerified: item.bytesVerified,
      filesVerified: item.filesVerified,
      duration: item.duration,
      errorCode: item.errorCode,
      errorMessage: item.errorMessage
    }));
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        data: executions
      })
    };
  } catch (error) {
    console.error('Error getting DataSync executions:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Failed to retrieve DataSync executions',
        details: error.message
      })
    };
  }
};
