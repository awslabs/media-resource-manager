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
  console.log('ListDataSyncLocations event:', JSON.stringify(event, null, 2));
  
  try {
    // Query locations using the type-index GSI
    const result = await dynamodb.send(new QueryCommand({
      TableName: process.env.DATASYNC_TABLE_NAME,
      IndexName: 'type-index',
      KeyConditionExpression: '#type = :type',
      ExpressionAttributeNames: {
        '#type': 'type'
      },
      ExpressionAttributeValues: {
        ':type': 'LOCATION'
      },
      ScanIndexForward: false // Most recent first
    }));
    
    console.log('Locations found:', result.Items?.length || 0);
    
    // Map to response format
    const locations = (result.Items || []).map(item => ({
      locationId: item.locationId,
      locationArn: item.locationArn,
      name: item.name,
      locationType: item.locationType,
      status: item.status,
      // S3-specific fields
      bucketArn: item.bucketArn,
      isCrossAccount: item.isCrossAccount,
      subdirectory: item.subdirectory,
      // FSx-specific fields
      storageId: item.storageId,
      fsxFileSystemArn: item.fsxFileSystemArn,
      // Timestamps
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }));
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(locations)
    };
  } catch (error) {
    console.error('Error listing DataSync locations:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Failed to retrieve DataSync locations',
        details: error.message
      })
    };
  }
};
