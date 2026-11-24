// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { SSMClient, SendCommandCommand, GetParameterCommand, DescribeInstanceInformationCommand } = require('@aws-sdk/client-ssm');
const { EC2Client, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
const {
    SecretsManagerClient,
    GetSecretValueCommand,
    CreateSecretCommand,
    PutSecretValueCommand,
    PutResourcePolicyCommand,
    DeleteSecretCommand,
} = require('@aws-sdk/client-secrets-manager');
const { FSxClient, DescribeStorageVirtualMachinesCommand } = require('@aws-sdk/client-fsx');
const { requireAdmin } = require('../shared/authz');
const { redactForLog } = require('../shared/log-redact');

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
const ACRONYM = process.env.ACRONYM || '';

const INSTANCE_ID_PATTERN = /^i-[0-9a-f]{8,17}$/;

function assertInstanceId(instanceId) {
    if (typeof instanceId !== 'string' || !INSTANCE_ID_PATTERN.test(instanceId)) {
        throw new Error('Invalid instanceId');
    }
}

// ==================== Per-workstation SMB mount secret ====================
// Standalone Windows workstations (and any workstation with FSx for ONTAP
// SMB storage) read the credentials their mounts need from their own secret
// at logon: /<ProductName>/Workstation/<instanceId>/SmbMount in the primary
// Region. The logon script and the Run Command carry only the secret ARN.

function mountSecretName(instanceId) {
    return `/${PASCAL_CASE_NAME}/Workstation/${instanceId}/SmbMount`;
}

// 15 s in all; the mount manager's timeout is 10 minutes.
const CREATE_SECRET_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isScheduledForDeletion(error) {
    return error.name === 'InvalidRequestException' && /scheduled for deletion/i.test(error.message || '');
}

/** IAM role ARN patterns of the primary and regional hub workstation roles. */
async function workstationRoleArnPatterns() {
    const param = await ssmPrimary.send(new GetParameterCommand({
        Name: `/${PASCAL_CASE_NAME}/DCV/InstanceRoleArn`
    }));
    const primaryRoleArn = param.Parameter.Value;
    const account = primaryRoleArn.split(':')[4];
    const patterns = [
        primaryRoleArn,
        `arn:aws:iam::${account}:role/${PASCAL_CASE_NAME}-Regional-Workstation-Role`,
        `arn:aws:iam::${account}:role/${PASCAL_CASE_NAME}-Regional-Workstation-Role-*`,
    ];
    if (ACRONYM) patterns.push(`arn:aws:iam::${account}:role/${ACRONYM}-Regional-Workstation-Role-*`);
    return patterns;
}

/**
 * Resource policy for a workstation's SMB mount secret: GetSecretValue is
 * denied to every caller except a workstation role session for this
 * instance. An EC2 instance role session's aws:userid is
 * "<role-id>:<instance-id>".
 */
function mountSecretPolicy(instanceId, roleArnPatterns) {
    return {
        Version: '2012-10-17',
        Statement: [
            {
                Sid: 'ReadOnlyFromThisWorkstation',
                Effect: 'Deny',
                Principal: '*',
                Action: 'secretsmanager:GetSecretValue',
                Resource: '*',
                Condition: { StringNotLike: { 'aws:userid': `*:${instanceId}` } },
            },
            {
                Sid: 'ReadOnlyWithAWorkstationRole',
                Effect: 'Deny',
                Principal: '*',
                Action: 'secretsmanager:GetSecretValue',
                Resource: '*',
                Condition: { ArnNotLike: { 'aws:PrincipalArn': roleArnPatterns } },
            },
        ],
    };
}

/**
 * Create or update the workstation's SMB mount secret and return its ARN.
 * A new secret starts with an empty value; the credentials are written only
 * after the resource policy is in place.
 *
 * A detach force-deletes the secret, and Secrets Manager removes it
 * asynchronously. Until it is gone, CreateSecret with the same name fails
 * with InvalidRequestException ("scheduled for deletion"), so an attach soon
 * after a detach retries until the name is free.
 */
async function putMountSecret(instanceId, mounts) {
    assertInstanceId(instanceId);
    const policy = JSON.stringify(mountSecretPolicy(instanceId, await workstationRoleArnPatterns()));
    let secretId = mountSecretName(instanceId);
    for (let attempt = 0; ; attempt++) {
        try {
            const created = await secretsManager.send(new CreateSecretCommand({
                Name: secretId,
                Description: `SMB mount credentials for workstation ${instanceId}, read by the workstation at logon`,
                SecretString: '{}',
            }));
            secretId = created.ARN;
            break;
        } catch (error) {
            if (error.name === 'ResourceExistsException') break;
            const delay = CREATE_SECRET_RETRY_DELAYS_MS[attempt];
            if (!isScheduledForDeletion(error) || delay === undefined) throw error;
            console.log(`SMB mount secret for ${instanceId} is still being deleted; retrying in ${delay / 1000} s`);
            await sleep(delay);
        }
    }
    await secretsManager.send(new PutResourcePolicyCommand({
        SecretId: secretId,
        ResourcePolicy: policy,
        BlockPublicPolicy: true,
    }));
    const put = await secretsManager.send(new PutSecretValueCommand({
        SecretId: secretId,
        SecretString: JSON.stringify({ version: 1, mounts }),
    }));
    return put.ARN;
}

/** Delete the workstation's SMB mount secret if it exists. */
async function deleteMountSecret(instanceId) {
    assertInstanceId(instanceId);
    try {
        await secretsManager.send(new DeleteSecretCommand({
            SecretId: mountSecretName(instanceId),
            ForceDeleteWithoutRecovery: true,
        }));
        console.log(`SMB mount secret deleted for ${instanceId}`);
    } catch (error) {
        if (error.name === 'ResourceNotFoundException') return;
        console.error(`Failed to delete the SMB mount secret for ${instanceId}:`, error.name, error.message);
    }
}

exports.handler = async (event) => {
    console.log('FSx Mount Manager Event:', JSON.stringify(redactForLog(event), null, 2));

    // SECURITY: not currently exposed via API Gateway; gate on admin only
    // if an authorizer context ever appears, as belt-and-suspenders in
    // case an API route is wired up later.
    // See H1-3966572 / GHSA-58q4-fcw9-2778 / SIM P498186948.
    if (event.requestContext?.authorizer) {
        const denial = requireAdmin(event);
        if (denial) return denial;
    }

    try {
        const { action, instanceId, storageId } = event;
        
        switch (action) {
            case 'updateInstance':
                assertInstanceId(instanceId);
                return await updateInstanceMountScript(instanceId);
            case 'removeInstance':
                // Workstation deleted: remove its SMB mount secret.
                await deleteMountSecret(instanceId);
                return { success: true, instanceId };
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

/**
 * Whether a Windows workstation is joined to the domain.
 *
 * New records store joinDomain. Records created before that have neither
 * joinDomain nor domainId: for those, compare the computer name SSM reports
 * for the instance with the AD domain name, and store the answer. If that is
 * not possible, use the deployment's creation default
 * (DEFAULT_WINDOWS_JOIN_DOMAIN: false with Cognito sign-in, where the console
 * creates standalone workstations, and true with AD sign-in, where it
 * creates domain-joined ones).
 */
async function resolveJoinDomain(workstation, workstationRegion) {
    if (typeof workstation.joinDomain === 'boolean') return workstation.joinDomain;
    if (workstation.domainId) return true;

    let joined = null;
    try {
        const domainParam = await ssmPrimary.send(new GetParameterCommand({
            Name: `/${PASCAL_CASE_NAME}/Identity/ActiveDirectoryDomainName`
        }));
        const domain = String(domainParam.Parameter?.Value || '').trim().toLowerCase();
        const info = await getSSMClient(workstationRegion).send(new DescribeInstanceInformationCommand({
            Filters: [{ Key: 'InstanceIds', Values: [workstation.instanceId] }]
        }));
        const computerName = info.InstanceInformationList?.[0]?.ComputerName;
        if (domain && computerName) {
            joined = String(computerName).trim().toLowerCase().endsWith(`.${domain}`);
        }
    } catch (error) {
        console.warn(`Could not look up domain membership for ${workstation.instanceId}:`, error.name, error.message);
    }

    if (joined === null) {
        const fallback = process.env.DEFAULT_WINDOWS_JOIN_DOMAIN === 'true';
        console.warn(`joinDomain not recorded for ${workstation.instanceId} and not determinable; using the deployment default (${fallback})`);
        return fallback;
    }

    // Record the answer so later mounts and starts use it.
    try {
        await dynamodb.send(new UpdateCommand({
            TableName: WORKSTATION_TABLE_NAME,
            Key: { instanceId: workstation.instanceId },
            UpdateExpression: 'SET joinDomain = :joinDomain',
            ConditionExpression: 'attribute_exists(instanceId) AND attribute_not_exists(joinDomain)',
            ExpressionAttributeValues: { ':joinDomain': joined }
        }));
        console.log(`Recorded joinDomain=${joined} for ${workstation.instanceId} from its computer name`);
    } catch (error) {
        console.warn(`Could not record joinDomain for ${workstation.instanceId}:`, error.name, error.message);
    }
    return joined;
}

async function updateInstanceMountScript(instanceId, attempt = 0) {
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
    const isDomainJoined = await resolveJoinDomain(workstation, workstationRegion);
    console.log(`Workstation ${instanceId} domain-joined: ${isDomainJoined}`);
    
    // Get storage configuration for this instance. If it changed while this
    // run was building the script, start over from the current record so the
    // latest configuration (and its secret) is what the workstation gets.
    let storageConfigs;
    try {
        storageConfigs = await getStorageForInstance(instanceId, workstation, isDomainJoined, workstationRegion);
    } catch (error) {
        if (error instanceof StaleStorageConfigError && attempt < 2) {
            return updateInstanceMountScript(instanceId, attempt + 1);
        }
        throw error;
    }
    
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
        await deleteMountSecret(instanceId);
        const loginScript = generateLoginScript([], isDomainJoined, null, {});
        await assertStorageConfigCurrent(instanceId, workstation.storageConfig);
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

            // Resolve the AD service-account secret via the mode-agnostic SSM
            // parameter populated by IdentityConstruct. In managed mode this
            // points at the MRM-created ResourceAdmin secret; in connector mode
            // it points at the customer-supplied secret ARN. Fall back to the
            // legacy well-known name for backward compat with deployments that
            // predate PR 3.
            let adSecretId;
            try {
                const arnParam = await ssmPrimary.send(new GetParameterCommand({
                    Name: `/${PASCAL_CASE_NAME}/Identity/AdServiceAccountSecretArn`
                }));
                adSecretId = arnParam.Parameter.Value;
            } catch (ssmErr) {
                console.warn(`AdServiceAccountSecretArn SSM param not found (${ssmErr.name}), using legacy secret name`);
                adSecretId = `/${PASCAL_CASE_NAME}/Identity/ResourceAdminActiveDirectoryLoginCredentials`;
            }

            const secretResponse = await secretsManager.send(new GetSecretValueCommand({
                SecretId: adSecretId
            }));
            credentials = JSON.parse(secretResponse.SecretString);

            console.log(`Retrieved AD credentials for non-domain workstation: ${credentials.username}@${domainName}`);
        } catch (error) {
            console.error('Failed to retrieve AD credentials for non-domain workstation:', error.name, error.message);
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
            
            // Use smbUser and smbPassword if available (set by configure-ontap-cifs Lambda).
            // Only the SMB user goes to the workstation; the ONTAP admin
            // credentials in the same secret never do.
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
    
    // Collect the credentials this workstation's mounts need. They go into the
    // workstation's own SMB mount secret; the logon script carries only the
    // secret ARN and reads it at logon.
    const mounts = {};
    for (const storage of storageConfigs) {
        if (storage.type === 'fsx-ontap') {
            const ontap = ontapCredentialsMap[storage.storageId];
            if (ontap) mounts[storage.storageId] = { username: ontap.username, password: ontap.password };
        } else if (!isDomainJoined && credentials && domainName) {
            mounts[storage.storageId] = { username: `${domainName}\\${credentials.username}`, password: credentials.password };
        }
    }

    let mountSecretArn = null;
    if (Object.keys(mounts).length > 0) {
        // If the secret can't be written, fail the run rather than send a
        // script whose mounts have no credentials. The workstation keeps its
        // current script, and the async invocation is retried.
        try {
            mountSecretArn = await putMountSecret(instanceId, mounts);
        } catch (error) {
            console.error(`Failed to write the SMB mount secret for ${instanceId}:`, error.name, error.message);
            throw new Error(`Could not write the SMB mount secret for ${instanceId}: ${error.name}`);
        }
        console.log(`SMB mount secret updated for ${instanceId}: ${Object.keys(mounts).length} mount(s)`);
    } else {
        await deleteMountSecret(instanceId);
    }
    const mountSecret = mountSecretArn
        ? { arn: mountSecretArn, region: process.env.AWS_REGION, storageIds: new Set(Object.keys(mounts)) }
        : null;

    // Non-secret ONTAP share details for the script (share name, CIFS server).
    const ontapShares = {};
    for (const [storageId, ontap] of Object.entries(ontapCredentialsMap)) {
        ontapShares[storageId] = { shareName: ontap.shareName, cifsServerName: ontap.cifsServerName };
    }

    const loginScript = generateLoginScript(storageConfigs, isDomainJoined, mountSecret, ontapShares);
    await assertStorageConfigCurrent(instanceId, workstation.storageConfig);
    await deployLoginScript(instanceId, loginScript, workstationRegion);
    
    return storageConfigs;
}

/**
 * Thrown when the workstation's storageConfig changed while a run was
 * building its script. Two saves start two runs that can overlap (for
 * example an attach that is waiting for a deleted secret's name and a later
 * detach), so the older run must not send its script last.
 */
class StaleStorageConfigError extends Error {}

// JSON with sorted keys, so two reads of the same map compare equal.
function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}

async function assertStorageConfigCurrent(instanceId, usedStorageConfig) {
    const current = await dynamodb.send(new GetCommand({ TableName: WORKSTATION_TABLE_NAME, Key: { instanceId } }));
    if (canonicalJson(current.Item?.storageConfig) !== canonicalJson(usedStorageConfig)) {
        console.log(`Storage configuration for ${instanceId} changed during this run; not sending its script`);
        throw new StaleStorageConfigError(`Storage configuration for ${instanceId} changed during the run`);
    }
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

/** Quote a value as a PowerShell single-quoted string literal. */
function psQuote(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Script lines that read this workstation's SMB mount secret at logon and
 * define Get-MountCredential, which returns a PSCredential for one storage.
 * The script holds only the secret ARN; the credentials stay in memory.
 */
function generateMountCredentialReader(mountSecret) {
    if (!mountSecret) {
        return `
$mountCredentials = $null`;
    }
    return `
# Read this workstation's SMB mount credentials from Secrets Manager with the
# instance role. Fastest first:
#   1. the AWS SDK for .NET assemblies that ship inside the AWSPowerShell
#      module, loaded directly (importing the whole module takes minutes the
#      first time);
#   2. the AWS CLI;
#   3. the modular AWS.Tools.SecretsManager module;
#   4. the AWSPowerShell module.
# The secret value stays in this process; only the ARN is on any command line.
$mountCredentials = $null
$secretString = $null
$secretArn = ${psQuote(mountSecret.arn)}
$secretRegion = ${psQuote(mountSecret.region)}
$readStart = Get-Date
$readClient = $null
# The AWSPowerShell folder on Amazon Windows AMIs; otherwise ask PowerShell.
$awsPowerShellBase = $null
if (\${env:ProgramFiles(x86)}) { $awsPowerShellBase = Join-Path \${env:ProgramFiles(x86)} 'AWS Tools\\PowerShell\\AWSPowerShell' }
if (-not ($awsPowerShellBase -and (Test-Path (Join-Path $awsPowerShellBase 'AWSSDK.SecretsManager.dll')))) {
    $awsPowerShellBase = (Get-Module -ListAvailable -Name AWSPowerShell | Sort-Object Version -Descending | Select-Object -First 1).ModuleBase
}
if ($awsPowerShellBase -and (Test-Path (Join-Path $awsPowerShellBase 'AWSSDK.SecretsManager.dll'))) {
    try {
        # Load only what the call needs, without enumerating types (Add-Type
        # does, and fails on dependencies it can't bind). The module's own
        # resolver (registered by its import) loads SDK dependencies such as
        # System.Text.Json from its folder whatever version is asked for;
        # register it the same way.
        [void][System.Reflection.Assembly]::LoadFrom((Join-Path $awsPowerShellBase 'AWSPowerShell.dll'))
        ([Amazon.PowerShell.Common.AWSModuleAssemblyInitializer]::new()).OnImport()
        [void][System.Reflection.Assembly]::LoadFrom((Join-Path $awsPowerShellBase 'AWSSDK.Core.dll'))
        [void][System.Reflection.Assembly]::LoadFrom((Join-Path $awsPowerShellBase 'AWSSDK.SecretsManager.dll'))
        $smClient = New-Object Amazon.SecretsManager.AmazonSecretsManagerClient([Amazon.RegionEndpoint]::GetBySystemName($secretRegion))
        $smRequest = New-Object Amazon.SecretsManager.Model.GetSecretValueRequest
        $smRequest.SecretId = $secretArn
        $smTask = $smClient.GetSecretValueAsync($smRequest)
        if (-not $smTask.Wait(15000)) { throw 'GetSecretValue did not finish within 15 s' }
        $secretString = $smTask.Result.SecretString
        $smClient.Dispose()
        $readClient = 'AWS SDK for .NET (AWSPowerShell assemblies)'
    } catch {
        $loadError = $_.Exception
        while ($loadError.InnerException -and -not ($loadError -is [System.Reflection.ReflectionTypeLoadException])) { $loadError = $loadError.InnerException }
        Add-Content -Path $logFile -Value "[$(Get-LogTime)] Could not read the SMB mount credentials with the AWS SDK for .NET after $([int]((Get-Date) - $readStart).TotalMilliseconds) ms, trying the next client: $($loadError.GetType().Name): $($loadError.Message)"
        if ($loadError -is [System.Reflection.ReflectionTypeLoadException]) {
            $loadError.LoaderExceptions | Where-Object { $_ } | Select-Object -First 3 | ForEach-Object {
                Add-Content -Path $logFile -Value "[$(Get-LogTime)]   Loader exception: $($_.Message)"
            }
        }
    }
}
if (-not $secretString) {
    try {
        if (Get-Command aws.exe -ErrorAction SilentlyContinue) {
            $readClient = 'AWS CLI'
            $secretOutput = & aws.exe secretsmanager get-secret-value --secret-id $secretArn --region $secretRegion --query SecretString --output text
            if ($LASTEXITCODE -ne 0) { throw "aws secretsmanager get-secret-value exited with code $LASTEXITCODE" }
            $secretString = ($secretOutput | Out-String).Trim()
            Remove-Variable -Name secretOutput
        } elseif (Get-Module -ListAvailable -Name AWS.Tools.SecretsManager) {
            $readClient = 'AWS.Tools.SecretsManager'
            Import-Module AWS.Tools.SecretsManager -ErrorAction Stop
            $secretString = (Get-SECSecretValue -SecretId $secretArn -Region $secretRegion -ErrorAction Stop).SecretString
        } else {
            $readClient = 'AWSPowerShell'
            Import-Module AWSPowerShell -ErrorAction Stop
            $secretString = (Get-SECSecretValue -SecretId $secretArn -Region $secretRegion -ErrorAction Stop).SecretString
        }
    } catch {
        Add-Content -Path $logFile -Value "[$(Get-LogTime)] ERROR: Could not read the SMB mount credentials: $($_.Exception.Message)"
    }
}
if ($secretString) {
    # The parser's error message can quote its input, so it is not logged.
    try { $mountCredentials = $secretString | ConvertFrom-Json } catch {
        Add-Content -Path $logFile -Value "[$(Get-LogTime)] ERROR: The SMB mount credentials are not valid JSON"
    }
    Remove-Variable -Name secretString
}
if ($mountCredentials) {
    Add-Content -Path $logFile -Value "[$(Get-LogTime)] Read the SMB mount credentials with $readClient in $([int]((Get-Date) - $readStart).TotalMilliseconds) ms"
}`;
}

function generateLoginScript(storageConfig, isDomainJoined, mountSecret, ontapShares = {}) {
    const hasMountCredential = (storageId) => !!(mountSecret && mountSecret.storageIds.has(storageId));
    const mountCommands = storageConfig.map(storage => {
        const driveLetter = storage.driveLetter || 'Z';
        
        // Handle FSxN storage type
        if (storage.type === 'fsx-ontap') {
            return generateFsxOntapMountCommand(storage, driveLetter, ontapShares[storage.storageId] || null, hasMountCredential(storage.storageId));
        }
        
        // Handle FSx Windows storage type
        const fsxDnsName = storage.fsxDnsName;
        const shareName = 'share';
        
        if (isDomainJoined) {
            // Domain-joined: use integrated Windows authentication
            return generateDomainJoinedMountCommand(storage, driveLetter, fsxDnsName, shareName);
        } else {
            // Non-domain-joined: credentials from the workstation's SMB mount secret
            return generateStandaloneMountCommand(storage, driveLetter, fsxDnsName, shareName, hasMountCredential(storage.storageId));
        }
    }).join('\n');

    return `# FSx Storage Mount Script - Auto-generated
# This script runs at user login to mount FSx file systems
# Generated on: $(Get-Date)
# Domain-joined: ${isDomainJoined}

# Set execution policy for this session
Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force

function Get-MountCredential([string]$StorageId) {
    if (-not $mountCredentials) { throw "SMB mount credentials are not available" }
    $entry = $mountCredentials.mounts.$StorageId
    if (-not $entry -or -not $entry.username -or -not $entry.password) { throw "No SMB mount credentials for storage $StorageId" }
    New-Object System.Management.Automation.PSCredential($entry.username, (ConvertTo-SecureString -String $entry.password -AsPlainText -Force))
}

# Log file. Each line gets the time it is written.
$logFile = "C:\\Windows\\Temp\\fsx-mount-log.txt"
function Get-LogTime { Get-Date -Format "yyyy-MM-dd HH:mm:ss" }

try {
    $mountErrors = 0
    Add-Content -Path $logFile -Value "[$(Get-LogTime)] Starting FSx mount for user: $env:USERNAME (Domain-joined: ${isDomainJoined})"
${generateMountCredentialReader(mountSecret)}
    
    # Clear any existing FSx network drive mappings to prevent conflicts
    Add-Content -Path $logFile -Value "[$(Get-LogTime)] Clearing existing FSx network drive mappings"
    $existingDrives = net use | Select-String "\\\\.*\\.(studio|fsx)\\." 
    foreach ($drive in $existingDrives) {
        $driveLetter = ($drive -split "\\s+")[1]
        if ($driveLetter -match "^[A-Z]:$") {
            net use $driveLetter /delete /y 2>$null
            Add-Content -Path $logFile -Value "[$(Get-LogTime)] Removed existing mapping: $driveLetter"
        }
    }
    
    ${mountCommands}
    
    if ($mountErrors -gt 0) {
        Add-Content -Path $logFile -Value "[$(Get-LogTime)] FSx mount completed with errors ($mountErrors failed) for user: $env:USERNAME"
    } else {
        Add-Content -Path $logFile -Value "[$(Get-LogTime)] FSx mount completed successfully for user: $env:USERNAME"
    }
    
    # Minimal refresh - just notify shell of drive changes (non-disruptive)
    Add-Content -Path $logFile -Value "[$(Get-LogTime)] Refreshing drive display"
    rundll32.exe shell32.dll,SHChangeNotify 0x8000000,0x1000,0,0
    
    Write-Host "FSx mount script completed. Check $logFile for details."
    
} catch {
    $errorMsg = "FSx mount script failed: $_"
    Add-Content -Path $logFile -Value "[$(Get-LogTime)] ERROR: $errorMsg"
    Write-Error $errorMsg
} finally {
    Remove-Variable -Name mountCredentials, mountCredential -ErrorAction SilentlyContinue
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
        $labelPath = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\MountPoints2\\$($networkPath.Replace('\\', '#'))"
        if (!(Test-Path $labelPath)) { New-Item -Path $labelPath -Force | Out-Null }
        Set-ItemProperty -Path $labelPath -Name "_LabelFromReg" -Value "${storage.name}"
        
        Write-Host "Successfully mounted ${storage.name} to ${driveLetter}: ($networkPath)"
        Add-Content -Path $logFile -Value "[$(Get-LogTime)] Successfully mounted ${storage.name} to ${driveLetter}:"
    } else {
        throw "net use failed with exit code $LASTEXITCODE"
    }
    
} catch {
    Write-Warning "Failed to mount ${storage.name} to ${driveLetter}: $_"
    $mountErrors++
    Add-Content -Path $logFile -Value "[$(Get-LogTime)] ERROR: Failed to mount ${storage.name}: $_"
}`;
}

/**
 * Mount one share with the credential for this storage from the
 * workstation's SMB mount secret. New-PSDrive -Persist maps the drive through
 * the Windows network provider (as net use does), so File Explorer shows it;
 * it runs in-process with the PSCredential, so no child process receives the
 * password as an argument, and no credential is saved.
 */
function generateCredentialMountCommand(storage, driveLetter, networkPath, modeLabel, logSuffix) {
    return `
# Mount ${storage.name} to ${driveLetter}: (${modeLabel})
try {
    $networkPath = "${networkPath}"
    $mountCredential = Get-MountCredential ${psQuote(storage.storageId)}
    
    # Remove existing mapping if it exists
    net use ${driveLetter}: /delete /y 2>$null
    
    New-PSDrive -Name "${driveLetter}" -PSProvider FileSystem -Root $networkPath -Credential $mountCredential -Persist -Scope Global -ErrorAction Stop | Out-Null
    
    # Fix "Disconnected Network Drive" display issue with comprehensive registry fix
    $regPath = "HKCU:\\Network\\${driveLetter}"
    if (!(Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
    Set-ItemProperty -Path $regPath -Name "RemotePath" -Value "$networkPath"
    Set-ItemProperty -Path $regPath -Name "UserName" -Value $mountCredential.UserName
    Set-ItemProperty -Path $regPath -Name "ProviderName" -Value "Microsoft Windows Network"
    Set-ItemProperty -Path $regPath -Name "ProviderType" -Value 0x20000 -Type DWord
    Set-ItemProperty -Path $regPath -Name "ConnectionType" -Value 1 -Type DWord
    Set-ItemProperty -Path $regPath -Name "DeferFlags" -Value 4 -Type DWord
    
    # Set custom label for network drive in Explorer
    $labelPath = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\MountPoints2\\$($networkPath.Replace('\\', '#'))"
    if (!(Test-Path $labelPath)) { New-Item -Path $labelPath -Force | Out-Null }
    Set-ItemProperty -Path $labelPath -Name "_LabelFromReg" -Value "${storage.name}"
    
    Write-Host "Successfully mounted ${storage.name}${logSuffix} to ${driveLetter}: ($networkPath)"
    Add-Content -Path $logFile -Value "[$(Get-LogTime)] Successfully mounted ${storage.name}${logSuffix} to ${driveLetter}:"
} catch {
    Write-Warning "Failed to mount ${storage.name}${logSuffix} to ${driveLetter}: $($_.Exception.Message)"
    $mountErrors++
    Add-Content -Path $logFile -Value "[$(Get-LogTime)] ERROR: Failed to mount ${storage.name}${logSuffix}: $($_.Exception.Message)"
} finally {
    Remove-Variable -Name mountCredential -ErrorAction SilentlyContinue
}`;
}

function generateStandaloneMountCommand(storage, driveLetter, fsxDnsName, shareName, hasMountCredential) {
    if (!hasMountCredential) {
        return `
# Mount ${storage.name} to ${driveLetter}: (Standalone - CREDENTIALS NOT AVAILABLE)
Write-Warning "Cannot mount ${storage.name} - AD credentials not configured for standalone workstation"
$mountErrors++
Add-Content -Path $logFile -Value "[$(Get-LogTime)] ERROR: Cannot mount ${storage.name} - AD credentials not available for standalone workstation"`;
    }
    return generateCredentialMountCommand(storage, driveLetter, `\\\\${fsxDnsName}\\${shareName}`,
        'Standalone - credentials from the workstation SMB mount secret', '');
}

/**
 * Generate mount command for FSx for NetApp ONTAP (SMB on Windows)
 * FSxN uses SVM DNS name and share name for mounting
 */
function generateFsxOntapMountCommand(storage, driveLetter, ontapShare, hasMountCredential) {
    // FSxN mount path: \\svm-dns-name\share-name
    const svmDnsName = storage.svmDnsName || storage.fsxDnsName;
    // Use share name from the ONTAP secret (set by configure-ontap-cifs), or fall back to vol1
    const shareName = ontapShare?.shareName || storage.shareName || 'vol1';
    
    if (!svmDnsName) {
        return `
# Mount ${storage.name} to ${driveLetter}: (FSxN - SVM DNS NAME NOT AVAILABLE)
Write-Warning "Cannot mount ${storage.name} - SVM DNS name not available"
$mountErrors++
Add-Content -Path $logFile -Value "[$(Get-LogTime)] ERROR: Cannot mount ${storage.name} - SVM DNS name not available"`;
    }
    
    // If the workstation's SMB mount secret holds the ONTAP SMB user, use it;
    // otherwise try without credentials (guest access)
    if (hasMountCredential) {
        return generateCredentialMountCommand(storage, driveLetter, `\\\\${svmDnsName}\\${shareName}`,
            'FSxN - ONTAP SMB user from the workstation SMB mount secret', ' (FSxN)');
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
        $labelPath = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\MountPoints2\\$($networkPath.Replace('\\', '#'))"
        if (!(Test-Path $labelPath)) { New-Item -Path $labelPath -Force | Out-Null }
        Set-ItemProperty -Path $labelPath -Name "_LabelFromReg" -Value "${storage.name}"
        
        Write-Host "Successfully mounted ${storage.name} (FSxN) to ${driveLetter}: ($networkPath)"
        Add-Content -Path $logFile -Value "[$(Get-LogTime)] Successfully mounted ${storage.name} (FSxN) to ${driveLetter}:"
    } else {
        throw "net use failed with exit code $LASTEXITCODE - credentials may be required"
    }
    
} catch {
    Write-Warning "Failed to mount ${storage.name} (FSxN) to ${driveLetter}: $_ - You may need to configure ONTAP credentials"
    $mountErrors++
    Add-Content -Path $logFile -Value "[$(Get-LogTime)] ERROR: Failed to mount ${storage.name} (FSxN): $_ - ONTAP credentials may be required"
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
                '# Queue a start that arrives while the task is running, so the latest',
                '# script always runs (the default ignores it). Then start the task to',
                '# mount for the signed-in user now; fail the command if it cannot start.',
                'try {',
                '    $task = Get-ScheduledTask -TaskName "FSxMountScript" -ErrorAction Stop',
                '    if ($task.Settings.MultipleInstances -ne "Queue") {',
                '        $task.Settings.MultipleInstances = "Queue"',
                '        Set-ScheduledTask -InputObject $task -ErrorAction Stop | Out-Null',
                '        Write-Host "Set the FSxMountScript task to queue new starts"',
                '    }',
                '    Start-ScheduledTask -TaskName "FSxMountScript" -ErrorAction Stop',
                '    Write-Host "Started the FSxMountScript task"',
                '} catch {',
                '    Write-Error "Could not start the FSxMountScript task: $($_.Exception.Message)"',
                '    exit 1',
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
