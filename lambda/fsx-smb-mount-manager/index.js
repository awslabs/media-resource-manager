// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { SSMClient, SendCommandCommand, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { EC2Client, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { FSxClient, DescribeStorageVirtualMachinesCommand } = require('@aws-sdk/client-fsx');

// DynamoDB client for primary region (workstation table is in primary region)
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

// Secrets Manager and SSM Parameter Store are in primary region (for AD credentials)
const secretsManager = new SecretsManagerClient({ region: process.env.AWS_REGION });
const ssmPrimary = new SSMClient({ region: process.env.AWS_REGION });

// Cache for regional clients
const ec2Clients = {};
const ssmClients = {};
const fsxClients = {};
const secretsManagerClients = {};

// Helper to get Secrets Manager client for specific region
function getSecretsManagerClient(region) {
    const targetRegion = region || process.env.AWS_REGION;
    if (!secretsManagerClients[targetRegion]) {
        secretsManagerClients[targetRegion] = new SecretsManagerClient({ region: targetRegion });
    }
    return secretsManagerClients[targetRegion];
}

// Helper to get EC2 client for specific region
function getEC2Client(region) {
    const targetRegion = region || process.env.AWS_REGION;
    if (!ec2Clients[targetRegion]) {
        ec2Clients[targetRegion] = new EC2Client({ region: targetRegion });
    }
    return ec2Clients[targetRegion];
}

// Helper to get SSM client for specific region
function getSSMClient(region) {
    const targetRegion = region || process.env.AWS_REGION;
    if (!ssmClients[targetRegion]) {
        ssmClients[targetRegion] = new SSMClient({ region: targetRegion });
    }
    return ssmClients[targetRegion];
}

// Helper to get FSx client for specific region
function getFSxClient(region) {
    const targetRegion = region || process.env.AWS_REGION;
    if (!fsxClients[targetRegion]) {
        fsxClients[targetRegion] = new FSxClient({ region: targetRegion });
    }
    return fsxClients[targetRegion];
}

const STORAGE_TABLE_NAME = process.env.STORAGE_TABLE_NAME;
const WORKSTATION_TABLE_NAME = process.env.WORKSTATION_TABLE_NAME;
const PASCAL_CASE_NAME = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';

exports.handler = async (event) => {
    console.log('FSx Mount Manager Event:', JSON.stringify(event, null, 2));
    
    try {
        const { action, instanceId, storageId } = event;
        
        switch (action) {
            case 'updateInstance':
                return await updateInstanceMountScript(instanceId);
            case 'updateStorage':
                return await updateStorageMountScripts(storageId);
            case 'updateAll':
                return await updateAllMountScripts();
            default:
                throw new Error(`Unknown action: ${action}`);
        }
        
    } catch (error) {
        console.error('Error in FSx Mount Manager:', error);
        throw error;
    }
};

async function updateInstanceMountScript(instanceId) {
    console.log(`Updating mount script for instance: ${instanceId}`);
    
    // Get workstation record to check domain status and platform
    const workstationParams = {
        TableName: WORKSTATION_TABLE_NAME,
        Key: { instanceId }
    };
    
    const workstationResult = await dynamodb.send(new GetCommand(workstationParams));
    const workstation = workstationResult.Item;
    
    if (!workstation) {
        console.log(`Workstation not found: ${instanceId}`);
        return { success: false, message: 'Workstation not found', instanceId };
    }
    
    // Get workstation region (may be in a spoke region)
    const workstationRegion = workstation.region || process.env.AWS_REGION;
    console.log(`Workstation ${instanceId} is in region: ${workstationRegion}`);
    
    // Check platform - FSx Windows mounts only work on Windows
    const platform = workstation.platform?.toLowerCase() || 'windows'; // Default to Windows for backward compatibility
    if (platform !== 'windows') {
        console.log(`Skipping FSx mount for non-Windows workstation: ${instanceId} (platform: ${platform})`);
        return { 
            success: true, 
            message: `FSx Windows mounts not supported on ${platform} workstations`, 
            instanceId,
            platform,
            skipped: true
        };
    }
    
    // Determine if workstation is domain-joined
    // Check joinDomain field first, then fall back to checking domainId
    const isDomainJoined = workstation.joinDomain !== false && (workstation.domainId || workstation.joinDomain === true);
    console.log(`Workstation ${instanceId} domain-joined: ${isDomainJoined}`);
    
    // Get storage configuration for this instance
    const storageConfigs = await getStorageForInstance(instanceId, workstation, isDomainJoined, workstationRegion);
    
    return {
        success: true,
        message: storageConfigs.length > 0 ? 
            `Mount script updated for ${storageConfigs.length} FSx volumes` : 
            'Mount script updated to clear all FSx volumes',
        instanceId,
        platform,
        region: workstationRegion,
        storageCount: storageConfigs.length,
        isDomainJoined
    };
}

async function updateStorageMountScripts(storageId) {
    console.log(`Updating mount scripts for storage: ${storageId}`);
    
    // Get storage configuration
    const storage = await getStorageById(storageId);
    if (!storage) {
        throw new Error(`Storage not found: ${storageId}`);
    }
    
    // Get all instances that use this storage
    const instances = storage.instances || [];
    const results = [];
    
    for (const instanceId of instances) {
        try {
            const result = await updateInstanceMountScript(instanceId);
            results.push(result);
        } catch (error) {
            console.error('Failed to update instance', instanceId + ':', error);
            results.push({
                success: false,
                instanceId,
                error: error.message
            });
        }
    }
    
    return {
        success: true,
        message: `Updated mount scripts for ${instances.length} instances`,
        storageId,
        results
    };
}

async function updateAllMountScripts() {
    console.log('Updating mount scripts for all instances with storage');
    
    // Get all running workstation instances
    const instances = await getAllWorkstationInstances();
    const results = [];
    
    for (const instance of instances) {
        try {
            const result = await updateInstanceMountScript(instance.instanceId);
            results.push(result);
        } catch (error) {
            console.error('Failed to update instance', instance.instanceId + ':', error);
            results.push({
                success: false,
                instanceId: instance.instanceId,
                error: error.message
            });
        }
    }
    
    return {
        success: true,
        message: `Updated mount scripts for ${instances.length} instances`,
        results
    };
}

async function getStorageForInstance(instanceId, workstation, isDomainJoined, workstationRegion) {
    if (!workstation.storageConfig) {
        // Generate empty script to clear any existing mounts
        const loginScript = generateLoginScript([], isDomainJoined, null, null);
        await deployLoginScript(instanceId, loginScript, workstationRegion);
        return [];
    }
    
    // Get storage details for each storage ID in the config
    const storageConfigs = [];
    for (const [storageId, config] of Object.entries(workstation.storageConfig)) {
        if (config.autoMount) {
            const storageParams = {
                TableName: STORAGE_TABLE_NAME,
                Key: { storageId }
            };
            
            const storageResult = await dynamodb.send(new GetCommand(storageParams));
            const storage = storageResult.Item;
            
            if (storage) {
                // Check if storage is in the same region as workstation
                const storageRegion = storage.region || process.env.AWS_REGION;
                if (storageRegion !== workstationRegion) {
                    console.log(`Skipping storage ${storageId} - different region (storage: ${storageRegion}, workstation: ${workstationRegion}). Cross-region mounts not supported.`);
                    continue;
                }
                // Parse parsedOutputs if it's a JSON string (contains svmId, junctionPath, etc.)
                let parsedOutputs = {};
                if (storage.parsedOutputs) {
                    try {
                        parsedOutputs = typeof storage.parsedOutputs === 'string' 
                            ? JSON.parse(storage.parsedOutputs) 
                            : storage.parsedOutputs;
                    } catch (e) {
                        console.warn('Failed to parse parsedOutputs for storage', storageId + ':', e);
                    }
                }
                
                // Get svmId from parsedOutputs or top-level field
                const svmId = storage.svmId || parsedOutputs.svmId;
                
                // For FSxN, we need to get the SVM DNS name for mounting
                // Storage is in the same region as the workstation
                let svmDnsName = null;
                if (storage.type === 'fsx-ontap' && svmId) {
                    try {
                        const fsx = getFSxClient(workstationRegion);
                        const svmResponse = await fsx.send(new DescribeStorageVirtualMachinesCommand({
                            StorageVirtualMachineIds: [svmId]
                        }));
                        const svm = svmResponse.StorageVirtualMachines?.[0];
                        // Use management endpoint as fallback if SMB endpoint not available
                        svmDnsName = svm?.Endpoints?.Smb?.DNSName || svm?.Endpoints?.Management?.DNSName;
                        console.log(`SVM ${svmId} DNS: smb=${svm?.Endpoints?.Smb?.DNSName}, mgmt=${svm?.Endpoints?.Management?.DNSName}, using=${svmDnsName}`);
                    } catch (error) {
                        console.error('Failed to get SVM DNS name for', svmId + ':', error);
                    }
                }
                
                storageConfigs.push({
                    ...storage,
                    storageId,
                    svmId,
                    driveLetter: config.driveLetter,
                    autoMount: config.autoMount,
                    shareName: config.shareName || storage.shareName || parsedOutputs.shareName || 'vol1',
                    svmDnsName: svmDnsName,
                    junctionPath: storage.junctionPath || config.junctionPath || parsedOutputs.junctionPath || '/vol1'
                });
            }
        }
    }
    
    // Get credentials and domain info for non-domain-joined workstations (FSx Windows)
    // For FSxN, we'll use ONTAP local user credentials from storage-specific secrets
    let credentials = null;
    let domainName = null;
    // Map of storageId -> ontapCredentials for FSxN storage
    const ontapCredentialsMap = {};
    
    // Check if we have any FSx Windows storage that needs AD credentials
    const hasFsxWindows = storageConfigs.some(s => s.type === 'fsx-windows');
    // Check if we have any FSxN storage that needs ONTAP credentials
    const fsxOntapStorages = storageConfigs.filter(s => s.type === 'fsx-ontap');
    
    if (!isDomainJoined && hasFsxWindows) {
        try {
            // Get domain name from SSM parameter (in primary region)
            const domainParam = await ssmPrimary.send(new GetParameterCommand({
                Name: `/${PASCAL_CASE_NAME}/Identity/ActiveDirectoryDomainName`
            }));
            domainName = domainParam.Parameter.Value;
            
            // Get credentials from Secrets Manager (using ResourceAdmin account)
            const secretResponse = await secretsManager.send(new GetSecretValueCommand({
                SecretId: `/${PASCAL_CASE_NAME}/Identity/ResourceAdminActiveDirectoryLoginCredentials`
            }));
            credentials = JSON.parse(secretResponse.SecretString);
            
            console.log(`Retrieved AD credentials for non-domain workstation: ${credentials.username}@${domainName}`);
        } catch (error) {
            console.error('Failed to retrieve AD credentials for non-domain workstation:', error);
        }
    }
    
    // Get ONTAP credentials for each FSxN storage from storage-specific secrets
    // Note: For regional storage, the secret is in the storage's region (created by CloudFormation)
    for (const storage of fsxOntapStorages) {
        try {
            // Get the storage's region - secrets are created in the same region as the storage
            const storageRegion = storage.region || process.env.AWS_REGION;
            const regionalSecretsManager = getSecretsManagerClient(storageRegion);
            
            // Try to get ONTAP credentials from storage-specific secret in the storage's region
            console.log(`Looking up ONTAP credentials for storage ${storage.storageId} in region ${storageRegion}`);
            const ontapSecretResponse = await regionalSecretsManager.send(new GetSecretValueCommand({
                SecretId: `/${PASCAL_CASE_NAME}/Storage/${storage.storageId}/OntapAdminCredentials`
            }));
            const ontapCreds = JSON.parse(ontapSecretResponse.SecretString);
            
            // Use smbUser and smbPassword if available (set by configure-ontap-cifs Lambda)
            if (ontapCreds.smbUser && ontapCreds.smbPassword) {
                ontapCredentialsMap[storage.storageId] = {
                    username: ontapCreds.smbUser,
                    password: ontapCreds.smbPassword,
                    cifsServerName: ontapCreds.cifsServerName,
                    shareName: ontapCreds.shareName || 'vol1'
                };
                console.log(`Retrieved ONTAP SMB credentials for storage ${storage.storageId} from ${storageRegion}: user=${ontapCreds.smbUser}`);
            } else {
                console.log(`ONTAP credentials found for ${storage.storageId} but no SMB user configured`);
            }
        } catch (error) {
            console.log(`ONTAP credentials not found for storage ${storage.storageId}, FSxN SMB mount may require manual setup: ${error.message}`);
        }
    }
    
    // Generate and deploy script - pass the credentials map for FSxN
    const loginScript = generateLoginScript(storageConfigs, isDomainJoined, credentials, domainName, ontapCredentialsMap);
    await deployLoginScript(instanceId, loginScript, workstationRegion);
    
    return storageConfigs;
}

async function getStorageById(storageId) {
    const params = {
        TableName: STORAGE_TABLE_NAME,
        Key: { storageId }
    };
    
    const result = await dynamodb.send(new GetCommand(params));
    return result.Item;
}

async function getAllWorkstationInstances() {
    const params = {
        TableName: WORKSTATION_TABLE_NAME,
        FilterExpression: '#status = :running',
        ExpressionAttributeNames: {
            '#status': 'status'
        },
        ExpressionAttributeValues: {
            ':running': 'running'
        }
    };
    
    const result = await dynamodb.send(new ScanCommand(params));
    return result.Items || [];
}

function generateLoginScript(storageConfig, isDomainJoined, credentials, domainName, ontapCredentialsMap = {}) {
    const mountCommands = storageConfig.map(storage => {
        const driveLetter = storage.driveLetter || 'Z';
        
        // Handle FSxN storage type
        if (storage.type === 'fsx-ontap') {
            // Get credentials for this specific storage
            const ontapCredentials = ontapCredentialsMap[storage.storageId] || null;
            return generateFsxOntapMountCommand(storage, driveLetter, ontapCredentials);
        }
        
        // Handle FSx Windows storage type
        const fsxDnsName = storage.fsxDnsName;
        const shareName = 'share';
        
        if (isDomainJoined) {
            // Domain-joined: use integrated Windows authentication
            return generateDomainJoinedMountCommand(storage, driveLetter, fsxDnsName, shareName);
        } else {
            // Non-domain-joined: use explicit credentials
            return generateStandaloneMountCommand(storage, driveLetter, fsxDnsName, shareName, credentials, domainName);
        }
    }).join('\n');

    return `# FSx Storage Mount Script - Auto-generated
# This script runs at user login to mount FSx file systems
# Generated on: $(Get-Date)
# Domain-joined: ${isDomainJoined}

# Set execution policy for this session
Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force

# Log file
$logFile = "C:\\Windows\\Temp\\fsx-mount-log.txt"
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

try {
    Add-Content -Path $logFile -Value "[$timestamp] Starting FSx mount for user: $env:USERNAME (Domain-joined: ${isDomainJoined})"
    
    # Clear any existing FSx network drive mappings to prevent conflicts
    Add-Content -Path $logFile -Value "[$timestamp] Clearing existing FSx network drive mappings"
    $existingDrives = net use | Select-String "\\\\.*\\.(studio|fsx)\\." 
    foreach ($drive in $existingDrives) {
        $driveLetter = ($drive -split "\\s+")[1]
        if ($driveLetter -match "^[A-Z]:$") {
            net use $driveLetter /delete /y 2>$null
            Add-Content -Path $logFile -Value "[$timestamp] Removed existing mapping: $driveLetter"
        }
    }
    
    ${mountCommands}
    
    Add-Content -Path $logFile -Value "[$timestamp] FSx mount completed successfully for user: $env:USERNAME"
    
    # Minimal refresh - just notify shell of drive changes (non-disruptive)
    Add-Content -Path $logFile -Value "[$timestamp] Refreshing drive display"
    rundll32.exe shell32.dll,SHChangeNotify 0x8000000,0x1000,0,0
    
    Write-Host "FSx mount script completed. Check $logFile for details."
    
} catch {
    $errorMsg = "FSx mount script failed: $_"
    Add-Content -Path $logFile -Value "[$timestamp] ERROR: $errorMsg"
    Write-Error $errorMsg
}
`;
}

function generateDomainJoinedMountCommand(storage, driveLetter, fsxDnsName, shareName) {
    return `
# Mount ${storage.name} to ${driveLetter}: (Domain-joined - using integrated auth)
try {
    $networkPath = "\\\\${fsxDnsName}\\${shareName}"
    
    # Remove existing mapping if it exists
    net use ${driveLetter}: /delete /y 2>$null
    
    # Mount using net use with integrated Windows authentication
    $result = net use ${driveLetter}: "$networkPath" /persistent:yes
    
    if ($LASTEXITCODE -eq 0) {
        # Fix "Disconnected Network Drive" display issue with comprehensive registry fix
        $regPath = "HKCU:\\Network\\${driveLetter}"
        if (!(Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
        Set-ItemProperty -Path $regPath -Name "RemotePath" -Value "$networkPath"
        Set-ItemProperty -Path $regPath -Name "UserName" -Value ""
        Set-ItemProperty -Path $regPath -Name "ProviderName" -Value "Microsoft Windows Network"
        Set-ItemProperty -Path $regPath -Name "ProviderType" -Value 0x20000 -Type DWord
        Set-ItemProperty -Path $regPath -Name "ConnectionType" -Value 1 -Type DWord
        Set-ItemProperty -Path $regPath -Name "DeferFlags" -Value 4 -Type DWord
        
        # Set custom label for network drive in Explorer
        $labelPath = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\MountPoints2\\##$($networkPath.Replace('\\', '#'))"
        if (!(Test-Path $labelPath)) { New-Item -Path $labelPath -Force | Out-Null }
        Set-ItemProperty -Path $labelPath -Name "_LabelFromReg" -Value "${storage.name}"
        
        Write-Host "Successfully mounted ${storage.name} to ${driveLetter}: ($networkPath)"
        Add-Content -Path $logFile -Value "[$timestamp] Successfully mounted ${storage.name} to ${driveLetter}:"
    } else {
        throw "net use failed with exit code $LASTEXITCODE"
    }
    
} catch {
    Write-Warning "Failed to mount ${storage.name} to ${driveLetter}: $_"
    Add-Content -Path $logFile -Value "[$timestamp] ERROR: Failed to mount ${storage.name}: $_"
}`;
}

function generateStandaloneMountCommand(storage, driveLetter, fsxDnsName, shareName, credentials, domainName) {
    if (!credentials || !domainName) {
        return `
# Mount ${storage.name} to ${driveLetter}: (Standalone - CREDENTIALS NOT AVAILABLE)
Write-Warning "Cannot mount ${storage.name} - AD credentials not configured for standalone workstation"
Add-Content -Path $logFile -Value "[$timestamp] ERROR: Cannot mount ${storage.name} - AD credentials not available for standalone workstation"`;
    }
    
    // For standalone workstations, we need to use explicit credentials
    // The credentials are embedded in the script - this is stored securely on the workstation
    const username = `${domainName}\\${credentials.username}`;
    
    // Escape password for PowerShell single-quoted string
    // In single-quoted strings, only single quotes need escaping (by doubling them)
    const escapedPassword = credentials.password.replace(/'/g, "''");
    
    return `
# Mount ${storage.name} to ${driveLetter}: (Standalone - using explicit credentials)
try {
    $networkPath = "\\\\${fsxDnsName}\\${shareName}"
    $username = "${username}"
    $password = '${escapedPassword}'
    
    # Remove existing mapping if it exists
    net use ${driveLetter}: /delete /y 2>$null
    
    # Mount using net use with explicit credentials
    $result = net use ${driveLetter}: "$networkPath" /user:$username $password /persistent:yes
    
    if ($LASTEXITCODE -eq 0) {
        # Fix "Disconnected Network Drive" display issue with comprehensive registry fix
        $regPath = "HKCU:\\Network\\${driveLetter}"
        if (!(Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
        Set-ItemProperty -Path $regPath -Name "RemotePath" -Value "$networkPath"
        Set-ItemProperty -Path $regPath -Name "UserName" -Value "$username"
        Set-ItemProperty -Path $regPath -Name "ProviderName" -Value "Microsoft Windows Network"
        Set-ItemProperty -Path $regPath -Name "ProviderType" -Value 0x20000 -Type DWord
        Set-ItemProperty -Path $regPath -Name "ConnectionType" -Value 1 -Type DWord
        Set-ItemProperty -Path $regPath -Name "DeferFlags" -Value 4 -Type DWord
        
        # Set custom label for network drive in Explorer
        $labelPath = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\MountPoints2\\##$($networkPath.Replace('\\', '#'))"
        if (!(Test-Path $labelPath)) { New-Item -Path $labelPath -Force | Out-Null }
        Set-ItemProperty -Path $labelPath -Name "_LabelFromReg" -Value "${storage.name}"
        
        Write-Host "Successfully mounted ${storage.name} to ${driveLetter}: ($networkPath) using explicit credentials"
        Add-Content -Path $logFile -Value "[$timestamp] Successfully mounted ${storage.name} to ${driveLetter}: (standalone mode)"
    } else {
        throw "net use failed with exit code $LASTEXITCODE"
    }
    
} catch {
    Write-Warning "Failed to mount ${storage.name} to ${driveLetter}: $_"
    Add-Content -Path $logFile -Value "[$timestamp] ERROR: Failed to mount ${storage.name}: $_"
}`;
}

/**
 * Generate mount command for FSx for NetApp ONTAP (SMB on Windows)
 * FSxN uses SVM DNS name and share name for mounting
 */
function generateFsxOntapMountCommand(storage, driveLetter, ontapCredentials) {
    // FSxN mount path: \\svm-dns-name\share-name
    const svmDnsName = storage.svmDnsName || storage.fsxDnsName;
    // Use share name from credentials (set by configure-ontap-cifs), or fall back to vol1
    const shareName = ontapCredentials?.shareName || storage.shareName || 'vol1';
    
    if (!svmDnsName) {
        return `
# Mount ${storage.name} to ${driveLetter}: (FSxN - SVM DNS NAME NOT AVAILABLE)
Write-Warning "Cannot mount ${storage.name} - SVM DNS name not available"
Add-Content -Path $logFile -Value "[$timestamp] ERROR: Cannot mount ${storage.name} - SVM DNS name not available"`;
    }
    
    // If we have ONTAP credentials, use them; otherwise try without credentials (guest access)
    if (ontapCredentials && ontapCredentials.username && ontapCredentials.password) {
        const escapedPassword = ontapCredentials.password.replace(/'/g, "''");
        
        return `
# Mount ${storage.name} to ${driveLetter}: (FSxN - using ONTAP local user)
try {
    $networkPath = "\\\\${svmDnsName}\\${shareName}"
    $username = "${ontapCredentials.username}"
    $password = '${escapedPassword}'
    
    # Remove existing mapping if it exists
    net use ${driveLetter}: /delete /y 2>$null
    
    # Mount using net use with ONTAP local user credentials
    $result = net use ${driveLetter}: "$networkPath" /user:$username $password /persistent:yes
    
    if ($LASTEXITCODE -eq 0) {
        # Fix "Disconnected Network Drive" display issue
        $regPath = "HKCU:\\Network\\${driveLetter}"
        if (!(Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
        Set-ItemProperty -Path $regPath -Name "RemotePath" -Value "$networkPath"
        Set-ItemProperty -Path $regPath -Name "UserName" -Value "$username"
        Set-ItemProperty -Path $regPath -Name "ProviderName" -Value "Microsoft Windows Network"
        Set-ItemProperty -Path $regPath -Name "ProviderType" -Value 0x20000 -Type DWord
        Set-ItemProperty -Path $regPath -Name "ConnectionType" -Value 1 -Type DWord
        Set-ItemProperty -Path $regPath -Name "DeferFlags" -Value 4 -Type DWord
        
        # Set custom label for network drive in Explorer
        $labelPath = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\MountPoints2\\##$($networkPath.Replace('\\', '#'))"
        if (!(Test-Path $labelPath)) { New-Item -Path $labelPath -Force | Out-Null }
        Set-ItemProperty -Path $labelPath -Name "_LabelFromReg" -Value "${storage.name}"
        
        Write-Host "Successfully mounted ${storage.name} (FSxN) to ${driveLetter}: ($networkPath)"
        Add-Content -Path $logFile -Value "[$timestamp] Successfully mounted ${storage.name} (FSxN) to ${driveLetter}:"
    } else {
        throw "net use failed with exit code $LASTEXITCODE"
    }
    
} catch {
    Write-Warning "Failed to mount ${storage.name} (FSxN) to ${driveLetter}: $_"
    Add-Content -Path $logFile -Value "[$timestamp] ERROR: Failed to mount ${storage.name} (FSxN): $_"
}`;
    } else {
        // Try without credentials - may work if guest access is enabled or user is prompted
        return `
# Mount ${storage.name} to ${driveLetter}: (FSxN - no stored credentials)
try {
    $networkPath = "\\\\${svmDnsName}\\${shareName}"
    
    # Remove existing mapping if it exists
    net use ${driveLetter}: /delete /y 2>$null
    
    # Try to mount - Windows may prompt for credentials or use cached credentials
    $result = net use ${driveLetter}: "$networkPath" /persistent:yes
    
    if ($LASTEXITCODE -eq 0) {
        # Fix "Disconnected Network Drive" display issue
        $regPath = "HKCU:\\Network\\${driveLetter}"
        if (!(Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
        Set-ItemProperty -Path $regPath -Name "RemotePath" -Value "$networkPath"
        Set-ItemProperty -Path $regPath -Name "UserName" -Value ""
        Set-ItemProperty -Path $regPath -Name "ProviderName" -Value "Microsoft Windows Network"
        Set-ItemProperty -Path $regPath -Name "ProviderType" -Value 0x20000 -Type DWord
        Set-ItemProperty -Path $regPath -Name "ConnectionType" -Value 1 -Type DWord
        Set-ItemProperty -Path $regPath -Name "DeferFlags" -Value 4 -Type DWord
        
        # Set custom label for network drive in Explorer
        $labelPath = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\MountPoints2\\##$($networkPath.Replace('\\', '#'))"
        if (!(Test-Path $labelPath)) { New-Item -Path $labelPath -Force | Out-Null }
        Set-ItemProperty -Path $labelPath -Name "_LabelFromReg" -Value "${storage.name}"
        
        Write-Host "Successfully mounted ${storage.name} (FSxN) to ${driveLetter}: ($networkPath)"
        Add-Content -Path $logFile -Value "[$timestamp] Successfully mounted ${storage.name} (FSxN) to ${driveLetter}:"
    } else {
        throw "net use failed with exit code $LASTEXITCODE - credentials may be required"
    }
    
} catch {
    Write-Warning "Failed to mount ${storage.name} (FSxN) to ${driveLetter}: $_ - You may need to configure ONTAP credentials"
    Add-Content -Path $logFile -Value "[$timestamp] ERROR: Failed to mount ${storage.name} (FSxN): $_ - ONTAP credentials may be required"
}`;
    }
}

async function deployLoginScript(instanceId, scriptContent, workstationRegion) {
    const ec2 = getEC2Client(workstationRegion);
    const ssm = getSSMClient(workstationRegion);
    
    // Check if instance is running
    const instanceInfo = await ec2.send(new DescribeInstancesCommand({
        InstanceIds: [instanceId]
    }));
    
    const instance = instanceInfo.Reservations[0]?.Instances[0];
    if (!instance || instance.State.Name !== 'running') {
        throw new Error(`Instance ${instanceId} is not running`);
    }
    
    const params = {
        DocumentName: 'AWS-RunPowerShellScript',
        InstanceIds: [instanceId],
        Parameters: {
            commands: [
                '# Deploy FSx Login Script',
                'if (-NOT ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {',
                '    Write-Error "This script requires Administrator privileges"',
                '    exit 1',
                '}',
                '',
                '# Create login script directory',
                '$scriptPath = "C:\\Windows\\System32\\GroupPolicy\\User\\Scripts\\Logon"',
                'if (!(Test-Path $scriptPath)) {',
                '    New-Item -Path $scriptPath -ItemType Directory -Force',
                '}',
                '',
                '# Write the FSx mount script',
                '$scriptFile = "$scriptPath\\MountFsxStorage.ps1"',
                `$scriptContent = @'`,
                scriptContent,
                `'@`,
                '$scriptContent | Out-File $scriptFile -Encoding UTF8',
                '',
                '# Trigger the scheduled task to run immediately for current user',
                'try {',
                '    Start-ScheduledTask -TaskName "FSxMountScript" -ErrorAction SilentlyContinue',
                '    Write-Host "Triggered FSx mount script to run immediately"',
                '} catch {',
                '    Write-Host "Could not trigger scheduled task (may not exist yet): $_"',
                '}',
                '',
                'Write-Host "FSx login script deployed successfully to $scriptFile"'
            ]
        },
        Comment: `Deploy FSx mount login script for instance ${instanceId}`
    };
    
    const result = await ssm.send(new SendCommandCommand(params));
    console.log(`SSM command sent to ${workstationRegion}: ${result.Command.CommandId}`);
    
    return result.Command.CommandId;
}
