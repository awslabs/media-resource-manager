// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,OPTIONS'
};

exports.handler = async (event) => {
  console.log('ListStorage event:', JSON.stringify(event, null, 2));
  
  try {
    console.log('Starting DynamoDB query...');
    console.log('Table name:', process.env.STORAGE_TABLE_NAME);
    
    // Check for region filter in query parameters
    const regionFilter = event.queryStringParameters?.region;
    console.log('Region filter:', regionFilter || 'none');
    
    let result;
    
    if (regionFilter) {
      // Use region GSI for filtered query
      console.log(`Querying region-index GSI for region: ${regionFilter}`);
      result = await dynamodb.send(new QueryCommand({
        TableName: process.env.STORAGE_TABLE_NAME,
        IndexName: 'region-index',
        KeyConditionExpression: '#region = :region',
        ExpressionAttributeNames: {
          '#region': 'region'
        },
        ExpressionAttributeValues: {
          ':region': regionFilter
        }
      }));
    } else {
      // No filter - scan all items
      result = await dynamodb.send(new ScanCommand({
        TableName: process.env.STORAGE_TABLE_NAME
      }));
    }
    
    console.log('DynamoDB scan result:', JSON.stringify(result, null, 2));
    console.log('Items found:', result.Items?.length || 0);
    
    // Flatten configuration properties to avoid phantom column in UI
    // Use top-level values first (set by create-storage), fall back to configuration for backwards compatibility
    const flattenedItems = (result.Items || []).map(item => ({
      ...item,
      // Use existing top-level values, or fall back to configuration for FSx Windows backwards compatibility
      storageCapacity: item.storageCapacity || item.configuration?.ssdStorageCapacity || item.configuration?.storageCapacity,
      throughput: item.throughput || item.configuration?.throughputCapacity || (item.configuration?.haPairs * item.configuration?.throughputCapacityPerHaPair),
      backupRetention: item.backupRetention || item.configuration?.automaticBackupRetentionPeriod || item.configuration?.backupRetention,
      // Ensure region is always present (default to primary region for legacy storage)
      region: item.region || process.env.AWS_REGION,
      configuration: undefined // Remove the nested configuration object
    }));
    
    const response = {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(flattenedItems)
    };
    
    console.log('Returning response:', JSON.stringify(response, null, 2));
    return response;
  } catch (error) {
    console.error('Error listing storage resources:', error);
    console.error('Error stack:', error.stack);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Failed to retrieve storage resources',
        details: error.message
      })
    };
  }
};
