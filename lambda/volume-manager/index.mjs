// Copyright © 2025 Amazon.com and Affiliates.
// Volume Manager — Lambda durable function for reliable EBS volume operations.
// Uses checkpoint/replay to ensure create→attach and detach→delete workflows
// complete reliably even if the function is interrupted.

import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import {
  EC2Client,
  CreateVolumeCommand,
  AttachVolumeCommand,
  DetachVolumeCommand,
  DeleteVolumeCommand,
  ModifyVolumeCommand,
  DescribeVolumesCommand,
  DescribeInstancesCommand,
} from '@aws-sdk/client-ec2';
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient());

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'OPTIONS,POST,GET',
};

function response(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...corsHeaders }, body: JSON.stringify(body) };
}

// Helper: get workstation record from DynamoDB
async function getWorkstation(instanceId) {
  const result = await dynamodb.send(new GetCommand({
    TableName: process.env.WORKSTATION_TABLE_NAME,
    Key: { instanceId }
  }));
  return result.Item;
}

// Helper: get regional EC2 and SSM clients
function getClients(region) {
  const primaryRegion = process.env.AWS_REGION;
  const targetRegion = (region && region !== primaryRegion) ? region : primaryRegion;
  return {
    ec2: new EC2Client({ region: targetRegion }),
    ssm: new SSMClient({ region: targetRegion }),
  };
}

// Helper: get current instance state
async function getInstanceState(ec2, instanceId) {
  const result = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  return result.Reservations?.[0]?.Instances?.[0]?.State?.Name;
}

// Helper: run SSM command and wait for completion
async function runSsmCommand(ssm, instanceId, platform, commands) {
  const documentName = platform?.toLowerCase() === 'windows'
    ? 'AWS-RunPowerShellScript'
    : 'AWS-RunShellScript';

  const result = await ssm.send(new SendCommandCommand({
    InstanceIds: [instanceId],
    DocumentName: documentName,
    Parameters: { commands },
    TimeoutSeconds: 60,
    Comment: 'Extend file system after EBS volume resize',
  }));

  const commandId = result.Command.CommandId;
  console.log(`SSM command ${commandId} sent to ${instanceId}`);

  // Poll for completion
  let attempts = 0;
  while (attempts < 12) { // 60 seconds max
    await new Promise(resolve => setTimeout(resolve, 5000));
    try {
      const invocation = await ssm.send(new GetCommandInvocationCommand({
        CommandId: commandId,
        InstanceId: instanceId,
      }));
      const status = invocation.Status;
      console.log(`SSM command ${commandId} status: ${status}`);
      if (status === 'Success') return { success: true, output: invocation.StandardOutputContent };
      if (['Failed', 'Cancelled', 'TimedOut', 'DeliveryTimedOut'].includes(status)) {
        throw new Error(`SSM command failed with status ${status}: ${invocation.StandardErrorContent}`);
      }
    } catch (err) {
      if (err.name !== 'InvocationDoesNotExist') throw err;
    }
    attempts++;
  }
  throw new Error('SSM command timed out waiting for completion');
}

// ─── Add Volume ──────────────────────────────────────────────────────────────
async function handleAddVolume(event, context) {
  const { instanceId, size, volumeType = 'gp3', deviceName } = event.body;

  if (!instanceId || !size || !deviceName) {
    return response(400, { error: 'instanceId, size, and deviceName are required' });
  }

  const workstation = await getWorkstation(instanceId);
  if (!workstation) return response(404, { error: 'Workstation not found' });

  const { ec2 } = getClients(workstation.region);

  // Step 1: Get instance AZ
  const instanceInfo = await context.step(async () => {
    const result = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const instance = result.Reservations?.[0]?.Instances?.[0];
    if (!instance) throw new Error(`EC2 instance ${instanceId} not found`);
    return { availabilityZone: instance.Placement?.AvailabilityZone };
  });

  // Step 2: Create the EBS volume
  const volumeId = await context.step(async () => {
    const result = await ec2.send(new CreateVolumeCommand({
      AvailabilityZone: instanceInfo.availabilityZone,
      Size: size,
      VolumeType: volumeType,
      TagSpecifications: [{
        ResourceType: 'volume',
        Tags: [
          { Key: 'Name', Value: `${workstation.workstationName || instanceId}-data` },
          { Key: 'ManagedBy', Value: process.env.PASCAL_CASE_NAME || 'MediaResourceManager' },
          { Key: 'InstanceId', Value: instanceId }
        ]
      }]
    }));
    console.log(`Created volume ${result.VolumeId} (${size}GB ${volumeType})`);
    return result.VolumeId;
  });

  // Wait: poll until volume is available
  await context.waitForCondition(
    'wait-for-volume-available',
    async (state) => {
      const result = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
      const volState = result.Volumes?.[0]?.State;
      console.log(`Volume ${volumeId} state: ${volState}`);
      return { ...state, isAvailable: volState === 'available' };
    },
    {
      initialState: { isAvailable: false },
      waitStrategy: (state) => {
        if (state.isAvailable) return { shouldContinue: false };
        return { shouldContinue: true, delay: { seconds: 5 } };
      },
    }
  );

  // Step 3: Attach the volume
  await context.step(async () => {
    await ec2.send(new AttachVolumeCommand({ VolumeId: volumeId, InstanceId: instanceId, Device: deviceName }));
    console.log(`Attached volume ${volumeId} to ${instanceId} as ${deviceName}`);
  });

  return response(200, {
    message: `Volume ${volumeId} created and attached as ${deviceName}`,
    volumeId, deviceName, size, volumeType
  });
}

// ─── Resize Volume ───────────────────────────────────────────────────────────
async function handleResizeVolume(event, context) {
  const { instanceId, volumeId, newSize } = event.body;

  if (!instanceId || !volumeId || !newSize) {
    return response(400, { error: 'instanceId, volumeId, and newSize are required' });
  }

  const workstation = await getWorkstation(instanceId);
  if (!workstation) return response(404, { error: 'Workstation not found' });

  const { ec2, ssm } = getClients(workstation.region);
  const platform = workstation.platform?.toLowerCase();

  // Step 1: Validate and resize the volume
  await context.step(async () => {
    const volumesResult = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
    const volume = volumesResult.Volumes?.[0];
    if (!volume) throw new Error(`Volume ${volumeId} not found`);
    if (newSize <= volume.Size) throw new Error(`New size (${newSize}GB) must be larger than current size (${volume.Size}GB)`);
    await ec2.send(new ModifyVolumeCommand({ VolumeId: volumeId, Size: newSize }));
    console.log(`Resized volume ${volumeId} to ${newSize}GB`);
  });

  // Wait: poll until instance is running so we can extend the file system via SSM.
  // The durable function suspends here without incurring compute charges.
  // macOS doesn't support online resize extension via SSM — skip it.
  if (platform !== 'macos') {
    await context.waitForCondition(
      'wait-for-instance-running',
      async (state) => {
        const instanceState = await getInstanceState(ec2, instanceId);
        console.log(`Instance ${instanceId} state: ${instanceState} — waiting for running to extend file system`);
        return { ...state, isRunning: instanceState === 'running' };
      },
      {
        initialState: { isRunning: false },
        waitStrategy: (state) => {
          if (state.isRunning) return { shouldContinue: false };
          return { shouldContinue: true, delay: { seconds: 30 } };
        },
      }
    );

    // Step 2: Extend the file system via SSM
    await context.step(async () => {
      let commands;
      if (platform === 'windows') {
        commands = [
          // Extend all partitions on all disks to use full available space
          'Get-Disk | ForEach-Object { $disk = $_; Get-Partition -DiskNumber $disk.Number | Where-Object { $_.Type -ne "Reserved" -and $_.DriveLetter } | ForEach-Object { $size = (Get-PartitionSupportedSize -DiskNumber $disk.Number -PartitionNumber $_.PartitionNumber).SizeMax; Resize-Partition -DiskNumber $disk.Number -PartitionNumber $_.PartitionNumber -Size $size } }'
        ];
      } else {
        // Linux (Ubuntu, Rocky, Amazon Linux) — detect filesystem type and extend accordingly
        commands = [
          // Grow the partition first (works for both xvd* and nvme* device names)
          'ROOT_DISK=$(lsblk -no PKNAME $(findmnt -n -o SOURCE /) | head -1)',
          'ROOT_PART=$(findmnt -n -o SOURCE /)',
          'PART_NUM=$(echo $ROOT_PART | grep -o "[0-9]*$")',
          'sudo growpart /dev/$ROOT_DISK $PART_NUM || true',
          // Detect filesystem type and extend
          'FS_TYPE=$(df -T / | tail -1 | awk \'{print $2}\')',
          'if [ "$FS_TYPE" = "xfs" ]; then sudo xfs_growfs /; elif [ "$FS_TYPE" = "ext4" ] || [ "$FS_TYPE" = "ext3" ]; then sudo resize2fs $ROOT_PART; fi',
          'echo "File system extension complete. New size: $(df -h / | tail -1 | awk \'{print $2}\')"'
        ];
      }

      const result = await runSsmCommand(ssm, instanceId, platform, commands);
      console.log(`File system extended on ${instanceId}: ${result.output}`);
    });
  }

  return response(200, {
    message: platform === 'macos'
      ? `Volume resize to ${newSize}GB initiated.`
      : `Volume resize to ${newSize}GB complete. File system extended automatically.`,
    volumeId,
    newSize
  });
}

// ─── Detach Volume ───────────────────────────────────────────────────────────
async function handleDetachVolume(event, context) {
  const { instanceId, volumeId, deleteVolume = false } = event.body;

  if (!instanceId || !volumeId) {
    return response(400, { error: 'instanceId and volumeId are required' });
  }

  const workstation = await getWorkstation(instanceId);
  if (!workstation) return response(404, { error: 'Workstation not found' });

  const { ec2 } = getClients(workstation.region);

  // Step 1: Verify not root volume, then detach
  await context.step(async () => {
    const describeResult = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const instance = describeResult.Reservations?.[0]?.Instances?.[0];
    const rootDeviceName = instance?.RootDeviceName;
    const bdm = instance?.BlockDeviceMappings?.find(b => b.Ebs?.VolumeId === volumeId);
    if (bdm?.DeviceName === rootDeviceName) throw new Error('Cannot detach the root volume');
    await ec2.send(new DetachVolumeCommand({ VolumeId: volumeId, InstanceId: instanceId, Force: false }));
    console.log(`Detached volume ${volumeId} from ${instanceId}`);
  });

  if (deleteVolume) {
    // Wait: poll until volume is available after detach
    await context.waitForCondition(
      'wait-for-volume-detached',
      async (state) => {
        const result = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
        const volState = result.Volumes?.[0]?.State;
        console.log(`Volume ${volumeId} state: ${volState}`);
        return { ...state, isAvailable: volState === 'available' };
      },
      {
        initialState: { isAvailable: false },
        waitStrategy: (state) => {
          if (state.isAvailable) return { shouldContinue: false };
          return { shouldContinue: true, delay: { seconds: 5 } };
        },
      }
    );

    // Step 2: Delete the volume
    await context.step(async () => {
      await ec2.send(new DeleteVolumeCommand({ VolumeId: volumeId }));
      console.log(`Deleted volume ${volumeId}`);
    });
  }

  return response(200, {
    message: deleteVolume ? `Volume ${volumeId} detached and deleted` : `Volume ${volumeId} detached successfully`,
    volumeId,
    deleted: deleteVolume
  });
}

// ─── Main handler ────────────────────────────────────────────────────────────
export const handler = withDurableExecution(async (event, context) => {
  console.log('Volume manager event:', JSON.stringify({ path: event.path, method: event.httpMethod }, null, 2));

  const { httpMethod: method, path } = event;

  if (method === 'POST') {
    const body = JSON.parse(event.body || '{}');
    const enrichedEvent = { ...event, body };

    if (path === '/workstations/volumes/add') return await handleAddVolume(enrichedEvent, context);
    if (path === '/workstations/volumes/resize') return await handleResizeVolume(enrichedEvent, context);
    if (path === '/workstations/volumes/detach') return await handleDetachVolume(enrichedEvent, context);
  }

  return response(404, { error: 'Route not found' });
});
