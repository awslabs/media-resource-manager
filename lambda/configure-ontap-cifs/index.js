// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { Client } = require('ssh2');
const https = require('https');
const { SecretsManagerClient, GetSecretValueCommand, UpdateSecretCommand } = require('@aws-sdk/client-secrets-manager');
const { FSxClient, DescribeStorageVirtualMachinesCommand } = require('@aws-sdk/client-fsx');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');

const secretsManager = new SecretsManagerClient();
const fsx = new FSxClient();
const lambdaClient = new LambdaClient();
const dynamoClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

const PASCAL_CASE_NAME = process.env.PASCAL_CASE_NAME || 'AMCCloudEditManager';
const ACRONYM = process.env.ACRONYM || 'acem';
const PRIMARY_REGION = process.env.AWS_REGION;
const REGIONAL_HUBS_TABLE = process.env.REGIONAL_HUBS_TABLE_NAME;

/**
 * Check if a region has a regional hub with the configure-ontap-cifs Lambda deployed
 * Returns the Lambda ARN if available, null otherwise
 */
async function getRegionalOntapConfigLambda(region) {
  if (!region || region === PRIMARY_REGION || !REGIONAL_HUBS_TABLE) {
    return null;
  }
  
  try {
    const hubResult = await dynamodb.send(new GetCommand({
      TableName: REGIONAL_HUBS_TABLE,
      Key: { region }
    }));
    
    if (!hubResult.Item || hubResult.Item.status !== 'available') {
      return null;
    }
    
    // Check if the regional hub has the configure-ontap-cifs Lambda
    // The Lambda ARN follows the pattern: arn:aws:lambda:{region}:{account}:function:{acronym}-regional-configure-ontap-cifs
    const accountId = process.env.AWS_ACCOUNT_ID || hubResult.Item.accountId;
    if (!accountId) {
      console.log('Cannot determine AWS account ID for regional Lambda invocation');
      return null;
    }
    
    return `arn:aws:lambda:${region}:${accountId}:function:${ACRONYM.toLowerCase()}-regional-configure-ontap-cifs`;
  } catch (error) {
    console.error('Error checking regional hub:', error);
    return null;
  }
}

/**
 * Invoke the regional configure-ontap-cifs Lambda
 * This is used when storage is in a satellite region and we need to
 * route the request to the Lambda in that region (which has VPC access)
 */
async function invokeRegionalLambda(region, event) {
  const regionalFunctionArn = await getRegionalOntapConfigLambda(region);
  
  if (!regionalFunctionArn) {
    console.log(`No regional configure-ontap-cifs Lambda available for region ${region}`);
    return null;
  }
  
  console.log(`Routing ONTAP configuration to regional Lambda: ${regionalFunctionArn}`);
  
  const regionalLambdaClient = new LambdaClient({ region });
  
  const response = await regionalLambdaClient.send(new InvokeCommand({
    FunctionName: regionalFunctionArn,
    InvocationType: 'RequestResponse',
    Payload: JSON.stringify({
      ...event,
      isRegionalInvocation: true // Prevent infinite routing loops
    })
  }));
  
  const responsePayload = JSON.parse(Buffer.from(response.Payload).toString());
  console.log('Regional Lambda response:', JSON.stringify(responsePayload));
  
  return responsePayload;
}

/**
 * Generate a secure random password for CIFS local user
 * Must meet ONTAP password requirements:
 * - At least 6 characters
 * - Characters from 3 of 4 categories: uppercase, lowercase, digits, special
 */
function generatePassword() {
    const length = 16;
    const lowercase = 'abcdefghijklmnopqrstuvwxyz';
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const digits = '0123456789';
    const special = '!@#$%^&*';
    
    let password = '';
    // Ensure at least one from each required category
    password += lowercase[Math.floor(Math.random() * lowercase.length)];
    password += uppercase[Math.floor(Math.random() * uppercase.length)];
    password += digits[Math.floor(Math.random() * digits.length)];
    password += special[Math.floor(Math.random() * special.length)];
    
    // Fill the rest with mixed characters
    const allChars = lowercase + uppercase + digits + special;
    for (let i = password.length; i < length; i++) {
        password += allChars[Math.floor(Math.random() * allChars.length)];
    }
    
    // Shuffle the password
    return password.split('').sort(() => Math.random() - 0.5).join('');
}

/**
 * Make ONTAP REST API call
 */
function ontapRestCall(host, username, password, method, path, body = null) {
    return new Promise((resolve, reject) => {
        const auth = Buffer.from(`${username}:${password}`).toString('base64');
        
        // nosemgrep: bypass-tls-verification — FSxN ONTAP management endpoint uses self-signed cert, VPC-internal
        const options = {
            hostname: host,
            port: 443,
            path: `/api${path}`,
            method: method,
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            rejectUnauthorized: false // FSxN uses self-signed certs that rotate automatically. No API to pin cert.
        };
        
        console.log(`ONTAP REST ${method} ${path}`);
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                console.log(`ONTAP REST response: ${res.statusCode} - ${data.substring(0, 500)}`);
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({ statusCode: res.statusCode, data: data ? JSON.parse(data) : null });
                } else {
                    reject(new Error(`ONTAP REST API error ${res.statusCode}: ${data}`));
                }
            });
        });
        
        req.on('error', reject);
        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('ONTAP REST API timeout'));
        });
        
        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

/**
 * Execute ONTAP CLI command via SSH and return output
 */
function executeOntapCommand(host, username, password, command, timeout = 30000) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        let output = '';
        let errorOutput = '';
        
        const timer = setTimeout(() => {
            conn.end();
            reject(new Error(`SSH command timed out after ${timeout}ms`));
        }, timeout);
        
        conn.on('ready', () => {
            console.log(`SSH connected to ${host}, executing: ${command}`);
            conn.exec(command, (err, stream) => {
                if (err) {
                    clearTimeout(timer);
                    conn.end();
                    return reject(err);
                }
                
                stream.on('close', (code) => {
                    clearTimeout(timer);
                    conn.end();
                    console.log(`Command exit code: ${code}, output: ${output}`);
                    resolve({ code, output: output.trim(), error: errorOutput.trim() });
                });
                
                stream.on('data', (data) => {
                    output += data.toString();
                });
                
                stream.stderr.on('data', (data) => {
                    errorOutput += data.toString();
                });
            });
        });
        
        conn.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        
        conn.connect({
            host,
            port: 22,
            username,
            password,
            readyTimeout: 20000,
            algorithms: {
                kex: [
                    'curve25519-sha256',
                    'curve25519-sha256@libssh.org',
                    'ecdh-sha2-nistp256',
                    'ecdh-sha2-nistp384',
                    'ecdh-sha2-nistp521',
                    'diffie-hellman-group-exchange-sha256',
                    'diffie-hellman-group14-sha256',
                    'diffie-hellman-group14-sha1'
                ],
                cipher: [
                    'aes128-ctr',
                    'aes192-ctr', 
                    'aes256-ctr',
                    'aes128-gcm@openssh.com',
                    'aes256-gcm@openssh.com'
                ],
                hmac: [
                    'hmac-sha2-256',
                    'hmac-sha2-512',
                    'hmac-sha1'
                ]
            }
        });
    });
}

/**
 * Configure CIFS/SMB and NFS export policy on FSxN SVM
 */
exports.handler = async (event) => {
    console.log('Configure ONTAP CIFS/NFS event:', JSON.stringify(event, null, 2));
    
    const { storageId, type, parsedOutputs, region, isRegionalInvocation } = event;
    
    // Only configure for FSxN storage
    if (type !== 'fsx-ontap') {
        console.log(`Skipping configuration for non-ONTAP storage type: ${type}`);
        return { ...event, cifsConfigured: false, nfsConfigured: false, cifsSkipped: true, reason: 'Not FSxN storage' };
    }
    
    // Check if we need to route to a regional Lambda
    // Skip routing if this is already a regional invocation (prevents loops)
    if (!isRegionalInvocation && region && region !== PRIMARY_REGION) {
        console.log(`Storage is in region ${region}, checking for regional Lambda...`);
        try {
            const regionalResult = await invokeRegionalLambda(region, event);
            if (regionalResult) {
                console.log('Regional Lambda handled the configuration');
                return regionalResult;
            }
            console.log('No regional Lambda available, will attempt direct configuration (may fail if VPC access required)');
        } catch (error) {
            console.error('Error invoking regional Lambda:', error);
            // Fall through to try direct configuration
        }
    }
    
    const svmId = parsedOutputs?.svmId;
    if (!svmId) {
        console.log('No SVM ID found, skipping configuration');
        return { ...event, cifsConfigured: false, nfsConfigured: false, cifsSkipped: true, reason: 'No SVM ID' };
    }
    
    try {
        // Get SVM details
        const svmResponse = await fsx.send(new DescribeStorageVirtualMachinesCommand({
            StorageVirtualMachineIds: [svmId]
        }));
        
        const svm = svmResponse.StorageVirtualMachines?.[0];
        if (!svm) {
            throw new Error(`SVM not found: ${svmId}`);
        }
        
        const svmName = svm.Name;
        const svmUuid = svm.UUID;
        const managementEndpoint = svm.Endpoints?.Management?.DNSName;
        const smbEndpoint = svm.Endpoints?.Smb?.DNSName;
        
        console.log(`SVM ${svmName} (${svmUuid}): management=${managementEndpoint}, smb=${smbEndpoint}`);
        
        if (!managementEndpoint) {
            throw new Error('SVM management endpoint not available');
        }
        
        // Get ONTAP admin credentials
        const secretResponse = await secretsManager.send(new GetSecretValueCommand({
            SecretId: `/${PASCAL_CASE_NAME}/Storage/${storageId}/OntapAdminCredentials`
        }));
        const credentials = JSON.parse(secretResponse.SecretString);
        const vsadminPassword = credentials.vsadminPassword;
        
        // Configure NFS export policy first (always do this)
        let nfsConfigured = false;
        try {
            nfsConfigured = await configureNfsExportPolicy(managementEndpoint, vsadminPassword, svmName);
        } catch (nfsError) {
            console.error('NFS export policy configuration failed:', nfsError.message);
        }
        
        // Check if SMB is already configured
        if (smbEndpoint) {
            console.log('SMB endpoint already exists - CIFS is configured');
            return {
                ...event,
                cifsConfigured: true,
                nfsConfigured,
                smbEndpoint,
                reason: 'CIFS already configured'
            };
        }
        
        // Create CIFS server name (max 15 chars for NetBIOS)
        const cifsServerName = svmName.substring(0, 15).toUpperCase().replace(/[^A-Z0-9]/g, '');
        
        // Generate password for SMB local user
        const smbUserPassword = generatePassword();
        
        console.log(`Configuring CIFS on SVM ${svmName} with server name ${cifsServerName}`);
        
        // Step 1: Create CIFS server in workgroup mode (via SSH - REST API requires AD)
        console.log('Step 1: Creating CIFS server...');
        try {
            const result = await executeOntapCommand(
                managementEndpoint, 
                'vsadmin', 
                vsadminPassword,
                `cifs create -cifs-server ${cifsServerName} -workgroup WORKGROUP`
            );
            console.log('CIFS server create result:', result);
        } catch (err) {
            if (err.message?.includes('already exists') || err.output?.includes('already exists') ||
                err.message?.includes('Only one CIFS server')) {
                console.log('CIFS server already exists, continuing...');
            } else {
                console.warn('CIFS server create warning:', err.message);
            }
        }
        
        // Step 2: Create local SMB user via REST API (non-interactive, includes password)
        console.log('Step 2: Creating local SMB user via REST API...');
        const localUserName = `${cifsServerName}\\smbuser`;
        try {
            const userResult = await ontapRestCall(
                managementEndpoint,
                'vsadmin',
                vsadminPassword,
                'POST',
                '/protocols/cifs/local-users',
                {
                    svm: { name: svmName },
                    name: localUserName,
                    password: smbUserPassword,
                    full_name: 'SMB Mount User',
                    account_disabled: false
                }
            );
            console.log('User create result:', userResult);
        } catch (err) {
            if (err.message?.includes('already exists') || err.message?.includes('655736')) {
                console.log('User already exists, deleting and recreating to reset password...');
                // User exists - delete and recreate to ensure password is fresh without "must change" flag
                try {
                    // Get the user's SID first via REST API
                    const usersResponse = await ontapRestCall(
                        managementEndpoint,
                        'vsadmin',
                        vsadminPassword,
                        'GET',
                        `/protocols/cifs/local-users?svm.name=${encodeURIComponent(svmName)}&name=${encodeURIComponent(localUserName)}`
                    );
                    
                    if (usersResponse.data?.records?.length > 0) {
                        const userSid = usersResponse.data.records[0].sid;
                        const svmUuid = usersResponse.data.records[0].svm?.uuid;
                        console.log(`Found existing user with SID: ${userSid}, SVM UUID: ${svmUuid}`);
                        
                        // Delete the existing user
                        try {
                            await ontapRestCall(
                                managementEndpoint,
                                'vsadmin',
                                vsadminPassword,
                                'DELETE',
                                `/protocols/cifs/local-users/${svmUuid}/${userSid}`
                            );
                            console.log('Existing user deleted');
                        } catch (deleteErr) {
                            console.warn('Failed to delete user:', deleteErr.message);
                        }
                        
                        // Recreate the user with fresh password
                        try {
                            await ontapRestCall(
                                managementEndpoint,
                                'vsadmin',
                                vsadminPassword,
                                'POST',
                                '/protocols/cifs/local-users',
                                {
                                    svm: { name: svmName },
                                    name: localUserName,
                                    password: smbUserPassword,
                                    full_name: 'SMB Mount User',
                                    account_disabled: false
                                }
                            );
                            console.log('User recreated with fresh password');
                        } catch (createErr) {
                            console.warn('Failed to recreate user:', createErr.message);
                        }
                    } else {
                        console.warn('Could not find existing user to update');
                    }
                } catch (updateErr) {
                    console.warn('Failed to update user:', updateErr.message);
                }
            } else {
                console.warn('User create warning:', err.message);
            }
        }
        
        // Step 3: Create SMB share for the volume (via SSH)
        console.log('Step 3: Creating SMB share...');
        try {
            const result = await executeOntapCommand(
                managementEndpoint,
                'vsadmin',
                vsadminPassword,
                `cifs share create -share-name vol1 -path /vol1`
            );
            console.log('Share create result:', result);
        } catch (err) {
            if (err.message?.includes('already exists') || err.output?.includes('already exists') ||
                err.message?.includes('duplicate entry') || err.output?.includes('duplicate entry')) {
                console.log('Share already exists, continuing...');
            } else {
                console.warn('Share create warning:', err.message);
            }
        }
        
        // Step 4: Grant Everyone full access to the share
        console.log('Step 4: Setting share permissions...');
        try {
            const result = await executeOntapCommand(
                managementEndpoint,
                'vsadmin',
                vsadminPassword,
                `cifs share access-control create -share vol1 -user-or-group Everyone -permission Full_Control`
            );
            console.log('Access control result:', result);
        } catch (err) {
            if (err.message?.includes('already exists') || err.output?.includes('already exists') ||
                err.message?.includes('duplicate entry') || err.output?.includes('duplicate entry')) {
                console.log('Access control already exists, continuing...');
            } else {
                console.warn('Access control warning:', err.message);
            }
        }
        
        // Step 5: Change volume security style to UNIX for proper NFS access
        // UNIX security style works best for multi-protocol without AD
        // SMB still works - Windows users map to unix UIDs
        console.log('Step 5: Setting volume to UNIX security style...');
        try {
            await executeOntapCommand(
                managementEndpoint,
                'vsadmin',
                vsadminPassword,
                `volume modify -volume *_vol1 -security-style unix -unix-permissions 0777 -user 0 -group 0`,
                30000
            );
            console.log('Volume security style set to UNIX with 0777 permissions');
        } catch (err) {
            console.warn('Volume security style change warning:', err.message);
            // Try just permissions if security style change fails
            try {
                await executeOntapCommand(
                    managementEndpoint,
                    'vsadmin',
                    vsadminPassword,
                    `volume modify -volume *_vol1 -unix-permissions 0777`,
                    30000
                );
            } catch (e) {
                console.warn('Volume permissions warning:', e.message);
            }
        }
        
        // Step 6: Set file directory security on the junction path for NTFS ACLs (SMB write access)
        console.log('Step 6: Configuring NTFS file directory security for SMB write access...');
        try {
            // Create security descriptor with Everyone full control
            await executeOntapCommand(
                managementEndpoint,
                'vsadmin',
                vsadminPassword,
                `vserver security file-directory ntfs create -ntfs-sd sd_everyone -owner BUILTIN\\Administrators -group BUILTIN\\Administrators`,
                30000
            );
            console.log('NTFS SD created');
        } catch (err) {
            if (err.message?.includes('already exists') || err.output?.includes('already exists')) {
                console.log('NTFS SD already exists');
            } else {
                console.warn('NTFS SD create warning:', err.message);
            }
        }
        
        // Add DACL entry for Everyone with full control
        try {
            await executeOntapCommand(
                managementEndpoint,
                'vsadmin',
                vsadminPassword,
                `vserver security file-directory ntfs dacl add -ntfs-sd sd_everyone -access-type allow -account Everyone -rights full-control -apply-to this-folder,sub-folders,files`,
                30000
            );
            console.log('NTFS DACL added');
        } catch (err) {
            if (err.message?.includes('already exists') || err.output?.includes('already exists')) {
                console.log('NTFS DACL already exists');
            } else {
                console.warn('NTFS DACL add warning:', err.message);
            }
        }
        
        // Create policy
        try {
            await executeOntapCommand(
                managementEndpoint,
                'vsadmin',
                vsadminPassword,
                `vserver security file-directory policy create -policy-name policy_everyone`,
                30000
            );
            console.log('Policy created');
        } catch (err) {
            if (!err.message?.includes('already exists') && !err.output?.includes('already exists')) {
                console.warn('Policy create warning:', err.message);
            }
        }
        
        // Add task to policy
        try {
            await executeOntapCommand(
                managementEndpoint,
                'vsadmin',
                vsadminPassword,
                `vserver security file-directory policy task add -policy-name policy_everyone -path /vol1 -ntfs-sd sd_everyone -security-type ntfs`,
                30000
            );
            console.log('Policy task added');
        } catch (err) {
            if (!err.message?.includes('already exists') && !err.output?.includes('already exists')) {
                console.warn('Policy task add warning:', err.message);
            }
        }
        
        // Apply the policy to set NTFS permissions
        try {
            const result = await executeOntapCommand(
                managementEndpoint,
                'vsadmin',
                vsadminPassword,
                `vserver security file-directory apply -policy-name policy_everyone`,
                60000
            );
            console.log('Policy applied:', result.output);
        } catch (err) {
            console.warn('Policy apply warning:', err.message);
        }
        
        // Update the secret with SMB credentials
        console.log('Updating secret with SMB credentials...');
        credentials.smbUser = localUserName;
        credentials.smbPassword = smbUserPassword;
        credentials.cifsServerName = cifsServerName;
        credentials.shareName = 'vol1';
        
        await secretsManager.send(new UpdateSecretCommand({
            SecretId: `/${PASCAL_CASE_NAME}/Storage/${storageId}/OntapAdminCredentials`,
            SecretString: JSON.stringify(credentials)
        }));
        
        // Wait a moment and check for SMB endpoint
        console.log('Waiting for SMB endpoint to become available...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        const updatedSvmResponse = await fsx.send(new DescribeStorageVirtualMachinesCommand({
            StorageVirtualMachineIds: [svmId]
        }));
        const updatedSvm = updatedSvmResponse.StorageVirtualMachines?.[0];
        const newSmbEndpoint = updatedSvm?.Endpoints?.Smb?.DNSName;
        
        console.log('CIFS configuration completed. SMB endpoint:', newSmbEndpoint);
        
        return {
            ...event,
            cifsConfigured: true,
            nfsConfigured,
            cifsServerName,
            smbEndpoint: newSmbEndpoint || managementEndpoint,
            smbUser: localUserName,
            shareName: 'vol1'
        };
        
    } catch (error) {
        console.error('Error configuring CIFS:', error);
        // Don't fail the whole storage creation - return error info but continue
        return {
            ...event,
            cifsConfigured: false,
            nfsConfigured: false,
            cifsError: error.message,
            reason: `CIFS configuration failed: ${error.message}`
        };
    }
};

/**
 * Configure NFS export policy to allow read/write access from all clients
 * This fixes the "Permission denied" error when writing to NFS mounts
 */
async function configureNfsExportPolicy(managementEndpoint, vsadminPassword, svmName) {
    console.log('Configuring NFS export policy for full read/write access...');
    
    // Step 1: Create a permissive export policy (or use default)
    const policyName = 'fsxn_full_access';
    
    try {
        // Try to create the export policy via REST API
        console.log(`Creating export policy: ${policyName}`);
        await ontapRestCall(
            managementEndpoint,
            'vsadmin',
            vsadminPassword,
            'POST',
            '/protocols/nfs/export-policies',
            {
                svm: { name: svmName },
                name: policyName
            }
        );
        console.log(`Export policy ${policyName} created`);
    } catch (err) {
        if (err.message?.includes('already exists') || err.message?.includes('duplicate')) {
            console.log(`Export policy ${policyName} already exists`);
        } else {
            console.warn('Export policy create warning:', err.message);
        }
    }
    
    // Step 2: Add export policy rule allowing all access
    // Use SSH to add the rule since REST API for rules can be complex
    console.log('Adding export policy rule for full access...');
    
    // First, try to modify existing rule 1 to be permissive
    try {
        const result = await executeOntapCommand(
            managementEndpoint,
            'vsadmin',
            vsadminPassword,
            `export-policy rule modify -policyname default -ruleindex 1 -clientmatch 0.0.0.0/0 -rorule any -rwrule any -superuser any -anon 0`,
            15000
        );
        console.log('Modified existing export policy rule:', result);
    } catch (err) {
        console.log('Could not modify existing rule, will create new one');
    }
    
    // Add permissive rule to default export policy (which is applied to volumes by default)
    console.log('Adding permissive rule to default export policy...');
    try {
        const result = await executeOntapCommand(
            managementEndpoint,
            'vsadmin',
            vsadminPassword,
            `export-policy rule create -policyname default -clientmatch 0.0.0.0/0 -rorule any -rwrule any -superuser any -anon 0`,
            30000
        );
        console.log('Export policy rule create result:', result);
    } catch (err) {
        if (err.message?.includes('already exists') || err.message?.includes('duplicate') ||
            err.output?.includes('already exists') || err.output?.includes('duplicate')) {
            console.log('Export policy rule already exists');
        } else {
            // Try alternative syntax
            console.log('Trying alternative export policy rule syntax...');
            try {
                const result = await executeOntapCommand(
                    managementEndpoint,
                    'vsadmin',
                    vsadminPassword,
                    `vserver export-policy rule create -vserver ${svmName} -policyname default -clientmatch 0.0.0.0/0 -rorule any -rwrule any -superuser any -anon 0`,
                    30000
                );
                console.log('Alternative export policy rule result:', result);
            } catch (altErr) {
                console.warn('Alternative export policy rule warning:', altErr.message);
            }
        }
    }
    
    // Step 3: Ensure the volume uses the default export policy with our permissive rule
    // The volume should already use 'default' policy, but let's verify
    console.log('Verifying volume export policy...');
    try {
        const result = await executeOntapCommand(
            managementEndpoint,
            'vsadmin',
            vsadminPassword,
            `volume show -fields policy`,
            15000
        );
        console.log('Volume export policy:', result.output);
    } catch (err) {
        console.warn('Volume policy check warning:', err.message);
    }
    
    // Step 4: Show the export policy rules for verification
    console.log('Listing export policy rules...');
    try {
        const result = await executeOntapCommand(
            managementEndpoint,
            'vsadmin',
            vsadminPassword,
            `export-policy rule show -policyname default`,
            15000
        );
        console.log('Export policy rules:', result.output);
    } catch (err) {
        console.warn('Export policy rule show warning:', err.message);
    }
    
    console.log('NFS export policy configuration completed');
    return true;
}
