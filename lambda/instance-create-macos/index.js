// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { EC2Client, RunInstancesCommand, DescribeImagesCommand, DescribeHostsCommand, AllocateHostsCommand, DescribeSubnetsCommand } = require('@aws-sdk/client-ec2');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { ResourceGroupsClient, GroupResourcesCommand, ListGroupResourcesCommand, GetGroupConfigurationCommand } = require('@aws-sdk/client-resource-groups');
const { LicenseManagerClient, UpdateLicenseSpecificationsForResourceCommand } = require('@aws-sdk/client-license-manager');

// Default clients for primary region
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient());
const ssm = new SSMClient();

// Helper to create clients for specific region
function getEC2Client(region) {
    if (region && region !== process.env.AWS_REGION) {
        return new EC2Client({ region });
    }
    return new EC2Client();
}

function getResourceGroupsClient(region) {
    if (region && region !== process.env.AWS_REGION) {
        return new ResourceGroupsClient({ region });
    }
    return new ResourceGroupsClient();
}

function getLicenseManagerClient(region) {
    if (region && region !== process.env.AWS_REGION) {
        return new LicenseManagerClient({ region });
    }
    return new LicenseManagerClient();
}

/**
 * Generate a unique hostname using atomic DynamoDB counter
 */
async function generateHostname() {
    const pascalCaseName = process.env.PASCAL_CASE_NAME;
    const hostnameCounterTable = process.env.HOSTNAME_COUNTER_TABLE_NAME;

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

/**
 * Get the license configuration ARN from the Host Resource Group configuration
 */
async function getLicenseConfigFromResourceGroup(hostResourceGroupArn, resourceGroups) {
    const groupName = hostResourceGroupArn.split('/').pop();
    
    try {
        const configResult = await resourceGroups.send(new GetGroupConfigurationCommand({
            Group: groupName
        }));
        
        // Find the EC2::HostManagement configuration
        const hostMgmtConfig = configResult.GroupConfiguration?.Configuration?.find(
            c => c.Type === 'AWS::EC2::HostManagement'
        );
        
        if (hostMgmtConfig) {
            // Look for allowed-host-based-license-configurations parameter
            const licenseParam = hostMgmtConfig.Parameters?.find(
                p => p.Name === 'allowed-host-based-license-configurations'
            );
            
            if (licenseParam?.Values?.length > 0) {
                console.log(`Found license configuration: ${licenseParam.Values[0]}`);
                return licenseParam.Values[0];
            }
        }
        
        console.warn('No license configuration found in Host Resource Group');
        return null;
    } catch (error) {
        console.error('Error getting Host Resource Group configuration:', error.message);
        return null;
    }
}

/**
 * Find available dedicated hosts of the specified instance type that are NOT in the Host Resource Group
 */
async function findOrphanedHosts(instanceType, availabilityZones, hostResourceGroupArn, ec2, resourceGroups) {
    console.log(`Looking for orphaned ${instanceType} hosts not in Host Resource Group...`);
    
    // Get hosts currently in the resource group
    const groupName = hostResourceGroupArn.split('/').pop();
    let hostsInGroup = new Set();
    
    try {
        const groupResources = await resourceGroups.send(new ListGroupResourcesCommand({
            Group: groupName
        }));
        
        for (const resource of groupResources.ResourceIdentifiers || []) {
            if (resource.ResourceType === 'AWS::EC2::Host') {
                const hostId = resource.ResourceArn.split('/').pop();
                hostsInGroup.add(hostId);
            }
        }
        console.log(`Hosts currently in group: ${Array.from(hostsInGroup).join(', ') || 'none'}`);
    } catch (error) {
        console.warn('Could not list group resources:', error.message);
    }
    
    // Find available hosts of the right type
    try {
        const describeResult = await ec2.send(new DescribeHostsCommand({
            Filter: [
                { Name: 'instance-type', Values: [instanceType] },
                { Name: 'state', Values: ['available'] }
            ]
        }));
        
        const orphanedHosts = (describeResult.Hosts || []).filter(host => {
            // Check if host has capacity and is in one of our AZs
            const hasCapacity = host.AvailableCapacity?.AvailableInstanceCapacity?.some(
                c => c.InstanceType === instanceType && c.AvailableCapacity > 0
            );
            const inValidAz = availabilityZones.includes(host.AvailabilityZone);
            const notInGroup = !hostsInGroup.has(host.HostId);
            
            return hasCapacity && inValidAz && notInGroup;
        });
        
        console.log(`Found ${orphanedHosts.length} orphaned hosts: ${orphanedHosts.map(h => h.HostId).join(', ')}`);
        return orphanedHosts;
    } catch (error) {
        console.warn('Error finding orphaned hosts:', error.message);
        return [];
    }
}

/**
 * Add a dedicated host to the Host Resource Group by associating it with the license configuration
 */
async function addHostToResourceGroup(hostId, hostResourceGroupArn, licenseConfigArn, targetRegion, resourceGroups, licenseManager) {
    console.log(`Adding host ${hostId} to Host Resource Group...`);
    
    const accountId = process.env.AWS_ACCOUNT_ID;
    const hostArn = `arn:aws:ec2:${targetRegion}:${accountId}:dedicated-host/${hostId}`;
    const groupName = hostResourceGroupArn.split('/').pop();
    
    try {
        // First, associate the license configuration with the host
        // This is required for the host to be part of the Host Resource Group
        await licenseManager.send(new UpdateLicenseSpecificationsForResourceCommand({
            ResourceArn: hostArn,
            AddLicenseSpecifications: [
                { LicenseConfigurationArn: licenseConfigArn }
            ]
        }));
        console.log(`Associated license configuration with host ${hostId}`);
        
        // Now add the host to the resource group
        await resourceGroups.send(new GroupResourcesCommand({
            Group: groupName,
            ResourceArns: [hostArn]
        }));
        console.log(`Added host ${hostId} to resource group ${groupName}`);
        
        return true;
    } catch (error) {
        console.error('Failed to add host', hostId, 'to resource group:', error.message);
        return false;
    }
}

/**
 * Allocate a new dedicated host and add it to the Host Resource Group
 */
async function allocateNewHost(instanceType, availabilityZones, hostResourceGroupArn, licenseConfigArn, targetRegion, ec2, resourceGroups, licenseManager, pascalCaseName) {
    console.log(`Attempting to allocate new ${instanceType} dedicated host...`);
    
    // Try each AZ until we find one with capacity
    for (const az of availabilityZones) {
        console.log(`Trying to allocate host in ${az}...`);
        
        try {
            const allocateResult = await ec2.send(new AllocateHostsCommand({
                InstanceType: instanceType,
                Quantity: 1,
                AvailabilityZone: az,
                AutoPlacement: 'on',
                HostMaintenance: 'on',
                TagSpecifications: [{
                    ResourceType: 'dedicated-host',
                    Tags: [
                        { Key: 'Name', Value: `${pascalCaseName || 'VDI'}-${instanceType}-AutoAllocated` },
                        { Key: 'ManagedBy', Value: pascalCaseName || 'WorkstationManager' },
                        { Key: 'AutoAllocated', Value: 'true' }
                    ]
                }]
            }));
            
            const newHostId = allocateResult.HostIds?.[0];
            if (!newHostId) {
                console.warn(`AllocateHosts succeeded but no host ID returned for ${az}`);
                continue;
            }
            
            console.log(`Successfully allocated new host ${newHostId} in ${az}`);
            
            // Add the new host to the resource group
            if (licenseConfigArn) {
                const added = await addHostToResourceGroup(newHostId, hostResourceGroupArn, licenseConfigArn, targetRegion, resourceGroups, licenseManager);
                if (!added) {
                    console.warn(`Host ${newHostId} allocated but could not be added to resource group`);
                }
            }
            
            return { hostId: newHostId, availabilityZone: az };
        } catch (error) {
            console.warn(`Failed to allocate host in ${az}: ${error.message}`);
            
            // If it's a capacity error, try the next AZ
            if (error.message?.includes('Insufficient capacity') || 
                error.message?.includes('InsufficientHostCapacity') ||
                error.Code === 'InsufficientHostCapacity') {
                continue;
            }
            
            // For other errors (like quota exceeded), log and continue
            if (error.message?.includes('limit') || error.message?.includes('quota')) {
                console.error(`Host allocation quota/limit error: ${error.message}`);
                break; // No point trying other AZs if we hit quota
            }
        }
    }
    
    console.error('Failed to allocate host in any AZ');
    return null;
}

exports.handler = async (event) => {
    console.log('Creating macOS EC2 instance:', JSON.stringify(event, null, 2));

    const { amiId, instanceType, assignedUserId, dedicatedHostId, availabilityZone, rootVolumeSize, pipelineId, region, regionalConfig } = event;

    // Determine target region and configuration
    const targetRegion = region || process.env.AWS_REGION;
    const isRemoteRegion = targetRegion !== process.env.AWS_REGION;
    const pascalCaseName = process.env.PASCAL_CASE_NAME;
    
    // Get clients for target region
    const ec2 = getEC2Client(targetRegion);
    const resourceGroups = getResourceGroupsClient(targetRegion);
    const licenseManager = getLicenseManagerClient(targetRegion);
    
    // Use regional config if provided (satellite region), otherwise use environment variables
    let hostResourceGroupArn, subnetMappingsRaw, securityGroupId, instanceProfileName, effectiveAmiId;
    
    if (isRemoteRegion && regionalConfig) {
        // For satellite regions, we need regional Host Resource Group (if macOS is enabled)
        hostResourceGroupArn = regionalConfig.hostResourceGroupArn;
        subnetMappingsRaw = regionalConfig.subnetMappings || [];
        securityGroupId = regionalConfig.securityGroupId;
        // Instance profile name follows pattern: ${PascalCaseName}-Regional-Workstation-Profile
        instanceProfileName = regionalConfig.instanceProfileName || `${pascalCaseName}-Regional-Workstation-Profile`;
        effectiveAmiId = regionalConfig.regionalAmiId || amiId;
        console.log(`Using regional config for ${targetRegion}: hostResourceGroup=${hostResourceGroupArn}, instanceProfile=${instanceProfileName}, ami=${effectiveAmiId}`);
    } else {
        hostResourceGroupArn = process.env.HOST_RESOURCE_GROUP_ARN;
        subnetMappingsRaw = process.env.SUBNET_IDS.split(',');
        securityGroupId = process.env.SECURITY_GROUP_ID;
        instanceProfileName = process.env.INSTANCE_PROFILE_NAME;
        effectiveAmiId = amiId;
    }
    
    const useHostResourceGroup = !!hostResourceGroupArn;
    
    // Get license configuration ARN from the Host Resource Group (needed for adding orphaned hosts)
    let licenseConfigArn = null;
    if (useHostResourceGroup) {
        licenseConfigArn = await getLicenseConfigFromResourceGroup(hostResourceGroupArn, resourceGroups);
    }

    // Parse subnet mappings (format: "subnet-xxx:az-name" or just "subnet-xxx")
    let subnetMappings = (Array.isArray(subnetMappingsRaw) ? subnetMappingsRaw : []).map(s => {
        if (typeof s === 'object') return s; // Already parsed
        const [subnetId, az] = s.split(':');
        return { subnetId, az };
    });
    
    // If any subnet is missing AZ info, look it up
    const subnetsNeedingAz = subnetMappings.filter(s => s.subnetId && !s.az);
    if (subnetsNeedingAz.length > 0) {
        try {
            const subnetIds = subnetsNeedingAz.map(s => s.subnetId);
            console.log('Looking up AZs for subnets in', targetRegion + ':', subnetIds);
            const describeSubnets = await ec2.send(new DescribeSubnetsCommand({ SubnetIds: subnetIds }));
            console.log('DescribeSubnets response:', JSON.stringify(describeSubnets, null, 2));
            const azMap = {};
            for (const subnet of describeSubnets.Subnets || []) {
                azMap[subnet.SubnetId] = subnet.AvailabilityZone;
            }
            subnetMappings = subnetMappings.map(s => ({
                subnetId: s.subnetId,
                az: s.az || azMap[s.subnetId]
            }));
            console.log('Resolved subnet AZs:', JSON.stringify(subnetMappings));
        } catch (error) {
            console.error('Could not look up subnet AZs:', error);
        }
    }
    
    const availabilityZones = subnetMappings.map(s => s.az).filter(Boolean);

    // Find appropriate subnet
    let subnetId;
    let subnetsToTry = [];
    
    if (useHostResourceGroup) {
        // For Host Resource Group, find AZs where we have available hosts of the right type
        // and prioritize those subnets
        try {
            const describeResult = await ec2.send(new DescribeHostsCommand({
                Filter: [
                    { Name: 'instance-type', Values: [instanceType] },
                    { Name: 'state', Values: ['available'] }
                ]
            }));
            
            // Find AZs with available capacity
            const azsWithCapacity = new Set();
            for (const host of describeResult.Hosts || []) {
                const hasCapacity = host.AvailableCapacity?.AvailableInstanceCapacity?.some(
                    c => c.InstanceType === instanceType && c.AvailableCapacity > 0
                );
                if (hasCapacity) {
                    azsWithCapacity.add(host.AvailabilityZone);
                }
            }
            
            console.log(`AZs with available ${instanceType} capacity: ${Array.from(azsWithCapacity).join(', ') || 'none'}`);
            
            // Prioritize subnets in AZs with available hosts
            const prioritizedSubnets = subnetMappings.filter(s => azsWithCapacity.has(s.az));
            const otherSubnets = subnetMappings.filter(s => !azsWithCapacity.has(s.az));
            subnetsToTry = [...prioritizedSubnets, ...otherSubnets];
            
            if (prioritizedSubnets.length > 0) {
                subnetId = prioritizedSubnets[0].subnetId;
                console.log(`Using Host Resource Group - prioritized subnet in AZ with capacity: ${subnetId} (${prioritizedSubnets[0].az})`);
            } else {
                subnetId = subnetMappings[0]?.subnetId;
                console.log('Using Host Resource Group - no AZ with capacity found, using first subnet:', subnetId);
            }
        } catch (error) {
            console.warn('Could not check host availability, using first subnet:', error.message);
            subnetId = subnetMappings[0]?.subnetId;
            subnetsToTry = subnetMappings;
        }
    } else if (availabilityZone) {
        const matchingSubnet = subnetMappings.find(s => s.az === availabilityZone);
        subnetId = matchingSubnet?.subnetId;
        subnetsToTry = matchingSubnet ? [matchingSubnet] : [];
        console.log('Using Dedicated Host in AZ', availabilityZone, '- subnet:', subnetId);
    } else {
        subnetId = subnetMappings[0]?.subnetId;
        subnetsToTry = subnetMappings;
    }

    if (!subnetId) {
        throw new Error('No subnet found. Available: ' + subnetMappings.map(s => s.az).join(', '));
    }

    // Generate unique hostname
    let hostname = null;
    let hostnameNumber = null;
    try {
        const hostnameResult = await generateHostname();
        hostname = hostnameResult.hostname;
        hostnameNumber = hostnameResult.hostnameNumber;
    } catch (error) {
        console.warn('Failed to generate hostname, will use fallback:', error.message);
    }

    // Get AMI details
    let imageName = null;
    let amiMinVolumeSize = 200;

    try {
        const imageResult = await dynamodb.send(new GetCommand({
            TableName: process.env.IMAGES_TABLE_NAME,
            Key: { amiId }
        }));
        if (imageResult.Item?.name) imageName = imageResult.Item.name;
    } catch (e) { console.warn('Failed to get image name from Images table'); }

    if (!imageName && pipelineId) {
        try {
            const result = await dynamodb.send(new GetCommand({
                TableName: process.env.IMAGE_PIPELINES_TABLE_NAME,
                Key: { pipelineId }
            }));
            if (result.Item?.name) imageName = result.Item.name;
        } catch (e) { console.warn('Failed to get pipeline name'); }
    }

    try {
        const describeResult = await ec2.send(new DescribeImagesCommand({ ImageIds: [effectiveAmiId] }));
        const image = describeResult.Images?.[0];
        if (image) {
            if (!imageName && image.Name) {
                imageName = image.Name.includes('macOS') ? 'macOS Workstation' : image.Name.split('/').pop();
            }
            const rootDevice = image.BlockDeviceMappings?.find(
                bdm => bdm.DeviceName === image.RootDeviceName || bdm.DeviceName === '/dev/sda1'
            );
            if (rootDevice?.Ebs?.VolumeSize) {
                amiMinVolumeSize = rootDevice.Ebs.VolumeSize;
                console.log(`AMI root volume size: ${amiMinVolumeSize}GB`);
            }
        }
    } catch (e) { console.warn('Failed to get AMI details from EC2:', e.message); }

    const effectiveVolumeSize = Math.max(rootVolumeSize || 200, amiMinVolumeSize);
    console.log(`Requested: ${rootVolumeSize}GB, AMI minimum: ${amiMinVolumeSize}GB, Using: ${effectiveVolumeSize}GB`);

    if (!imageName) imageName = 'macOS Workstation';

    const imageBaseName = imageName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const paddedNumber = hostnameNumber ? hostnameNumber.toString().padStart(4, '0') : Date.now().toString().slice(-4);
    const workstationName = `${imageBaseName}-${paddedNumber}`;

    // Build placement configuration
    const placement = useHostResourceGroup
        ? { HostResourceGroupArn: hostResourceGroupArn, Tenancy: 'host' }
        : { HostId: dedicatedHostId, Tenancy: 'host' };

    console.log('Placement configuration:', JSON.stringify(placement));
    console.log(`Using AMI: ${effectiveAmiId} (source: ${amiId})`);

    // Build RunInstances parameters
    const runInstancesParams = {
        MinCount: 1,
        MaxCount: 1,
        InstanceType: instanceType,
        ImageId: effectiveAmiId,
        SubnetId: subnetId,
        SecurityGroupIds: [securityGroupId],
        IamInstanceProfile: {
            Name: instanceProfileName
        },
        Placement: placement,
        BlockDeviceMappings: [{
            DeviceName: '/dev/sda1',
            Ebs: {
                VolumeSize: effectiveVolumeSize,
                VolumeType: 'gp3',
                DeleteOnTermination: true
            }
        }],
        TagSpecifications: [{
            ResourceType: 'instance',
            Tags: [
                { Key: 'Name', Value: workstationName },
                ...(assignedUserId ? [{ Key: 'AssignedUser', Value: assignedUserId }] : []),
                { Key: 'ManagedBy', Value: pascalCaseName || 'WorkstationManager' },
                { Key: 'Platform', Value: 'macOS' },
                { Key: 'Region', Value: targetRegion },
                ...(hostname ? [{ Key: 'Hostname', Value: hostname }] : []),
                ...(dedicatedHostId ? [{ Key: 'DedicatedHostId', Value: dedicatedHostId }] : []),
                ...(useHostResourceGroup ? [{ Key: 'HostResourceGroup', Value: 'true' }] : [])
            ]
        }]
    };

    let result;
    let retryWithOrphanedHost = false;
    let lastError = null;

    // Try launching with each subnet in priority order
    for (let i = 0; i < subnetsToTry.length; i++) {
        const currentSubnet = subnetsToTry[i];
        runInstancesParams.SubnetId = currentSubnet.subnetId;
        
        console.log(`Attempt ${i + 1}/${subnetsToTry.length}: Trying subnet ${currentSubnet.subnetId} in AZ ${currentSubnet.az}`);
        
        try {
            result = await ec2.send(new RunInstancesCommand(runInstancesParams));
            console.log(`Successfully launched in ${currentSubnet.az}`);
            break; // Success, exit the loop
        } catch (error) {
            console.error('Launch failed in', currentSubnet.az + ':', error.message);
            lastError = error;
            
            // If this is a configuration error, try the next subnet
            if ((error.name === 'InvalidParameterValue' || error.Code === 'InvalidParameterValue') &&
                error.message?.includes('configuration is currently not supported')) {
                console.log('No suitable host in this AZ, trying next subnet...');
                continue;
            }
            
            // For other errors, don't retry with different subnets
            break;
        }
    }

    // If we didn't get a result, try the orphaned host recovery
    if (!result && lastError && useHostResourceGroup) {
        console.log('All subnet attempts failed, checking for orphaned hosts...');
        
        // Look for orphaned hosts (available hosts not in the resource group)
        const orphanedHosts = await findOrphanedHosts(instanceType, availabilityZones, hostResourceGroupArn, ec2, resourceGroups);
        
        if (orphanedHosts.length > 0 && licenseConfigArn) {
            // Try to add an orphaned host to the resource group
            const hostToAdd = orphanedHosts[0];
            console.log(`Attempting to add orphaned host ${hostToAdd.HostId} to resource group...`);
            
            const added = await addHostToResourceGroup(hostToAdd.HostId, hostResourceGroupArn, licenseConfigArn, targetRegion, resourceGroups, licenseManager);
            
            if (added) {
                // Wait a moment for the association to propagate
                console.log('Waiting for host association to propagate...');
                await new Promise(resolve => setTimeout(resolve, 5000));
                
                // Update subnet to match the host's AZ
                const hostAz = hostToAdd.AvailabilityZone;
                const matchingSubnet = subnetMappings.find(s => s.az === hostAz);
                if (matchingSubnet) {
                    runInstancesParams.SubnetId = matchingSubnet.subnetId;
                    console.log(`Updated subnet to ${matchingSubnet.subnetId} for AZ ${hostAz}`);
                }
                
                // Retry the launch
                console.log('Retrying instance launch with orphaned host...');
                try {
                    result = await ec2.send(new RunInstancesCommand(runInstancesParams));
                    retryWithOrphanedHost = true;
                } catch (retryError) {
                    console.error('Retry launch also failed:', retryError.message);
                    lastError = retryError;
                }
            }
        } else if (orphanedHosts.length > 0 && !licenseConfigArn) {
            console.warn('Found orphaned hosts but license config not available - cannot add to group');
        }
    }

    // If still no result, try to explicitly allocate a new dedicated host
    if (!result && useHostResourceGroup) {
        console.log('No existing hosts available, attempting to allocate a new dedicated host...');
        
        const newHost = await allocateNewHost(instanceType, availabilityZones, hostResourceGroupArn, licenseConfigArn, targetRegion, ec2, resourceGroups, licenseManager, pascalCaseName);
        
        if (newHost) {
            // Wait for the host to become available
            console.log(`Waiting for new host ${newHost.hostId} to become available...`);
            await new Promise(resolve => setTimeout(resolve, 10000));
            
            // Update subnet to match the new host's AZ
            const matchingSubnet = subnetMappings.find(s => s.az === newHost.availabilityZone);
            if (matchingSubnet) {
                runInstancesParams.SubnetId = matchingSubnet.subnetId;
                console.log(`Updated subnet to ${matchingSubnet.subnetId} for new host in ${newHost.availabilityZone}`);
            }
            
            // Try to launch on the new host
            console.log('Attempting to launch instance on newly allocated host...');
            try {
                result = await ec2.send(new RunInstancesCommand(runInstancesParams));
                console.log('Successfully launched on newly allocated host');
            } catch (launchError) {
                console.error('Failed to launch on new host:', launchError.message);
                lastError = launchError;
            }
        }
    }

    // If still no result, throw the last error with helpful context
    if (!result) {
        const errorMsg = `No suitable ${instanceType} host available in any AZ and could not allocate a new one. ` +
            `Tried AZs: ${subnetsToTry.map(s => s.az).join(', ')}. ` +
            `This may be due to AWS capacity constraints in the region or service quota limits. ` +
            `Original error: ${lastError?.message || 'Unknown error'}`;
        throw new Error(errorMsg);
    }

    const instanceId = result.Instances[0].InstanceId;
    const launchedAz = result.Instances[0].Placement?.AvailabilityZone || availabilityZone;
    const launchedHostId = result.Instances[0].Placement?.HostId;
    const currentTime = new Date().toISOString();

    console.log(`Instance ${instanceId} launched on host ${launchedHostId} in ${launchedAz}`);
    if (retryWithOrphanedHost) {
        console.log('Successfully launched after adding orphaned host to resource group');
    }

    await dynamodb.send(new PutCommand({
        TableName: process.env.WORKSTATION_TABLE_NAME,
        Item: {
            instanceId,
            // Only include assignedUserId if it has a value (DynamoDB GSI doesn't allow empty strings)
            ...(assignedUserId && { assignedUserId }),
            amiId: effectiveAmiId,
            sourceAmiId: amiId, // Keep track of original AMI
            instanceType,
            workstationName,
            hostname,
            hostnameNumber,
            platform: 'macOS',
            ...(launchedHostId && { dedicatedHostId: launchedHostId }),
            ...(useHostResourceGroup && { hostResourceGroupArn }),
            status: 'launching',
            dcvStatus: 'launching',
            instanceStatus: 'pending',
            region: targetRegion,
            subnetId: runInstancesParams.SubnetId,
            availabilityZone: launchedAz,
            instanceStartTime: currentTime,
            createdAt: currentTime,
            ...(pipelineId && { pipelineId })
        }
    }));

    return {
        instanceId,
        assignedUserId: assignedUserId || null,
        amiId: effectiveAmiId,
        instanceType,
        platform: 'macOS',
        hostname,
        ...(launchedHostId && { dedicatedHostId: launchedHostId }),
        ...(useHostResourceGroup && { hostResourceGroupArn }),
        availabilityZone: launchedAz,
        region: targetRegion,
        status: 'launching'
    };
};
