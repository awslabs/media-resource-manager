// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'PUT,OPTIONS'
};

exports.handler = async (event) => {
  console.log('UpdateStorage event:', JSON.stringify(event, null, 2));
  
  try {
    const storageId = event.pathParameters?.storageId;
    if (!storageId) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'Storage ID is required'
        })
      };
    }
    
    const data = JSON.parse(event.body || '{}');
    const updateExpression = [];
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};
    
    if (data.name) {
      updateExpression.push('#name = :name');
      expressionAttributeNames['#name'] = 'name';
      expressionAttributeValues[':name'] = data.name;
    }
    
    if (data.status) {
      updateExpression.push('#status = :status');
      expressionAttributeNames['#status'] = 'status';
      expressionAttributeValues[':status'] = data.status;
    }
    
    if (data.configuration) {
      updateExpression.push('#configuration = :configuration');
      expressionAttributeNames['#configuration'] = 'configuration';
      expressionAttributeValues[':configuration'] = data.configuration;
    }
    
    if (updateExpression.length === 0) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'No valid fields to update'
        })
      };
    }
    
    const result = await dynamodb.send(new UpdateCommand({
      TableName: process.env.STORAGE_TABLE_NAME,
      Key: { storageId },
      UpdateExpression: `SET ${updateExpression.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    }));
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        data: result.Attributes
      })
    };
  } catch (error) {
    console.error('Error updating storage resource:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Failed to update storage resource'
      })
    };
  }
};
