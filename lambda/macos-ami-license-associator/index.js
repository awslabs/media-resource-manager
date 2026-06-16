// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom Resource Lambda for copying macOS AMIs and associating license configurations
 * 
 * This Lambda solves the Host Resource Group license requirement:
 * - AWS public macOS AMIs don't have license configurations
 * - To launch into a Host Resource Group, the AMI MUST have a license config
 * - This Lambda copies the public AMI and associates our license configuration
 * 
 * The copied AMI can then be used with Host Resource Groups for auto-allocation.
 */

const { EC2Client, CopyImageCommand, DescribeImagesCommand, DeregisterImageCommand, DeleteSnapshotCommand } = require('@aws-sdk/client-ec2');
const { LicenseManagerClient, UpdateLicenseSpecificationsForResourceCommand, ListLicenseSpecificationsForResourceCommand } = require('@aws-sdk/client-license-manager');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const ec2 = new EC2Client();
const licenseManager = new LicenseManagerClient();
const ssm = new SSMClient();

exports.handler = async (event, context) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  const requestType = event.RequestType;
  const props = event.ResourceProperties;
  
  try {
    let response;
    
    switch (requestType) {
      case 'Create':
        response = await createLicensedAmi(props);
        break;
      case 'Update':
        response = await updateLicensedAmi(props, event.OldResourceProperties, event.PhysicalResourceId);
        break;
      case 'Delete':
        response = await deleteLicensedAmi(event.PhysicalResourceId, props);
        break;
      default:
        throw new Error(`Unknown request type: ${requestType}`);
    }
    
    return {
      PhysicalResourceId: response.AmiId || event.PhysicalResourceId || 'none',
      Data: response,
    };
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
};

async function createLicensedAmi(props) {
  const { SourceAmiSsmPath, LicenseConfigurationArn, AmiNamePrefix, MacOSVersion } = props;
  
  console.log(`Creating licensed AMI copy for ${MacOSVersion}`);
  console.log(`Source AMI SSM Path: ${SourceAmiSsmPath}`);
  console.log(`License Configuration ARN: ${LicenseConfigurationArn}`);
  
  // Get the source AMI ID from SSM
  const sourceAmiId = await getAmiIdFromSsm(SourceAmiSsmPath);
  console.log(`Source AMI ID: ${sourceAmiId}`);
  
  // Check if we already have a licensed copy of this AMI
  const existingAmi = await findExistingLicensedAmi(AmiNamePrefix, sourceAmiId);
  if (existingAmi) {
    console.log(`Found existing licensed AMI: ${existingAmi.ImageId}`);
    // Verify license is still associated
    await ensureLicenseAssociated(existingAmi.ImageId, LicenseConfigurationArn);
    return {
      AmiId: existingAmi.ImageId,
      SourceAmiId: sourceAmiId,
      AmiName: existingAmi.Name,
    };
  }
  
  // Copy the AMI
  const amiName = `${AmiNamePrefix}-${sourceAmiId}-licensed`;
  console.log(`Copying AMI with name: ${amiName}`);
  
  const copyResponse = await ec2.send(new CopyImageCommand({
    SourceImageId: sourceAmiId,
    SourceRegion: process.env.AWS_REGION,
    Name: amiName,
    Description: `Licensed copy of ${sourceAmiId} for Host Resource Group placement. macOS ${MacOSVersion}.`,
  }));
  
  const newAmiId = copyResponse.ImageId;
  console.log(`AMI copy initiated: ${newAmiId}`);
  
  // Wait for the AMI to be available
  await waitForAmiAvailable(newAmiId);
  
  // Associate the license configuration
  await associateLicenseConfiguration(newAmiId, LicenseConfigurationArn);
  
  // Tag the AMI with source info for tracking
  await tagAmi(newAmiId, sourceAmiId, MacOSVersion, AmiNamePrefix);
  
  return {
    AmiId: newAmiId,
    SourceAmiId: sourceAmiId,
    AmiName: amiName,
  };
}

async function updateLicensedAmi(props, oldProps, physicalResourceId) {
  const { SourceAmiSsmPath, LicenseConfigurationArn, AmiNamePrefix, MacOSVersion } = props;
  
  // Get current source AMI ID
  const currentSourceAmiId = await getAmiIdFromSsm(SourceAmiSsmPath);
  
  // Check if the existing AMI is still valid and based on the current source
  if (physicalResourceId && physicalResourceId !== 'none') {
    try {
      const describeResponse = await ec2.send(new DescribeImagesCommand({
        ImageIds: [physicalResourceId],
      }));
      
      if (describeResponse.Images && describeResponse.Images.length > 0) {
        const existingAmi = describeResponse.Images[0];
        const sourceTag = existingAmi.Tags?.find(t => t.Key === 'SourceAmiId');
        
        if (sourceTag && sourceTag.Value === currentSourceAmiId) {
          console.log(`Existing AMI ${physicalResourceId} is still based on current source ${currentSourceAmiId}`);
          // Just ensure license is associated
          await ensureLicenseAssociated(physicalResourceId, LicenseConfigurationArn);
          return {
            AmiId: physicalResourceId,
            SourceAmiId: currentSourceAmiId,
            AmiName: existingAmi.Name,
          };
        }
        
        console.log(`Source AMI changed from ${sourceTag?.Value} to ${currentSourceAmiId}, creating new copy`);
      }
    } catch (error) {
      console.log(`Could not describe existing AMI ${physicalResourceId}: ${error.message}`);
    }
  }
  
  // Source AMI changed or existing AMI not found, create new one
  const result = await createLicensedAmi(props);
  
  // Clean up old AMI if it exists and is different
  if (physicalResourceId && physicalResourceId !== 'none' && physicalResourceId !== result.AmiId) {
    try {
      await cleanupAmi(physicalResourceId);
    } catch (error) {
      console.log(`Warning: Could not clean up old AMI ${physicalResourceId}: ${error.message}`);
    }
  }
  
  return result;
}

async function deleteLicensedAmi(amiId, props) {
  if (!amiId || amiId === 'none') {
    console.log('No AMI to delete');
    // Return the same physical resource ID - cannot change during DELETE
    return { AmiId: amiId || 'none' };
  }
  
  console.log(`Deleting licensed AMI: ${amiId}`);
  
  try {
    await cleanupAmi(amiId);
    console.log(`Successfully cleaned up AMI: ${amiId}`);
  } catch (error) {
    // Log but don't fail - the AMI may already be deleted or not exist
    console.log(`Warning: Could not clean up AMI ${amiId}: ${error.message}`);
  }
  
  // IMPORTANT: Return the same physical resource ID - CloudFormation does not allow
  // changing the physical resource ID during DELETE operations
  return { AmiId: amiId };
}

async function getAmiIdFromSsm(ssmPath) {
  const response = await ssm.send(new GetParameterCommand({
    Name: ssmPath,
  }));
  return response.Parameter.Value;
}

async function findExistingLicensedAmi(namePrefix, sourceAmiId) {
  try {
    const response = await ec2.send(new DescribeImagesCommand({
      Owners: ['self'],
      Filters: [
        { Name: 'name', Values: [`${namePrefix}-${sourceAmiId}-licensed`] },
        { Name: 'state', Values: ['available'] },
      ],
    }));
    
    if (response.Images && response.Images.length > 0) {
      return response.Images[0];
    }
  } catch (error) {
    console.log(`Error finding existing AMI: ${error.message}`);
  }
  return null;
}

async function waitForAmiAvailable(amiId, maxWaitMinutes = 30) {
  console.log(`Waiting for AMI ${amiId} to become available...`);
  const startTime = Date.now();
  const maxWaitMs = maxWaitMinutes * 60 * 1000;
  
  while (Date.now() - startTime < maxWaitMs) {
    const response = await ec2.send(new DescribeImagesCommand({
      ImageIds: [amiId],
    }));
    
    if (response.Images && response.Images.length > 0) {
      const state = response.Images[0].State;
      console.log(`AMI state: ${state}`);
      
      if (state === 'available') {
        console.log(`AMI ${amiId} is now available`);
        return;
      } else if (state === 'failed') {
        throw new Error(`AMI ${amiId} failed to copy`);
      }
    }
    
    // Wait 30 seconds before checking again
    await sleep(30000);
  }
  
  throw new Error(`Timeout waiting for AMI ${amiId} to become available`);
}

async function associateLicenseConfiguration(amiId, licenseConfigArn) {
  console.log(`Associating license configuration ${licenseConfigArn} with AMI ${amiId}`);
  
  await licenseManager.send(new UpdateLicenseSpecificationsForResourceCommand({
    ResourceArn: `arn:aws:ec2:${process.env.AWS_REGION}:${process.env.AWS_ACCOUNT_ID}:image/${amiId}`,
    AddLicenseSpecifications: [
      {
        LicenseConfigurationArn: licenseConfigArn,
      },
    ],
  }));
  
  console.log('License configuration associated successfully');
}

async function ensureLicenseAssociated(amiId, licenseConfigArn) {
  console.log(`Ensuring license ${licenseConfigArn} is associated with AMI ${amiId}`);
  
  try {
    const response = await licenseManager.send(new ListLicenseSpecificationsForResourceCommand({
      ResourceArn: `arn:aws:ec2:${process.env.AWS_REGION}:${process.env.AWS_ACCOUNT_ID}:image/${amiId}`,
    }));
    
    const hasLicense = response.LicenseSpecifications?.some(
      spec => spec.LicenseConfigurationArn === licenseConfigArn
    );
    
    if (!hasLicense) {
      console.log('License not found, associating...');
      await associateLicenseConfiguration(amiId, licenseConfigArn);
    } else {
      console.log('License already associated');
    }
  } catch (error) {
    console.log(`Error checking license, attempting to associate: ${error.message}`);
    await associateLicenseConfiguration(amiId, licenseConfigArn);
  }
}

async function tagAmi(amiId, sourceAmiId, macOSVersion, namePrefix) {
  const { EC2Client, CreateTagsCommand } = require('@aws-sdk/client-ec2');
  const ec2ForTags = new EC2Client();
  
  await ec2ForTags.send(new CreateTagsCommand({
    Resources: [amiId],
    Tags: [
      { Key: 'SourceAmiId', Value: sourceAmiId },
      { Key: 'MacOSVersion', Value: macOSVersion },
      { Key: 'Purpose', Value: 'Licensed-Parent-AMI-For-HRG' },
      { Key: 'ManagedBy', Value: namePrefix },
      { Key: 'Name', Value: `${namePrefix}-${macOSVersion}-Licensed-Parent` },
    ],
  }));
  
  console.log('AMI tagged successfully');
}

async function cleanupAmi(amiId) {
  console.log(`Cleaning up AMI ${amiId}`);
  
  // Get snapshot IDs before deregistering
  const describeResponse = await ec2.send(new DescribeImagesCommand({
    ImageIds: [amiId],
  }));
  
  const snapshotIds = [];
  if (describeResponse.Images && describeResponse.Images.length > 0) {
    const image = describeResponse.Images[0];
    for (const mapping of image.BlockDeviceMappings || []) {
      if (mapping.Ebs?.SnapshotId) {
        snapshotIds.push(mapping.Ebs.SnapshotId);
      }
    }
  }
  
  // Deregister the AMI
  await ec2.send(new DeregisterImageCommand({
    ImageId: amiId,
  }));
  console.log(`AMI ${amiId} deregistered`);
  
  // Delete associated snapshots
  for (const snapshotId of snapshotIds) {
    try {
      await ec2.send(new DeleteSnapshotCommand({
        SnapshotId: snapshotId,
      }));
      console.log(`Snapshot ${snapshotId} deleted`);
    } catch (error) {
      console.log(`Warning: Could not delete snapshot ${snapshotId}: ${error.message}`);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
