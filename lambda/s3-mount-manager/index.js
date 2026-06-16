// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * S3 Mount Manager Lambda
 * 
 * Manages Mountpoint for Amazon S3 on Linux workstations.
 * Handles installation, mounting via systemd, and unmounting.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { SSMClient, SendCommandCommand, GetCommandInvocationCommand } = require('@aws-sdk/client-ssm');
const { EC2Client, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);
const ssm = new SSMClient({ region: process.env.AWS_REGION });
const ec2 = new EC2Client({ region: process.env.AWS_REGION });

const STORAGE_TABLE_NAME = process.env.STORAGE_TABLE_NAME;
const WORKSTATION_TABLE_NAME = process.env.WORKSTATION_TABLE_NAME;

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
    'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

exports.handler = async (event) => {
    console.log('S3 Mount Manager Event:', JSON.stringify(event, null, 2));
    
    try {
        // Handle API Gateway event format
        let action, instanceId, storageId;
        
        if (event.body) {
            // API Gateway request
            const body = JSON.parse(event.body);
            action = body.action;
            instanceId = body.instanceId;
            storageId = body.storageId;
        } else {
            // Direct invocation
            action = event.action;
            instanceId = event.instanceId;
            storageId = event.storageId;
        }
        
        let result;
        switch (action) {
            case 'mount':
                result = await mountS3Storage(instanceId, storageId);
                break;
            case 'unmount':
                result = await unmountS3Storage(instanceId, storageId);
                break;
            case 'status':
                result = await checkMountStatus(instanceId, storageId);
                break;
            default:
                return {
                    statusCode: 400,
                    headers: corsHeaders,
                    body: JSON.stringify({ success: false, error: `Unknown action: ${action}` })
                };
        }
        
        // Return API Gateway formatted response
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify(result)
        };
        
    } catch (error) {
        console.error('Error in S3 Mount Manager:', error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ 
                success: false, 
                error: error.message 
            })
        };
    }
};


/**
 * Mount S3 bucket on a Linux workstation using Mountpoint for S3
 */
async function mountS3Storage(instanceId, storageId) {
    console.log(`Mounting S3 storage ${storageId} on instance ${instanceId}`);
    
    // Get storage configuration
    const storage = await getStorageById(storageId);
    if (!storage) {
        throw new Error(`Storage not found: ${storageId}`);
    }
    
    if (storage.type !== 'mountpoint-s3') {
        throw new Error(`Storage ${storageId} is not a Mountpoint for S3 type`);
    }
    
    // Get workstation to verify it's Linux
    const workstation = await getWorkstationById(instanceId);
    if (!workstation) {
        throw new Error(`Workstation not found: ${instanceId}`);
    }
    
    if (workstation.platform?.toLowerCase() !== 'linux') {
        throw new Error(`Mountpoint for S3 only supports Linux workstations. Instance ${instanceId} is ${workstation.platform}`);
    }
    
    // Verify instance is running
    const instanceInfo = await ec2.send(new DescribeInstancesCommand({
        InstanceIds: [instanceId]
    }));
    
    const instance = instanceInfo.Reservations[0]?.Instances[0];
    if (!instance || instance.State.Name !== 'running') {
        throw new Error(`Instance ${instanceId} is not running`);
    }
    
    // Generate systemd service name (sanitized)
    const serviceName = `mountpoint-s3-${storageId.replace(/[^a-zA-Z0-9]/g, '-')}`;
    
    // Generate the installation and mount script
    const script = generateMountScript(storage, serviceName);
    
    // Execute via SSM (comment limited to 100 chars)
    const comment = `Mount S3 ${storage.bucketName.substring(0, 40)} - ${storageId.substring(0, 8)}`;
    const commandResult = await ssm.send(new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: 'AWS-RunShellScript',
        Parameters: {
            commands: [script]
        },
        Comment: comment
    }));
    
    console.log(`SSM command sent: ${commandResult.Command.CommandId}`);
    
    // Wait for command to complete (with timeout)
    const result = await waitForCommand(commandResult.Command.CommandId, instanceId, 120);
    
    if (result.Status === 'Success') {
        console.log(`Successfully mounted S3 storage ${storageId} on ${instanceId}`);
        return {
            success: true,
            message: `S3 bucket ${storage.bucketName} mounted at ${storage.mountPath}`,
            instanceId,
            storageId,
            mountPath: storage.mountPath
        };
    } else {
        console.error(`Failed to mount S3 storage: ${result.StandardErrorContent}`);
        throw new Error(`Mount failed: ${result.StandardErrorContent || result.Status}`);
    }
}

/**
 * Unmount S3 bucket from a Linux workstation
 */
async function unmountS3Storage(instanceId, storageId) {
    console.log(`Unmounting S3 storage ${storageId} from instance ${instanceId}`);
    
    // Get storage configuration
    const storage = await getStorageById(storageId);
    if (!storage) {
        throw new Error(`Storage not found: ${storageId}`);
    }
    
    // Generate systemd service name (sanitized)
    const serviceName = `mountpoint-s3-${storageId.replace(/[^a-zA-Z0-9]/g, '-')}`;
    
    // Generate unmount script
    const script = `#!/bin/bash
set -e

SERVICE_NAME="${serviceName}"
MOUNT_PATH="${storage.mountPath}"
STORAGE_NAME="${storage.name}"

echo "Unmounting S3 storage: $MOUNT_PATH"

# Stop and disable the systemd service
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    echo "Stopping service $SERVICE_NAME..."
    sudo systemctl stop "$SERVICE_NAME"
fi

if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
    echo "Disabling service $SERVICE_NAME..."
    sudo systemctl disable "$SERVICE_NAME"
fi

# Remove the service file
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"
if [ -f "$SERVICE_FILE" ]; then
    echo "Removing service file..."
    sudo rm -f "$SERVICE_FILE"
    sudo systemctl daemon-reload
fi

# Unmount if still mounted (use lazy unmount to handle busy mounts)
if mountpoint -q "$MOUNT_PATH" 2>/dev/null; then
    echo "Unmounting $MOUNT_PATH..."
    sudo umount -l "$MOUNT_PATH" || true
    sleep 1
fi

# Remove mount directory if empty or stale
if [ -d "$MOUNT_PATH" ]; then
    # Check if it's a stale mount point (transport endpoint not connected)
    if ! mountpoint -q "$MOUNT_PATH" 2>/dev/null; then
        echo "Removing mount directory..."
        sudo rmdir "$MOUNT_PATH" 2>/dev/null || true
    fi
fi

# Remove desktop shortcuts for all users
for USER_HOME in /home/*; do
    DESKTOP_FILE="$USER_HOME/Desktop/$STORAGE_NAME.desktop"
    if [ -f "$DESKTOP_FILE" ]; then
        echo "Removing desktop shortcut: $DESKTOP_FILE"
        rm -f "$DESKTOP_FILE"
    fi
done

echo "S3 storage unmounted successfully"
`;
    
    // Execute via SSM
    const commandResult = await ssm.send(new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: 'AWS-RunShellScript',
        Parameters: {
            commands: [script]
        },
        Comment: `Unmount S3 storage ${storageId}`
    }));
    
    const result = await waitForCommand(commandResult.Command.CommandId, instanceId, 60);
    
    if (result.Status === 'Success') {
        return {
            success: true,
            message: `S3 storage unmounted from ${storage.mountPath}`,
            instanceId,
            storageId
        };
    } else {
        throw new Error(`Unmount failed: ${result.StandardErrorContent || result.Status}`);
    }
}

/**
 * Check mount status on a workstation
 */
async function checkMountStatus(instanceId, storageId) {
    const storage = await getStorageById(storageId);
    if (!storage) {
        throw new Error(`Storage not found: ${storageId}`);
    }
    
    const serviceName = `mountpoint-s3-${storageId.replace(/[^a-zA-Z0-9]/g, '-')}`;
    
    const script = `#!/bin/bash
MOUNT_PATH="${storage.mountPath}"
SERVICE_NAME="${serviceName}"

# Check if mounted
if mountpoint -q "$MOUNT_PATH" 2>/dev/null; then
    echo "MOUNTED"
    # Check service status
    if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        echo "SERVICE_ACTIVE"
    else
        echo "SERVICE_INACTIVE"
    fi
else
    echo "NOT_MOUNTED"
fi
`;
    
    const commandResult = await ssm.send(new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: 'AWS-RunShellScript',
        Parameters: {
            commands: [script]
        },
        Comment: `Check S3 mount status for ${storageId}`
    }));
    
    const result = await waitForCommand(commandResult.Command.CommandId, instanceId, 30);
    
    const output = result.StandardOutputContent || '';
    const isMounted = output.includes('MOUNTED') && !output.includes('NOT_MOUNTED');
    const serviceActive = output.includes('SERVICE_ACTIVE');
    
    return {
        success: true,
        instanceId,
        storageId,
        mounted: isMounted,
        serviceActive,
        mountPath: storage.mountPath
    };
}


/**
 * Generate the bash script to install mountpoint and create systemd service
 */
function generateMountScript(storage, serviceName) {
    // Build mount options array
    const mountOptions = [];
    
    // Prefix option
    if (storage.prefix) {
        mountOptions.push(`--prefix "${storage.prefix}"`);
    }
    
    // Access mode
    if (storage.accessMode === 'read-only') {
        mountOptions.push('--read-only');
    }
    
    // Allow delete (only for read-write mode)
    if (storage.accessMode === 'read-write' && storage.allowDelete) {
        mountOptions.push('--allow-delete');
    }
    
    // Allow other users
    if (storage.allowOther) {
        mountOptions.push('--allow-other');
    }
    
    // UID/GID options
    if (storage.uid) {
        mountOptions.push(`--uid ${storage.uid}`);
    }
    if (storage.gid) {
        mountOptions.push(`--gid ${storage.gid}`);
    }
    
    // Cache path
    if (storage.cachePath) {
        mountOptions.push(`--cache "${storage.cachePath}"`);
    }
    
    const mountOptionsStr = mountOptions.join(' ');
    
    return `#!/bin/bash
set -e

BUCKET_NAME="${storage.bucketName}"
MOUNT_PATH="${storage.mountPath}"
SERVICE_NAME="${serviceName}"
MOUNT_OPTIONS="${mountOptionsStr}"

echo "Setting up Mountpoint for S3: $BUCKET_NAME -> $MOUNT_PATH"

# Detect OS type
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_ID="$ID"
else
    OS_ID="unknown"
fi

echo "Detected OS: $OS_ID"

# Install mountpoint-s3 if not already installed
if ! command -v mount-s3 &> /dev/null; then
    echo "Installing Mountpoint for S3..."
    
    case "$OS_ID" in
        amzn|rhel|centos|rocky|fedora)
            # RPM-based systems
            cd /tmp
            curl -sL -o mount-s3.rpm "https://s3.amazonaws.com/mountpoint-s3-release/latest/x86_64/mount-s3.rpm"
            sudo yum install -y ./mount-s3.rpm
            rm -f mount-s3.rpm
            ;;
        ubuntu|debian)
            # DEB-based systems
            cd /tmp
            curl -sL -o mount-s3.deb "https://s3.amazonaws.com/mountpoint-s3-release/latest/x86_64/mount-s3.deb"
            sudo apt-get install -y ./mount-s3.deb
            rm -f mount-s3.deb
            ;;
        *)
            echo "Unsupported OS: $OS_ID"
            exit 1
            ;;
    esac
    
    echo "Mountpoint for S3 installed successfully"
else
    echo "Mountpoint for S3 already installed"
fi

# Create mount directory
echo "Creating mount directory: $MOUNT_PATH"
sudo mkdir -p "$MOUNT_PATH"

# Enable user_allow_other in fuse.conf for --allow-other to work
if ! grep -q "^user_allow_other" /etc/fuse.conf 2>/dev/null; then
    echo "Enabling user_allow_other in /etc/fuse.conf..."
    echo "user_allow_other" | sudo tee -a /etc/fuse.conf > /dev/null
fi

# Create cache directory if specified
${storage.cachePath ? `
echo "Creating cache directory: ${storage.cachePath}"
sudo mkdir -p "${storage.cachePath}"
` : ''}

# Create systemd service file
echo "Creating systemd service: $SERVICE_NAME"
sudo tee /etc/systemd/system/$SERVICE_NAME.service > /dev/null << EOF
[Unit]
Description=Mountpoint for S3 - ${storage.name}
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
ExecStart=/usr/bin/mount-s3 $BUCKET_NAME $MOUNT_PATH $MOUNT_OPTIONS
ExecStop=/usr/bin/umount $MOUNT_PATH
Restart=on-failure
RestartSec=10
TimeoutStartSec=60

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd and enable service
echo "Enabling and starting service..."
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl start "$SERVICE_NAME"

# Verify mount
sleep 2
if mountpoint -q "$MOUNT_PATH"; then
    echo "SUCCESS: S3 bucket mounted at $MOUNT_PATH"
    echo "Mount options: $MOUNT_OPTIONS"
    ls -la "$MOUNT_PATH" | head -10
    
    # Create desktop shortcut for all users with home directories
    STORAGE_NAME="${storage.name}"
    for USER_HOME in /home/*; do
        if [ -d "$USER_HOME/Desktop" ]; then
            USERNAME=$(basename "$USER_HOME")
            DESKTOP_FILE="$USER_HOME/Desktop/$STORAGE_NAME.desktop"
            echo "Creating desktop shortcut for $USERNAME..."
            cat > "$DESKTOP_FILE" << DESKTOP_EOF
[Desktop Entry]
Type=Link
Name=$STORAGE_NAME
Comment=S3 Mount: $BUCKET_NAME
Icon=folder-remote
URL=$MOUNT_PATH
DESKTOP_EOF
            chown "$USERNAME:$USERNAME" "$DESKTOP_FILE"
            chmod 755 "$DESKTOP_FILE"
        fi
    done
else
    echo "ERROR: Mount verification failed"
    sudo systemctl status "$SERVICE_NAME" --no-pager || true
    exit 1
fi
`;
}

/**
 * Get storage configuration by ID
 */
async function getStorageById(storageId) {
    const result = await dynamodb.send(new GetCommand({
        TableName: STORAGE_TABLE_NAME,
        Key: { storageId }
    }));
    return result.Item;
}

/**
 * Get workstation by instance ID
 */
async function getWorkstationById(instanceId) {
    const result = await dynamodb.send(new GetCommand({
        TableName: WORKSTATION_TABLE_NAME,
        Key: { instanceId }
    }));
    return result.Item;
}

/**
 * Wait for SSM command to complete
 */
async function waitForCommand(commandId, instanceId, timeoutSeconds = 120) {
    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;
    
    while (Date.now() - startTime < timeoutMs) {
        try {
            const result = await ssm.send(new GetCommandInvocationCommand({
                CommandId: commandId,
                InstanceId: instanceId
            }));
            
            if (['Success', 'Failed', 'Cancelled', 'TimedOut'].includes(result.Status)) {
                return result;
            }
            
            // Wait before polling again
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
            if (error.name === 'InvocationDoesNotExist') {
                // Command not yet registered, wait and retry
                await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
                throw error;
            }
        }
    }
    
    throw new Error(`Command ${commandId} timed out after ${timeoutSeconds} seconds`);
}
