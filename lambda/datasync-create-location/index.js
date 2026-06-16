// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { DataSyncClient, CreateLocationS3Command, CreateLocationFsxOntapCommand, CreateLocationFsxWindowsCommand } = require('@aws-sdk/client-datasync');
const { FSxClient, DescribeFileSystemsCommand, DescribeStorageVirtualMachinesCommand } = require('@aws-sdk/client-fsx');
const { EC2Client, DescribeNetworkInterfacesCommand } = require('@aws-sdk/client-ec2');
const crypto = require('crypto');
const { generateBucketPolicy } = require('./policy-generator');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

// Helper to get region-specific clients
const getRegionalClients = (region) => {
  const targetRegion = region || process.env.AWS_REGION;
  return {
    dataSyncClient: new DataSyncClient({ region: targetRegion }),
    fsxClient: new FSxClient({ region: targetRegion }),
    ec2Client: new EC2Client({ region: targetRegion })
  };
};

// Default clients for primary region (S3 locations)
const defaultClients = getRegionalClients(process.env.AWS_REGION);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

// Validate S3 bucket ARN format
const validateBucketArn = (arn) => {
  const arnRegex = /^arn:aws:s3:::[\w.-]+$/;
  return arnRegex.test(arn);
};

// Extract bucket name from ARN
const getBucketNameFromArn = (arn) => {
  const match = arn.match(/^arn:aws:s3:::(.+)$/);
  return match ? match[1] : null;
};

exports.handler = async (event) => {
  console.log('CreateDataSyncLocation event:', JSON.stringify(event, null, 2));
  
  try {
    const body = JSON.parse(event.body || '{}');
    const { name, type, s3Config, fsxConfig } = body;
    
    // Validate required fields
    if (!name || !type) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'Missing required fields: name and type are required'
        })
      };
    }
    
    // Validate type
    if (!['S3', 'FSX_ONTAP', 'FSX_WINDOWS'].includes(type)) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'Invalid location type. Must be S3, FSX_ONTAP, or FSX_WINDOWS'
        })
      };
    }
    
    const locationId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    let locationArn;
    let locationData = {
      pk: `LOCATION#${locationId}`,
      sk: 'METADATA',
      type: 'LOCATION',
      locationId,
      name,
      locationType: type,
      status: 'creating',
      createdAt: timestamp,
      updatedAt: timestamp
    };
    
    // Handle S3 location creation
    if (type === 'S3') {
      if (!s3Config || !s3Config.bucketArn) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({
            success: false,
            error: 'S3 configuration with bucketArn is required for S3 locations'
          })
        };
      }
      
      // Validate bucket ARN format
      if (!validateBucketArn(s3Config.bucketArn)) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({
            success: false,
            error: 'INVALID_ARN',
            message: 'The bucket ARN format is invalid. Expected format: arn:aws:s3:::bucket-name'
          })
        };
      }
      
      const bucketName = getBucketNameFromArn(s3Config.bucketArn);
      const isCrossAccount = s3Config.isCrossAccount || false;
      
      // For cross-account, generate and return the required bucket policy
      if (isCrossAccount) {
        const bucketPolicy = generateBucketPolicy(
          process.env.AWS_ACCOUNT_ID || process.env.AWS_REGION.split(':')[4],
          bucketName,
          process.env.DATASYNC_ROLE_ARN
        );
        locationData.generatedBucketPolicy = JSON.stringify(bucketPolicy);
      }
      
      try {
        const createLocationResponse = await defaultClients.dataSyncClient.send(new CreateLocationS3Command({
          S3BucketArn: s3Config.bucketArn,
          S3Config: {
            BucketAccessRoleArn: s3Config.bucketAccessRoleArn || process.env.DATASYNC_ROLE_ARN
          },
          Subdirectory: s3Config.subdirectory || '/'
        }));
        
        locationArn = createLocationResponse.LocationArn;
        locationData.locationArn = locationArn;
        locationData.bucketArn = s3Config.bucketArn;
        locationData.bucketAccessRoleArn = s3Config.bucketAccessRoleArn || process.env.DATASYNC_ROLE_ARN;
        locationData.isCrossAccount = isCrossAccount;
        locationData.subdirectory = s3Config.subdirectory || '/';
        locationData.status = 'available';
      } catch (dataSyncError) {
        console.error('DataSync CreateLocationS3 error:', dataSyncError);
        
        if (dataSyncError.name === 'InvalidRequestException' && dataSyncError.message.toLowerCase().includes('access denied')) {
          return {
            statusCode: 400,
            headers: corsHeaders,
            body: JSON.stringify({
              success: false,
              error: 'BUCKET_ACCESS_DENIED',
              message: 'Access denied to S3 bucket. For cross-account buckets, ensure the bucket policy grants access to the DataSync role.',
              bucketPolicy: isCrossAccount ? locationData.generatedBucketPolicy : undefined
            })
          };
        }
        
        throw dataSyncError;
      }
    }
    
    // Handle FSx ONTAP location creation
    else if (type === 'FSX_ONTAP') {
      if (!fsxConfig || !fsxConfig.storageId) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({
            success: false,
            error: 'FSx configuration with storageId is required for FSX_ONTAP locations'
          })
        };
      }
      
      // Get storage resource from storage table
      const storageResult = await dynamodb.send(new GetCommand({
        TableName: process.env.STORAGE_TABLE_NAME,
        Key: { storageId: fsxConfig.storageId }
      }));
      
      if (!storageResult.Item) {
        return {
          statusCode: 404,
          headers: corsHeaders,
          body: JSON.stringify({
            success: false,
            error: 'FSX_NOT_FOUND',
            message: 'The specified FSx file system was not found in the storage table.'
          })
        };
      }
      
      const storage = storageResult.Item;
      
      if (storage.status !== 'available') {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({
            success: false,
            error: 'FSX_NOT_AVAILABLE',
            message: 'The FSx file system is not in available status.'
          })
        };
      }
      
      // Get regional clients for the FSx file system's region
      const storageRegion = storage.region || process.env.AWS_REGION;
      const { dataSyncClient, fsxClient, ec2Client } = getRegionalClients(storageRegion);
      
      // Get SVM details for ONTAP
      const svmResult = await fsxClient.send(new DescribeStorageVirtualMachinesCommand({
        StorageVirtualMachineIds: [storage.svmId]
      }));
      
      if (!svmResult.StorageVirtualMachines || svmResult.StorageVirtualMachines.length === 0) {
        return {
          statusCode: 404,
          headers: corsHeaders,
          body: JSON.stringify({
            success: false,
            error: 'SVM_NOT_FOUND',
            message: 'The storage virtual machine was not found.'
          })
        };
      }
      
      const svm = svmResult.StorageVirtualMachines[0];
      
      // Get FSx file system details to get network interfaces
      const fsxResult = await fsxClient.send(new DescribeFileSystemsCommand({
        FileSystemIds: [storage.fsxFileSystemId]
      }));
      
      if (!fsxResult.FileSystems || fsxResult.FileSystems.length === 0) {
        return {
          statusCode: 404,
          headers: corsHeaders,
          body: JSON.stringify({
            success: false,
            error: 'FSX_NOT_FOUND',
            message: 'The FSx file system was not found in AWS.'
          })
        };
      }
      
      const fileSystem = fsxResult.FileSystems[0];
      
      // Get security groups from the file system's network interfaces
      let finalSgArns = [];
      
      // First try to get from storage record
      if (storage.securityGroupId) {
        finalSgArns = [`arn:aws:ec2:${storageRegion}:${process.env.AWS_ACCOUNT_ID}:security-group/${storage.securityGroupId}`];
      }
      
      // Try parsedOutputs
      if (finalSgArns.length === 0 && storage.parsedOutputs) {
        try {
          const outputs = typeof storage.parsedOutputs === 'string' 
            ? JSON.parse(storage.parsedOutputs) 
            : storage.parsedOutputs;
          if (outputs.securityGroupId) {
            finalSgArns = [`arn:aws:ec2:${storageRegion}:${process.env.AWS_ACCOUNT_ID}:security-group/${outputs.securityGroupId}`];
          }
        } catch (e) {
          console.warn('Could not parse storage outputs:', e);
        }
      }
      
      // If still no security groups, look them up from the FSx network interfaces
      if (finalSgArns.length === 0 && fileSystem.NetworkInterfaceIds && fileSystem.NetworkInterfaceIds.length > 0) {
        try {
          const eniResult = await ec2Client.send(new DescribeNetworkInterfacesCommand({
            NetworkInterfaceIds: fileSystem.NetworkInterfaceIds
          }));
          
          // Collect unique security group IDs from all network interfaces
          const sgIds = new Set();
          for (const eni of (eniResult.NetworkInterfaces || [])) {
            for (const sg of (eni.Groups || [])) {
              sgIds.add(sg.GroupId);
            }
          }
          
          finalSgArns = Array.from(sgIds).map(
            sgId => `arn:aws:ec2:${storageRegion}:${process.env.AWS_ACCOUNT_ID}:security-group/${sgId}`
          );
          console.log('Found security groups from ENIs:', finalSgArns);
        } catch (e) {
          console.warn('Could not get security groups from network interfaces:', e);
        }
      }
      
      // If still no security groups, return error
      if (finalSgArns.length === 0) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({
            success: false,
            error: 'NO_SECURITY_GROUP',
            message: 'Could not determine security group for FSx file system. The file system may not have network interfaces configured.'
          })
        };
      }
      
      // Create DataSync location for FSx ONTAP using NFS protocol
      const createLocationResponse = await dataSyncClient.send(new CreateLocationFsxOntapCommand({
        StorageVirtualMachineArn: svm.ResourceARN,
        SecurityGroupArns: finalSgArns,
        Protocol: {
          NFS: {
            MountOptions: {
              Version: 'NFS3'
            }
          }
        },
        Subdirectory: fsxConfig.subdirectory || storage.junctionPath || '/vol1'
      }));
      
      locationArn = createLocationResponse.LocationArn;
      locationData.locationArn = locationArn;
      locationData.storageId = fsxConfig.storageId;
      locationData.fsxFileSystemArn = storage.fsxResourceArn;
      locationData.svmArn = svm.ResourceARN;
      locationData.subdirectory = fsxConfig.subdirectory || storage.junctionPath || '/vol1';
      locationData.region = storageRegion;
      locationData.status = 'available';
    }
    
    // Handle FSx Windows location creation
    else if (type === 'FSX_WINDOWS') {
      if (!fsxConfig || !fsxConfig.storageId) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({
            success: false,
            error: 'FSx configuration with storageId is required for FSX_WINDOWS locations'
          })
        };
      }
      
      // Get storage resource from storage table
      const storageResult = await dynamodb.send(new GetCommand({
        TableName: process.env.STORAGE_TABLE_NAME,
        Key: { storageId: fsxConfig.storageId }
      }));
      
      if (!storageResult.Item) {
        return {
          statusCode: 404,
          headers: corsHeaders,
          body: JSON.stringify({
            success: false,
            error: 'FSX_NOT_FOUND',
            message: 'The specified FSx file system was not found in the storage table.'
          })
        };
      }
      
      const storage = storageResult.Item;
      
      if (storage.status !== 'available') {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({
            success: false,
            error: 'FSX_NOT_AVAILABLE',
            message: 'The FSx file system is not in available status.'
          })
        };
      }
      
      // Get regional clients for the FSx file system's region
      const storageRegion = storage.region || process.env.AWS_REGION;
      const { dataSyncClient, fsxClient } = getRegionalClients(storageRegion);
      
      // Get FSx Windows file system details
      const fsxResult = await fsxClient.send(new DescribeFileSystemsCommand({
        FileSystemIds: [storage.fsxFileSystemId]
      }));
      
      if (!fsxResult.FileSystems || fsxResult.FileSystems.length === 0) {
        return {
          statusCode: 404,
          headers: corsHeaders,
          body: JSON.stringify({
            success: false,
            error: 'FSX_NOT_FOUND',
            message: 'The FSx file system was not found in AWS.'
          })
        };
      }
      
      const fileSystem = fsxResult.FileSystems[0];
      
      // Get security groups - first try WindowsConfiguration, then fall back to network interfaces
      const { ec2Client } = getRegionalClients(storageRegion);
      let finalSgArns = [];
      
      // First try to get from storage record
      if (storage.securityGroupId) {
        finalSgArns = [`arn:aws:ec2:${storageRegion}:${process.env.AWS_ACCOUNT_ID}:security-group/${storage.securityGroupId}`];
      }
      
      // Try parsedOutputs
      if (finalSgArns.length === 0 && storage.parsedOutputs) {
        try {
          const outputs = typeof storage.parsedOutputs === 'string' 
            ? JSON.parse(storage.parsedOutputs) 
            : storage.parsedOutputs;
          if (outputs.securityGroupId) {
            finalSgArns = [`arn:aws:ec2:${storageRegion}:${process.env.AWS_ACCOUNT_ID}:security-group/${outputs.securityGroupId}`];
          }
        } catch (e) {
          console.warn('Could not parse storage outputs:', e);
        }
      }
      
      // Try WindowsConfiguration.SecurityGroupIds
      if (finalSgArns.length === 0 && fileSystem.WindowsConfiguration?.SecurityGroupIds?.length > 0) {
        finalSgArns = fileSystem.WindowsConfiguration.SecurityGroupIds.map(
          sgId => `arn:aws:ec2:${storageRegion}:${process.env.AWS_ACCOUNT_ID}:security-group/${sgId}`
        );
      }
      
      // If still no security groups, look them up from the FSx network interfaces
      if (finalSgArns.length === 0 && fileSystem.NetworkInterfaceIds && fileSystem.NetworkInterfaceIds.length > 0) {
        try {
          const eniResult = await ec2Client.send(new DescribeNetworkInterfacesCommand({
            NetworkInterfaceIds: fileSystem.NetworkInterfaceIds
          }));
          
          // Collect unique security group IDs from all network interfaces
          const sgIds = new Set();
          for (const eni of (eniResult.NetworkInterfaces || [])) {
            for (const sg of (eni.Groups || [])) {
              sgIds.add(sg.GroupId);
            }
          }
          
          finalSgArns = Array.from(sgIds).map(
            sgId => `arn:aws:ec2:${storageRegion}:${process.env.AWS_ACCOUNT_ID}:security-group/${sgId}`
          );
          console.log('Found security groups from ENIs for FSx Windows:', finalSgArns);
        } catch (e) {
          console.warn('Could not get security groups from network interfaces:', e);
        }
      }
      
      // If still no security groups, return error
      if (finalSgArns.length === 0) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({
            success: false,
            error: 'NO_SECURITY_GROUP',
            message: 'Could not determine security group for FSx Windows file system. The file system may not have network interfaces configured.'
          })
        };
      }
      
      // Get AD credentials from Secrets Manager and domain from SSM
      const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
      const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
      const ssmClient = new SSMClient({ region: process.env.AWS_REGION });
      const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION });
      
      let smbUser, smbPassword, smbDomain;
      try {
        // Get domain name from SSM
        const domainParam = await ssmClient.send(new GetParameterCommand({
          Name: process.env.AD_DOMAIN_PARAMETER_NAME
        }));
        smbDomain = domainParam.Parameter?.Value;
        
        // Get credentials from Secrets Manager
        const secretResponse = await secretsClient.send(new GetSecretValueCommand({
          SecretId: process.env.AD_CREDENTIALS_SECRET_ARN
        }));
        const credentials = JSON.parse(secretResponse.SecretString);
        smbUser = credentials.username;
        smbPassword = credentials.password;
      } catch (credError) {
        console.error('Error fetching AD credentials:', credError);
        return {
          statusCode: 500,
          headers: corsHeaders,
          body: JSON.stringify({
            success: false,
            error: 'CREDENTIALS_ERROR',
            message: 'Failed to retrieve Active Directory credentials. Ensure the AD is configured.'
          })
        };
      }
      
      // Create DataSync location for FSx Windows
      const createLocationResponse = await dataSyncClient.send(new CreateLocationFsxWindowsCommand({
        FsxFilesystemArn: fileSystem.ResourceARN,
        SecurityGroupArns: finalSgArns,
        Subdirectory: fsxConfig.subdirectory || '/share',
        User: smbUser,
        Password: smbPassword,
        Domain: smbDomain
      }));
      
      locationArn = createLocationResponse.LocationArn;
      locationData.locationArn = locationArn;
      locationData.storageId = fsxConfig.storageId;
      locationData.fsxFileSystemArn = fileSystem.ResourceARN;
      locationData.subdirectory = fsxConfig.subdirectory || '/share';
      locationData.region = storageRegion;
      locationData.status = 'available';
    }
    
    // Store location in DynamoDB
    await dynamodb.send(new PutCommand({
      TableName: process.env.DATASYNC_TABLE_NAME,
      Item: locationData
    }));
    
    console.log('Location created successfully:', locationId);
    
    return {
      statusCode: 201,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        data: {
          locationId,
          locationArn,
          type,
          name,
          status: locationData.status,
          createdAt: timestamp,
          // Include bucket policy for cross-account S3
          bucketPolicy: locationData.generatedBucketPolicy ? JSON.parse(locationData.generatedBucketPolicy) : undefined
        }
      })
    };
  } catch (error) {
    console.error('Error creating DataSync location:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'DATASYNC_ERROR',
        message: 'Failed to create DataSync location. Please try again.',
        details: error.message
      })
    };
  }
};
