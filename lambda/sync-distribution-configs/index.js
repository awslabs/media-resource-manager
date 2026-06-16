// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { ImagebuilderClient, ListDistributionConfigurationsCommand, GetDistributionConfigurationCommand, UpdateDistributionConfigurationCommand } = require('@aws-sdk/client-imagebuilder');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const imageBuilderClient = new ImagebuilderClient({ region: process.env.AWS_REGION });

const PASCAL_CASE_NAME = process.env.PASCAL_CASE_NAME;
const REGIONAL_HUBS_TABLE_NAME = process.env.REGIONAL_HUBS_TABLE_NAME;
const PRIMARY_REGION = process.env.AWS_REGION;

/**
 * Lambda triggered when regional hubs change (create/update/delete).
 * Updates all system macOS pipeline distribution configs to include/exclude the changed region.
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  try {
    // Get all active satellite hubs with their license configs from DynamoDB
    const satelliteHubs = await getActiveSatelliteHubs();
    console.log(`Active satellite hubs:`, satelliteHubs);
    
    // Find all system macOS distribution configs
    const distConfigs = await findSystemDistributionConfigs();
    console.log(`Found ${distConfigs.length} system distribution configs to update`);
    
    // Update each distribution config
    for (const config of distConfigs) {
      await updateDistributionConfig(config, satelliteHubs);
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Updated ${distConfigs.length} distribution configs`,
        satelliteHubs
      })
    };
  } catch (error) {
    console.error('Error syncing distribution configs:', error);
    throw error;
  }
};

async function getActiveSatelliteHubs() {
  const result = await dynamoClient.send(new ScanCommand({
    TableName: REGIONAL_HUBS_TABLE_NAME
  }));
  
  return (result.Items || [])
    .filter(item => {
      const status = item.status?.S?.toLowerCase();
      const region = item.region?.S;
      return (status === 'active' || status === 'available') && region && region !== PRIMARY_REGION;
    })
    .map(item => ({
      region: item.region?.S,
      licenseConfigurationArn: item.licenseConfigurationArn?.S,
    }));
}

async function findSystemDistributionConfigs() {
  const configs = [];
  let nextToken;
  
  do {
    const response = await imageBuilderClient.send(new ListDistributionConfigurationsCommand({
      nextToken
    }));
    
    // Filter for our system macOS distribution configs
    const systemConfigs = (response.distributionConfigurationSummaryList || [])
      .filter(config => 
        config.name?.startsWith(`${PASCAL_CASE_NAME}-macOS-`) && 
        config.name?.includes('-DCV-Ready-Dist')
      );
    
    configs.push(...systemConfigs);
    nextToken = response.nextToken;
  } while (nextToken);
  
  return configs;
}

async function updateDistributionConfig(configSummary, satelliteHubs) {
  const configArn = configSummary.arn;
  const configName = configSummary.name;
  
  console.log(`Updating distribution config: ${configName}`);
  
  // Get current config details
  const currentConfig = await imageBuilderClient.send(new GetDistributionConfigurationCommand({
    distributionConfigurationArn: configArn
  }));
  
  const existingDistributions = currentConfig.distributionConfiguration?.distributions || [];
  
  // Find the primary region distribution (has license config)
  const primaryDistribution = existingDistributions.find(d => d.region === PRIMARY_REGION);
  if (!primaryDistribution) {
    console.warn(`No primary region distribution found for ${configName}, skipping`);
    return;
  }
  
  // Extract macOS version from config name (e.g., "MediaResourceManager-macOS-Sequoia-DCV-Ready-Dist" -> "Sequoia")
  const macosVersionMatch = configName.match(/macOS-(\w+)-DCV-Ready/);
  const macosVersion = macosVersionMatch ? macosVersionMatch[1] : 'Unknown';
  
  // Extract pipeline ID from primary distribution tags
  const pipelineId = primaryDistribution.amiDistributionConfiguration?.amiTags?.PipelineId || 
                     `system-macos-${macosVersion.toLowerCase()}-dcv-ready`;
  
  // Build new distributions array
  const newDistributions = [primaryDistribution];
  
  // Add satellite regions with their license configs
  for (const hub of satelliteHubs) {
    const distConfig = {
      region: hub.region,
      amiDistributionConfiguration: {
        name: `macOS-${macosVersion}-DCV-Ready-{{imagebuilder:buildDate}}`,
        description: `macOS ${macosVersion} AMI with DCV pre-configured and SIP disabled (distributed to ${hub.region})`,
        amiTags: {
          'Name': `macOS-${macosVersion}-DCV-Ready`,
          'CreatedBy': PASCAL_CASE_NAME,
          'PipelineId': pipelineId,
          'IsSystemImage': 'true',
          'DCVReady': 'true',
          'MacOSVersion': macosVersion,
          'Platform': 'macOS',
          'SourceRegion': PRIMARY_REGION,
          'DistributedTo': hub.region,
        },
      },
    };
    
    // Include license config if available for this region
    if (hub.licenseConfigurationArn) {
      distConfig.licenseConfigurationArns = [hub.licenseConfigurationArn];
      console.log(`Including license config for ${hub.region}: ${hub.licenseConfigurationArn}`);
    } else {
      console.warn(`No license config found for ${hub.region}`);
    }
    
    newDistributions.push(distConfig);
  }
  
  // Update the distribution config
  await imageBuilderClient.send(new UpdateDistributionConfigurationCommand({
    distributionConfigurationArn: configArn,
    description: currentConfig.distributionConfiguration?.description,
    distributions: newDistributions,
  }));
  
  console.log(`Updated ${configName} with ${satelliteHubs.length} satellite regions`);
}
