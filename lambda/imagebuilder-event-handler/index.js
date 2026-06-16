// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient, UpdateItemCommand, PutItemCommand, ScanCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand: DocScanCommand, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { ImagebuilderClient, GetImageCommand, GetInfrastructureConfigurationCommand, UpdateInfrastructureConfigurationCommand, StartImagePipelineExecutionCommand } = require('@aws-sdk/client-imagebuilder');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { LicenseManagerClient, UpdateLicenseSpecificationsForResourceCommand } = require('@aws-sdk/client-license-manager');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamoDocClient = DynamoDBDocumentClient.from(dynamoClient);
const imageBuilderClient = new ImagebuilderClient({ region: process.env.AWS_REGION });
const ssmClient = new SSMClient({ region: process.env.AWS_REGION });

exports.handler = async (event) => {
  console.log('ImageBuilder event:', JSON.stringify(event, null, 2));

  const detail = event.detail;
  const state = detail.state?.status;
  const imageArn = event.resources?.[0];
  
  if (!imageArn || !state) {
    console.log('Missing imageArn or state');
    return;
  }

  console.log(`Image ${imageArn} state: ${state}`);

  if (state === 'AVAILABLE' || state === 'FAILED') {
    // Get full image details from ImageBuilder
    const imageDetails = await imageBuilderClient.send(new GetImageCommand({
      imageBuildVersionArn: imageArn
    }));

    const recipeArn = imageDetails.image?.imageRecipe?.arn;
    if (!recipeArn) {
      console.log('No recipe ARN found');
      return;
    }

    const recipeName = recipeArn.split('/')[1];
    const pipelineId = await findPipelineByRecipeName(recipeName);
    
    if (!pipelineId) {
      console.log('Pipeline not found for recipe:', recipeName);
      return;
    }

    console.log(`Found pipeline ${pipelineId} for recipe ${recipeName}`);

    if (state === 'AVAILABLE') {
      const amiId = imageDetails.image?.outputResources?.amis?.[0]?.image;
      const amiName = imageDetails.image?.outputResources?.amis?.[0]?.name;
      const allAmis = imageDetails.image?.outputResources?.amis || [];
      
      await updatePipelineStatus(pipelineId, 'COMPLETED');
      
      // Store the ImageBuilder image ARN and all AMI details in the pipeline record
      await storeImageBuildInPipeline(pipelineId, imageArn, allAmis);
      
      if (amiId) {
        // registerAMI returns the platform from the pipeline record
        const platform = await registerAMI(amiId, amiName, pipelineId);
        
        // Register AMIs distributed to satellite regions and associate license configs
        await registerDistributedAMIs(imageDetails, pipelineId, platform);
      }
    } else if (state === 'FAILED') {
      // Check if failure is due to InsufficientInstanceCapacity
      const failureReason = detail.state?.reason || '';
      const isCapacityFailure = failureReason.includes('InsufficientInstanceCapacity') || 
                               failureReason.includes('Insufficient capacity') ||
                               failureReason.includes('InsufficientHostCapacity');
      
      if (isCapacityFailure) {
        console.log(`Capacity failure detected for pipeline ${pipelineId}: ${failureReason}`);
        await handleCapacityFailure(pipelineId, imageDetails);
      } else {
        // Extract a shorter error message for display
        let shortReason = failureReason;
        if (failureReason.includes('failed with reason:')) {
          shortReason = failureReason.split('failed with reason:')[1]?.trim() || failureReason;
        }
        // Truncate if too long
        if (shortReason.length > 500) {
          shortReason = shortReason.substring(0, 497) + '...';
        }
        await updatePipelineStatus(pipelineId, 'FAILED', shortReason);
      }
    }
  }
};

async function findPipelineByRecipeName(recipeName) {
  // First try to find by imageRecipeArn (for user-created pipelines)
  let result = await dynamoClient.send(new ScanCommand({
    TableName: process.env.PIPELINES_TABLE_NAME,
    FilterExpression: 'contains(imageRecipeArn, :recipeName)',
    ExpressionAttributeValues: {
      ':recipeName': { S: recipeName }
    }
  }));
  
  if (result.Items?.length > 0) {
    return result.Items[0].pipelineId?.S;
  }
  
  // For system pipelines, try to match by name pattern
  // Recipe name format: mediaresourcemanager-macos-sonoma-dcv-ready-recipe
  // Pipeline name format: macOS Sonoma DCV-Ready Base
  const recipeNameLower = recipeName.toLowerCase();
  
  // Extract OS version from recipe name (e.g., "sonoma", "sequoia", "tahoe")
  const macosVersions = ['sonoma', 'sequoia', 'tahoe', 'ventura', 'monterey'];
  let matchedVersion = null;
  for (const version of macosVersions) {
    if (recipeNameLower.includes(version)) {
      matchedVersion = version;
      break;
    }
  }
  
  if (matchedVersion) {
    // Search for system pipeline by name containing the version
    result = await dynamoClient.send(new ScanCommand({
      TableName: process.env.PIPELINES_TABLE_NAME
    }));
    
    for (const item of result.Items || []) {
      const pipelineName = item.name?.S?.toLowerCase() || '';
      const pipelineId = item.pipelineId?.S || '';
      
      // Match system pipelines by name or ID containing the macOS version
      if ((pipelineName.includes(matchedVersion) || pipelineId.includes(matchedVersion)) &&
          (pipelineName.includes('macos') || pipelineId.includes('macos'))) {
        console.log(`Found system pipeline ${item.pipelineId?.S} for recipe ${recipeName}`);
        return item.pipelineId?.S;
      }
    }
  }
  
  console.log(`No pipeline found for recipe: ${recipeName}`);
  return null;
}

async function updatePipelineStatus(pipelineId, status, statusMessage = null) {
  const updateExpression = statusMessage 
    ? 'SET #status = :status, statusMessage = :statusMessage, updatedAt = :updatedAt'
    : 'SET #status = :status, updatedAt = :updatedAt REMOVE statusMessage';
  
  const expressionAttributeValues = {
    ':status': { S: status },
    ':updatedAt': { S: new Date().toISOString() }
  };
  
  if (statusMessage) {
    expressionAttributeValues[':statusMessage'] = { S: statusMessage };
  }
  
  await dynamoClient.send(new UpdateItemCommand({
    TableName: process.env.PIPELINES_TABLE_NAME,
    Key: { pipelineId: { S: pipelineId } },
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: expressionAttributeValues
  }));
  
  console.log(`Updated pipeline ${pipelineId} status to ${status}${statusMessage ? ': ' + statusMessage : ''}`);
}

/**
 * Store ImageBuilder image ARN and AMI details in the pipeline record for cleanup tracking
 * This allows deletePipeline to find and delete all associated resources
 */
async function storeImageBuildInPipeline(pipelineId, imageBuilderArn, amis) {
  try {
    // Build the image build record with all AMI details
    const imageBuild = {
      imageBuilderArn: imageBuilderArn,
      createdAt: new Date().toISOString(),
      amis: amis.map(ami => ({
        amiId: ami.image,
        region: ami.region,
        name: ami.name
      }))
    };
    
    // Get current pipeline record to append to existing builds
    const currentRecord = await dynamoClient.send(new GetItemCommand({
      TableName: process.env.PIPELINES_TABLE_NAME,
      Key: { pipelineId: { S: pipelineId } }
    }));
    
    // Parse existing imageBuilds or start with empty array
    let existingBuilds = [];
    if (currentRecord.Item?.imageBuilds?.S) {
      try {
        existingBuilds = JSON.parse(currentRecord.Item.imageBuilds.S);
      } catch (e) {
        console.warn('Could not parse existing imageBuilds:', e.message);
      }
    }
    
    // Append new build
    existingBuilds.push(imageBuild);
    
    // Update pipeline record with new imageBuilds array
    await dynamoClient.send(new UpdateItemCommand({
      TableName: process.env.PIPELINES_TABLE_NAME,
      Key: { pipelineId: { S: pipelineId } },
      UpdateExpression: 'SET imageBuilds = :imageBuilds, latestAmiId = :latestAmiId, updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':imageBuilds': { S: JSON.stringify(existingBuilds) },
        ':latestAmiId': { S: amis[0]?.image || '' },
        ':updatedAt': { S: new Date().toISOString() }
      }
    }));
    
    console.log(`Stored image build ${imageBuilderArn} with ${amis.length} AMIs in pipeline ${pipelineId}`);
  } catch (error) {
    console.error('Failed to store image build in pipeline', pipelineId + ':', error);
    // Don't throw - this is supplementary tracking, not critical
  }
}

async function registerAMI(amiId, amiName, pipelineId) {
  // Get platform from pipeline record - this is the authoritative source
  let platform = null;
  
  if (pipelineId) {
    try {
      const pipelineResult = await dynamoClient.send(new GetItemCommand({
        TableName: process.env.PIPELINES_TABLE_NAME,
        Key: { pipelineId: { S: pipelineId } }
      }));
      
      platform = pipelineResult.Item?.platform?.S;
      console.log(`Platform from pipeline ${pipelineId}: ${platform}`);
    } catch (error) {
      console.log('Could not fetch pipeline details for platform:', error.message);
    }
  }
  
  // Fail if platform cannot be determined from pipeline
  if (!platform) {
    console.error(`Platform could not be determined for AMI ${amiId} from pipeline ${pipelineId}`);
    throw new Error(`Platform could not be determined for AMI ${amiId}. Pipeline ${pipelineId} does not have a platform field.`);
  }
  
  console.log(`Registering AMI ${amiId} with platform: ${platform}`);
  
  // Register primary region AMI
  await dynamoClient.send(new PutItemCommand({
    TableName: process.env.IMAGES_TABLE_NAME,
    Item: {
      amiId: { S: amiId },
      name: { S: amiName || `AMI from pipeline ${pipelineId}` },
      platform: { S: platform },
      description: { S: `Built from pipeline ${pipelineId}` },
      state: { S: 'available' },
      isAutoGenerated: { BOOL: false },
      pipelineId: { S: pipelineId },
      region: { S: process.env.AWS_REGION },
      createdAt: { S: new Date().toISOString() },
      updatedAt: { S: new Date().toISOString() }
    }
  }));
  
  console.log(`Registered AMI ${amiId} from pipeline ${pipelineId} with platform ${platform}`);
  
  return platform; // Return platform for use by caller
}

/**
 * Register AMIs distributed to satellite regions and associate license configurations for macOS
 * This is called after the primary AMI is registered
 */
async function registerDistributedAMIs(imageDetails, pipelineId, platform) {
  const amis = imageDetails.image?.outputResources?.amis || [];
  const primaryRegion = process.env.AWS_REGION;
  
  // Get regional hubs for license configuration lookup
  let regionalHubs = [];
  try {
    const result = await dynamoDocClient.send(new DocScanCommand({
      TableName: process.env.REGIONAL_HUBS_TABLE_NAME || `${process.env.ACRONYM?.toLowerCase() || 'tfc'}-regional-hubs`
    }));
    regionalHubs = result.Items || [];
  } catch (error) {
    console.warn('Could not fetch regional hubs:', error.message);
  }
  
  // Process each distributed AMI
  for (const ami of amis) {
    const amiRegion = ami.region;
    const amiId = ami.image;
    const amiName = ami.name;
    
    // Skip primary region (already registered)
    if (amiRegion === primaryRegion) {
      continue;
    }
    
    console.log(`Processing distributed AMI ${amiId} in region ${amiRegion}`);
    
    // Register in tfc-amis table with region info
    try {
      await dynamoDocClient.send(new PutCommand({
        TableName: process.env.IMAGES_TABLE_NAME,
        Item: {
          amiId: amiId,
          name: amiName || `AMI from pipeline ${pipelineId}`,
          platform: platform,
          description: `Built from pipeline ${pipelineId} (distributed to ${amiRegion})`,
          state: 'available',
          isAutoGenerated: false,
          pipelineId: pipelineId,
          region: amiRegion,
          sourceRegion: primaryRegion,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      }));
      console.log(`Registered distributed AMI ${amiId} in region ${amiRegion}`);
    } catch (error) {
      console.error('Failed to register distributed AMI', amiId + ':', error.message);
    }
    
    // For macOS AMIs, associate the regional license configuration
    if (platform === 'macOS') {
      const regionalHub = regionalHubs.find(h => h.region === amiRegion);
      const licenseConfigArn = regionalHub?.licenseConfigurationArn;
      
      if (licenseConfigArn) {
        try {
          const licenseManager = new LicenseManagerClient({ region: amiRegion });
          await licenseManager.send(new UpdateLicenseSpecificationsForResourceCommand({
            ResourceArn: `arn:aws:ec2:${amiRegion}::image/${amiId}`,
            AddLicenseSpecifications: [
              { LicenseConfigurationArn: licenseConfigArn }
            ]
          }));
          console.log(`Associated license config ${licenseConfigArn} with AMI ${amiId} in ${amiRegion}`);
        } catch (error) {
          console.error('Failed to associate license config with AMI', amiId, 'in', amiRegion + ':', error.message);
          // Don't fail the whole process - the AMI is still usable, just needs manual license association
        }
      } else {
        console.warn(`No license configuration found for macOS AMI in region ${amiRegion}`);
      }
    }
  }
}

async function handleCapacityFailure(pipelineId, imageDetails) {
  try {
    // Get pipeline details from DynamoDB
    const pipelineResult = await dynamoClient.send(new GetItemCommand({
      TableName: process.env.PIPELINES_TABLE_NAME,
      Key: { pipelineId: { S: pipelineId } }
    }));
    
    const pipeline = pipelineResult.Item;
    if (!pipeline) {
      console.log(`Pipeline ${pipelineId} not found in database`);
      return;
    }
    
    const retryCount = parseInt(pipeline.retryCount?.N || '0');
    const maxRetries = 2; // Try up to 2 different subnets
    
    if (retryCount >= maxRetries) {
      console.log(`Max retries (${maxRetries}) reached for pipeline ${pipelineId}`);
      await updatePipelineStatus(pipelineId, 'FAILED');
      return;
    }
    
    // Get alternative subnet
    const currentSubnet = pipeline.subnetId?.S;
    const triedSubnets = pipeline.triedSubnets?.SS || [currentSubnet];
    const alternativeSubnet = await getAlternativeSubnet(triedSubnets);
    
    if (!alternativeSubnet) {
      console.log(`No untried alternative subnet found for pipeline ${pipelineId}`);
      await updatePipelineStatus(pipelineId, 'FAILED');
      return;
    }
    
    console.log(`Retrying pipeline ${pipelineId} with subnet ${alternativeSubnet} (attempt ${retryCount + 1})`);
    
    // Update infrastructure configuration with new subnet
    const infraConfigArn = pipeline.infrastructureConfigurationArn?.S;
    if (infraConfigArn) {
      // Get current infrastructure configuration to preserve all settings
      const currentConfig = await imageBuilderClient.send(new GetInfrastructureConfigurationCommand({
        infrastructureConfigurationArn: infraConfigArn
      }));
      
      // Update with new subnet while preserving all other settings
      await imageBuilderClient.send(new UpdateInfrastructureConfigurationCommand({
        infrastructureConfigurationArn: infraConfigArn,
        name: currentConfig.infrastructureConfiguration.name,
        instanceProfileName: currentConfig.infrastructureConfiguration.instanceProfileName,
        instanceTypes: currentConfig.infrastructureConfiguration.instanceTypes,
        subnetId: alternativeSubnet,
        securityGroupIds: currentConfig.infrastructureConfiguration.securityGroupIds,
        keyPair: currentConfig.infrastructureConfiguration.keyPair,
        terminateInstanceOnFailure: currentConfig.infrastructureConfiguration.terminateInstanceOnFailure,
        snsTopicArn: currentConfig.infrastructureConfiguration.snsTopicArn,
        resourceTags: currentConfig.infrastructureConfiguration.resourceTags,
        instanceMetadataOptions: currentConfig.infrastructureConfiguration.instanceMetadataOptions,
        logging: currentConfig.infrastructureConfiguration.logging
      }));
    }
    
    // Update pipeline record with new subnet, add to tried subnets, and increment retry count
    const newTriedSubnets = [...triedSubnets, alternativeSubnet];
    await dynamoClient.send(new UpdateItemCommand({
      TableName: process.env.PIPELINES_TABLE_NAME,
      Key: { pipelineId: { S: pipelineId } },
      UpdateExpression: 'SET subnetId = :subnet, triedSubnets = :triedSubnets, retryCount = :retryCount, #status = :status, updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':subnet': { S: alternativeSubnet },
        ':triedSubnets': { SS: newTriedSubnets },
        ':retryCount': { N: (retryCount + 1).toString() },
        ':status': { S: 'RETRYING' },
        ':updatedAt': { S: new Date().toISOString() }
      }
    }));
    
    // Restart pipeline execution
    const pipelineArn = pipeline.pipelineArn?.S;
    if (pipelineArn) {
      await imageBuilderClient.send(new StartImagePipelineExecutionCommand({
        imagePipelineArn: pipelineArn,
        executionRole: `arn:aws:iam::${process.env.AWS_ACCOUNT_ID}:role/MediaResourceManager-ImageBuilder-ServiceRole`
      }));
      console.log(`Restarted pipeline execution for ${pipelineId}`);
    }
    
  } catch (error) {
    console.error('Error handling capacity failure for pipeline', pipelineId + ':', error);
    await updatePipelineStatus(pipelineId, 'FAILED');
  }
}

async function getAlternativeSubnet(triedSubnets) {
  try {
    const pascalCaseName = process.env.PASCAL_CASE_NAME;
    
    // Get private subnet IDs from parameter store (correct parameter names)
    const subnetParams = await Promise.all([
      ssmClient.send(new GetParameterCommand({ Name: `/${pascalCaseName}/Network/PrivateSubnet1/SubnetID` })),
      ssmClient.send(new GetParameterCommand({ Name: `/${pascalCaseName}/Network/PrivateSubnet2/SubnetID` }))
    ]);
    
    const availableSubnets = subnetParams
      .map(param => param.Parameter.Value)
      .filter(subnetId => !triedSubnets.includes(subnetId));
    
    if (availableSubnets.length === 0) {
      console.log('No untried subnets found in parameter store');
      return null;
    }
    
    // Return first untried subnet
    const alternativeSubnet = availableSubnets[0];
    console.log(`Found untried subnet from parameter store: ${alternativeSubnet}`);
    return alternativeSubnet;
    
  } catch (error) {
    console.error('Error getting subnets from parameter store:', error);
    return null;
  }
}
