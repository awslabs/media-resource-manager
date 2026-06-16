// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const dynamoClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);
const secretsManager = new SecretsManagerClient({});

const PRIMARY_REGION = process.env.AWS_REGION;
const REGIONAL_HUBS_TABLE = process.env.REGIONAL_HUBS_TABLE_NAME;

/**
 * Generate a secure random password for ONTAP admin
 * Must meet ONTAP password requirements: 8-50 chars, at least one letter and one digit
 */
function generateOntapPassword() {
  const length = 24;
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const special = '!@#$%^&*';
  const allChars = lowercase + uppercase + digits + special;
  
  // Ensure at least one of each required type
  let password = '';
  password += lowercase[Math.floor(Math.random() * lowercase.length)];
  password += uppercase[Math.floor(Math.random() * uppercase.length)];
  password += digits[Math.floor(Math.random() * digits.length)];
  password += special[Math.floor(Math.random() * special.length)];
  
  // Fill the rest randomly
  for (let i = password.length; i < length; i++) {
    password += allChars[Math.floor(Math.random() * allChars.length)];
  }
  
  // Shuffle the password
  return password.split('').sort(() => Math.random() - 0.5).join('');
}

/**
 * Generate CloudFormation template for FSx for Windows File Server
 * AD credentials are passed as parameters (retrieved by Lambda) instead of using
 * {{resolve:secretsmanager:...}} dynamic references to avoid KMS permission issues
 */
function generateFsxWindowsTemplate(storageId, storageName, configuration, productName, adCredentials) {
  return {
    "AWSTemplateFormatVersion": "2010-09-09",
    "Description": `FSx for Windows File Server - Storage ID: ${storageId}`,
    "Parameters": {
      "SSDStorageCapacity": {
        "Type": "Number",
        "Default": configuration.ssdStorageCapacity,
        "MinValue": 32,
        "MaxValue": 65536
      },
      "ThroughputCapacity": {
        "Type": "Number",
        "Default": configuration.throughputCapacity,
        "AllowedValues": [32, 64, 128, 256, 512, 1024, 2048, 4608, 6144, 9216, 12288]
      },
      "AutomaticBackupRetentionPeriod": {
        "Type": "Number",
        "Default": configuration.automaticBackupRetentionPeriod,
        "MinValue": 1,
        "MaxValue": 90
      },
      "ProductName": {
        "Type": "String",
        "Default": productName
      },
      "StorageName": {
        "Type": "String",
        "Default": storageName,
        "Description": "Name of the storage resource"
      },
      "ADUsername": {
        "Type": "String",
        "Default": adCredentials.username,
        "NoEcho": true,
        "Description": "Active Directory service account username"
      },
      "ADPassword": {
        "Type": "String",
        "Default": adCredentials.password,
        "NoEcho": true,
        "Description": "Active Directory service account password"
      }
    },
    "Resources": {
      "FsxSecurityGroup": {
        "Type": "AWS::EC2::SecurityGroup",
        "Properties": {
          "GroupDescription": "Controls access to the Amazon FSx for Windows File Server",
          "VpcId": {
            "Fn::Join": ["", ["{{resolve:ssm:/", {"Ref": "ProductName"}, "/Network/VpcId}}"]]
          },
          "SecurityGroupIngress": [
            {
              "CidrIp": {"Fn::Join": ["", ["{{resolve:ssm:/", {"Ref": "ProductName"}, "/Network/VpcCidr}}"]]},
              "FromPort": 445,
              "IpProtocol": "tcp",
              "ToPort": 445
            },
            {
              "CidrIp": {"Fn::Join": ["", ["{{resolve:ssm:/", {"Ref": "ProductName"}, "/Network/VpcCidr}}"]]},
              "FromPort": 5985,
              "IpProtocol": "tcp",
              "ToPort": 5985
            }
          ],
          "SecurityGroupEgress": [
            {"CidrIp": "0.0.0.0/0", "FromPort": 53, "IpProtocol": "udp", "ToPort": 53},
            {"CidrIp": "0.0.0.0/0", "FromPort": 88, "IpProtocol": "udp", "ToPort": 88},
            {"CidrIp": "0.0.0.0/0", "FromPort": 123, "IpProtocol": "udp", "ToPort": 123},
            {"CidrIp": "0.0.0.0/0", "FromPort": 389, "IpProtocol": "udp", "ToPort": 389},
            {"CidrIp": "0.0.0.0/0", "FromPort": 464, "IpProtocol": "udp", "ToPort": 464},
            {"CidrIp": "0.0.0.0/0", "FromPort": 53, "IpProtocol": "tcp", "ToPort": 53},
            {"CidrIp": "0.0.0.0/0", "FromPort": 88, "IpProtocol": "tcp", "ToPort": 88},
            {"CidrIp": "0.0.0.0/0", "FromPort": 135, "IpProtocol": "tcp", "ToPort": 135},
            {"CidrIp": "0.0.0.0/0", "FromPort": 389, "IpProtocol": "tcp", "ToPort": 389},
            {"CidrIp": "0.0.0.0/0", "FromPort": 445, "IpProtocol": "tcp", "ToPort": 445},
            {"CidrIp": "0.0.0.0/0", "FromPort": 464, "IpProtocol": "tcp", "ToPort": 464},
            {"CidrIp": "0.0.0.0/0", "FromPort": 636, "IpProtocol": "tcp", "ToPort": 636},
            {"CidrIp": "0.0.0.0/0", "FromPort": 3268, "IpProtocol": "tcp", "ToPort": 3268},
            {"CidrIp": "0.0.0.0/0", "FromPort": 3269, "IpProtocol": "tcp", "ToPort": 3269},
            {"CidrIp": "0.0.0.0/0", "FromPort": 9389, "IpProtocol": "tcp", "ToPort": 9389},
            {"CidrIp": "0.0.0.0/0", "FromPort": 49152, "IpProtocol": "tcp", "ToPort": 65535}
          ]
        }
      },
      "FsxFileSystem": {
        "Type": "AWS::FSx::FileSystem",
        "Properties": {
          "FileSystemType": "WINDOWS",
          "StorageCapacity": {"Ref": "SSDStorageCapacity"},
          "SubnetIds": [
            {"Fn::Join": ["", ["{{resolve:ssm:/", {"Ref": "ProductName"}, "/Network/PrivateSubnet1/SubnetID}}"]]},
            {"Fn::Join": ["", ["{{resolve:ssm:/", {"Ref": "ProductName"}, "/Network/PrivateSubnet2/SubnetID}}"]]}
          ],
          "SecurityGroupIds": [{"Ref": "FsxSecurityGroup"}],
          "Tags": [{"Key": "Name", "Value": {"Ref": "StorageName"}}],
          "WindowsConfiguration": {
            "ThroughputCapacity": {"Ref": "ThroughputCapacity"},
            "AutomaticBackupRetentionDays": {"Ref": "AutomaticBackupRetentionPeriod"},
            "DeploymentType": "MULTI_AZ_1",
            "PreferredSubnetId": {"Fn::Join": ["", ["{{resolve:ssm:/", {"Ref": "ProductName"}, "/Network/PrivateSubnet1/SubnetID}}"]]},
            "WeeklyMaintenanceStartTime": "1:05:00",
            "SelfManagedActiveDirectoryConfiguration": {
              "DnsIps": [
                {"Fn::Join": ["", ["{{resolve:ssm:/", {"Ref": "ProductName"}, "/Identity/ActiveDirectoryServerIP1}}"]]},
                {"Fn::Join": ["", ["{{resolve:ssm:/", {"Ref": "ProductName"}, "/Identity/ActiveDirectoryServerIP2}}"]]}
              ],
              "DomainName": {"Fn::Join": ["", ["{{resolve:ssm:/", {"Ref": "ProductName"}, "/Identity/ActiveDirectoryDomainName}}"]]},
              "UserName": {"Ref": "ADUsername"},
              "Password": {"Ref": "ADPassword"}
            }
          }
        }
      }
    },
    "Outputs": {
      "FsxFileSystemId": {
        "Value": {"Ref": "FsxFileSystem"},
        "Description": "FSx File System ID"
      },
      "FsxDnsName": {
        "Value": {"Fn::GetAtt": ["FsxFileSystem", "DNSName"]},
        "Description": "FSx DNS Name"
      },
      "FsxResourceArn": {
        "Value": {"Fn::GetAtt": ["FsxFileSystem", "ResourceARN"]},
        "Description": "FSx Resource ARN"
      }
    }
  };
}


/**
 * Generate CloudFormation template for FSx for NetApp ONTAP
 * Creates: Security Group + Admin Secret + File System + SVM + Volume
 * Uses Workgroup mode (no Active Directory required)
 * 
 * @param regionalNetworkConfig - If provided, uses hardcoded values for regional hub.
 *                                If null, uses SSM dynamic references for primary region.
 */
function generateFsxOntapTemplate(storageId, storageName, configuration, productName, adminPassword, regionalNetworkConfig = null) {
  const haPairs = configuration.haPairs || 1;
  const throughputPerHaPair = configuration.throughputCapacityPerHaPair || 3072;
  const deploymentType = configuration.deploymentType || 'SINGLE_AZ_2';
  const isMultiAz = deploymentType === 'MULTI_AZ_1' || deploymentType === 'MULTI_AZ_2';
  
  // FlexGroup volumes have 8 constituents per HA pair
  // Minimum size per constituent is 100 GiB
  // So minimum volume size = 100 GiB * 8 * haPairs
  const constituentsPerHaPair = 8;
  const minSizePerConstituentGiB = 100;
  const minVolumeSizeGiB = minSizePerConstituentGiB * constituentsPerHaPair * haPairs;
  const requestedVolumeSizeGiB = configuration.volumeSize || 1024;
  const volumeSizeGiB = Math.max(requestedVolumeSizeGiB, minVolumeSizeGiB);
  // Convert GiB to MiB (1 GiB = 1024 MiB)
  const volumeSizeInMiB = volumeSizeGiB * 1024;
  
  if (requestedVolumeSizeGiB < minVolumeSizeGiB) {
    console.log(`Volume size adjusted from ${requestedVolumeSizeGiB} GiB to ${volumeSizeGiB} GiB to meet FlexGroup minimum (${minVolumeSizeGiB} GiB for ${haPairs} HA pairs)`);
  }
  
  // Sanitize storage name for ONTAP resources (only alphanumeric and underscores allowed)
  // Must start with letter or underscore, max 203 chars
  const sanitizedName = storageName.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 190);

  // Network configuration - use hardcoded values for regional hubs, SSM refs for primary
  let vpcIdRef, vpcCidrRef, subnetIds, preferredSubnetId;
  
  if (regionalNetworkConfig) {
    // Regional hub: use hardcoded values from DynamoDB
    console.log('Using hardcoded network config for regional hub');
    vpcIdRef = regionalNetworkConfig.vpcId;
    vpcCidrRef = regionalNetworkConfig.vpcCidr;
    subnetIds = isMultiAz ? [
      regionalNetworkConfig.privateSubnet1Id,
      regionalNetworkConfig.privateSubnet2Id
    ] : [
      regionalNetworkConfig.privateSubnet1Id
    ];
    preferredSubnetId = regionalNetworkConfig.privateSubnet1Id;
  } else {
    // Primary region: use SSM dynamic references
    console.log('Using SSM dynamic references for primary region');
    vpcIdRef = {"Fn::Join": ["", ["{{resolve:ssm:/", {"Ref": "ProductName"}, "/Network/VpcId}}"]]};
    vpcCidrRef = {"Fn::Join": ["", ["{{resolve:ssm:/", {"Ref": "ProductName"}, "/Network/VpcCidr}}"]]};
    subnetIds = isMultiAz ? [
      {"Fn::Join": ["", ["{{resolve:ssm:/", {"Ref": "ProductName"}, "/Network/PrivateSubnet1/SubnetID}}"]]},
      {"Fn::Join": ["", ["{{resolve:ssm:/", {"Ref": "ProductName"}, "/Network/PrivateSubnet2/SubnetID}}"]]}
    ] : [
      {"Fn::Join": ["", ["{{resolve:ssm:/", {"Ref": "ProductName"}, "/Network/PrivateSubnet1/SubnetID}}"]]}
    ];
    preferredSubnetId = {"Fn::Join": ["", ["{{resolve:ssm:/", {"Ref": "ProductName"}, "/Network/PrivateSubnet1/SubnetID}}"]]};
  }

  const ontapConfig = {
    "DeploymentType": {"Ref": "DeploymentType"},
    "AutomaticBackupRetentionDays": {"Ref": "AutomaticBackupRetentionDays"},
    "DailyAutomaticBackupStartTime": "05:00",
    "WeeklyMaintenanceStartTime": "1:05:00",
    "ThroughputCapacityPerHAPair": {"Ref": "ThroughputCapacityPerHaPair"},
    "FsxAdminPassword": {"Ref": "AdminPassword"}
  };

  if (deploymentType === 'SINGLE_AZ_2') {
    ontapConfig["HAPairs"] = {"Ref": "HaPairs"};
  }
  if (isMultiAz) {
    ontapConfig["PreferredSubnetId"] = preferredSubnetId;
  }

  return {
    "AWSTemplateFormatVersion": "2010-09-09",
    "Description": `FSx for NetApp ONTAP - Storage ID: ${storageId}`,
    "Parameters": {
      "StorageCapacity": {
        "Type": "Number",
        "Default": configuration.storageCapacity || (1024 * haPairs),
        "MinValue": 1024 * haPairs,
        "Description": "SSD storage capacity in GiB (minimum 1024 per HA pair)"
      },
      "ThroughputCapacityPerHaPair": {
        "Type": "Number",
        "Default": throughputPerHaPair,
        "AllowedValues": [128, 256, 512, 1024, 2048, 4096, 1536, 3072, 6144],
        "Description": "Throughput capacity per HA pair in MBps"
      },
      "HaPairs": {
        "Type": "Number",
        "Default": haPairs,
        "MinValue": 1,
        "MaxValue": 12,
        "Description": "Number of HA pairs (1-12 for SINGLE_AZ_2)"
      },
      "DeploymentType": {
        "Type": "String",
        "Default": deploymentType,
        "AllowedValues": ["SINGLE_AZ_1", "SINGLE_AZ_2", "MULTI_AZ_1", "MULTI_AZ_2"],
        "Description": "FSx ONTAP deployment type"
      },
      "AutomaticBackupRetentionDays": {
        "Type": "Number",
        "Default": configuration.backupRetention || 30,
        "MinValue": 0,
        "MaxValue": 90,
        "Description": "Days to retain automatic backups"
      },
      "VolumeSize": {
        "Type": "Number",
        "Default": volumeSizeInMiB,
        "MinValue": minVolumeSizeGiB * 1024,
        "Description": `Initial volume size in MiB (minimum ${minVolumeSizeGiB} GiB for ${haPairs} HA pairs)`
      },
      "SecurityStyle": {
        "Type": "String",
        "Default": "UNIX",
        "AllowedValues": ["UNIX", "NTFS", "MIXED"],
        "Description": "Volume security style - UNIX recommended for multi-protocol access without AD"
      },
      "ProductName": {
        "Type": "String",
        "Default": productName
      },
      "StorageName": {
        "Type": "String",
        "Default": storageName,
        "Description": "Name of the storage resource"
      },
      "SanitizedName": {
        "Type": "String",
        "Default": sanitizedName,
        "Description": "Sanitized name for ONTAP resources (alphanumeric and underscores only)"
      },
      "AdminPassword": {
        "Type": "String",
        "Default": adminPassword,
        "NoEcho": true,
        "Description": "Admin password for ONTAP file system and SVM (fsxadmin/vsadmin)"
      },
      "StorageId": {
        "Type": "String",
        "Default": storageId,
        "Description": "Storage resource ID for secret naming"
      }
    },
    "Resources": {
      "OntapAdminSecret": {
        "Type": "AWS::SecretsManager::Secret",
        "Properties": {
          "Name": {"Fn::Sub": "/${ProductName}/Storage/${StorageId}/OntapAdminCredentials"},
          "Description": {"Fn::Sub": "ONTAP admin credentials for ${StorageName}"},
          "SecretString": {"Fn::Sub": `{"fsxadminPassword":"\${AdminPassword}","vsadminPassword":"\${AdminPassword}","username":"fsxadmin","svmUsername":"vsadmin"}`},
          "Tags": [
            {"Key": "Name", "Value": {"Fn::Sub": "${StorageName}-ontap-credentials"}},
            {"Key": "StorageId", "Value": {"Ref": "StorageId"}}
          ]
        }
      },
      "FsxOntapSecurityGroup": {
        "Type": "AWS::EC2::SecurityGroup",
        "Properties": {
          "GroupDescription": "Controls access to FSx for NetApp ONTAP",
          "VpcId": vpcIdRef,
          "SecurityGroupIngress": [
            {"CidrIp": vpcCidrRef, "FromPort": 111, "IpProtocol": "tcp", "ToPort": 111},
            {"CidrIp": vpcCidrRef, "FromPort": 111, "IpProtocol": "udp", "ToPort": 111},
            {"CidrIp": vpcCidrRef, "FromPort": 635, "IpProtocol": "tcp", "ToPort": 635},
            {"CidrIp": vpcCidrRef, "FromPort": 635, "IpProtocol": "udp", "ToPort": 635},
            {"CidrIp": vpcCidrRef, "FromPort": 2049, "IpProtocol": "tcp", "ToPort": 2049},
            {"CidrIp": vpcCidrRef, "FromPort": 2049, "IpProtocol": "udp", "ToPort": 2049},
            {"CidrIp": vpcCidrRef, "FromPort": 4045, "IpProtocol": "tcp", "ToPort": 4046},
            {"CidrIp": vpcCidrRef, "FromPort": 4045, "IpProtocol": "udp", "ToPort": 4046},
            {"CidrIp": vpcCidrRef, "FromPort": 139, "IpProtocol": "tcp", "ToPort": 139},
            {"CidrIp": vpcCidrRef, "FromPort": 445, "IpProtocol": "tcp", "ToPort": 445},
            {"CidrIp": vpcCidrRef, "FromPort": 3260, "IpProtocol": "tcp", "ToPort": 3260},
            {"CidrIp": vpcCidrRef, "FromPort": 22, "IpProtocol": "tcp", "ToPort": 22},
            {"CidrIp": vpcCidrRef, "FromPort": 443, "IpProtocol": "tcp", "ToPort": 443}
          ],
          "SecurityGroupEgress": [
            {"CidrIp": "0.0.0.0/0", "IpProtocol": "-1"}
          ],
          "Tags": [{"Key": "Name", "Value": {"Fn::Sub": "${StorageName}-sg"}}]
        }
      },
      "FsxOntapFileSystem": {
        "Type": "AWS::FSx::FileSystem",
        "DependsOn": "OntapAdminSecret",
        "Properties": {
          "FileSystemType": "ONTAP",
          "StorageCapacity": {"Ref": "StorageCapacity"},
          "StorageType": "SSD",
          "SubnetIds": subnetIds,
          "SecurityGroupIds": [{"Ref": "FsxOntapSecurityGroup"}],
          "Tags": [{"Key": "Name", "Value": {"Ref": "StorageName"}}],
          "OntapConfiguration": ontapConfig
        }
      },
      "FsxOntapSvm": {
        "Type": "AWS::FSx::StorageVirtualMachine",
        "DependsOn": "FsxOntapFileSystem",
        "Properties": {
          "FileSystemId": {"Ref": "FsxOntapFileSystem"},
          "Name": {"Ref": "SanitizedName"},
          "SvmAdminPassword": {"Ref": "AdminPassword"},
          "RootVolumeSecurityStyle": {"Ref": "SecurityStyle"},
          "Tags": [{"Key": "Name", "Value": {"Fn::Sub": "${StorageName}-svm"}}]
        }
      },
      "FsxOntapVolume": {
        "Type": "AWS::FSx::Volume",
        "DependsOn": "FsxOntapSvm",
        "Properties": {
          "Name": {"Fn::Sub": "${SanitizedName}_vol1"},
          "VolumeType": "ONTAP",
          "OntapConfiguration": {
            "StorageVirtualMachineId": {"Ref": "FsxOntapSvm"},
            "JunctionPath": "/vol1",
            "SizeInMegabytes": {"Ref": "VolumeSize"},
            "SecurityStyle": {"Ref": "SecurityStyle"},
            "StorageEfficiencyEnabled": true,
            "TieringPolicy": {
              "Name": configuration.tieringPolicy || "AUTO",
              "CoolingPeriod": 31
            }
          },
          "Tags": [{"Key": "Name", "Value": {"Fn::Sub": "${StorageName}-vol1"}}]
        }
      }
    },
    "Outputs": {
      "FileSystemId": {
        "Value": {"Ref": "FsxOntapFileSystem"},
        "Description": "FSx ONTAP File System ID"
      },
      "FileSystemArn": {
        "Value": {"Fn::Sub": "arn:${AWS::Partition}:fsx:${AWS::Region}:${AWS::AccountId}:file-system/${FsxOntapFileSystem}"},
        "Description": "FSx ONTAP File System ARN"
      },
      "SvmId": {
        "Value": {"Ref": "FsxOntapSvm"},
        "Description": "Storage Virtual Machine ID"
      },
      "SvmArn": {
        "Value": {"Fn::GetAtt": ["FsxOntapSvm", "ResourceARN"]},
        "Description": "Storage Virtual Machine ARN"
      },
      "VolumeId": {
        "Value": {"Ref": "FsxOntapVolume"},
        "Description": "Volume ID"
      },
      "JunctionPath": {
        "Value": "/vol1",
        "Description": "Volume junction path for mounting"
      },
      "AdminSecretArn": {
        "Value": {"Ref": "OntapAdminSecret"},
        "Description": "ARN of the Secrets Manager secret containing ONTAP admin credentials"
      }
    }
  };
}


/**
 * Get network configuration for a region
 * - Primary region: Returns null (use SSM dynamic references in CloudFormation)
 * - Regional hubs: Looks up VPC/subnet info from DynamoDB and returns hardcoded values
 */
async function getRegionalNetworkConfig(region) {
  // Primary region uses SSM dynamic references
  if (!region || region === PRIMARY_REGION) {
    return null;
  }
  
  // Regional hubs: look up network config from DynamoDB
  if (!REGIONAL_HUBS_TABLE) {
    throw new Error('REGIONAL_HUBS_TABLE_NAME environment variable not set');
  }
  
  console.log(`Looking up network config for regional hub: ${region}`);
  
  const hubResult = await dynamodb.send(new GetCommand({
    TableName: REGIONAL_HUBS_TABLE,
    Key: { region }
  }));
  
  if (!hubResult.Item) {
    throw new Error(`Regional hub not found for region: ${region}`);
  }
  
  const hub = hubResult.Item;
  console.log(`Found regional hub: ${JSON.stringify(hub)}`);
  
  // Extract network configuration from hub record
  const networkConfig = {
    vpcId: hub.vpcId,
    vpcCidr: hub.vpcCidr,
    privateSubnet1Id: hub.privateSubnet1Id,
    privateSubnet2Id: hub.privateSubnet2Id,
    subnetIds: hub.subnetIds // comma-separated list
  };
  
  // Validate required fields
  if (!networkConfig.vpcId || !networkConfig.privateSubnet1Id) {
    throw new Error(`Regional hub ${region} missing required network configuration (vpcId, privateSubnet1Id)`);
  }
  
  console.log(`Regional network config: ${JSON.stringify(networkConfig)}`);
  return networkConfig;
}


/**
 * Retrieve AD credentials from Secrets Manager
 * Used for FSx Windows file systems that need to join a self-managed AD domain
 */
async function getAdCredentials(productName) {
  const secretName = `/${productName}/Identity/ResourceAdminActiveDirectoryLoginCredentials`;
  console.log(`Retrieving AD credentials from secret: ${secretName}`);
  
  try {
    const response = await secretsManager.send(new GetSecretValueCommand({
      SecretId: secretName
    }));
    
    const secret = JSON.parse(response.SecretString);
    console.log('Successfully retrieved AD credentials');
    
    return {
      username: secret.username,
      password: secret.password
    };
  } catch (error) {
    console.error(`Failed to retrieve AD credentials: ${error.message}`);
    throw new Error(`Failed to retrieve AD credentials from Secrets Manager: ${error.message}`);
  }
}


exports.handler = async (event) => {
  console.log('GenerateFsxTemplate received event:', JSON.stringify(event, null, 2));

  const { storageId, name, type, configuration, region } = event;
  console.log('Extracted values:', { storageId, name, type, configuration, region });

  const productName = process.env.PRODUCT_NAME;
  const acronym = process.env.ACRONYM;
  const stackName = `${acronym}-Storage-${storageId}`;
  
  // Get network configuration for the target region
  // Returns null for primary region (use SSM dynamic refs), or hardcoded values for regional hubs
  const regionalNetworkConfig = await getRegionalNetworkConfig(region);

  let template;
  let parameters;

  if (type === 'fsx-ontap') {
    // Generate a secure password for ONTAP admin access
    const adminPassword = generateOntapPassword();
    
    template = generateFsxOntapTemplate(storageId, name, configuration, productName, adminPassword, regionalNetworkConfig);
    // Sanitize name for ONTAP resources (only alphanumeric and underscores allowed)
    const sanitizedName = name.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 190);
    
    // Calculate minimum volume size for FlexGroup volumes
    // FlexGroup volumes have 8 constituents per HA pair, minimum 100 GiB per constituent
    const haPairs = configuration.haPairs || 1;
    const constituentsPerHaPair = 8;
    const minSizePerConstituentGiB = 100;
    const minVolumeSizeGiB = minSizePerConstituentGiB * constituentsPerHaPair * haPairs;
    const requestedVolumeSizeGiB = configuration.volumeSize || 1024;
    const volumeSizeGiB = Math.max(requestedVolumeSizeGiB, minVolumeSizeGiB);
    
    parameters = [
      { ParameterKey: 'StorageCapacity', ParameterValue: (configuration.storageCapacity || (1024 * (configuration.haPairs || 1))).toString() },
      { ParameterKey: 'ThroughputCapacityPerHaPair', ParameterValue: (configuration.throughputCapacityPerHaPair || 3072).toString() },
      { ParameterKey: 'HaPairs', ParameterValue: (configuration.haPairs || 1).toString() },
      { ParameterKey: 'DeploymentType', ParameterValue: configuration.deploymentType || 'SINGLE_AZ_2' },
      { ParameterKey: 'AutomaticBackupRetentionDays', ParameterValue: (configuration.backupRetention || 30).toString() },
      { ParameterKey: 'VolumeSize', ParameterValue: (volumeSizeGiB * 1024).toString() },
      { ParameterKey: 'SecurityStyle', ParameterValue: configuration.securityStyle || 'MIXED' },
      { ParameterKey: 'ProductName', ParameterValue: productName },
      { ParameterKey: 'StorageName', ParameterValue: name },
      { ParameterKey: 'SanitizedName', ParameterValue: sanitizedName },
      { ParameterKey: 'AdminPassword', ParameterValue: adminPassword },
      { ParameterKey: 'StorageId', ParameterValue: storageId }
    ];
  } else {
    // FSx Windows - retrieve AD credentials from Secrets Manager
    // This avoids KMS permission issues with CloudFormation's {{resolve:secretsmanager:...}} dynamic references
    const adCredentials = await getAdCredentials(productName);
    
    template = generateFsxWindowsTemplate(storageId, name, configuration, productName, adCredentials);
    parameters = [
      { ParameterKey: 'SSDStorageCapacity', ParameterValue: configuration.ssdStorageCapacity.toString() },
      { ParameterKey: 'ThroughputCapacity', ParameterValue: configuration.throughputCapacity.toString() },
      { ParameterKey: 'AutomaticBackupRetentionPeriod', ParameterValue: configuration.automaticBackupRetentionPeriod.toString() },
      { ParameterKey: 'ProductName', ParameterValue: productName },
      { ParameterKey: 'StorageName', ParameterValue: name },
      { ParameterKey: 'ADUsername', ParameterValue: adCredentials.username },
      { ParameterKey: 'ADPassword', ParameterValue: adCredentials.password }
    ];
  }

  return {
    storageId,
    stackName,
    template: JSON.stringify(template),
    parameters,
    region: region || PRIMARY_REGION
  };
};
