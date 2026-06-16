// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { SSMClient, SendCommandCommand } = require('@aws-sdk/client-ssm');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient());

// Helper to create SSM client for specific region
function getSSMClient(region) {
    if (region && region !== process.env.AWS_REGION) {
        return new SSMClient({ region });
    }
    return new SSMClient();
}

exports.handler = async (event) => {
    const { instanceId, hostname, region } = event;
    console.log(`Setting Windows hostname to ${hostname} on instance ${instanceId} (region: ${region || 'primary'})`);

    const ssm = getSSMClient(region);

    // PowerShell script to rename the computer
    // Note: This requires a reboot to take effect, which happens later in the workflow
    const commands = [
        `$hostname = "${hostname}"`,
        'Write-Host "Setting hostname to: $hostname"',
        'try {',
        '    # Rename the computer',
        '    Rename-Computer -NewName $hostname -Force -ErrorAction Stop',
        '    Write-Host "Successfully renamed computer to $hostname"',
        '    Write-Host "Note: Reboot required for hostname change to take effect"',
        '} catch {',
        '    Write-Host "Error renaming computer: $($_.Exception.Message)"',
        '    exit 1',
        '}'
    ];

    const result = await ssm.send(new SendCommandCommand({
        DocumentName: 'AWS-RunPowerShellScript',
        InstanceIds: [instanceId],
        Parameters: { commands },
        TimeoutSeconds: 120,
        Comment: `Set hostname to ${hostname}`
    }));

    // Update workstation record with hostname
    await dynamodb.send(new UpdateCommand({
        TableName: process.env.WORKSTATION_TABLE_NAME,
        Key: { instanceId },
        UpdateExpression: 'SET hostname = :hostname, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
            ':hostname': hostname,
            ':updatedAt': new Date().toISOString()
        }
    }));

    return {
        ...event,
        hostnameCommandId: result.Command.CommandId,
        hostnameSet: true
    };
};
