// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Image Manager Lambda Function - Updated for IAM permissions v2
const { DynamoDBClient, PutItemCommand, UpdateItemCommand, DeleteItemCommand, ScanCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand: DocScanCommand } = require('@aws-sdk/lib-dynamodb');
const { EC2Client, DescribeImagesCommand, DeregisterImageCommand, CopyImageCommand } = require('@aws-sdk/client-ec2');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
const { ImagebuilderClient, CreateImagePipelineCommand, CreateImageRecipeCommand, 
        CreateInfrastructureConfigurationCommand, CreateDistributionConfigurationCommand,
        StartImagePipelineExecutionCommand, GetImagePipelineCommand, CreateComponentCommand,
        DeleteImagePipelineCommand, DeleteImageRecipeCommand, DeleteInfrastructureConfigurationCommand,
        DeleteDistributionConfigurationCommand, DeleteComponentCommand, UpdateInfrastructureConfigurationCommand,
        UpdateImagePipelineCommand, ListImagesCommand, DeleteImageCommand, ListImageBuildVersionsCommand,
        ListImageRecipesCommand } = require('@aws-sdk/client-imagebuilder');

// STS client for getting account ID
const stsClient = new STSClient({ region: process.env.AWS_REGION });
let cachedAccountId = null;

// Helper function to get AWS account ID dynamically
async function getAccountId() {
  if (cachedAccountId) return cachedAccountId;
  const response = await stsClient.send(new GetCallerIdentityCommand({}));
  cachedAccountId = response.Account;
  return cachedAccountId;
}

// Helper function to determine OS version from AMI ID
async function getOsVersionFromAmi(amiId) {
  try {
    const command = new DescribeImagesCommand({
      ImageIds: [amiId]
    });
    
    const result = await ec2Client.send(command);
    const image = result.Images?.[0];
    
    if (!image) {
      return 'Unknown';
    }
    
    const name = image.Name || '';
    const description = image.Description || '';
    const platform = image.Platform || 'linux';
    
    // Check for Windows versions
    if (platform === 'windows' || name.toLowerCase().includes('windows')) {
      if (name.includes('2025') || description.includes('2025')) {
        return 'Windows Server 2025';
      } else if (name.includes('2022') || description.includes('2022')) {
        return 'Windows Server 2022';
      } else if (name.includes('2019') || description.includes('2019')) {
        return 'Windows Server 2019';
      } else if (name.includes('2016') || description.includes('2016')) {
        return 'Windows Server 2016';
      } else if (name.includes('2012') || description.includes('2012')) {
        return 'Windows Server 2012';
      } else {
        return 'Windows Server';
      }
    }
    
    // Check for Linux versions
    if (name.toLowerCase().includes('ubuntu')) {
      if (name.includes('22.04')) return 'Ubuntu 22.04';
      if (name.includes('20.04')) return 'Ubuntu 20.04';
      if (name.includes('18.04')) return 'Ubuntu 18.04';
      return 'Ubuntu';
    }
    
    if (name.toLowerCase().includes('amazon linux')) {
      if (name.includes('2023')) return 'Amazon Linux 2023';
      if (name.includes('2')) return 'Amazon Linux 2';
      return 'Amazon Linux';
    }
    
    if (name.toLowerCase().includes('centos')) {
      return 'CentOS';
    }

    if (name.toLowerCase().includes('rocky')) {
      if (name.includes('-9-') || name.includes('9.')) return 'Rocky Linux 9';
      if (name.includes('-8-') || name.includes('8.')) return 'Rocky Linux 8';
      return 'Rocky Linux';
    }
    
    // Check for macOS versions
    if (name.toLowerCase().includes('macos') || name.toLowerCase().includes('amzn-ec2-macos')) {
      if (name.toLowerCase().includes('tahoe') || name.includes('26.')) return 'macOS Tahoe';
      if (name.toLowerCase().includes('sequoia') || name.includes('15.')) return 'macOS Sequoia';
      if (name.toLowerCase().includes('sonoma') || name.includes('14.')) return 'macOS Sonoma';
      if (name.toLowerCase().includes('ventura') || name.includes('13.')) return 'macOS Ventura';
      if (name.toLowerCase().includes('monterey') || name.includes('12.')) return 'macOS Monterey';
      return 'macOS';
    }
    
    if (name.toLowerCase().includes('rhel') || name.toLowerCase().includes('red hat')) {
      return 'Red Hat Enterprise Linux';
    }
    
    return platform === 'windows' ? 'Windows Server' : 'Linux';
  } catch (error) {
    console.warn('Failed to determine OS version from AMI:', error);
    return 'Unknown';
  }
}
async function testInstanceAvailability(subnetId, instanceType = 'm5.large') {
  try {
    const ec2Client = new (require('@aws-sdk/client-ec2').EC2Client)({ region: process.env.AWS_REGION });
    const { RunInstancesCommand, TerminateInstancesCommand } = require('@aws-sdk/client-ec2');
    const ssmClient = new SSMClient({ region: process.env.AWS_REGION });
    
    console.log(`Testing real capacity by launching test instance in subnet ${subnetId}`);
    
    // Get latest Amazon Linux 2023 AMI from SSM parameter (works in any region)
    let testAmiId;
    try {
      const ssmResponse = await ssmClient.send(new GetParameterCommand({
        Name: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64'
      }));
      testAmiId = ssmResponse.Parameter.Value;
      console.log(`Using AMI ${testAmiId} for capacity test`);
    } catch (ssmError) {
      console.error('Failed to get AMI from SSM, skipping capacity test:', ssmError);
      return true; // Assume capacity is available if we can't test
    }
    
    // Actually launch an instance to test real capacity
    const result = await ec2Client.send(new RunInstancesCommand({
      ImageId: testAmiId,
      MinCount: 1,
      MaxCount: 1,
      InstanceType: instanceType,
      SubnetId: subnetId,
      SecurityGroupIds: [process.env.BUILD_SECURITY_GROUP_ID],
      IamInstanceProfile: {
        Name: process.env.IMAGE_BUILDER_INSTANCE_PROFILE
      }
    }));
    
    const instanceId = result.Instances[0].InstanceId;
    console.log(`Test instance ${instanceId} launched successfully in ${subnetId}`);
    
    // Immediately terminate it
    await ec2Client.send(new TerminateInstancesCommand({
      InstanceIds: [instanceId]
    }));
    
    console.log(`Test instance ${instanceId} terminated - capacity confirmed in ${subnetId}`);
    return true;
    
  } catch (error) {
    console.log('Launch test error for subnet', subnetId + ':', error.name, error.message);
    
    if (error.message && error.message.includes('InsufficientInstanceCapacity')) {
      console.log(`ICE error confirmed - no capacity in subnet ${subnetId}`);
      return false;
    } else {
      console.log('Other error in subnet', subnetId, '- treating as unavailable:', error.name);
      return false;
    }
  }
}

// Helper function to get available subnets for retry logic
async function getAvailableSubnets() {
  try {
    const subnets = [];
    const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
    
    // Try to get subnet IDs from SSM parameters
    try {
      const subnet1Response = await ssmClient.send(new GetParameterCommand({
        Name: `/${pascalCaseName}/Network/PrivateSubnet1/SubnetID`
      }));
      subnets.push(subnet1Response.Parameter.Value);
    } catch (error) {
      console.log('Could not retrieve PrivateSubnet1 from SSM:', error.message);
    }
    
    try {
      const subnet2Response = await ssmClient.send(new GetParameterCommand({
        Name: `/${pascalCaseName}/Network/PrivateSubnet2/SubnetID`
      }));
      subnets.push(subnet2Response.Parameter.Value);
    } catch (error) {
      console.log('Could not retrieve PrivateSubnet2 from SSM:', error.message);
    }
    
    // Fallback to environment variables if SSM parameters not found
    if (subnets.length === 0) {
      if (process.env.SUBNET_ID_1) subnets.push(process.env.SUBNET_ID_1);
      if (process.env.SUBNET_ID_2) subnets.push(process.env.SUBNET_ID_2);
    }
    
    return subnets;
  } catch (error) {
    console.error('Error getting available subnets:', error);
    return [];
  }
}

async function handleICEErrorAndRetry(pipelineId, pipelineArn) {
  try {
    // Get available subnets
    const availableSubnets = await getAvailableSubnets();
    
    // Get current infrastructure config from pipeline
    const pipeline = await imageBuilderClient.send(new GetImagePipelineCommand({
      imagePipelineArn: pipelineArn
    }));
    
    const infraConfigArn = pipeline.imagePipeline.infrastructureConfigurationArn;
    
    // Test subnets for availability
    for (const subnetId of availableSubnets) {
      const hasCapacity = await testInstanceAvailability(subnetId);
      if (hasCapacity) {
        console.log(`Switching to subnet ${subnetId} due to ICE error`);
        
        // Update infrastructure configuration with new subnet
        await imageBuilderClient.send(new UpdateInfrastructureConfigurationCommand({
          infrastructureConfigurationArn: infraConfigArn,
          subnetId: subnetId,
          logging: {
            s3Logs: {
              s3BucketName: process.env.LOGS_BUCKET_NAME,
              s3KeyPrefix: 'imagebuilder-logs'
            }
          }
        }));
        
        // Retry pipeline execution
        await imageBuilderClient.send(new StartImagePipelineExecutionCommand({
          imagePipelineArn: pipelineArn
        }));
        
        return;
      }
    }
    
    throw new Error('No subnets with available capacity found');
  } catch (error) {
    console.error('Failed to handle ICE error:', error);
    throw error;
  }
}

const crypto = require('crypto');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamoDocClient = DynamoDBDocumentClient.from(dynamoClient);
const ec2Client = new EC2Client({ region: process.env.AWS_REGION });
const ssmClient = new SSMClient({ region: process.env.AWS_REGION });
const imageBuilderClient = new ImagebuilderClient({ region: process.env.AWS_REGION });

/**
 * Get list of active regional hubs for multi-region AMI distribution
 * Returns array of regions with status 'available' or 'creating'
 */
async function getActiveRegionalHubs() {
  try {
    const result = await dynamoDocClient.send(new DocScanCommand({
      TableName: process.env.REGIONAL_HUBS_TABLE_NAME || `${process.env.ACRONYM?.toLowerCase() || 'tfc'}-regional-hubs`
    }));
    
    // Filter to only active hubs (available or creating status)
    const activeHubs = (result.Items || []).filter(hub => 
      hub.status === 'available' || hub.status === 'creating'
    );
    
    console.log('Found', activeHubs.length, 'active regional hubs:', activeHubs.map(h => h.region));
    return activeHubs;
  } catch (error) {
    console.warn('Could not fetch regional hubs, using primary region only:', error.message);
    return [];
  }
}

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  const { httpMethod: method, path, body } = event;
  
  try {
    if (method === 'OPTIONS') {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: ''
      };
    }
    
    switch (method) {
      case 'GET':
        if (path === '/images') {
          return await getImages();
        } else if (path.startsWith('/images/pipelines/') && path.endsWith('/status')) {
          const pipelineId = path.split('/')[3];
          return await getPipelineStatus(pipelineId);
        } else if (path === '/images/pipelines') {
          return await getPipelines();
        }
        break;
      case 'POST':
        if (path === '/images') {
          return await createImage(JSON.parse(body), event);
        } else if (path === '/images/copy') {
          return await copyImageToRegions(JSON.parse(body), event);
        } else if (path === '/images/create-pipeline') {
          return await createImagePipeline(JSON.parse(body), event);
        } else if (path.startsWith('/images/pipelines/') && path.endsWith('/execute')) {
          const pipelineId = path.split('/')[3];
          return await executePipeline(pipelineId);
        }
        break;
      case 'PUT':
        if (path.startsWith('/images/pipelines/')) {
          const pipelineId = path.split('/')[3];
          return await updatePipeline(pipelineId, JSON.parse(body), event);
        } else if (path.startsWith('/images/')) {
          return await updateImage(path.split('/')[2], JSON.parse(body), event);
        }
        break;
      case 'DELETE':
        if (path.startsWith('/images/pipelines/')) {
          const pipelineId = path.split('/')[3];
          return await deletePipeline(pipelineId, event);
        } else if (path.startsWith('/images/')) {
          return await deleteImage(path.split('/')[2], event);
        }
        break;
    }
    
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Not found' })
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: error.message })
    };
  }
};

async function getImages() {
  try {
    // Get images from DynamoDB
    const command = new ScanCommand({
      TableName: process.env.IMAGES_TABLE_NAME
    });
    
    const result = await dynamoClient.send(command);
    const images = result.Items?.map(item => ({
      amiId: item.amiId?.S,
      name: item.name?.S,
      platform: item.platform?.S,
      description: item.description?.S,
      state: item.state?.S,
      createdAt: item.createdAt?.S,
      owner: item.owner?.S,
      architecture: item.architecture?.S,
      virtualizationType: item.virtualizationType?.S,
      pipelineId: item.pipelineId?.S,
      region: item.region?.S,
      sourceRegion: item.sourceRegion?.S,
      isAutoGenerated: item.isAutoGenerated?.BOOL || false
    })) || [];

    // Get latest Windows Server 2025 AMI from SSM
    try {
      const ssmCommand2025 = new GetParameterCommand({
        Name: '/aws/service/ami-windows-latest/Windows_Server-2025-English-Full-Base'
      });
      
      const ssmResult2025 = await ssmClient.send(ssmCommand2025);
      const latestWindows2025Ami = ssmResult2025.Parameter.Value;
      
      // Check if this AMI is already in the DynamoDB results
      const existingAmi2025 = images.find(img => img.amiId === latestWindows2025Ami);
      
      if (!existingAmi2025) {
        // Add the latest Windows Server 2025 AMI to the results
        images.unshift({
          amiId: latestWindows2025Ami,
          name: 'Microsoft Windows Server 2025 Base (Latest)',
          platform: 'windows',
          description: 'Latest Microsoft Windows Server 2025 Base AMI (automatically updated)',
          state: 'available',
          createdAt: new Date().toISOString(),
          owner: 'amazon',
          architecture: 'x86_64',
          virtualizationType: 'hvm',
          isAutoGenerated: true
        });
      }
    } catch (ssmError) {
      console.warn('Failed to fetch latest Windows Server 2025 AMI from SSM:', ssmError);
      // Continue without the latest AMI if SSM fails
    }

    // Get latest Windows Server 2022 AMI from SSM
    try {
      const ssmCommand = new GetParameterCommand({
        Name: '/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base'
      });
      
      const ssmResult = await ssmClient.send(ssmCommand);
      const latestWindowsAmi = ssmResult.Parameter.Value;
      
      // Check if this AMI is already in the DynamoDB results
      const existingAmi = images.find(img => img.amiId === latestWindowsAmi);
      
      if (!existingAmi) {
        // Add the latest Windows Server 2022 AMI to the results
        images.unshift({
          amiId: latestWindowsAmi,
          name: 'Microsoft Windows Server 2022 Base (Latest)',
          platform: 'windows',
          description: 'Latest Microsoft Windows Server 2022 Base AMI (automatically updated)',
          state: 'available',
          createdAt: new Date().toISOString(),
          owner: 'amazon',
          architecture: 'x86_64',
          virtualizationType: 'hvm',
          isAutoGenerated: true
        });
      }
    } catch (ssmError) {
      console.warn('Failed to fetch latest Windows AMI from SSM:', ssmError);
      // Continue without the latest AMI if SSM fails
    }

    // Get latest Ubuntu 22.04 LTS AMI from SSM
    try {
      const ubuntuSsmCommand = new GetParameterCommand({
        Name: '/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id'
      });
      
      const ubuntuSsmResult = await ssmClient.send(ubuntuSsmCommand);
      const latestUbuntuAmi = ubuntuSsmResult.Parameter.Value;
      
      // Check if this AMI is already in the DynamoDB results
      const existingUbuntuAmi = images.find(img => img.amiId === latestUbuntuAmi);
      
      if (!existingUbuntuAmi) {
        // Add the latest Ubuntu 22.04 AMI to the results
        images.unshift({
          amiId: latestUbuntuAmi,
          name: 'Ubuntu Server 22.04 LTS (Latest)',
          platform: 'linux',
          description: 'Latest Ubuntu Server 22.04 LTS AMI (automatically updated)',
          state: 'available',
          createdAt: new Date().toISOString(),
          owner: 'amazon',
          architecture: 'x86_64',
          virtualizationType: 'hvm',
          isAutoGenerated: true
        });
      }
    } catch (ssmError) {
      console.warn('Failed to fetch latest Ubuntu AMI from SSM:', ssmError);
      // Continue without the latest AMI if SSM fails
    }

    // Get latest Rocky Linux 8 AMI using EC2 DescribeImages
    // Rocky Linux AMIs are published by Rocky Enterprise Software Foundation (owner: 792107900819)
    // Note: Rocky 8 is required for DaVinci Resolve compatibility (Rocky 9 not officially supported)
    try {
      const rocky8Result = await ec2Client.send(new DescribeImagesCommand({
        Owners: ['792107900819'],
        Filters: [
          { Name: 'name', Values: ['Rocky-8-EC2-Base-8*x86_64*'] },
          { Name: 'state', Values: ['available'] },
          { Name: 'architecture', Values: ['x86_64'] }
        ]
      }));
      
      // Sort by creation date and get the latest
      const rocky8Images = rocky8Result.Images?.sort((a, b) => 
        new Date(b.CreationDate) - new Date(a.CreationDate)
      ) || [];
      
      if (rocky8Images.length > 0) {
        const latestRocky8 = rocky8Images[0];
        const existingRocky8 = images.find(img => img.amiId === latestRocky8.ImageId);
        
        if (!existingRocky8) {
          images.unshift({
            amiId: latestRocky8.ImageId,
            name: 'Rocky Linux 8 (Latest)',
            platform: 'linux',
            description: 'Latest Rocky Linux 8 AMI - RHEL-compatible, required for DaVinci Resolve',
            state: 'available',
            createdAt: latestRocky8.CreationDate,
            owner: 'Rocky Enterprise Software Foundation',
            architecture: 'x86_64',
            virtualizationType: 'hvm',
            isAutoGenerated: true
          });
        }
      }
    } catch (rocky8Error) {
      console.warn('Failed to fetch latest Rocky Linux 8 AMI:', rocky8Error);
    }
    
    // NOTE: macOS AMIs (Tahoe, Sequoia, Sonoma) are NOT included in the Images table
    // because raw macOS AMIs require DCV-Ready pipeline processing before they can be
    // used for workstations. Users should create macOS workstations from pipeline-built
    // DCV-Ready images only. The macOS base images are available in the pipeline creation
    // flow via the ImageCreation page.
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify(images)
    };
  } catch (error) {
    console.error('Error fetching images:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to fetch images' })
    };
  }
}

async function createImage(imageData, event) {
  const { amiId, name, description, platform, region } = imageData;
  
  // Validate AMI ID format (ami-xxxxxxxxxxxxxxxxx)
  const amiIdRegex = /^ami-[a-f0-9]{8,17}$/;
  if (!amiId || !amiIdRegex.test(amiId)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ 
        error: 'Invalid AMI ID format. AMI IDs must start with "ami-" followed by 8-17 hexadecimal characters (e.g., ami-0123456789abcdef0)' 
      })
    };
  }

  // Validate required fields
  if (!name || !platform) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Name and platform are required fields' })
    };
  }
  
  try {
    // Use provided region or default to the Lambda's region (primary region)
    const imageRegion = region || process.env.AWS_REGION;
    
    const command = new PutItemCommand({
      TableName: process.env.IMAGES_TABLE_NAME,
      Item: {
        amiId: { S: amiId },
        name: { S: name },
        description: { S: description || '' },
        platform: { S: platform },
        state: { S: 'available' },
        region: { S: imageRegion },
        createdAt: { S: new Date().toISOString() }
      }
    });
    
    await dynamoClient.send(command);
    
    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ message: 'Image created successfully', amiId, region: imageRegion })
    };
  } catch (error) {
    console.error('Error creating image:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to create image' })
    };
  }
}

async function updateImage(amiId, updateData, event) {
  try {
    // Check if this is an auto-generated AMI (Windows or Ubuntu via SSM)
    const autoGeneratedParams = [
      '/aws/service/ami-windows-latest/Windows_Server-2025-English-Full-Base',
      '/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base',
      '/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id'
    ];
    
    for (const paramName of autoGeneratedParams) {
      try {
        const ssmResult = await ssmClient.send(new GetParameterCommand({ Name: paramName }));
        if (ssmResult.Parameter.Value === amiId) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
            body: JSON.stringify({ error: 'Cannot edit auto-generated AMI. This AMI is automatically managed by AWS.' })
          };
        }
      } catch (ssmError) {
        console.warn('Failed to check auto-generated AMI param', paramName + ':', ssmError.message);
      }
    }

    // Check if this is a Rocky Linux auto-generated AMI (by owner and name pattern)
    try {
      const describeResult = await ec2Client.send(new DescribeImagesCommand({ ImageIds: [amiId] }));
      const image = describeResult.Images?.[0];
      if (image && image.OwnerId === '792107900819' && image.Name?.startsWith('Rocky-')) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ error: 'Cannot edit auto-generated AMI. This AMI is automatically managed by Rocky Enterprise Software Foundation.' })
        };
      }
    } catch (describeError) {
      console.warn('Failed to check Rocky Linux AMI:', describeError.message);
    }

    const updateExpression = [];
    const expressionAttributeValues = {};
    const expressionAttributeNames = {};
    
    if (updateData.name) {
      updateExpression.push('#name = :name');
      expressionAttributeValues[':name'] = { S: updateData.name };
      expressionAttributeNames['#name'] = 'name';
    }
    if (updateData.description !== undefined) {
      updateExpression.push('description = :description');
      expressionAttributeValues[':description'] = { S: updateData.description };
    }
    if (updateData.platform) {
      updateExpression.push('platform = :platform');
      expressionAttributeValues[':platform'] = { S: updateData.platform };
    }
    if (updateData.state) {
      updateExpression.push('#state = :state');
      expressionAttributeValues[':state'] = { S: updateData.state };
      expressionAttributeNames['#state'] = 'state';
    }
    
    const command = new UpdateItemCommand({
      TableName: process.env.IMAGES_TABLE_NAME,
      Key: { amiId: { S: amiId } },
      UpdateExpression: `SET ${updateExpression.join(', ')}`,
      ExpressionAttributeValues: expressionAttributeValues,
      ExpressionAttributeNames: expressionAttributeNames
    });
    
    await dynamoClient.send(command);
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ message: 'Image updated successfully' })
    };
  } catch (error) {
    console.error('Error updating image:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to update image' })
    };
  }
}

async function deleteImage(amiId, event) {
  try {
    // Check if this is an auto-generated AMI (Windows or Ubuntu via SSM)
    const autoGeneratedParams = [
      '/aws/service/ami-windows-latest/Windows_Server-2025-English-Full-Base',
      '/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base',
      '/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id'
    ];
    
    for (const paramName of autoGeneratedParams) {
      try {
        const ssmResult = await ssmClient.send(new GetParameterCommand({ Name: paramName }));
        if (ssmResult.Parameter.Value === amiId) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
            body: JSON.stringify({ error: 'Cannot delete auto-generated AMI. This AMI is automatically managed by AWS.' })
          };
        }
      } catch (ssmError) {
        console.warn('Failed to check auto-generated AMI param', paramName + ':', ssmError.message);
      }
    }

    // Check if this is a Rocky Linux auto-generated AMI (by owner and name pattern)
    try {
      const describeResult = await ec2Client.send(new DescribeImagesCommand({ ImageIds: [amiId] }));
      const image = describeResult.Images?.[0];
      if (image && image.OwnerId === '792107900819' && image.Name?.startsWith('Rocky-')) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ error: 'Cannot delete auto-generated AMI. This AMI is automatically managed by Rocky Enterprise Software Foundation.' })
        };
      }
    } catch (describeError) {
      console.warn('Failed to check Rocky Linux AMI:', describeError.message);
    }

    const command = new DeleteItemCommand({
      TableName: process.env.IMAGES_TABLE_NAME,
      Key: { amiId: { S: amiId } }
    });
    
    await dynamoClient.send(command);
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ message: 'Image deleted successfully' })
    };
  } catch (error) {
    console.error('Error deleting image:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to delete image' })
    };
  }
}

// Copy AMI to multiple regions
async function copyImageToRegions(copyData, event) {
  const { sourceAmiId, sourceRegion, targetRegions, name, platform, description, pipelineId } = copyData;
  
  if (!sourceAmiId || !targetRegions || targetRegions.length === 0) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'sourceAmiId and targetRegions are required' })
    };
  }

  // Validate AMI ID format
  const amiIdRegex = /^ami-[a-f0-9]{8,17}$/;
  if (!amiIdRegex.test(sourceAmiId)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Invalid source AMI ID format' })
    };
  }

  const results = [];
  const errors = [];
  const effectiveSourceRegion = sourceRegion || process.env.AWS_REGION;

  for (const targetRegion of targetRegions) {
    try {
      // Create EC2 client for the target region
      const targetEc2Client = new EC2Client({ region: targetRegion });
      
      // Copy the AMI to the target region
      const copyCommand = new CopyImageCommand({
        SourceImageId: sourceAmiId,
        SourceRegion: effectiveSourceRegion,
        Name: `${name} (copied from ${effectiveSourceRegion})`,
        Description: description || `Copied from ${sourceAmiId} in ${effectiveSourceRegion}`,
      });

      const copyResult = await targetEc2Client.send(copyCommand);
      const newAmiId = copyResult.ImageId;

      console.log(`Successfully initiated AMI copy to ${targetRegion}: ${newAmiId}`);

      // Store the new AMI in DynamoDB
      const putCommand = new PutItemCommand({
        TableName: process.env.IMAGES_TABLE_NAME,
        Item: {
          amiId: { S: newAmiId },
          name: { S: name },
          description: { S: description || '' },
          platform: { S: platform || 'windows' },
          state: { S: 'pending' }, // AMI copy is async, starts as pending
          region: { S: targetRegion },
          sourceRegion: { S: effectiveSourceRegion },
          sourceAmiId: { S: sourceAmiId },
          createdAt: { S: new Date().toISOString() },
          ...(pipelineId && { pipelineId: { S: pipelineId } }),
        }
      });

      await dynamoClient.send(putCommand);

      results.push({
        targetRegion,
        newAmiId,
        status: 'initiated'
      });
    } catch (error) {
      console.error('Error copying AMI to', targetRegion + ':', error);
      errors.push({
        targetRegion,
        error: error.message
      });
    }
  }

  if (results.length === 0) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ 
        error: 'Failed to copy image to any region',
        details: errors
      })
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
    body: JSON.stringify({
      message: `AMI copy initiated to ${results.length} region(s)`,
      results,
      errors: errors.length > 0 ? errors : undefined
    })
  };
}

// Image Builder Pipeline Functions
async function createImagePipeline(pipelineData, event) {
  const { name, description, baseImageId, platform, instanceType, components } = pipelineData;
  const pipelineId = crypto.randomUUID();
  
  // Prefix Image Builder resource names with the product acronym (lowercase)
  // This makes log groups identifiable for cleanup: /aws/imagebuilder/{acronym}-{name}-*
  const acronym = (process.env.ACRONYM || 'mrm').toLowerCase();
  const prefixedName = `${acronym}-${name}`;
  
  // Standard tags applied to all Image Builder resources for identification and cleanup
  const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
  const managedByTags = {
    ManagedBy: pascalCaseName,
    PipelineId: pipelineId,
  };
  
  try {
    // Resolve symbolic base image IDs to actual AMI IDs
    let resolvedBaseImageId = baseImageId;
    
    if (baseImageId === 'windows-2025') {
      const ssmResult = await ssmClient.send(new GetParameterCommand({
        Name: '/aws/service/ami-windows-latest/Windows_Server-2025-English-Full-Base'
      }));
      resolvedBaseImageId = ssmResult.Parameter.Value;
    } else if (baseImageId === 'windows-2022') {
      const ssmResult = await ssmClient.send(new GetParameterCommand({
        Name: '/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base'
      }));
      resolvedBaseImageId = ssmResult.Parameter.Value;
    } else if (baseImageId === 'windows-2019') {
      const ssmResult = await ssmClient.send(new GetParameterCommand({
        Name: '/aws/service/ami-windows-latest/Windows_Server-2019-English-Full-Base'
      }));
      resolvedBaseImageId = ssmResult.Parameter.Value;
    } else if (baseImageId === 'ubuntu-22.04') {
      const ssmResult = await ssmClient.send(new GetParameterCommand({
        Name: '/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id'
      }));
      resolvedBaseImageId = ssmResult.Parameter.Value;
    } else if (baseImageId === 'rocky-8') {
      // Rocky Linux 8 - use EC2 DescribeImages to get latest (owner: 792107900819)
      // Note: Rocky 8 is required for DaVinci Resolve compatibility
      const rocky8Result = await ec2Client.send(new DescribeImagesCommand({
        Owners: ['792107900819'],
        Filters: [
          { Name: 'name', Values: ['Rocky-8-EC2-Base-8*x86_64*'] },
          { Name: 'state', Values: ['available'] },
          { Name: 'architecture', Values: ['x86_64'] }
        ]
      }));
      const rocky8Images = rocky8Result.Images?.sort((a, b) => 
        new Date(b.CreationDate) - new Date(a.CreationDate)
      ) || [];
      if (rocky8Images.length > 0) {
        resolvedBaseImageId = rocky8Images[0].ImageId;
      } else {
        throw new Error('Could not find Rocky Linux 8 AMI');
      }
    } else if (baseImageId === 'rocky-9') {
      // Rocky Linux 9 - use EC2 DescribeImages to get latest (owner: 792107900819)
      const rocky9Result = await ec2Client.send(new DescribeImagesCommand({
        Owners: ['792107900819'],
        Filters: [
          { Name: 'name', Values: ['Rocky-9-EC2-Base-9*x86_64*'] },
          { Name: 'state', Values: ['available'] },
          { Name: 'architecture', Values: ['x86_64'] }
        ]
      }));
      const rocky9Images = rocky9Result.Images?.sort((a, b) => 
        new Date(b.CreationDate) - new Date(a.CreationDate)
      ) || [];
      if (rocky9Images.length > 0) {
        resolvedBaseImageId = rocky9Images[0].ImageId;
      } else {
        throw new Error('Could not find Rocky Linux 9 AMI');
      }
    }
    
    // Determine platform from input or derive from base image
    const resolvedPlatform = platform || (baseImageId.startsWith('ubuntu') || baseImageId.startsWith('linux') || baseImageId.startsWith('rocky') ? 'Linux' : 'Windows');
    
    // For macOS pipelines, validate that the base image is NOT a raw AWS macOS AMI
    // Raw macOS AMIs require SIP disable which can only be done by the system DCV-Ready pipeline
    if (resolvedPlatform === 'macOS') {
      // Check if this is a raw AWS macOS AMI from SSM parameters
      const rawMacOsParams = [
        '/aws/service/ec2-macos/tahoe/arm64_mac/latest/image_id',
        '/aws/service/ec2-macos/sequoia/arm64_mac/latest/image_id',
        '/aws/service/ec2-macos/sonoma/arm64_mac/latest/image_id',
        '/aws/service/ec2-macos/ventura/arm64_mac/latest/image_id',
        '/aws/service/ec2-macos/monterey/arm64_mac/latest/image_id'
      ];
      
      for (const paramName of rawMacOsParams) {
        try {
          const ssmResult = await ssmClient.send(new GetParameterCommand({ Name: paramName }));
          if (ssmResult.Parameter.Value === resolvedBaseImageId) {
            return {
              statusCode: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
              body: JSON.stringify({ 
                error: 'Cannot use raw AWS macOS AMI as base image. macOS requires SIP to be disabled for DCV to work. Please use the DCV-Ready macOS base AMI created by the system pipeline, or a golden image derived from it.',
                requiresDcvReadyBase: true
              })
            };
          }
        } catch (ssmError) {
          // Parameter doesn't exist or can't be read, continue checking
        }
      }
      
      // Also check if the AMI has the DCVReady tag (indicating it's from our system pipeline)
      // or if it's owned by us (a user golden image derived from DCV-Ready)
      try {
        const describeResult = await ec2Client.send(new DescribeImagesCommand({ ImageIds: [resolvedBaseImageId] }));
        const image = describeResult.Images?.[0];
        
        if (image) {
          const isDcvReady = image.Tags?.some(tag => tag.Key === 'DCVReady' && tag.Value === 'true');
          const accountId = await getAccountId();
          const isOwnedBySelf = image.OwnerId === accountId;
          const isFromPipeline = image.Tags?.some(tag => tag.Key === 'PipelineId');
          
          // If it's an Amazon-owned macOS AMI without DCVReady tag, reject it
          if (image.OwnerId === 'amazon' && !isDcvReady) {
            return {
              statusCode: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
              body: JSON.stringify({ 
                error: 'Cannot use raw AWS macOS AMI as base image. macOS requires SIP to be disabled for DCV to work. Please use the DCV-Ready macOS base AMI created by the system pipeline, or a golden image derived from it.',
                requiresDcvReadyBase: true
              })
            };
          }
          
          // If it's our own AMI but not from a pipeline and not DCVReady, warn but allow
          // (This allows flexibility for advanced users who know what they're doing)
          if (isOwnedBySelf && !isFromPipeline && !isDcvReady) {
            console.warn(`macOS pipeline using custom AMI ${resolvedBaseImageId} without DCVReady tag - user assumes responsibility for DCV configuration`);
          }
        }
      } catch (describeError) {
        console.warn('Could not verify macOS base image:', describeError.message);
      }
    }
    
    // Get OS version from base AMI
    const baseOsVersion = await getOsVersionFromAmi(resolvedBaseImageId);
    
    // 1. Create Infrastructure Configuration with availability testing
    let infraConfig;
    const availableSubnets = await getAvailableSubnets();
    let selectedSubnet;
    
    // Test each subnet for availability before creating infrastructure config
    // Determine the correct instance type based on platform
    // macOS requires mac2.metal (or mac2-m2.metal, mac2-m2pro.metal for M2 chips)
    let resolvedInstanceType = instanceType;
    if (resolvedPlatform === 'macOS') {
      resolvedInstanceType = 'mac2.metal'; // ARM-based Mac instances
      console.log('macOS platform detected, using mac2.metal instance type');
    } else if (!resolvedInstanceType) {
      resolvedInstanceType = 'm5.large'; // Default for Windows/Linux
    }
    
    for (let i = 0; i < availableSubnets.length; i++) {
      const subnetId = availableSubnets[i];
      console.log(`Testing instance availability in subnet: ${subnetId}`);
      
      // Skip availability test for macOS - dedicated hosts handle capacity differently
      if (resolvedPlatform === 'macOS') {
        console.log('Skipping capacity test for macOS (uses dedicated hosts)');
        selectedSubnet = subnetId;
        break;
      }
      
      const hasCapacity = await testInstanceAvailability(subnetId, resolvedInstanceType);
      if (hasCapacity) {
        console.log(`Capacity available in subnet: ${subnetId}`);
        selectedSubnet = subnetId;
        break;
      } else {
        console.log(`No capacity in subnet: ${subnetId}, trying next...`);
      }
    }
    
    if (!selectedSubnet) {
      throw new Error('No subnet has sufficient capacity for the requested instance type. Please try again later.');
    }
    
    console.log(`Creating infrastructure config with subnet: ${selectedSubnet}, instanceType: ${resolvedInstanceType}`);
    
    // Build infrastructure configuration parameters
    const infraConfigParams = {
      name: `${prefixedName}-infra-${pipelineId.substring(0, 8)}`,
      instanceProfileName: process.env.IMAGE_BUILDER_INSTANCE_PROFILE,
      instanceTypes: [resolvedInstanceType],
      subnetId: selectedSubnet,
      securityGroupIds: [process.env.BUILD_SECURITY_GROUP_ID],
      terminateInstanceOnFailure: true,
      resourceTags: managedByTags,
      tags: managedByTags,
      logging: {
        s3Logs: {
          s3BucketName: process.env.LOGS_BUCKET_NAME,
          s3KeyPrefix: 'imagebuilder-logs'
        }
      }
    };
    
    // For macOS, add the Host Resource Group for dedicated host placement
    if (resolvedPlatform === 'macOS') {
      const accountId = await getAccountId();
      const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
      const hostResourceGroupArn = `arn:aws:resource-groups:${process.env.AWS_REGION}:${accountId}:group/${pascalCaseName}-Mac-Host-Resource-Group`;
      // Add placement configuration for dedicated host with Host Resource Group
      infraConfigParams.placement = {
        tenancy: 'host',
        hostResourceGroupArn: hostResourceGroupArn
      };
      console.log('macOS pipeline will use Host Resource Group:', hostResourceGroupArn);
    }
    
    console.log('Infrastructure config params:', JSON.stringify(infraConfigParams, null, 2));
    
    try {
      infraConfig = await imageBuilderClient.send(new CreateInfrastructureConfigurationCommand(infraConfigParams));
      console.log('Infrastructure config created:', infraConfig.infrastructureConfigurationArn);
    } catch (infraError) {
      console.error('Failed to create infrastructure config:', infraError);
      console.error('Error name:', infraError.name);
      console.error('Error message:', infraError.message);
      console.error('Error $metadata:', JSON.stringify(infraError.$metadata, null, 2));
      throw infraError;
    }

    // 2. Create Distribution Configuration with multi-region support
    // Get active regional hubs for distribution
    const regionalHubs = await getActiveRegionalHubs();
    const primaryRegion = process.env.AWS_REGION;
    
    // Build distributions array - always include primary region first
    const distributions = [
      {
        region: primaryRegion,
        amiDistributionConfiguration: {
          name: `${name}-{{imagebuilder:buildDate}}`,
          description: description || `AMI created from ${name} pipeline`,
          amiTags: {
            'CreatedBy': process.env.PASCAL_CASE_NAME || 'MediaResourceManager',
            'PipelineId': pipelineId,
            'BaseImage': baseImageId,
            'Platform': resolvedPlatform
          }
        }
      }
    ];
    
    // Add satellite regions from active regional hubs
    for (const hub of regionalHubs) {
      if (hub.region !== primaryRegion) {
        console.log(`Adding distribution to satellite region: ${hub.region}`);
        distributions.push({
          region: hub.region,
          amiDistributionConfiguration: {
            name: `${name}-{{imagebuilder:buildDate}}`,
            description: description || `AMI created from ${name} pipeline (distributed to ${hub.region})`,
            amiTags: {
              'CreatedBy': process.env.PASCAL_CASE_NAME || 'MediaResourceManager',
              'PipelineId': pipelineId,
              'BaseImage': baseImageId,
              'Platform': resolvedPlatform,
              'SourceRegion': primaryRegion,
              'DistributedTo': hub.region
            }
          }
        });
      }
    }
    
    console.log('Creating distribution config for', distributions.length, 'region(s):', distributions.map(d => d.region));
    
    const distConfig = await imageBuilderClient.send(new CreateDistributionConfigurationCommand({
      name: `${prefixedName}-dist-${pipelineId.substring(0, 8)}`,
      distributions: distributions,
      tags: managedByTags,
    }));

    // 3. Create Custom Components and track ARNs
    const componentArns = [];
    const updatedComponents = [];
    
    // Sort components to ensure AWS CLI comes first
    const sortedComponents = [...(components || [])].sort((a, b) => {
      const aIsAwsCli = a.name?.toLowerCase().includes('aws-cli') || a.name?.toLowerCase().includes('aws cli');
      const bIsAwsCli = b.name?.toLowerCase().includes('aws-cli') || b.name?.toLowerCase().includes('aws cli');
      
      if (aIsAwsCli && !bIsAwsCli) return -1;
      if (!aIsAwsCli && bIsAwsCli) return 1;
      return 0;
    });
    
    for (const component of sortedComponents) {
      if (component.type === 'CUSTOM_SCRIPT') {
        const componentArn = await createCustomComponent(component, pipelineId, resolvedPlatform);
        componentArns.push({ componentArn });
        // Store component with ARN for deletion later
        updatedComponents.push({
          ...component,
          componentArn: componentArn
        });
      } else if (component.componentArn) {
        componentArns.push({ componentArn: component.componentArn });
        updatedComponents.push(component);
      }
    }

    // 4. Create Image Recipe with larger root volume for software installation
    // Default Windows AMI has 30GB which is insufficient for large software like DaVinci Resolve
    // Linux uses /dev/sda1 or /dev/xvda depending on the AMI
    // macOS DCV-Ready base images have 200GB volumes, so we must match or exceed that
    // Windows needs 200GB for large software packages like Adobe Creative Cloud (~50GB+ installed)
    const rootDeviceName = resolvedPlatform === 'Linux' ? '/dev/sda1' : '/dev/sda1';
    const volumeSize = 200;
    const imageRecipe = await imageBuilderClient.send(new CreateImageRecipeCommand({
      name: `${prefixedName}-recipe-${pipelineId.substring(0, 8)}`,
      semanticVersion: '1.0.0',
      parentImage: resolvedBaseImageId,
      components: componentArns,
      description: description || `Recipe for ${name} pipeline`,
      tags: managedByTags,
      blockDeviceMappings: [
        {
          deviceName: rootDeviceName,
          ebs: {
            volumeSize: volumeSize,
            volumeType: 'gp3',
            deleteOnTermination: true
          }
        }
      ]
    }));

    // 5. Create Image Pipeline
    const pipeline = await imageBuilderClient.send(new CreateImagePipelineCommand({
      name: `${prefixedName}-pipeline-${pipelineId.substring(0, 8)}`,
      description: description || `Pipeline for creating ${name} images`,
      imageRecipeArn: imageRecipe.imageRecipeArn,
      infrastructureConfigurationArn: infraConfig.infrastructureConfigurationArn,
      distributionConfigurationArn: distConfig.distributionConfigurationArn,
      status: 'ENABLED',
      enhancedImageMetadataEnabled: true,
      tags: managedByTags,
    }));

    // 6. Store pipeline info in DynamoDB
    await dynamoClient.send(new PutItemCommand({
      TableName: process.env.PIPELINES_TABLE_NAME,
      Item: {
        pipelineId: { S: pipelineId },
        status: { S: 'CREATED' },
        name: { S: name },
        description: { S: description || '' },
        baseImageId: { S: resolvedBaseImageId },
        baseOsVersion: { S: baseOsVersion },
        platform: { S: resolvedPlatform },
        pipelineArn: { S: pipeline.imagePipelineArn },
        imageRecipeArn: { S: imageRecipe.imageRecipeArn },
        infrastructureConfigurationArn: { S: infraConfig.infrastructureConfigurationArn },
        distributionConfigurationArn: { S: distConfig.distributionConfigurationArn },
        components: { S: JSON.stringify(updatedComponents) },
        createdAt: { S: new Date().toISOString() },
        updatedAt: { S: new Date().toISOString() }
      }
    }));

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({
        message: 'Pipeline created successfully',
        pipelineId,
        pipelineArn: pipeline.imagePipelineArn
      })
    };
  } catch (error) {
    console.error('Error creating pipeline:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to create pipeline: ' + error.message })
    };
  }
}

async function createCustomComponent(component, pipelineId, platform = 'Windows') {
  const isLinux = platform === 'Linux';
  const executeAction = isLinux ? 'ExecuteBash' : 'ExecutePowerShell';
  
  const componentDocument = {
    name: component.name,
    description: `Custom component for ${component.name}`,
    schemaVersion: '1.0',
    phases: [
      {
        name: 'build',
        steps: [
          {
            name: 'ExecuteCustomScript',
            action: executeAction,
            inputs: {
              commands: [component.script]
            }
          }
        ]
      }
    ]
  };

  const componentResult = await imageBuilderClient.send(new CreateComponentCommand({
    name: `${component.name}-${pipelineId.substring(0, 8)}`,
    semanticVersion: '1.0.0',
    platform: platform,
    data: JSON.stringify(componentDocument),
    tags: {
      ManagedBy: process.env.PASCAL_CASE_NAME || 'MediaResourceManager',
      PipelineId: pipelineId,
    },
  }));

  return componentResult.componentBuildVersionArn;
}

async function getPipelineStatus(pipelineId) {
  try {
    const dbResult = await dynamoClient.send(new GetItemCommand({
      TableName: process.env.PIPELINES_TABLE_NAME,
      Key: { pipelineId: { S: pipelineId } }
    }));

    if (!dbResult.Item) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Pipeline not found' })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({
        pipelineId,
        status: dbResult.Item.status.S,
        name: dbResult.Item.name.S,
        description: dbResult.Item.description.S,
        buildProgress: dbResult.Item.buildProgress ? JSON.parse(dbResult.Item.buildProgress.S) : null
      })
    };
  } catch (error) {
    console.error('Error getting pipeline status:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to get pipeline status' })
    };
  }
}

async function getPipelines() {
  try {
    const result = await dynamoClient.send(new ScanCommand({
      TableName: process.env.PIPELINES_TABLE_NAME
    }));
    
    const pipelines = result.Items?.map(item => ({
      pipelineId: item.pipelineId?.S,
      name: item.name?.S,
      status: item.status?.S,
      description: item.description?.S,
      baseImageId: item.baseImageId?.S,
      baseOsVersion: item.baseOsVersion?.S,
      platform: item.platform?.S || 'Windows',
      components: item.components?.S ? JSON.parse(item.components.S) : [],
      createdAt: item.createdAt?.S,
      updatedAt: item.updatedAt?.S,
      pipelineArn: item.pipelineArn?.S,
      isSystemPipeline: item.isSystemPipeline?.BOOL || false,
      statusMessage: item.statusMessage?.S
    })) || [];

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ pipelines })
    };
  } catch (error) {
    console.error('Error fetching pipelines:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to fetch pipelines' })
    };
  }
}

async function deletePipeline(pipelineId, event) {
  try {
    // Get pipeline details from DynamoDB
    const dbResult = await dynamoClient.send(new GetItemCommand({
      TableName: process.env.PIPELINES_TABLE_NAME,
      Key: { pipelineId: { S: pipelineId } }
    }));

    if (!dbResult.Item) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Pipeline not found' })
      };
    }

    const pipeline = dbResult.Item;
    
    // Block deletion of system pipelines
    if (pipeline.isSystemPipeline?.BOOL === true) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ 
          error: 'Cannot delete system pipeline. This pipeline is required for macOS workstation support.',
          isSystemPipeline: true
        })
      };
    }

    const deletedResources = [];

    // 1. Delete Image Pipeline
    if (pipeline.pipelineArn?.S) {
      try {
        await imageBuilderClient.send(new DeleteImagePipelineCommand({
          imagePipelineArn: pipeline.pipelineArn.S
        }));
        deletedResources.push('Image Pipeline');
      } catch (error) {
        console.warn('Failed to delete pipeline:', error.message);
      }
    }

    // 2. Delete Image Recipe
    if (pipeline.imageRecipeArn?.S) {
      try {
        await imageBuilderClient.send(new DeleteImageRecipeCommand({
          imageRecipeArn: pipeline.imageRecipeArn.S
        }));
        deletedResources.push('Image Recipe');
      } catch (error) {
        console.warn('Failed to delete recipe:', error.message);
      }
    }

    // 3. Delete Infrastructure Configuration
    if (pipeline.infrastructureConfigurationArn?.S) {
      try {
        await imageBuilderClient.send(new DeleteInfrastructureConfigurationCommand({
          infrastructureConfigurationArn: pipeline.infrastructureConfigurationArn.S
        }));
        deletedResources.push('Infrastructure Configuration');
      } catch (error) {
        console.warn('Failed to delete infrastructure config:', error.message);
      }
    }

    // 4. Delete Distribution Configuration
    if (pipeline.distributionConfigurationArn?.S) {
      try {
        await imageBuilderClient.send(new DeleteDistributionConfigurationCommand({
          distributionConfigurationArn: pipeline.distributionConfigurationArn.S
        }));
        deletedResources.push('Distribution Configuration');
      } catch (error) {
        console.warn('Failed to delete distribution config:', error.message);
      }
    }

    // 5. Delete Custom Components
    if (pipeline.components?.S) {
      const components = JSON.parse(pipeline.components.S);
      for (const component of components) {
        if (component.type === 'CUSTOM_SCRIPT' && component.componentArn) {
          try {
            await imageBuilderClient.send(new DeleteComponentCommand({
              componentBuildVersionArn: component.componentArn
            }));
            deletedResources.push(`Component: ${component.name}`);
          } catch (error) {
            console.warn('Failed to delete component', component.name + ':', error.message);
          }
        }
      }
    }

    // 5b. Delete resources tracked in imageBuilds (preferred method - uses stored ARNs)
    if (pipeline.imageBuilds?.S) {
      try {
        const imageBuilds = JSON.parse(pipeline.imageBuilds.S);
        console.log(`Found ${imageBuilds.length} tracked image builds to clean up`);
        
        for (const build of imageBuilds) {
          // Delete ImageBuilder image
          if (build.imageBuilderArn) {
            try {
              await imageBuilderClient.send(new DeleteImageCommand({
                imageBuildVersionArn: build.imageBuilderArn
              }));
              deletedResources.push(`ImageBuilder Image: ${build.imageBuilderArn}`);
              console.log(`Deleted ImageBuilder image: ${build.imageBuilderArn}`);
            } catch (error) {
              console.warn('Failed to delete ImageBuilder image', build.imageBuilderArn + ':', error.message);
            }
          }
          
          // Delete AMIs in each region
          for (const ami of build.amis || []) {
            if (ami.amiId && ami.region) {
              try {
                const regionalEc2Client = new EC2Client({ region: ami.region });
                await regionalEc2Client.send(new DeregisterImageCommand({
                  ImageId: ami.amiId
                }));
                console.log(`Deregistered AMI ${ami.amiId} in ${ami.region}`);
              } catch (error) {
                console.warn('Failed to deregister AMI', ami.amiId, 'in', ami.region + ':', error.message);
              }
              
              // Remove from tfc-amis table
              try {
                await dynamoClient.send(new DeleteItemCommand({
                  TableName: process.env.IMAGES_TABLE_NAME,
                  Key: { amiId: { S: ami.amiId } }
                }));
                deletedResources.push(`AMI: ${ami.amiId} (${ami.region})`);
              } catch (error) {
                console.warn('Failed to delete AMI record', ami.amiId + ':', error.message);
              }
            }
          }
        }
      } catch (error) {
        console.warn('Failed to parse/process imageBuilds:', error.message);
      }
    }

    // 6. Find and delete associated AMIs (by EC2 tag) - fallback for older pipelines
    const amiTags = [
      { Name: 'tag:PipelineId', Values: [pipelineId] }
    ];
    
    try {
      const images = await ec2Client.send(new DescribeImagesCommand({
        Owners: ['self'],
        Filters: amiTags
      }));

      for (const image of images.Images || []) {
        try {
          await ec2Client.send(new DeregisterImageCommand({
            ImageId: image.ImageId
          }));
          
          // Remove from AMI table
          await dynamoClient.send(new DeleteItemCommand({
            TableName: process.env.IMAGES_TABLE_NAME,
            Key: {
              amiId: { S: image.ImageId }
            }
          }));
          
          deletedResources.push(`AMI: ${image.ImageId}`);
        } catch (error) {
          console.warn('Failed to delete AMI', image.ImageId + ':', error.message);
        }
      }
    } catch (error) {
      console.warn('Failed to find associated AMIs by tag:', error.message);
    }

    // 6b. Also find and delete AMIs from DynamoDB by pipelineId field
    // (imagebuilder-event-handler stores pipelineId in the record, not as EC2 tag)
    try {
      const amiRecords = await dynamoClient.send(new ScanCommand({
        TableName: process.env.IMAGES_TABLE_NAME,
        FilterExpression: 'pipelineId = :pipelineId',
        ExpressionAttributeValues: {
          ':pipelineId': { S: pipelineId }
        }
      }));

      for (const record of amiRecords.Items || []) {
        const amiId = record.amiId?.S;
        const amiRegion = record.region?.S || process.env.AWS_REGION;
        
        if (amiId) {
          try {
            // Deregister the AMI (may be in a different region)
            const regionalEc2Client = new EC2Client({ region: amiRegion });
            await regionalEc2Client.send(new DeregisterImageCommand({
              ImageId: amiId
            }));
            console.log(`Deregistered AMI ${amiId} in region ${amiRegion}`);
          } catch (error) {
            console.warn('Failed to deregister AMI', amiId, 'in', amiRegion + ':', error.message);
          }
          
          // Remove from DynamoDB
          try {
            await dynamoClient.send(new DeleteItemCommand({
              TableName: process.env.IMAGES_TABLE_NAME,
              Key: { amiId: { S: amiId } }
            }));
            deletedResources.push(`AMI Record: ${amiId} (${amiRegion})`);
          } catch (error) {
            console.warn('Failed to delete AMI record', amiId + ':', error.message);
          }
        }
      }
    } catch (error) {
      console.warn('Failed to find associated AMIs by pipelineId in DynamoDB:', error.message);
    }

    // 7. Delete Image Builder image records
    try {
      // Get all images and filter by recipe name pattern
      // ImageBuilder images are named after the recipe they were built from
      const allImages = await imageBuilderClient.send(new ListImagesCommand({
        owner: 'Self'
      }));
      
      // Build list of patterns to match
      const matchPatterns = [];
      
      // Extract recipe name from ARN (e.g., "digital-developers-recipe-bff2eb2d" from the ARN)
      if (pipeline.imageRecipeArn?.S) {
        const recipeName = pipeline.imageRecipeArn.S.split('/')[1]?.split('/')[0];
        if (recipeName) {
          matchPatterns.push(recipeName.toLowerCase());
        }
      }
      
      // Also match by pipeline ID suffix (the UUID portion)
      const pipelineIdSuffix = pipelineId.substring(0, 8);
      if (pipelineIdSuffix) {
        matchPatterns.push(pipelineIdSuffix.toLowerCase());
      }
      
      // Match by sanitized pipeline name
      const pipelineName = pipeline.name?.S;
      if (pipelineName) {
        // Sanitize name the same way we do when creating recipes
        const sanitizedName = pipelineName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
        matchPatterns.push(sanitizedName);
      }
      
      console.log(`Searching for ImageBuilder images matching patterns: ${matchPatterns.join(', ')}`);
      
      // Filter images that match any of our patterns
      const matchingImages = (allImages.imageVersionList || []).filter(image => {
        const imageName = (image.name || '').toLowerCase();
        return matchPatterns.some(pattern => imageName.includes(pattern));
      });
      
      console.log(`Found ${matchingImages.length} matching ImageBuilder images to delete`);

      for (const image of matchingImages) {
        try {
          // List all build versions for this image
          const buildVersions = await imageBuilderClient.send(new ListImageBuildVersionsCommand({
            imageVersionArn: image.arn
          }));
          
          // Delete each build version
          for (const buildVersion of buildVersions.imageSummaryList || []) {
            try {
              await imageBuilderClient.send(new DeleteImageCommand({
                imageBuildVersionArn: buildVersion.arn
              }));
              deletedResources.push(`Image Builder Image: ${buildVersion.arn}`);
              console.log(`Deleted ImageBuilder image: ${buildVersion.arn}`);
            } catch (error) {
              console.warn('Failed to delete Image Builder build version', buildVersion.arn + ':', error.message);
            }
          }
        } catch (error) {
          console.warn('Failed to list/delete Image Builder image versions for', image.arn + ':', error.message);
        }
      }
    } catch (error) {
      console.warn('Failed to find/delete Image Builder images:', error.message);
    }

    // 7. Delete pipeline record from DynamoDB
    await dynamoClient.send(new DeleteItemCommand({
      TableName: process.env.PIPELINES_TABLE_NAME,
      Key: { pipelineId: { S: pipelineId } }
    }));
    deletedResources.push('Pipeline Record');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({
        message: 'Pipeline deleted successfully',
        deletedResources
      })
    };
  } catch (error) {
    console.error('Error deleting pipeline:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to delete pipeline: ' + error.message })
    };
  }
}

async function executePipeline(pipelineId) {
  try {
    const dbResult = await dynamoClient.send(new GetItemCommand({
      TableName: process.env.PIPELINES_TABLE_NAME,
      Key: { pipelineId: { S: pipelineId } }
    }));

    if (!dbResult.Item) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Pipeline not found' })
      };
    }

    const pipelineArn = dbResult.Item.pipelineArn.S;
    
    try {
      const execution = await imageBuilderClient.send(new StartImagePipelineExecutionCommand({
        imagePipelineArn: pipelineArn
      }));
    } catch (error) {
      if (error.message && error.message.includes('InsufficientInstanceCapacity')) {
        console.log('ICE error during pipeline execution, attempting subnet switch...');
        await handleICEErrorAndRetry(pipelineId, pipelineArn);
        return;
      }
      throw error;
    }

    // Update status to BUILDING
    await dynamoClient.send(new UpdateItemCommand({
      TableName: process.env.PIPELINES_TABLE_NAME,
      Key: { pipelineId: { S: pipelineId } },
      UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': { S: 'BUILDING' },
        ':updatedAt': { S: new Date().toISOString() }
      }
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({
        message: 'Pipeline execution started',
        executionId: execution.imageBuildVersionArn
      })
    };
  } catch (error) {
    console.error('Error executing pipeline:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to execute pipeline: ' + error.message })
    };
  }
}

async function updatePipeline(pipelineId, updateData, event) {
  try {
    // Get current pipeline from DynamoDB
    const dbResult = await dynamoClient.send(new GetItemCommand({
      TableName: process.env.PIPELINES_TABLE_NAME,
      Key: { pipelineId: { S: pipelineId } }
    }));

    if (!dbResult.Item) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Pipeline not found' })
      };
    }

    const pipeline = dbResult.Item;
    const { components } = updateData;
    
    if (!components || !Array.isArray(components)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Components array is required' })
      };
    }

    // Build component ARNs for the new recipe
    const componentArns = [];
    const updatedComponents = [];
    
    // Sort components to ensure AWS CLI comes first
    const sortedComponents = [...components].sort((a, b) => {
      const aIsAwsCli = a.name?.toLowerCase().includes('aws-cli') || a.name?.toLowerCase().includes('aws cli');
      const bIsAwsCli = b.name?.toLowerCase().includes('aws-cli') || b.name?.toLowerCase().includes('aws cli');
      if (aIsAwsCli && !bIsAwsCli) return -1;
      if (!aIsAwsCli && bIsAwsCli) return 1;
      return 0;
    });

    for (const component of sortedComponents) {
      if (component.componentArn) {
        componentArns.push({ componentArn: component.componentArn });
        updatedComponents.push(component);
      }
    }

    if (componentArns.length === 0) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'At least one component with componentArn is required' })
      };
    }

    // Parse current recipe ARN to get base name
    const currentRecipeArn = pipeline.imageRecipeArn?.S;
    // ARN format: arn:aws:imagebuilder:region:account:image-recipe/name/version
    const recipeArnParts = currentRecipeArn?.split('/') || [];
    const currentRecipeName = recipeArnParts[1] || `${pipeline.name?.S}-recipe-${pipelineId.substring(0, 8)}`;
    
    // List existing recipe versions to find the highest version
    let highestVersion = { major: 1, minor: 0, patch: 0 };
    try {
      const existingRecipes = await imageBuilderClient.send(new ListImageRecipesCommand({
        owner: 'Self',
        filters: [{ name: 'name', values: [currentRecipeName] }]
      }));
      
      for (const recipe of existingRecipes.imageRecipeSummaryList || []) {
        // Extract version from ARN
        const versionMatch = recipe.arn?.match(/\/(\d+)\.(\d+)\.(\d+)$/);
        if (versionMatch) {
          const [, major, minor, patch] = versionMatch.map(Number);
          if (major > highestVersion.major ||
              (major === highestVersion.major && minor > highestVersion.minor) ||
              (major === highestVersion.major && minor === highestVersion.minor && patch > highestVersion.patch)) {
            highestVersion = { major, minor, patch };
          }
        }
      }
      console.log(`Found highest existing version: ${highestVersion.major}.${highestVersion.minor}.${highestVersion.patch}`);
    } catch (listError) {
      console.log('Could not list existing recipes, starting from 1.0.0:', listError.message);
    }
    
    // Increment patch version
    const newVersion = `${highestVersion.major}.${highestVersion.minor}.${highestVersion.patch + 1}`;
    
    console.log(`Creating new recipe version: ${currentRecipeName} v${newVersion}`);
    
    // Use 200GB for all platforms to support large software packages like Adobe Creative Cloud
    const volumeSize = 200;
    
    const newRecipe = await imageBuilderClient.send(new CreateImageRecipeCommand({
      name: currentRecipeName,
      semanticVersion: newVersion,
      parentImage: pipeline.baseImageId?.S,
      components: componentArns,
      description: `Updated recipe for ${pipeline.name?.S} pipeline`,
      blockDeviceMappings: [
        {
          deviceName: '/dev/sda1',
          ebs: {
            volumeSize: volumeSize,
            volumeType: 'gp3',
            deleteOnTermination: true
          }
        }
      ]
    }));

    console.log(`New recipe created: ${newRecipe.imageRecipeArn}`);

    // Update pipeline to use new recipe
    await imageBuilderClient.send(new UpdateImagePipelineCommand({
      imagePipelineArn: pipeline.pipelineArn?.S,
      imageRecipeArn: newRecipe.imageRecipeArn,
      infrastructureConfigurationArn: pipeline.infrastructureConfigurationArn?.S,
      distributionConfigurationArn: pipeline.distributionConfigurationArn?.S,
      status: 'ENABLED',
      enhancedImageMetadataEnabled: true
    }));

    console.log(`Pipeline updated to use new recipe`);

    // Update DynamoDB record
    await dynamoClient.send(new UpdateItemCommand({
      TableName: process.env.PIPELINES_TABLE_NAME,
      Key: { pipelineId: { S: pipelineId } },
      UpdateExpression: 'SET imageRecipeArn = :recipeArn, components = :components, updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':recipeArn': { S: newRecipe.imageRecipeArn },
        ':components': { S: JSON.stringify(updatedComponents) },
        ':updatedAt': { S: new Date().toISOString() }
      }
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({
        message: 'Pipeline updated successfully',
        newRecipeArn: newRecipe.imageRecipeArn,
        recipeVersion: newVersion
      })
    };
  } catch (error) {
    console.error('Error updating pipeline:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to update pipeline: ' + error.message })
    };
  }
}
