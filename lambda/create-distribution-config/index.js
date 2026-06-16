// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { ImagebuilderClient, CreateDistributionConfigurationCommand, UpdateDistributionConfigurationCommand, DeleteDistributionConfigurationCommand, GetDistributionConfigurationCommand, ListDistributionConfigurationsCommand } = require('@aws-sdk/client-imagebuilder');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const imageBuilderClient = new ImagebuilderClient({ region: process.env.AWS_REGION });

/**
 * Custom Resource Lambda to create/update Image Builder distribution configurations
 * with dynamic satellite regions from the regional hubs table.
 */
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  const requestType = event.RequestType;
  const props = event.ResourceProperties;
  const configName = props.ConfigName;
  const macosVersion = props.MacOSVersion;
  const pascalCaseName = props.PascalCaseName;
  const pipelineId = props.PipelineId;
  const primaryRegion = props.PrimaryRegion;
  const licenseConfigArn = props.LicenseConfigurationArn;
  const regionalHubsTableName = props.RegionalHubsTableName;
  
  // For Delete requests, delete the distribution config
  if (requestType === 'Delete') {
    try {
      const configArn = event.PhysicalResourceId;
      if (configArn && configArn.startsWith('arn:aws:imagebuilder')) {
        await imageBuilderClient.send(new DeleteDistributionConfigurationCommand({
          distributionConfigurationArn: configArn
        }));
        console.log(`Deleted distribution config: ${configArn}`);
      }
    } catch (error) {
      if (error.name !== 'ResourceNotFoundException') {
        console.error('Error deleting distribution config:', error);
      }
    }
    return { PhysicalResourceId: event.PhysicalResourceId };
  }
  
  // Fetch satellite regions and their license configs from DynamoDB
  let satelliteHubs = [];
  try {
    // Scan for hubs with status 'ACTIVE' or 'available' (case-insensitive)
    const result = await dynamoClient.send(new ScanCommand({
      TableName: regionalHubsTableName
    }));
    
    satelliteHubs = (result.Items || [])
      .filter(item => {
        const status = item.status?.S?.toLowerCase();
        const region = item.region?.S;
        return (status === 'active' || status === 'available') && region && region !== primaryRegion;
      })
      .map(item => ({
        region: item.region?.S,
        licenseConfigurationArn: item.licenseConfigurationArn?.S,
      }));
    
    console.log('Found', satelliteHubs.length, 'satellite hubs:', satelliteHubs);
  } catch (error) {
    if (error.name === 'ResourceNotFoundException') {
      console.log('Regional hubs table not found, using primary region only');
    } else {
      console.warn('Error fetching satellite regions:', error.message);
    }
  }
  
  // Build distributions array
  const distributions = [
    {
      region: primaryRegion,
      amiDistributionConfiguration: {
        name: `macOS-${macosVersion}-DCV-Ready-{{imagebuilder:buildDate}}`,
        description: `macOS ${macosVersion} AMI with DCV pre-configured and SIP disabled`,
        amiTags: {
          'Name': `macOS-${macosVersion}-DCV-Ready`,
          'CreatedBy': pascalCaseName,
          'PipelineId': pipelineId,
          'IsSystemImage': 'true',
          'DCVReady': 'true',
          'MacOSVersion': macosVersion,
          'Platform': 'macOS',
        },
      },
      licenseConfigurationArns: [licenseConfigArn],
    }
  ];
  
  // Add satellite regions with their license configs
  for (const hub of satelliteHubs) {
    const distConfig = {
      region: hub.region,
      amiDistributionConfiguration: {
        name: `macOS-${macosVersion}-DCV-Ready-{{imagebuilder:buildDate}}`,
        description: `macOS ${macosVersion} AMI with DCV pre-configured and SIP disabled (distributed to ${hub.region})`,
        amiTags: {
          'Name': `macOS-${macosVersion}-DCV-Ready`,
          'CreatedBy': pascalCaseName,
          'PipelineId': pipelineId,
          'IsSystemImage': 'true',
          'DCVReady': 'true',
          'MacOSVersion': macosVersion,
          'Platform': 'macOS',
          'SourceRegion': primaryRegion,
          'DistributedTo': hub.region,
        },
      },
    };
    
    // Include license config if available for this region
    if (hub.licenseConfigurationArn) {
      distConfig.licenseConfigurationArns = [hub.licenseConfigurationArn];
      console.log(`Including license config for ${hub.region}: ${hub.licenseConfigurationArn}`);
    } else {
      console.warn(`No license config found for ${hub.region}, AMI will need manual license association`);
    }
    
    distributions.push(distConfig);
  }
  
  const satelliteRegions = satelliteHubs.map(h => h.region);
  
  try {
    let configArn;
    
    if (requestType === 'Create') {
      // Try to create, but if it already exists, get the ARN and update it instead
      try {
        const response = await imageBuilderClient.send(new CreateDistributionConfigurationCommand({
          name: configName,
          description: `Distribution config for macOS ${macosVersion} DCV-Ready pipeline`,
          distributions: distributions,
          tags: {
            'ManagedBy': pascalCaseName,
            'MacOSVersion': macosVersion,
          },
        }));
        configArn = response.distributionConfigurationArn;
        console.log(`Created distribution config: ${configArn}`);
      } catch (createError) {
        if (createError.name === 'ResourceAlreadyExistsException') {
          // Config already exists, find it and update it
          console.log(`Distribution config ${configName} already exists, updating instead`);
          configArn = `arn:aws:imagebuilder:${process.env.AWS_REGION}:${process.env.AWS_ACCOUNT_ID || primaryRegion.split(':')[4]}:distribution-configuration/${configName.toLowerCase()}`;
          
          // Get the existing config to verify it exists
          try {
            await imageBuilderClient.send(new GetDistributionConfigurationCommand({
              distributionConfigurationArn: configArn
            }));
          } catch (getError) {
            // Try to find it by listing
            const listResponse = await imageBuilderClient.send(new ListDistributionConfigurationsCommand({}));
            const existingConfig = listResponse.distributionConfigurationSummaryList?.find(c => c.name === configName);
            if (existingConfig) {
              configArn = existingConfig.arn;
            } else {
              throw new Error(`Could not find existing distribution config: ${configName}`);
            }
          }
          
          // Update the existing config
          await imageBuilderClient.send(new UpdateDistributionConfigurationCommand({
            distributionConfigurationArn: configArn,
            description: `Distribution config for macOS ${macosVersion} DCV-Ready pipeline`,
            distributions: distributions,
          }));
          console.log(`Updated existing distribution config: ${configArn}`);
        } else {
          throw createError;
        }
      }
    } else if (requestType === 'Update') {
      // Update existing distribution config
      configArn = event.PhysicalResourceId;
      
      // Check if config exists
      try {
        await imageBuilderClient.send(new GetDistributionConfigurationCommand({
          distributionConfigurationArn: configArn
        }));
        
        // Config exists, update it
        await imageBuilderClient.send(new UpdateDistributionConfigurationCommand({
          distributionConfigurationArn: configArn,
          description: `Distribution config for macOS ${macosVersion} DCV-Ready pipeline`,
          distributions: distributions,
        }));
        console.log(`Updated distribution config: ${configArn}`);
      } catch (error) {
        if (error.name === 'ResourceNotFoundException') {
          // Config was deleted externally, recreate it
          const response = await imageBuilderClient.send(new CreateDistributionConfigurationCommand({
            name: configName,
            description: `Distribution config for macOS ${macosVersion} DCV-Ready pipeline`,
            distributions: distributions,
            tags: {
              'ManagedBy': pascalCaseName,
              'MacOSVersion': macosVersion,
            },
          }));
          configArn = response.distributionConfigurationArn;
          console.log(`Recreated distribution config: ${configArn}`);
        } else {
          throw error;
        }
      }
    }
    
    return {
      PhysicalResourceId: configArn,
      Data: {
        DistributionConfigurationArn: configArn,
        SatelliteRegionCount: satelliteRegions.length.toString(),
        SatelliteRegions: satelliteRegions.join(','),
      }
    };
  } catch (error) {
    console.error('Error managing distribution config:', error);
    throw error;
  }
};
