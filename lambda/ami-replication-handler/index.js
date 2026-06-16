// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AMI Replication Handler
 * 
 * Triggered by EventBridge when a new AMI is created or registered.
 * Copies the AMI to all available satellite regions and updates the regional hub records.
 */

const { EC2Client, CopyImageCommand, DescribeImagesCommand } = require('@aws-sdk/client-ec2');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');

const dynamoClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

exports.handler = async (event) => {
  console.log('AMI Replication Handler event:', JSON.stringify(event, null, 2));
  
  try {
    // Handle both EventBridge events and direct invocations
    let amiId, sourceRegion, amiName, amiDescription;
    
    if (event.detail) {
      // EventBridge event from EC2 AMI state change
      amiId = event.detail['image-id'] || event.detail.imageId;
      sourceRegion = event.region;
      
      // Get AMI details
      const ec2 = new EC2Client({ region: sourceRegion });
      const describeResult = await ec2.send(new DescribeImagesCommand({
        ImageIds: [amiId]
      }));
      
      if (!describeResult.Images || describeResult.Images.length === 0) {
        console.log('AMI not found:', amiId);
        return { success: false, error: 'AMI not found' };
      }
      
      const ami = describeResult.Images[0];
      amiName = ami.Name;
      amiDescription = ami.Description;
      
      // Check if this AMI is managed by our application
      const managedByTag = ami.Tags?.find(t => t.Key === 'ManagedBy');
      if (!managedByTag || managedByTag.Value !== process.env.PRODUCT_NAME) {
        console.log('AMI not managed by this application, skipping replication');
        return { success: true, message: 'AMI not managed by this application' };
      }
    } else if (event.amiId) {
      // Direct invocation
      amiId = event.amiId;
      sourceRegion = event.sourceRegion || process.env.AWS_REGION;
      amiName = event.amiName;
      amiDescription = event.amiDescription;
    } else {
      return { success: false, error: 'Invalid event format' };
    }
    
    console.log(`Processing AMI replication for ${amiId} from ${sourceRegion}`);
    
    // Get all available satellite regions
    const satelliteRegions = await getAvailableSatelliteRegions();
    
    if (satelliteRegions.length === 0) {
      console.log('No satellite regions available for replication');
      return { success: true, message: 'No satellite regions to replicate to' };
    }
    
    console.log('Replicating to', satelliteRegions.length, 'satellite regions:', satelliteRegions.map(r => r.region));
    
    // Copy AMI to each satellite region
    const replicationResults = await Promise.allSettled(
      satelliteRegions.map(hub => copyAmiToRegion(amiId, amiName, amiDescription, sourceRegion, hub.region))
    );
    
    // Process results and update regional hub records
    const results = [];
    for (let i = 0; i < satelliteRegions.length; i++) {
      const hub = satelliteRegions[i];
      const result = replicationResults[i];
      
      if (result.status === 'fulfilled') {
        results.push({
          region: hub.region,
          success: true,
          targetAmiId: result.value.targetAmiId
        });
        
        // Update regional hub record with new AMI
        await updateRegionalHubAmi(hub.region, amiId, result.value.targetAmiId, amiName);
      } else {
        results.push({
          region: hub.region,
          success: false,
          error: result.reason?.message || 'Unknown error'
        });
        console.error('Failed to replicate to', hub.region + ':', result.reason);
      }
    }
    
    // Also update the AMI table with replication status
    await updateAmiReplicationStatus(amiId, results);
    
    const successCount = results.filter(r => r.success).length;
    console.log(`Replication complete: ${successCount}/${satelliteRegions.length} successful`);
    
    return {
      success: true,
      sourceAmiId: amiId,
      sourceRegion,
      replicationResults: results
    };
  } catch (error) {
    console.error('Error in AMI replication handler:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

async function getAvailableSatelliteRegions() {
  const result = await dynamodb.send(new ScanCommand({
    TableName: process.env.REGIONAL_HUBS_TABLE_NAME,
    FilterExpression: '#status = :available',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':available': 'available' }
  }));
  
  return result.Items || [];
}

async function copyAmiToRegion(sourceAmiId, amiName, amiDescription, sourceRegion, targetRegion) {
  console.log(`Copying AMI ${sourceAmiId} from ${sourceRegion} to ${targetRegion}`);
  
  const ec2 = new EC2Client({ region: targetRegion });
  
  const copyResult = await ec2.send(new CopyImageCommand({
    SourceImageId: sourceAmiId,
    SourceRegion: sourceRegion,
    Name: amiName || `Replicated-${sourceAmiId}`,
    Description: amiDescription || `Replicated from ${sourceRegion}`,
    Encrypted: true // Always encrypt replicated AMIs
  }));
  
  console.log(`AMI copy initiated: ${sourceAmiId} -> ${copyResult.ImageId} in ${targetRegion}`);
  
  return {
    targetAmiId: copyResult.ImageId,
    targetRegion
  };
}

async function updateRegionalHubAmi(region, sourceAmiId, targetAmiId, amiName) {
  try {
    // Get current AMIs map
    const hubResult = await dynamodb.send(new GetCommand({
      TableName: process.env.REGIONAL_HUBS_TABLE_NAME,
      Key: { region }
    }));
    
    const currentAmis = hubResult.Item?.amis || {};
    
    // Determine AMI type from name
    let amiType = 'custom';
    if (amiName) {
      const nameLower = amiName.toLowerCase();
      if (nameLower.includes('windows')) amiType = 'windows';
      else if (nameLower.includes('linux') || nameLower.includes('amazon')) amiType = 'linux';
      else if (nameLower.includes('macos') || nameLower.includes('mac')) amiType = 'macos';
    }
    
    // Update AMIs map
    currentAmis[sourceAmiId] = {
      targetAmiId,
      amiType,
      amiName,
      replicatedAt: new Date().toISOString(),
      status: 'pending' // Will be 'available' once copy completes
    };
    
    await dynamodb.send(new UpdateCommand({
      TableName: process.env.REGIONAL_HUBS_TABLE_NAME,
      Key: { region },
      UpdateExpression: 'SET amis = :amis, updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':amis': currentAmis,
        ':updatedAt': new Date().toISOString()
      }
    }));
    
    console.log(`Updated regional hub ${region} with AMI mapping: ${sourceAmiId} -> ${targetAmiId}`);
  } catch (error) {
    console.error('Failed to update regional hub', region + ':', error);
  }
}

async function updateAmiReplicationStatus(amiId, results) {
  try {
    const replicationMap = {};
    for (const result of results) {
      replicationMap[result.region] = {
        targetAmiId: result.targetAmiId || null,
        status: result.success ? 'pending' : 'failed',
        error: result.error || null,
        replicatedAt: new Date().toISOString()
      };
    }
    
    await dynamodb.send(new UpdateCommand({
      TableName: process.env.AMI_TABLE_NAME,
      Key: { amiId },
      UpdateExpression: 'SET replication = :replication, updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':replication': replicationMap,
        ':updatedAt': new Date().toISOString()
      }
    }));
    
    console.log(`Updated AMI ${amiId} with replication status`);
  } catch (error) {
    console.error(`Failed to update AMI replication status:`, error);
  }
}
