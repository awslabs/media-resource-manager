// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * NFS Mount Manager Lambda
 * 
 * Manages NFS mounts for FSx for NetApp ONTAP on Linux and macOS workstations.
 * Uses systemd on Linux and launchd on macOS for persistent mounts.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { SSMClient, SendCommandCommand, GetCommandInvocationCommand } = require('@aws-sdk/client-ssm');
const { EC2Client, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
const { FSxClient, DescribeStorageVirtualMachinesCommand } = require('@aws-sdk/client-fsx');

// DynamoDB client for primary region (workstation table is in primary region)
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

// Cache for regional clients
const ec2Clients = {};
const ssmClients = {};
const fsxClients = {};

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

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
    'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

exports.handler = async (event) => {
    console.log('NFS Mount Manager Event:', JSON.stringify(event, null, 2));
    
    try {
        // Handle API Gateway event format
        let action, instanceId, storageId;
        
        if (event.body) {
            const body = JSON.parse(event.body);
            action = body.action;
            instanceId = body.instanceId;
            storageId = body.storageId;
        } else {
            action = event.action;
            instanceId = event.instanceId;
            storageId = event.storageId;
        }
        
        let result;
        switch (action) {
            case 'mount':
                result = await mountNfsStorage(instanceId, storageId);
                break;
            case 'unmount':
                result = await unmountNfsStorage(instanceId, storageId);
                break;
            case 'status':
                result = await checkMountStatus(instanceId, storageId);
                break;
            case 'updateInstance':
                result = await updateInstanceMounts(instanceId);
                break;
            default:
                return {
                    statusCode: 400,
                    headers: corsHeaders,
                    body: JSON.stringify({ success: false, error: `Unknown action: ${action}` })
                };
        }
        
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify(result)
        };
        
    } catch (error) {
        console.error('Error in NFS Mount Manager:', error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ success: false, error: error.message })
        };
    }
};

/**
 * Update all NFS mounts for an instance based on its storageConfig
 * Called by workstation-manager when storage config changes
 */
async function updateInstanceMounts(instanceId) {
    console.log(`Updating NFS mounts for instance: ${instanceId}`);
    
    // Get workstation record
    const workstation = await getWorkstationById(instanceId);
    if (!workstation) {
        console.log(`Workstation not found: ${instanceId}`);
        return { success: false, message: 'Workstation not found', instanceId };
    }
    
    // Get workstation region
    const workstationRegion = workstation.region || process.env.AWS_REGION;
    console.log(`Workstation ${instanceId} is in region: ${workstationRegion}`);
    
    // Check platform - NFS mounts only work on Linux/macOS
    const platform = workstation.platform?.toLowerCase();
    if (platform !== 'linux' && platform !== 'macos') {
        console.log(`Skipping NFS mount for non-Linux/macOS workstation: ${instanceId} (platform: ${platform})`);
        return { 
            success: true, 
            message: `NFS mounts not supported on ${platform} workstations`, 
            instanceId,
            platform,
            skipped: true
        };
    }
    
    // Check if instance is running
    const ec2 = getEC2Client(workstationRegion);
    try {
        const instanceInfo = await ec2.send(new DescribeInstancesCommand({
            InstanceIds: [instanceId]
        }));
        const instance = instanceInfo.Reservations[0]?.Instances[0];
        if (!instance || instance.State.Name !== 'running') {
            console.log(`Instance ${instanceId} is not running, skipping mount`);
            return { 
                success: true, 
                message: 'Instance not running, mount will be applied when started', 
                instanceId,
                skipped: true
            };
        }
    } catch (error) {
        console.error(`Failed to check instance state: ${error.message}`);
        return { success: false, message: `Failed to check instance state: ${error.message}`, instanceId };
    }
    
    const storageConfig = workstation.storageConfig || {};
    const results = [];
    
    // Process each storage in the config
    for (const [storageId, config] of Object.entries(storageConfig)) {
        // Only process FSxN storage
        if (config.type !== 'fsx-ontap') {
            continue;
        }
        
        // Get storage to check region
        let storage;
        try {
            storage = await getStorageById(storageId);
        } catch (e) {
            console.error(`Failed to get storage ${storageId}: ${e.message}`);
            results.push({ storageId, action: 'skip', success: false, error: `Storage not found: ${storageId}` });
            continue;
        }
        
        // Check if storage is in the same region as workstation
        const storageRegion = storage?.region || process.env.AWS_REGION;
        if (storageRegion !== workstationRegion) {
            console.log(`Skipping storage ${storageId} - different region (storage: ${storageRegion}, workstation: ${workstationRegion})`);
            results.push({ 
                storageId, 
                action: 'skip', 
                success: false, 
                error: `Storage is in ${storageRegion}, workstation is in ${workstationRegion}. Cross-region mounts not supported.` 
            });
            continue;
        }
        
        if (config.autoMount) {
            try {
                console.log(`Mounting FSxN storage ${storageId} on ${instanceId}`);
                const result = await mountNfsStorage(instanceId, storageId);
                results.push({ storageId, action: 'mount', ...result });
            } catch (error) {
                console.error(`Failed to mount ${storageId}: ${error.message}`);
                results.push({ storageId, action: 'mount', success: false, error: error.message });
            }
        } else {
            // autoMount is disabled - unmount if currently mounted
            try {
                console.log(`Unmounting FSxN storage ${storageId} from ${instanceId} (autoMount disabled)`);
                const result = await unmountNfsStorage(instanceId, storageId);
                results.push({ storageId, action: 'unmount', ...result });
            } catch (error) {
                // Don't fail if unmount fails (might not be mounted)
                console.log(`Unmount ${storageId} skipped or failed: ${error.message}`);
                results.push({ storageId, action: 'unmount', skipped: true, message: error.message });
            }
        }
    }
    
    return {
        success: true,
        message: `Processed ${results.length} FSxN storage operations`,
        instanceId,
        platform,
        region: workstationRegion,
        results
    };
}


/**
 * Mount FSxN storage via NFS on a Linux or macOS workstation
 */
async function mountNfsStorage(instanceId, storageId) {
    console.log(`Mounting NFS storage ${storageId} on instance ${instanceId}`);
    
    // Get storage configuration
    const storage = await getStorageById(storageId);
    if (!storage) {
        throw new Error(`Storage not found: ${storageId}`);
    }
    
    if (storage.type !== 'fsx-ontap') {
        throw new Error(`Storage ${storageId} is not FSx for NetApp ONTAP type`);
    }
    
    // Get workstation to verify platform and get region
    const workstation = await getWorkstationById(instanceId);
    if (!workstation) {
        throw new Error(`Workstation not found: ${instanceId}`);
    }
    
    // Get workstation region (may be in a spoke region)
    const workstationRegion = workstation.region || process.env.AWS_REGION;
    const storageRegion = storage.region || process.env.AWS_REGION;
    console.log(`Workstation ${instanceId} is in region: ${workstationRegion}, Storage ${storageId} is in region: ${storageRegion}`);
    
    // Validate regions match - FSx storage can only be mounted from the same region
    if (workstationRegion !== storageRegion) {
        throw new Error(`Cannot mount storage from different region. Workstation is in ${workstationRegion}, but storage is in ${storageRegion}. FSx storage can only be mounted from workstations in the same region.`);
    }
    
    const platform = workstation.platform?.toLowerCase();
    if (platform !== 'linux' && platform !== 'macos') {
        throw new Error(`NFS mounts only supported on Linux and macOS. Instance ${instanceId} is ${platform}`);
    }
    
    // Use regional EC2 client
    const ec2 = getEC2Client(workstationRegion);
    
    // Verify instance is running
    const instanceInfo = await ec2.send(new DescribeInstancesCommand({
        InstanceIds: [instanceId]
    }));
    
    const instance = instanceInfo.Reservations[0]?.Instances[0];
    if (!instance || instance.State.Name !== 'running') {
        throw new Error(`Instance ${instanceId} is not running`);
    }
    
    // Get SVM NFS endpoint using regional FSx client
    const fsx = getFSxClient(workstationRegion);
    let nfsEndpoint = null;
    
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
    
    if (svmId) {
        try {
            const svmResponse = await fsx.send(new DescribeStorageVirtualMachinesCommand({
                StorageVirtualMachineIds: [svmId]
            }));
            const svm = svmResponse.StorageVirtualMachines?.[0];
            if (svm?.Endpoints?.Nfs?.DNSName) {
                nfsEndpoint = svm.Endpoints.Nfs.DNSName;
            }
            console.log(`SVM ${svmId} NFS endpoint: ${nfsEndpoint}`);
        } catch (error) {
            console.error('Failed to get SVM NFS endpoint for', svmId + ':', error);
        }
    }
    
    if (!nfsEndpoint) {
        throw new Error(`Could not determine NFS endpoint for storage ${storageId}`);
    }
    
    const junctionPath = storage.junctionPath || parsedOutputs.junctionPath || '/vol1';
    // Use platform-appropriate mount path: /Volumes for macOS, /mnt for Linux
    const defaultMountPath = platform === 'macos' 
        ? `/Volumes/fsxn-${storageId.substring(0, 8)}`
        : `/mnt/fsxn-${storageId.substring(0, 8)}`;
    const mountPath = workstation.storageConfig?.[storageId]?.mountPath || defaultMountPath;
    const serviceName = `nfs-fsxn-${storageId.replace(/[^a-zA-Z0-9]/g, '-')}`;
    
    // Generate and execute mount script based on platform
    let script;
    if (platform === 'linux') {
        script = generateLinuxNfsMountScript(storage, nfsEndpoint, junctionPath, mountPath, serviceName);
    } else {
        script = generateMacOsNfsMountScript(storage, nfsEndpoint, junctionPath, mountPath, serviceName);
    }
    
    // Execute via SSM using regional client
    const ssm = getSSMClient(workstationRegion);
    const documentName = platform === 'linux' ? 'AWS-RunShellScript' : 'AWS-RunShellScript';
    const commandResult = await ssm.send(new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: documentName,
        Parameters: {
            commands: [script]
        },
        Comment: `Mount FSxN NFS ${storage.name} at ${mountPath}`
    }));
    
    console.log(`SSM command sent to ${workstationRegion}: ${commandResult.Command.CommandId}`);
    
    // Wait for command to complete
    const result = await waitForCommand(commandResult.Command.CommandId, instanceId, 120, workstationRegion);
    
    if (result.Status === 'Success') {
        console.log(`Successfully mounted NFS storage ${storageId} on ${instanceId}`);
        return {
            success: true,
            message: `FSxN volume mounted at ${mountPath}`,
            instanceId,
            storageId,
            mountPath,
            nfsEndpoint,
            junctionPath,
            region: workstationRegion
        };
    } else {
        console.error(`Failed to mount NFS storage: ${result.StandardErrorContent}`);
        throw new Error(`Mount failed: ${result.StandardErrorContent || result.Status}`);
    }
}

/**
 * Generate Linux NFS mount script using systemd
 */
function generateLinuxNfsMountScript(storage, nfsEndpoint, junctionPath, mountPath, serviceName) {
    return `#!/bin/bash
set -e

NFS_ENDPOINT="${nfsEndpoint}"
JUNCTION_PATH="${junctionPath}"
MOUNT_PATH="${mountPath}"
SERVICE_NAME="${serviceName}"

echo "Setting up NFS mount for FSxN: $NFS_ENDPOINT:$JUNCTION_PATH -> $MOUNT_PATH"

# Detect OS type
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_ID="$ID"
else
    OS_ID="unknown"
fi

echo "Detected OS: $OS_ID"

# Install NFS client if not present
if ! command -v mount.nfs &> /dev/null; then
    echo "Installing NFS client..."
    case "$OS_ID" in
        amzn|rhel|centos|rocky|fedora)
            sudo yum install -y nfs-utils
            ;;
        ubuntu|debian)
            sudo apt-get update
            sudo apt-get install -y nfs-common
            ;;
        *)
            echo "Warning: Unknown OS, assuming NFS client is installed"
            ;;
    esac
fi

# Create mount directory
echo "Creating mount directory: $MOUNT_PATH"
sudo mkdir -p "$MOUNT_PATH"

# Use systemd-escape to properly generate unit name from path
# This handles special characters like dashes correctly
UNIT_NAME=$(systemd-escape --path "$MOUNT_PATH")

echo "Creating systemd mount unit: $UNIT_NAME.mount"
sudo tee /etc/systemd/system/$UNIT_NAME.mount > /dev/null << EOF
[Unit]
Description=FSxN NFS Mount - ${storage.name}
After=network-online.target
Wants=network-online.target

[Mount]
What=$NFS_ENDPOINT:$JUNCTION_PATH
Where=$MOUNT_PATH
Type=nfs
Options=nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd and enable/start the mount directly (skip automount for simplicity)
echo "Enabling and starting NFS mount..."
sudo systemctl daemon-reload
sudo systemctl enable "$UNIT_NAME.mount"
sudo systemctl start "$UNIT_NAME.mount"
# Verify mount
sleep 2
if mountpoint -q "$MOUNT_PATH"; then
    echo "SUCCESS: FSxN NFS mounted at $MOUNT_PATH"
    df -h "$MOUNT_PATH" 2>/dev/null || true
    ls -la "$MOUNT_PATH" || true
else
    echo "ERROR: Mount failed"
    systemctl status "$UNIT_NAME.mount" || true
    exit 1
fi
`;
}


/**
 * Generate macOS NFS mount script using launchd
 */
function generateMacOsNfsMountScript(storage, nfsEndpoint, junctionPath, mountPath, serviceName) {
    const plistName = `com.fsxn.mount.${serviceName}`;
    // Use storage name for Finder display, fallback to serviceName
    const volumeLabel = storage.name || `FSxN-${serviceName}`;
    
    return `#!/bin/bash
set -e

NFS_ENDPOINT="${nfsEndpoint}"
JUNCTION_PATH="${junctionPath}"
MOUNT_PATH="${mountPath}"
PLIST_NAME="${plistName}"
VOLUME_LABEL="${volumeLabel}"

echo "Setting up NFS mount for FSxN on macOS: $NFS_ENDPOINT:$JUNCTION_PATH -> $MOUNT_PATH"

# Create mount directory
echo "Creating mount directory: $MOUNT_PATH"
sudo mkdir -p "$MOUNT_PATH"

# Create mount script
MOUNT_SCRIPT="/usr/local/bin/mount-fsxn-${serviceName}.sh"
echo "Creating mount script: $MOUNT_SCRIPT"
sudo tee "$MOUNT_SCRIPT" > /dev/null << 'SCRIPT'
#!/bin/bash
MOUNT_PATH="${mountPath}"
NFS_ENDPOINT="${nfsEndpoint}"
JUNCTION_PATH="${junctionPath}"
VOLUME_LABEL="${volumeLabel}"

# Check if already mounted
if mount | grep -q "$MOUNT_PATH"; then
    echo "Already mounted"
    exit 0
fi

# Mount with macOS-specific options
# resvport: Use reserved port (required for some NFS servers)
# nfc: Normalize filenames to NFC (better compatibility)
# rsize/wsize: Large block sizes for performance
mount -t nfs -o resvport,nfc,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2 \\
    "$NFS_ENDPOINT:$JUNCTION_PATH" "$MOUNT_PATH"

if [ $? -eq 0 ]; then
    echo "Successfully mounted FSxN at $MOUNT_PATH"
    
    # Set custom Finder name for the volume
    # This creates a .localized folder with display name
    if [ -n "$VOLUME_LABEL" ]; then
        echo "Setting Finder display name to: $VOLUME_LABEL"
        # Use xattr to set Finder display name (works on NFS mounts)
        # The com.apple.FinderInfo attribute doesn't work on NFS, so we use a symlink approach
        # Create a friendly symlink in /Volumes if mount path is elsewhere
        FRIENDLY_LINK="/Volumes/$VOLUME_LABEL"
        if [ "$MOUNT_PATH" != "$FRIENDLY_LINK" ] && [ ! -e "$FRIENDLY_LINK" ]; then
            sudo ln -sf "$MOUNT_PATH" "$FRIENDLY_LINK" 2>/dev/null || true
            echo "Created friendly symlink: $FRIENDLY_LINK -> $MOUNT_PATH"
        fi
    fi
else
    echo "Failed to mount FSxN"
    exit 1
fi
SCRIPT

sudo chmod +x "$MOUNT_SCRIPT"

# Update the script with actual values
sudo sed -i '' "s|\\\${mountPath}|$MOUNT_PATH|g" "$MOUNT_SCRIPT"
sudo sed -i '' "s|\\\${nfsEndpoint}|$NFS_ENDPOINT|g" "$MOUNT_SCRIPT"
sudo sed -i '' "s|\\\${junctionPath}|$JUNCTION_PATH|g" "$MOUNT_SCRIPT"
sudo sed -i '' "s|\\\${volumeLabel}|$VOLUME_LABEL|g" "$MOUNT_SCRIPT"

# Create launchd plist for auto-mount at login
PLIST_PATH="/Library/LaunchDaemons/$PLIST_NAME.plist"
echo "Creating launchd plist: $PLIST_PATH"
sudo tee "$PLIST_PATH" > /dev/null << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$PLIST_NAME</string>
    <key>ProgramArguments</key>
    <array>
        <string>$MOUNT_SCRIPT</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>PathState</key>
        <dict>
            <key>$MOUNT_PATH</key>
            <false/>
        </dict>
    </dict>
    <key>StandardOutPath</key>
    <string>/var/log/fsxn-mount.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/fsxn-mount.log</string>
</dict>
</plist>
EOF

# Load the launchd job
echo "Loading launchd job..."
sudo launchctl unload "$PLIST_PATH" 2>/dev/null || true
sudo launchctl load "$PLIST_PATH"

# Run the mount script immediately
echo "Mounting now..."
sudo "$MOUNT_SCRIPT"

# Verify mount
if mount | grep -q "$MOUNT_PATH"; then
    echo "SUCCESS: FSxN NFS mounted at $MOUNT_PATH"
    df -h "$MOUNT_PATH"
else
    echo "WARNING: Mount may not be active yet - will mount on next boot or access"
fi
`;
}

/**
 * Unmount NFS storage from a workstation
 */
async function unmountNfsStorage(instanceId, storageId) {
    console.log(`Unmounting NFS storage ${storageId} from instance ${instanceId}`);
    
    const storage = await getStorageById(storageId);
    if (!storage) {
        throw new Error(`Storage not found: ${storageId}`);
    }
    
    const workstation = await getWorkstationById(instanceId);
    if (!workstation) {
        throw new Error(`Workstation not found: ${instanceId}`);
    }
    
    // Get workstation region (may be in a spoke region)
    const workstationRegion = workstation.region || process.env.AWS_REGION;
    console.log(`Workstation ${instanceId} is in region: ${workstationRegion}`);
    
    const platform = workstation.platform?.toLowerCase();
    // Use platform-appropriate mount path: /Volumes for macOS, /mnt for Linux
    const defaultMountPath = platform === 'macos' 
        ? `/Volumes/fsxn-${storageId.substring(0, 8)}`
        : `/mnt/fsxn-${storageId.substring(0, 8)}`;
    const mountPath = workstation.storageConfig?.[storageId]?.mountPath || defaultMountPath;
    const serviceName = `nfs-fsxn-${storageId.replace(/[^a-zA-Z0-9]/g, '-')}`;
    
    let script;
    if (platform === 'linux') {
        script = generateLinuxNfsUnmountScript(mountPath, serviceName);
    } else if (platform === 'macos') {
        script = generateMacOsNfsUnmountScript(mountPath, serviceName);
    } else {
        throw new Error(`NFS unmount not supported on ${platform}`);
    }
    
    // Use regional SSM client
    const ssm = getSSMClient(workstationRegion);
    const commandResult = await ssm.send(new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: 'AWS-RunShellScript',
        Parameters: {
            commands: [script]
        },
        Comment: `Unmount FSxN NFS ${storageId}`
    }));
    
    console.log(`SSM command sent to ${workstationRegion}: ${commandResult.Command.CommandId}`);
    
    const result = await waitForCommand(commandResult.Command.CommandId, instanceId, 60, workstationRegion);
    
    if (result.Status === 'Success') {
        return {
            success: true,
            message: `NFS storage unmounted from ${mountPath}`,
            instanceId,
            storageId,
            region: workstationRegion
        };
    } else {
        throw new Error(`Unmount failed: ${result.StandardErrorContent || result.Status}`);
    }
}

function generateLinuxNfsUnmountScript(mountPath, serviceName) {
    return `#!/bin/bash
set -e

MOUNT_PATH="${mountPath}"
UNIT_NAME=$(systemd-escape --path "$MOUNT_PATH")

echo "Unmounting NFS storage: $MOUNT_PATH"

# Stop and disable systemd units
if systemctl is-active --quiet "$UNIT_NAME.automount" 2>/dev/null; then
    echo "Stopping automount..."
    sudo systemctl stop "$UNIT_NAME.automount"
fi

if systemctl is-active --quiet "$UNIT_NAME.mount" 2>/dev/null; then
    echo "Stopping mount..."
    sudo systemctl stop "$UNIT_NAME.mount"
fi

sudo systemctl disable "$UNIT_NAME.automount" 2>/dev/null || true
sudo systemctl disable "$UNIT_NAME.mount" 2>/dev/null || true

# Remove unit files
sudo rm -f "/etc/systemd/system/$UNIT_NAME.mount"
sudo rm -f "/etc/systemd/system/$UNIT_NAME.automount"

# Also clean up old-style unit files (without proper escaping)
OLD_UNIT_NAME=$(echo "$MOUNT_PATH" | sed 's|^/||' | sed 's|/|-|g')
sudo rm -f "/etc/systemd/system/$OLD_UNIT_NAME.mount"
sudo rm -f "/etc/systemd/system/$OLD_UNIT_NAME.automount"

sudo systemctl daemon-reload

# Unmount if still mounted
if mountpoint -q "$MOUNT_PATH" 2>/dev/null; then
    echo "Force unmounting..."
    sudo umount -f "$MOUNT_PATH" || sudo umount -l "$MOUNT_PATH"
fi

# Remove mount directory if empty
if [ -d "$MOUNT_PATH" ] && [ -z "$(ls -A $MOUNT_PATH 2>/dev/null)" ]; then
    echo "Removing empty mount directory..."
    sudo rmdir "$MOUNT_PATH" 2>/dev/null || true
fi

echo "NFS storage unmounted successfully"
`;
}

function generateMacOsNfsUnmountScript(mountPath, serviceName) {
    const plistName = `com.fsxn.mount.${serviceName}`;
    
    return `#!/bin/bash
set -e

MOUNT_PATH="${mountPath}"
PLIST_NAME="${plistName}"
PLIST_PATH="/Library/LaunchDaemons/$PLIST_NAME.plist"
MOUNT_SCRIPT="/usr/local/bin/mount-fsxn-${serviceName}.sh"

echo "Unmounting NFS storage: $MOUNT_PATH"

# Unload launchd job
if [ -f "$PLIST_PATH" ]; then
    echo "Unloading launchd job..."
    sudo launchctl unload "$PLIST_PATH" 2>/dev/null || true
    sudo rm -f "$PLIST_PATH"
fi

# Remove mount script
if [ -f "$MOUNT_SCRIPT" ]; then
    sudo rm -f "$MOUNT_SCRIPT"
fi

# Remove any symlinks in /Volumes pointing to our mount path
for link in /Volumes/*; do
    if [ -L "$link" ]; then
        target=$(readlink "$link" 2>/dev/null || true)
        if [ "$target" = "$MOUNT_PATH" ]; then
            echo "Removing symlink: $link"
            sudo rm -f "$link"
        fi
    fi
done

# Unmount if mounted
if mount | grep -q "$MOUNT_PATH"; then
    echo "Unmounting..."
    sudo umount "$MOUNT_PATH" || sudo diskutil unmount force "$MOUNT_PATH"
fi

# Remove mount directory if empty
if [ -d "$MOUNT_PATH" ] && [ -z "$(ls -A $MOUNT_PATH 2>/dev/null)" ]; then
    echo "Removing empty mount directory..."
    sudo rmdir "$MOUNT_PATH" 2>/dev/null || true
fi

echo "NFS storage unmounted successfully"
`;
}

/**
 * Check mount status on a workstation
 */
async function checkMountStatus(instanceId, storageId) {
    const storage = await getStorageById(storageId);
    if (!storage) {
        throw new Error(`Storage not found: ${storageId}`);
    }
    
    const workstation = await getWorkstationById(instanceId);
    if (!workstation) {
        throw new Error(`Workstation not found: ${instanceId}`);
    }
    
    // Get workstation region (may be in a spoke region)
    const workstationRegion = workstation.region || process.env.AWS_REGION;
    console.log(`Workstation ${instanceId} is in region: ${workstationRegion}`);
    
    const platform = workstation.platform?.toLowerCase();
    // Use platform-appropriate mount path: /Volumes for macOS, /mnt for Linux
    const defaultMountPath = platform === 'macos' 
        ? `/Volumes/fsxn-${storageId.substring(0, 8)}`
        : `/mnt/fsxn-${storageId.substring(0, 8)}`;
    const mountPath = workstation.storageConfig?.[storageId]?.mountPath || defaultMountPath;
    
    let script;
    if (platform === 'linux') {
        script = `#!/bin/bash
MOUNT_PATH="${mountPath}"
if mountpoint -q "$MOUNT_PATH" 2>/dev/null; then
    echo "MOUNTED"
else
    echo "NOT_MOUNTED"
fi
`;
    } else if (platform === 'macos') {
        script = `#!/bin/bash
MOUNT_PATH="${mountPath}"
if mount | grep -q "$MOUNT_PATH"; then
    echo "MOUNTED"
else
    echo "NOT_MOUNTED"
fi
`;
    } else {
        throw new Error(`Mount status check not supported on ${platform}`);
    }
    
    // Use regional SSM client
    const ssm = getSSMClient(workstationRegion);
    const commandResult = await ssm.send(new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: 'AWS-RunShellScript',
        Parameters: {
            commands: [script]
        },
        Comment: `Check NFS mount status for ${storageId}`
    }));
    
    console.log(`SSM command sent to ${workstationRegion}: ${commandResult.Command.CommandId}`);
    
    const result = await waitForCommand(commandResult.Command.CommandId, instanceId, 30, workstationRegion);
    
    const output = result.StandardOutputContent || '';
    const isMounted = output.includes('MOUNTED') && !output.includes('NOT_MOUNTED');
    
    return {
        success: true,
        instanceId,
        storageId,
        mounted: isMounted,
        mountPath,
        region: workstationRegion
    };
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
async function waitForCommand(commandId, instanceId, timeoutSeconds = 120, region = null) {
    const ssm = getSSMClient(region);
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
            
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
            if (error.name === 'InvocationDoesNotExist') {
                await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
                throw error;
            }
        }
    }
    
    throw new Error(`Command ${commandId} timed out after ${timeoutSeconds} seconds`);
}
