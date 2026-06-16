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
    console.log(`Setting macOS hostname to ${hostname} on instance ${instanceId} (region: ${region || 'primary'})`);

    // macOS uses scutil for hostname management
    // There are three types of hostnames on macOS:
    // - ComputerName: User-friendly name shown in Finder
    // - LocalHostName: Bonjour name (used for .local network discovery)
    // - HostName: UNIX hostname
    const commands = [
        '#!/bin/bash',
        'set -e',
        `HOSTNAME="${hostname}"`,
        'echo "Setting macOS hostname to: $HOSTNAME"',
        '',
        '# Set all three hostname types on macOS',
        'sudo scutil --set ComputerName "$HOSTNAME"',
        'sudo scutil --set LocalHostName "$HOSTNAME"',
        'sudo scutil --set HostName "$HOSTNAME"',
        '',
        '# Flush DNS cache to ensure changes take effect',
        'sudo dscacheutil -flushcache',
        '',
        '# Verify the changes',
        'echo "ComputerName: $(scutil --get ComputerName)"',
        'echo "LocalHostName: $(scutil --get LocalHostName)"',
        'echo "HostName: $(scutil --get HostName)"',
        '',
        'echo "Successfully set all hostname types to $HOSTNAME"'
    ];

    const ssm = getSSMClient(region);
    const result = await ssm.send(new SendCommandCommand({
        DocumentName: 'AWS-RunShellScript',
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
