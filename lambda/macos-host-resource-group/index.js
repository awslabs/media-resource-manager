// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom Resource Lambda for managing Mac Host Resource Groups
 * 
 * This Lambda creates/updates/deletes a Host Resource Group with
 * AWS::EC2::HostManagement configuration for macOS Dedicated Hosts.
 * 
 * Using a Custom Resource allows us to:
 * 1. Control IAM permissions explicitly via the Lambda role
 * 2. Make deployments portable across accounts without IAM prereqs
 * 3. Handle the specific API calls needed for Host Resource Groups
 * 4. Automatically create the License Manager service-linked role if needed
 * 5. Create a License Configuration required for Host Resource Group instance launches
 * 
 * IMPORTANT: To launch instances into a Host Resource Group, the AMI must have
 * a core- or socket-based license configuration associated with it. This Lambda
 * creates that license configuration and returns its ARN for use in Image Builder.
 */

const { ResourceGroupsClient, CreateGroupCommand, DeleteGroupCommand, GetGroupCommand, UpdateGroupCommand, PutGroupConfigurationCommand } = require('@aws-sdk/client-resource-groups');
const { IAMClient, CreateServiceLinkedRoleCommand, GetRoleCommand } = require('@aws-sdk/client-iam');
const { LicenseManagerClient, CreateLicenseConfigurationCommand, DeleteLicenseConfigurationCommand, ListLicenseConfigurationsCommand, UpdateLicenseConfigurationCommand } = require('@aws-sdk/client-license-manager');

const resourceGroups = new ResourceGroupsClient();
const iam = new IAMClient();
const licenseManager = new LicenseManagerClient();

exports.handler = async (event, context) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  const requestType = event.RequestType;
  const props = event.ResourceProperties;
  const groupName = props.GroupName;
  
  try {
    let response;
    
    switch (requestType) {
      case 'Create':
        response = await createHostResourceGroup(groupName, props);
        break;
      case 'Update':
        response = await updateHostResourceGroup(groupName, props, event.OldResourceProperties);
        break;
      case 'Delete':
        response = await deleteHostResourceGroup(groupName, props);
        break;
      default:
        throw new Error(`Unknown request type: ${requestType}`);
    }
    
    return {
      PhysicalResourceId: groupName,
      Data: response,
    };
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
};

/**
 * Ensures the License Manager service-linked role exists.
 * This role is required for Host Resource Groups with EC2 Host Management.
 */
async function ensureLicenseManagerServiceRole() {
  const roleName = 'AWSServiceRoleForAWSLicenseManagerRole';
  
  try {
    await iam.send(new GetRoleCommand({ RoleName: roleName }));
    console.log('License Manager service-linked role already exists');
    return true;
  } catch (error) {
    if (error.name === 'NoSuchEntityException') {
      console.log('Creating License Manager service-linked role...');
      try {
        await iam.send(new CreateServiceLinkedRoleCommand({
          AWSServiceName: 'license-manager.amazonaws.com',
          Description: 'Service-linked role for AWS License Manager',
        }));
        console.log('License Manager service-linked role created');
        // Wait for the role to propagate - IAM is eventually consistent
        // Service-linked roles can take 10-30 seconds to be usable
        console.log('Waiting 30 seconds for service-linked role to propagate...');
        await sleep(30000);
        return true;
      } catch (createError) {
        if (createError.name === 'InvalidInputException' && createError.message.includes('already exists')) {
          console.log('Service-linked role already exists (race condition)');
          return true;
        }
        throw createError;
      }
    }
    throw error;
  }
}

async function createHostResourceGroup(groupName, props) {
  console.log(`Creating Host Resource Group: ${groupName}`);
  
  // Ensure the License Manager service-linked role exists
  await ensureLicenseManagerServiceRole();
  
  // Create or get the License Configuration (required for Host Resource Group launches)
  const licenseConfigArn = await ensureLicenseConfiguration(props);
  console.log(`License Configuration ARN: ${licenseConfigArn}`);
  
  // Check if group already exists
  try {
    const existing = await resourceGroups.send(new GetGroupCommand({ Group: groupName }));
    if (existing.Group) {
      console.log('Group already exists, updating configuration...');
      return await updateHostResourceGroup(groupName, props, {});
    }
  } catch (error) {
    if (error.name !== 'NotFoundException') {
      throw error;
    }
    // Group doesn't exist, continue with creation
  }
  
  // Create the group with Host Management configuration
  // Use the license configuration ARN instead of any-host-based-license-configuration
  const configuration = buildConfiguration(props, licenseConfigArn);
  
  const createResponse = await resourceGroups.send(new CreateGroupCommand({
    Name: groupName,
    Description: props.Description || 'Host Resource Group for macOS Dedicated Hosts',
    Configuration: configuration,
  }));
  
  console.log('Group created:', createResponse.Group?.GroupArn);
  
  return {
    GroupArn: createResponse.Group?.GroupArn,
    GroupName: groupName,
    LicenseConfigurationArn: licenseConfigArn,
  };
}

async function updateHostResourceGroup(groupName, props, oldProps) {
  console.log(`Updating Host Resource Group: ${groupName}`);
  
  // Ensure the License Manager service-linked role exists
  await ensureLicenseManagerServiceRole();
  
  // Create or get the License Configuration
  const licenseConfigArn = await ensureLicenseConfiguration(props);
  console.log(`License Configuration ARN: ${licenseConfigArn}`);
  
  // Check if the group exists first
  let groupExists = false;
  try {
    await resourceGroups.send(new GetGroupCommand({ Group: groupName }));
    groupExists = true;
  } catch (error) {
    if (error.name === 'NotFoundException') {
      console.log('Group does not exist, will create it');
      groupExists = false;
    } else {
      throw error;
    }
  }
  
  // If group doesn't exist, create it
  if (!groupExists) {
    return await createHostResourceGroup(groupName, props);
  }
  
  // Try to update the configuration
  // Note: AWS doesn't allow changing license configuration on existing groups
  // If we get an error about license config, we need to delete and recreate
  try {
    const configuration = buildConfiguration(props, licenseConfigArn);
    
    await resourceGroups.send(new PutGroupConfigurationCommand({
      Group: groupName,
      Configuration: configuration,
    }));
    
    // Get the group ARN
    const getResponse = await resourceGroups.send(new GetGroupCommand({ Group: groupName }));
    
    return {
      GroupArn: getResponse.Group?.GroupArn,
      GroupName: groupName,
      LicenseConfigurationArn: licenseConfigArn,
    };
  } catch (error) {
    // If we can't update due to license config mismatch, delete and recreate
    if (error.message && error.message.includes('license-configurations')) {
      console.log('License configuration mismatch, deleting and recreating group...');
      await deleteHostResourceGroup(groupName, props);
      // Wait a moment for deletion to propagate
      await sleep(3000);
      return await createHostResourceGroup(groupName, props);
    }
    throw error;
  }
}

async function deleteHostResourceGroup(groupName, props) {
  console.log(`Deleting Host Resource Group: ${groupName}`);
  
  try {
    await resourceGroups.send(new DeleteGroupCommand({ Group: groupName }));
    console.log('Group deleted');
  } catch (error) {
    if (error.name === 'NotFoundException') {
      console.log('Group not found, nothing to delete');
    } else {
      throw error;
    }
  }
  
  // Note: We don't delete the license configuration as it may be in use
  // and there's no harm in leaving it (no cost)
  
  return { GroupName: groupName };
}

function buildConfiguration(props, licenseConfigArn) {
  const hostFamilies = props.AllowedHostFamilies || ['mac2'];
  const autoAllocate = props.AutoAllocateHost !== 'false';
  const autoRelease = props.AutoReleaseHost === 'true';
  
  // Build the Host Management configuration
  // IMPORTANT: We use allowed-host-based-license-configurations with our specific
  // license configuration ARN instead of any-host-based-license-configuration.
  // This ensures instances launched into this group have the proper license association.
  const hostManagementParams = [
    {
      Name: 'allowed-host-families',
      Values: hostFamilies,
    },
    {
      Name: 'auto-allocate-host',
      Values: [autoAllocate ? 'true' : 'false'],
    },
    {
      Name: 'auto-release-host',
      Values: [autoRelease ? 'true' : 'false'],
    },
  ];
  
  // If we have a license configuration ARN, use it; otherwise fall back to any-host-based
  if (licenseConfigArn) {
    hostManagementParams.push({
      Name: 'allowed-host-based-license-configurations',
      Values: [licenseConfigArn],
    });
  } else {
    hostManagementParams.push({
      Name: 'any-host-based-license-configuration',
      Values: ['true'],
    });
  }
  
  return [
    {
      Type: 'AWS::EC2::HostManagement',
      Parameters: hostManagementParams,
    },
    {
      Type: 'AWS::ResourceGroups::Generic',
      Parameters: [
        {
          Name: 'allowed-resource-types',
          Values: ['AWS::EC2::Host'],
        },
        {
          Name: 'deletion-protection',
          Values: ['UNLESS_EMPTY'],
        },
      ],
    },
  ];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Creates or retrieves a License Configuration for macOS Dedicated Hosts.
 * This is REQUIRED for launching instances into a Host Resource Group.
 * 
 * Per AWS docs: "You must associate a core- or socket-based license configuration with the AMI"
 * to launch instances into a host resource group.
 */
async function ensureLicenseConfiguration(props, retryCount = 0) {
  const licenseConfigName = props.LicenseConfigurationName || `${props.GroupName}-License`;
  const maxRetries = 3;
  
  console.log(`Ensuring License Configuration exists: ${licenseConfigName} (attempt ${retryCount + 1}/${maxRetries + 1})`);
  
  // Check if license configuration already exists
  try {
    const listResponse = await licenseManager.send(new ListLicenseConfigurationsCommand({
      Filters: [
        {
          Name: 'name',
          Values: [licenseConfigName],
        },
      ],
    }));
    
    if (listResponse.LicenseConfigurations && listResponse.LicenseConfigurations.length > 0) {
      const existingConfig = listResponse.LicenseConfigurations[0];
      console.log(`License Configuration already exists: ${existingConfig.LicenseConfigurationArn}`);
      return existingConfig.LicenseConfigurationArn;
    }
  } catch (error) {
    // If service role not found, wait and retry
    if (error.message && error.message.includes('Service role not found') && retryCount < maxRetries) {
      console.log(`Service role not ready yet, waiting 15 seconds before retry...`);
      await sleep(15000);
      return ensureLicenseConfiguration(props, retryCount + 1);
    }
    console.log('Error checking for existing license configuration:', error.message);
    // Continue to create
  }
  
  // Create a new license configuration
  // Using 'Core' counting type which is appropriate for macOS Dedicated Hosts
  console.log('Creating new License Configuration...');
  
  try {
    const createResponse = await licenseManager.send(new CreateLicenseConfigurationCommand({
      Name: licenseConfigName,
      Description: `License configuration for macOS Dedicated Hosts in ${props.GroupName}`,
      LicenseCountingType: 'Core', // Core-based for Dedicated Hosts
      LicenseCount: 1000, // High limit - we're not actually tracking licenses, just enabling HRG
      LicenseCountHardLimit: false, // Soft limit - don't block launches
      // License rules for Dedicated Host tenancy
      LicenseRules: [
        '#allowedTenancy=EC2-DedicatedHost',
      ],
      Tags: [
        { Key: 'Purpose', Value: 'macOS-Dedicated-Host-Management' },
        { Key: 'ManagedBy', Value: props.GroupName },
      ],
    }));
    
    console.log(`License Configuration created: ${createResponse.LicenseConfigurationArn}`);
    
    // Wait a moment for the configuration to propagate
    await sleep(2000);
    
    return createResponse.LicenseConfigurationArn;
  } catch (error) {
    // If service role not found, wait and retry
    if (error.message && error.message.includes('Service role not found') && retryCount < maxRetries) {
      console.log(`Service role not ready for create, waiting 15 seconds before retry...`);
      await sleep(15000);
      return ensureLicenseConfiguration(props, retryCount + 1);
    }
    throw error;
  }
}

// Force Lambda update - v4
