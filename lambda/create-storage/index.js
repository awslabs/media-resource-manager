// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);
const sfn = new SFNClient({ region: process.env.AWS_REGION });
const s3 = new S3Client({ region: process.env.AWS_REGION });

const PRIMARY_REGION = process.env.AWS_REGION;
const REGIONAL_HUBS_TABLE = process.env.REGIONAL_HUBS_TABLE_NAME;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

function generateStorageId() {
  return crypto.randomUUID();
}

/**
 * Validate that the requested region is valid for storage creation
 * - Primary region is always valid
 * - Regional hubs must exist and be in 'active' status
 * @returns {Object} { valid: boolean, error?: string }
 */
async function validateRegion(region, storageType) {
  // Primary region is always valid
  if (!region || region === PRIMARY_REGION) {
    return { valid: true, region: PRIMARY_REGION };
  }
  
  // FSx Windows requires AD, which is only in primary region
  if (storageType === 'fsx-windows') {
    return { 
      valid: false, 
      error: 'FSx for Windows File Server can only be created in the primary region due to Active Directory requirements' 
    };
  }
  
  // For other storage types, check if regional hub exists and is available
  if (!REGIONAL_HUBS_TABLE) {
    return { 
      valid: false, 
      error: 'Regional hub support not configured' 
    };
  }
  
  try {
    const hubResult = await dynamodb.send(new GetCommand({
      TableName: REGIONAL_HUBS_TABLE,
      Key: { region }
    }));
    
    if (!hubResult.Item) {
      return { 
        valid: false, 
        error: `No regional hub found for region ${region}` 
      };
    }
    
    if (hubResult.Item.status !== 'available') {
      return { 
        valid: false, 
        error: `Regional hub in ${region} is not available (status: ${hubResult.Item.status})` 
      };
    }
    
    return { valid: true, region };
  } catch (error) {
    console.error('Error validating regional hub:', error);
    return { 
      valid: false, 
      error: `Failed to validate regional hub: ${error.message}` 
    };
  }
}

exports.handler = async (event) => {
  console.log('CreateStorage event:', JSON.stringify(event, null, 2));
  
  try {
    const data = JSON.parse(event.body || '{}');
    console.log('Parsed request data:', data);
    
    // Validate required fields
    if (!data.name || !data.configuration) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'Name and configuration are required'
        })
      };
    }

    const { configuration } = data;
    const storageType = data.type || 'fsx-windows';
    const requestedRegion = data.region; // Optional - defaults to primary region
    const storageId = generateStorageId();
    const createdAt = new Date().toISOString();

    // Validate region for storage creation
    const regionValidation = await validateRegion(requestedRegion, storageType);
    if (!regionValidation.valid) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: regionValidation.error
        })
      };
    }
    const targetRegion = regionValidation.region;

    // Handle different storage types
    if (storageType === 'mountpoint-s3') {
      return await createMountpointS3Storage(storageId, data, configuration, createdAt);
    } else if (storageType === 'fsx-windows') {
      return await createFsxWindowsStorage(storageId, data, configuration, createdAt, targetRegion);
    } else if (storageType === 'fsx-ontap') {
      return await createFsxOntapStorage(storageId, data, configuration, createdAt, targetRegion);
    } else {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: `Unsupported storage type: ${storageType}`
        })
      };
    }
  } catch (error) {
    console.error('Error creating storage resource:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Failed to create storage resource',
        details: error.message
      })
    };
  }
};

/**
 * Create Mountpoint for S3 storage resource
 * This is a lightweight storage type - just saves config to DynamoDB
 * No CloudFormation or state machine needed
 */
async function createMountpointS3Storage(storageId, data, configuration, createdAt) {
  // Validate S3-specific fields
  if (!configuration.bucketName) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Missing required field: bucketName'
      })
    };
  }

  // Validate bucket exists and is accessible
  try {
    await s3.send(new HeadBucketCommand({ Bucket: configuration.bucketName }));
    console.log(`Bucket ${configuration.bucketName} exists and is accessible`);
  } catch (error) {
    console.error('Bucket validation failed for', configuration.bucketName + ':', error);
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: `Cannot access S3 bucket: ${configuration.bucketName}. Ensure the bucket exists and the Lambda has permission to access it.`
      })
    };
  }

  // Normalize mount path
  let mountPath = configuration.mountPath || '/mnt/s3';
  if (!mountPath.startsWith('/')) {
    mountPath = '/' + mountPath;
  }

  // Set defaults for new options
  const accessMode = configuration.accessMode || 'read-write'; // Default to read-write for usability
  const allowDelete = accessMode === 'read-write' ? (configuration.allowDelete !== false) : false; // Default true for read-write
  const allowOther = configuration.allowOther !== false; // Default true
  // Default uid/gid to 1000 (typical first user on Linux) for non-root access
  const uid = configuration.uid || '1000';
  const gid = configuration.gid || '1000';

  // S3 buckets are global, but we store the region where this storage config was created
  // This helps with filtering in the UI (S3 mounts work from any region)
  const region = process.env.AWS_REGION;

  const item = {
    storageId,
    createdAt,
    name: data.name,
    type: 'mountpoint-s3',
    description: data.description || '',
    status: 'available', // Immediately available since no infrastructure to create
    platform: 'linux', // Mountpoint only supports Linux
    region: region, // S3 is global but we track where config was created
    bucketName: configuration.bucketName,
    prefix: configuration.prefix || '',
    mountPath: mountPath,
    accessMode: accessMode,
    allowDelete: allowDelete,
    allowOther: allowOther,
    uid: uid,
    gid: gid,
    cachePath: configuration.cachePath || '',
    configuration
  };

  console.log('Creating Mountpoint for S3 storage item:', item);

  await dynamodb.send(new PutCommand({
    TableName: process.env.STORAGE_TABLE_NAME,
    Item: item
  }));

  console.log('Mountpoint for S3 storage created successfully');

  return {
    statusCode: 201,
    headers: corsHeaders,
    body: JSON.stringify({
      success: true,
      data: {
        storageId,
        name: data.name,
        type: 'mountpoint-s3',
        status: 'available',
        platform: 'linux',
        region: region,
        bucketName: configuration.bucketName,
        prefix: configuration.prefix || '',
        mountPath: mountPath,
        accessMode: accessMode,
        allowDelete: allowDelete,
        allowOther: allowOther,
        uid: uid,
        gid: gid,
        cachePath: configuration.cachePath || '',
        configuration,
        createdAt
      }
    })
  };
}

/**
 * Create FSx for Windows storage resource
 * Uses CloudFormation via Step Functions state machine
 */
async function createFsxWindowsStorage(storageId, data, configuration, createdAt, targetRegion) {
  // Validate FSx-specific fields
  if (!configuration.ssdStorageCapacity || !configuration.throughputCapacity || !configuration.automaticBackupRetentionPeriod) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Missing required configuration fields: ssdStorageCapacity, throughputCapacity, automaticBackupRetentionPeriod'
      })
    };
  }

  // FSx Windows is only supported in primary region (AD dependency)
  const region = targetRegion || process.env.AWS_REGION;

  const item = {
    storageId,
    createdAt,
    name: data.name,
    type: 'fsx-windows',
    description: data.description || '',
    status: 'initializing',
    platform: 'windows',
    region: region, // FSx is regional - can only be mounted from same region
    storageCapacity: configuration.ssdStorageCapacity,
    throughput: configuration.throughputCapacity,
    backupRetention: configuration.automaticBackupRetentionPeriod,
    configuration
  };

  console.log('Creating FSx Windows storage item:', item);

  // 1. Create initial DynamoDB record
  await dynamodb.send(new PutCommand({
    TableName: process.env.STORAGE_TABLE_NAME,
    Item: item
  }));

  console.log('Storage item created successfully');

  // 2. Start Step Functions execution
  const executionName = `storage-creation-${storageId}-${Date.now()}`;
  console.log('Starting Step Functions execution:', executionName);

  await sfn.send(new StartExecutionCommand({
    stateMachineArn: process.env.STORAGE_CREATION_STATE_MACHINE_ARN,
    input: JSON.stringify({
      storageId,
      name: data.name,
      type: 'fsx-windows',
      region: region,
      configuration
    }),
    name: executionName
  }));

  console.log('Step Functions execution started successfully');

  return {
    statusCode: 201,
    headers: corsHeaders,
    body: JSON.stringify({
      success: true,
      data: {
        storageId,
        name: data.name,
        type: 'fsx-windows',
        status: 'initializing',
        platform: 'windows',
        region: region,
        configuration,
        createdAt
      }
    })
  };
}

/**
 * Create FSx for NetApp ONTAP storage resource
 * Uses CloudFormation via Step Functions state machine
 * Supports creation in regional hubs
 */
async function createFsxOntapStorage(storageId, data, configuration, createdAt, targetRegion) {
  // Apply team size presets if specified
  if (configuration.teamSize) {
    const presets = {
      'small': { haPairs: 1, throughputCapacityPerHaPair: 3072 },      // 3 GB/s
      'medium': { haPairs: 2, throughputCapacityPerHaPair: 3072 },     // 6 GB/s
      'large': { haPairs: 6, throughputCapacityPerHaPair: 3072 },      // 18 GB/s
      'enterprise': { haPairs: 6, throughputCapacityPerHaPair: 6144 }  // 36 GB/s
    };
    const preset = presets[configuration.teamSize];
    if (preset) {
      configuration.haPairs = preset.haPairs;
      configuration.throughputCapacityPerHaPair = preset.throughputCapacityPerHaPair;
    }
  }

  // Set defaults
  configuration.deploymentType = configuration.deploymentType || 'SINGLE_AZ_2';
  configuration.haPairs = configuration.haPairs || 1;
  // Minimum storage capacity is 1024 GiB per HA pair
  const minStorageCapacity = 1024 * configuration.haPairs;
  configuration.storageCapacity = Math.max(configuration.storageCapacity || minStorageCapacity, minStorageCapacity);
  configuration.volumeSize = configuration.volumeSize || 1024;
  configuration.backupRetention = configuration.backupRetention || 30;
  configuration.securityStyle = configuration.securityStyle || 'MIXED';
  configuration.tieringPolicy = configuration.tieringPolicy || 'AUTO';
  configuration.throughputCapacityPerHaPair = configuration.throughputCapacityPerHaPair || 3072;

  // Calculate total throughput for display
  const totalThroughput = configuration.haPairs * configuration.throughputCapacityPerHaPair;

  // FSx ONTAP can be created in primary region or regional hubs
  const region = targetRegion || process.env.AWS_REGION;

  const item = {
    storageId,
    createdAt,
    name: data.name,
    type: 'fsx-ontap',
    description: data.description || '',
    status: 'initializing',
    platform: 'multi', // Supports Windows, Mac, Linux
    region: region, // FSx is regional - can only be mounted from same region
    storageCapacity: configuration.storageCapacity,
    throughput: totalThroughput,
    haPairs: configuration.haPairs,
    throughputPerHaPair: configuration.throughputCapacityPerHaPair,
    deploymentType: configuration.deploymentType,
    volumeSize: configuration.volumeSize,
    backupRetention: configuration.backupRetention,
    securityStyle: configuration.securityStyle,
    configuration
  };

  console.log('Creating FSx ONTAP storage item:', item);

  // 1. Create initial DynamoDB record
  await dynamodb.send(new PutCommand({
    TableName: process.env.STORAGE_TABLE_NAME,
    Item: item
  }));

  console.log('Storage item created successfully');

  // 2. Start Step Functions execution
  const executionName = `storage-creation-${storageId}-${Date.now()}`;
  console.log('Starting Step Functions execution:', executionName);

  await sfn.send(new StartExecutionCommand({
    stateMachineArn: process.env.STORAGE_CREATION_STATE_MACHINE_ARN,
    input: JSON.stringify({
      storageId,
      name: data.name,
      type: 'fsx-ontap',
      region: region,
      configuration
    }),
    name: executionName
  }));

  console.log('Step Functions execution started successfully');

  return {
    statusCode: 201,
    headers: corsHeaders,
    body: JSON.stringify({
      success: true,
      data: {
        storageId,
        name: data.name,
        type: 'fsx-ontap',
        status: 'initializing',
        platform: 'multi',
        region: region,
        storageCapacity: configuration.storageCapacity,
        throughput: totalThroughput,
        haPairs: configuration.haPairs,
        deploymentType: configuration.deploymentType,
        configuration,
        createdAt
      }
    })
  };
}
