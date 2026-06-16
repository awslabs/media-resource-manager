// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { DataSyncClient, CreateTaskCommand } = require('@aws-sdk/client-datasync');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const crypto = require('crypto');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

// Cache for regional clients and log group ARNs
const regionalClients = {};
const logGroupArnCache = {};

// Get or create regional DataSync client
function getRegionalDataSyncClient(region) {
  if (!regionalClients[region]) {
    regionalClients[region] = new DataSyncClient({ region });
  }
  return regionalClients[region];
}

// Extract region from a location ARN
function getRegionFromArn(arn) {
  // ARN format: arn:aws:datasync:REGION:ACCOUNT:location/loc-xxx
  const parts = arn.split(':');
  return parts[3] || process.env.AWS_REGION;
}

// Get the CloudWatch log group ARN for a region
async function getLogGroupArnForRegion(region) {
  const primaryRegion = process.env.AWS_REGION;
  
  // If it's the primary region, use the environment variable
  if (region === primaryRegion) {
    return process.env.DATASYNC_LOG_GROUP_ARN || null;
  }
  
  // Check cache first
  if (logGroupArnCache[region]) {
    return logGroupArnCache[region];
  }
  
  // Look up from SSM parameter in the regional hub
  try {
    const ssmClient = new SSMClient({ region });
    const productName = process.env.PRODUCT_NAME;
    const parameterName = `/${productName}/RegionalHub/${region}/DataSync/LogGroupArn`;
    
    const response = await ssmClient.send(new GetParameterCommand({
      Name: parameterName
    }));
    
    const logGroupArn = response.Parameter?.Value;
    if (logGroupArn) {
      logGroupArnCache[region] = logGroupArn;
      console.log(`Found regional log group ARN for ${region}: ${logGroupArn}`);
    }
    return logGroupArn;
  } catch (error) {
    console.warn('Could not find DataSync log group ARN for region', region + ':', error.message);
    return null;
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

// Default task options
const DEFAULT_OPTIONS = {
  transferMode: 'CHANGED',
  verifyMode: 'ONLY_FILES_TRANSFERRED',
  overwriteMode: 'ALWAYS',
  preserveDeletedFiles: 'PRESERVE',
  logLevel: 'BASIC'  // BASIC logging enabled by default with CloudWatch log group
};

// Validate location compatibility (S3 <-> FSx only)
const areLocationsCompatible = (sourceType, destType) => {
  const isSourceS3 = sourceType === 'S3';
  const isDestS3 = destType === 'S3';
  const isSourceFsx = sourceType.startsWith('FSX_');
  const isDestFsx = destType.startsWith('FSX_');
  
  // S3 to FSx or FSx to S3 is valid
  return (isSourceS3 && isDestFsx) || (isSourceFsx && isDestS3);
};

exports.handler = async (event) => {
  console.log('CreateDataSyncTask event:', JSON.stringify(event, null, 2));
  
  try {
    const body = JSON.parse(event.body || '{}');
    const { name, sourceLocationId, destinationLocationId, options = {} } = body;
    
    // Validate required fields
    if (!name || !sourceLocationId || !destinationLocationId) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'Missing required fields: name, sourceLocationId, and destinationLocationId are required'
        })
      };
    }
    
    // Get source location
    const sourceResult = await dynamodb.send(new GetCommand({
      TableName: process.env.DATASYNC_TABLE_NAME,
      Key: {
        pk: `LOCATION#${sourceLocationId}`,
        sk: 'METADATA'
      }
    }));
    
    if (!sourceResult.Item) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'SOURCE_NOT_FOUND',
          message: 'The specified source location does not exist.'
        })
      };
    }
    
    const sourceLocation = sourceResult.Item;
    
    if (sourceLocation.status !== 'available') {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'LOCATION_NOT_AVAILABLE',
          message: 'The source location is not in available status.'
        })
      };
    }
    
    // Get destination location
    const destResult = await dynamodb.send(new GetCommand({
      TableName: process.env.DATASYNC_TABLE_NAME,
      Key: {
        pk: `LOCATION#${destinationLocationId}`,
        sk: 'METADATA'
      }
    }));
    
    if (!destResult.Item) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'DEST_NOT_FOUND',
          message: 'The specified destination location does not exist.'
        })
      };
    }
    
    const destLocation = destResult.Item;
    
    if (destLocation.status !== 'available') {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'LOCATION_NOT_AVAILABLE',
          message: 'The destination location is not in available status.'
        })
      };
    }
    
    // Validate location compatibility
    if (!areLocationsCompatible(sourceLocation.locationType, destLocation.locationType)) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'INCOMPATIBLE_LOCATIONS',
          message: 'Source and destination must be different types (S3 to FSx or FSx to S3).'
        })
      };
    }
    
    // Validate cross-region compatibility
    // DataSync requires both locations to be in the same region when FSx is involved
    const sourceRegion = getRegionFromArn(sourceLocation.locationArn);
    const destRegion = getRegionFromArn(destLocation.locationArn);
    const isSourceFsx = sourceLocation.locationType.startsWith('FSX_');
    const isDestFsx = destLocation.locationType.startsWith('FSX_');
    
    if (sourceRegion !== destRegion && (isSourceFsx || isDestFsx)) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'CROSS_REGION_FSX_NOT_SUPPORTED',
          message: `Cross-region transfers involving FSx are not supported. Source location is in ${sourceRegion} and destination is in ${destRegion}. Both locations must be in the same region when using FSx. Consider creating an S3 location in ${isDestFsx ? destRegion : sourceRegion} to use as the ${isDestFsx ? 'source' : 'destination'}.`
        })
      };
    }
    
    // Validate bandwidth limit if specified
    if (options.bytesPerSecond !== undefined) {
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
    
    // Merge options with defaults
    const taskOptions = {
      ...DEFAULT_OPTIONS,
      ...options
    };
    
    const taskId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    
    // Create DataSync task
    const dataSyncOptions = {
      TransferMode: taskOptions.transferMode,
      VerifyMode: taskOptions.verifyMode,
      OverwriteMode: taskOptions.overwriteMode,
      PreserveDeletedFiles: taskOptions.preserveDeletedFiles,
      LogLevel: taskOptions.logLevel
    };
    
    if (taskOptions.bytesPerSecond) {
      dataSyncOptions.BytesPerSecond = parseInt(taskOptions.bytesPerSecond, 10);
    }
    
    // Build CreateTaskCommand parameters
    const createTaskParams = {
      SourceLocationArn: sourceLocation.locationArn,
      DestinationLocationArn: destLocation.locationArn,
      Name: name,
      Options: dataSyncOptions
    };
    
    // Determine the region for the task from the location ARNs
    // DataSync tasks are created in the same region as the locations
    const taskRegion = getRegionFromArn(sourceLocation.locationArn);
    console.log(`Creating DataSync task in region: ${taskRegion}`);
    
    // Add CloudWatch log group ARN if logging is enabled (BASIC or TRANSFER)
    if (taskOptions.logLevel !== 'OFF') {
      const logGroupArn = await getLogGroupArnForRegion(taskRegion);
      if (logGroupArn) {
        createTaskParams.CloudWatchLogGroupArn = logGroupArn;
        console.log(`Using CloudWatch log group: ${logGroupArn}`);
      } else {
        console.warn(`No CloudWatch log group found for region ${taskRegion}, creating task without logging`);
        // Fall back to OFF if no log group is available
        dataSyncOptions.LogLevel = 'OFF';
      }
    }
    
    // Use regional DataSync client
    const regionalDataSyncClient = getRegionalDataSyncClient(taskRegion);
    const createTaskResponse = await regionalDataSyncClient.send(new CreateTaskCommand(createTaskParams));
    
    const taskArn = createTaskResponse.TaskArn;
    
    // Store task in DynamoDB
    const taskData = {
      pk: `TASK#${taskId}`,
      sk: 'METADATA',
      type: 'TASK',
      taskId,
      taskArn,
      name,
      status: 'available',
      region: taskRegion,
      sourceLocationId,
      sourceLocationArn: sourceLocation.locationArn,
      sourceLocationName: sourceLocation.name,
      destinationLocationId,
      destinationLocationArn: destLocation.locationArn,
      destinationLocationName: destLocation.name,
      options: taskOptions,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    
    await dynamodb.send(new PutCommand({
      TableName: process.env.DATASYNC_TABLE_NAME,
      Item: taskData
    }));
    
    console.log('Task created successfully:', taskId);
    
    return {
      statusCode: 201,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        data: {
          taskId,
          taskArn,
          name,
          status: 'available',
          region: taskRegion,
          sourceLocationId,
          destinationLocationId,
          options: taskOptions,
          createdAt: timestamp
        }
      })
    };
  } catch (error) {
    console.error('Error creating DataSync task:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Failed to create DataSync task',
        details: error.message
      })
    };
  }
};
