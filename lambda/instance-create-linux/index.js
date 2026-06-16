// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { EC2Client, RunInstancesCommand, DescribeImagesCommand } = require('@aws-sdk/client-ec2');
const { DynamoDBDocumentClient, PutCommand, QueryCommand, GetCommand, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

// Default clients for primary region
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient());
const ssm = new SSMClient();

// Helper to create EC2 client for specific region
function getEC2Client(region) {
    if (region && region !== process.env.AWS_REGION) {
        return new EC2Client({ region });
    }
    return new EC2Client();
}

/**
 * Generate a unique hostname using atomic DynamoDB counter
 */
async function generateHostname() {
    const pascalCaseName = process.env.PASCAL_CASE_NAME;
    const hostnameCounterTable = process.env.HOSTNAME_COUNTER_TABLE_NAME;

    // Get hostname configuration from SSM Parameter Store
    let hostnamePrefix = 'vdi-';
    let hostnameDigits = 4;

    try {
        const [prefixResult, digitsResult] = await Promise.all([
            ssm.send(new GetParameterCommand({ 
                Name: `/${pascalCaseName}/Workstation/HostnamePrefix` 
            })).catch(() => null),
            ssm.send(new GetParameterCommand({ 
                Name: `/${pascalCaseName}/Workstation/HostnameDigits` 
            })).catch(() => null)
        ]);

        if (prefixResult?.Parameter?.Value) {
            hostnamePrefix = prefixResult.Parameter.Value;
        }
        if (digitsResult?.Parameter?.Value) {
            hostnameDigits = parseInt(digitsResult.Parameter.Value, 10);
        }
    } catch (error) {
        console.warn('Could not fetch hostname config from SSM, using defaults:', error.message);
    }

    // Atomic increment of the counter using DynamoDB UpdateItem
    const updateResult = await dynamodb.send(new UpdateCommand({
        TableName: hostnameCounterTable,
        Key: { prefix: hostnamePrefix },
        UpdateExpression: 'SET #counter = if_not_exists(#counter, :zero) + :inc, lastUpdated = :now',
        ExpressionAttributeNames: { '#counter': 'counter' },
        ExpressionAttributeValues: {
            ':zero': 0,
            ':inc': 1,
            ':now': new Date().toISOString()
        },
        ReturnValues: 'UPDATED_NEW'
    }));

    const hostnameNumber = updateResult.Attributes.counter;
    const paddedNumber = hostnameNumber.toString().padStart(hostnameDigits, '0');
    const hostname = `${hostnamePrefix}${paddedNumber}`;

    console.log(`Generated hostname: ${hostname} (number: ${hostnameNumber})`);
    return { hostname, hostnameNumber };
}

exports.handler = async (event) => {
    console.log('Creating Linux EC2 instance:', JSON.stringify(event, null, 2));

    const { amiId, instanceType, assignedUserId, retrySubnetIndex = 0, rootVolumeSize, pipelineId, region, regionalConfig } = event;
    
    // Determine target region and configuration
    const targetRegion = region || process.env.AWS_REGION;
    const isRemoteRegion = targetRegion !== process.env.AWS_REGION;
    
    // Get EC2 client for target region
    const ec2 = getEC2Client(targetRegion);
    
    // Use regional config if provided (satellite region), otherwise use environment variables
    let subnetIds, launchTemplateId, effectiveAmiId;
    
    if (isRemoteRegion && regionalConfig) {
        // Support both subnetIds and subnetMappings field names
        subnetIds = regionalConfig.subnetIds || regionalConfig.subnetMappings || [];
        launchTemplateId = regionalConfig.launchTemplateId;
        effectiveAmiId = regionalConfig.regionalAmiId || amiId;
        console.log(`Using regional config for ${targetRegion}: launchTemplate=${launchTemplateId}, subnets=${subnetIds.join(',')}, ami=${effectiveAmiId}`);
    } else {
        subnetIds = process.env.SUBNET_IDS.split(',');
        launchTemplateId = process.env.LAUNCH_TEMPLATE_ID;
        effectiveAmiId = amiId;
    }

    if (retrySubnetIndex >= subnetIds.length) {
        throw new Error('All subnets exhausted - insufficient capacity');
    }

    const subnetId = subnetIds[retrySubnetIndex];
    console.log(`Attempting to launch in subnet ${subnetId} (attempt ${retrySubnetIndex + 1}/${subnetIds.length}) in region ${targetRegion}`);

    // Generate unique hostname using atomic counter
    let hostname = null;
    let hostnameNumber = null;
    try {
        const hostnameResult = await generateHostname();
        hostname = hostnameResult.hostname;
        hostnameNumber = hostnameResult.hostnameNumber;
    } catch (error) {
        console.warn('Failed to generate hostname, will use fallback:', error.message);
    }

    // Get AMI/pipeline name for workstation display name
    let imageName = null;

    // First try to get name from Images table using amiId
    try {
        const imageResult = await dynamodb.send(new GetCommand({
            TableName: process.env.IMAGES_TABLE_NAME,
            Key: { amiId }
        }));
        if (imageResult.Item?.name) {
            imageName = imageResult.Item.name;
        }
    } catch (e) { console.warn('Failed to get image name from Images table'); }

    // If not in Images table, try pipeline table
    if (!imageName && pipelineId) {
        try {
            const result = await dynamodb.send(new GetCommand({
                TableName: process.env.IMAGE_PIPELINES_TABLE_NAME,
                Key: { pipelineId }
            }));
            if (result.Item?.name) imageName = result.Item.name;
        } catch (e) { console.warn('Failed to get pipeline name'); }
    }

    // If still no name, look up from EC2 DescribeImages API
    if (!imageName) {
        try {
            const describeResult = await ec2.send(new DescribeImagesCommand({ ImageIds: [amiId] }));
            const image = describeResult.Images?.[0];
            if (image?.Name) {
                const amiName = image.Name;
                if (amiName.toLowerCase().includes('rocky')) {
                    if (amiName.includes('-8-') || amiName.includes('8.')) imageName = 'Rocky Linux 8';
                    else if (amiName.includes('-9-') || amiName.includes('9.')) imageName = 'Rocky Linux 9';
                    else imageName = 'Rocky Linux';
                } else if (amiName.toLowerCase().includes('ubuntu')) {
                    imageName = 'Ubuntu';
                } else {
                    imageName = amiName.split('/').pop().split('-').slice(0, 3).join(' ');
                }
            }
        } catch (e) { console.warn('Failed to get AMI name from EC2'); }
    }

    // Final fallback
    if (!imageName) imageName = 'Linux Workstation';

    // Get AMI minimum volume size to ensure we don't create a volume smaller than the snapshot
    let amiMinVolumeSize = 100;
    try {
        const describeResult = await ec2.send(new DescribeImagesCommand({ ImageIds: [effectiveAmiId] }));
        const image = describeResult.Images?.[0];
        if (image) {
            const rootDevice = image.BlockDeviceMappings?.find(
                bdm => bdm.DeviceName === image.RootDeviceName || bdm.DeviceName === '/dev/sda1'
            );
            if (rootDevice?.Ebs?.VolumeSize) {
                amiMinVolumeSize = rootDevice.Ebs.VolumeSize;
                console.log(`AMI root volume size: ${amiMinVolumeSize}GB`);
            }
        }
    } catch (e) { console.warn('Failed to get AMI details from EC2:', e.message); }

    const effectiveVolumeSize = Math.max(rootVolumeSize || 100, amiMinVolumeSize);
    console.log(`Requested: ${rootVolumeSize}GB, AMI minimum: ${amiMinVolumeSize}GB, Using: ${effectiveVolumeSize}GB`);

    // Create workstation name from image name + counter number
    // e.g., "rocky-linux-9-0001" or "ubuntu-0001"
    const imageBaseName = imageName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const paddedNumber = hostnameNumber ? hostnameNumber.toString().padStart(4, '0') : Date.now().toString().slice(-4);
    const workstationName = `${imageBaseName}-${paddedNumber}`;

    // Check if instance type has GPU
    const gpuTypes = ['p2', 'p3', 'p4', 'p5', 'g3', 'g4', 'g5', 'g6'];
    const hasGpu = gpuTypes.some(t => instanceType.toLowerCase().startsWith(t));

    // User data script to install SSM agent (required for Rocky/RHEL which don't have it pre-installed)
    const userDataScript = `#!/bin/bash
# Install SSM Agent for Rocky/RHEL (Ubuntu has it pre-installed)
if [ -f /etc/os-release ]; then
  . /etc/os-release
  if [ "$ID" = "rocky" ] || [ "$ID" = "rhel" ] || [ "$ID" = "centos" ]; then
    echo "Installing SSM Agent for $ID..."
    sudo dnf install -y https://s3.amazonaws.com/ec2-downloads-windows/SSMAgent/latest/linux_amd64/amazon-ssm-agent.rpm
    sudo systemctl enable amazon-ssm-agent
    sudo systemctl start amazon-ssm-agent
  fi
fi
`;
    const userDataBase64 = Buffer.from(userDataScript).toString('base64');

    try {
        const result = await ec2.send(new RunInstancesCommand({
            LaunchTemplate: { LaunchTemplateId: launchTemplateId, Version: '$Latest' },
            MinCount: 1, MaxCount: 1,
            InstanceType: instanceType,
            ImageId: effectiveAmiId,
            SubnetId: subnetId,
            UserData: userDataBase64,
            BlockDeviceMappings: [{
                DeviceName: '/dev/sda1',
                Ebs: { VolumeSize: effectiveVolumeSize, VolumeType: 'gp3', DeleteOnTermination: true }
            }],
            TagSpecifications: [{
                ResourceType: 'instance',
                Tags: [
                    { Key: 'Name', Value: workstationName },
                    ...(assignedUserId ? [{ Key: 'AssignedUser', Value: assignedUserId }] : []),
                    { Key: 'ManagedBy', Value: process.env.PASCAL_CASE_NAME || 'WorkstationManager' },
                    { Key: 'Platform', Value: 'Linux' },
                    { Key: 'Region', Value: targetRegion },
                    ...(hostname ? [{ Key: 'Hostname', Value: hostname }] : [])
                ]
            }]
        }));

        const instanceId = result.Instances[0].InstanceId;
        const currentTime = new Date().toISOString();

        await dynamodb.send(new PutCommand({
            TableName: process.env.WORKSTATION_TABLE_NAME,
            Item: {
                instanceId,
                // Only include assignedUserId if it has a value (DynamoDB GSI doesn't allow empty strings)
                ...(assignedUserId && { assignedUserId }),
                amiId: effectiveAmiId, 
                sourceAmiId: amiId, // Keep track of original AMI
                instanceType, workstationName,
                hostname, hostnameNumber,
                platform: 'Linux', hasGpu,
                status: 'launching', dcvStatus: 'launching', instanceStatus: 'pending',
                region: targetRegion, subnetId,
                instanceStartTime: currentTime, createdAt: currentTime,
                ...(pipelineId && { pipelineId })
            }
        }));

        return { 
            instanceId, assignedUserId: assignedUserId || null, amiId: effectiveAmiId, instanceType, 
            platform: 'Linux', hasGpu, hostname,
            region: targetRegion,
            status: 'launching' 
        };
    } catch (error) {
        const isCapacityError = error.name === 'InsufficientInstanceCapacity' ||
                               error.Code === 'InsufficientInstanceCapacity' ||
                               (error.message && error.message.includes('InsufficientInstanceCapacity'));
        
        // Unsupported error occurs when instance type is not available in the AZ
        const isUnsupportedError = error.name === 'Unsupported' ||
                                   error.Code === 'Unsupported' ||
                                   (error.message && error.message.includes('is not supported in your requested Availability Zone'));

        if (isCapacityError || isUnsupportedError) {
            const errorType = isCapacityError ? 'InsufficientInstanceCapacity' : 'Unsupported';
            const nextRetryIndex = retrySubnetIndex + 1;
            const willRetry = nextRetryIndex < subnetIds.length;

            console.log(`${errorType} error in subnet ${subnetId}: ${error.message}`);

            // If no more subnets to try, create a failed workstation record
            if (!willRetry) {
                const failedInstanceId = 'failed-' + Date.now();
                await dynamodb.send(new PutCommand({
                    TableName: process.env.WORKSTATION_TABLE_NAME,
                    Item: {
                        instanceId: failedInstanceId,
                        ...(assignedUserId && { assignedUserId }),
                        amiId: effectiveAmiId, instanceType,
                        workstationName: 'Failed - ' + instanceType,
                        platform: 'Linux',
                        status: 'failed', dcvStatus: 'failed', instanceStatus: 'failed',
                        failureReason: errorType === 'Unsupported' 
                            ? 'Instance type ' + instanceType + ' is not supported in any available availability zone. Try a different instance type.'
                            : 'Insufficient capacity for ' + instanceType + ' in all availability zones. Try a different instance type or try again later.',
                        region: targetRegion,
                        createdAt: new Date().toISOString(),
                        ...(pipelineId && { pipelineId })
                    }
                }));
            }

            return { ...event, error: errorType, errorMessage: error.message, retrySubnetIndex: nextRetryIndex, shouldRetry: willRetry };
        }
        throw error;
    }
};
