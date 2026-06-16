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
    console.log(`Setting Linux hostname to ${hostname} on instance ${instanceId} (region: ${region || 'primary'})`);

    // Bash script to set hostname (works on Ubuntu, Rocky, RHEL, CentOS)
    const commands = [
        '#!/bin/bash',
        'set -e',
        `HOSTNAME="${hostname}"`,
        'echo "Setting hostname to: $HOSTNAME"',
        '',
        '# Set hostname immediately using hostnamectl',
        'sudo hostnamectl set-hostname "$HOSTNAME"',
        '',
        '# Also update /etc/hostname for persistence',
        'echo "$HOSTNAME" | sudo tee /etc/hostname > /dev/null',
        '',
        '# Update /etc/hosts to include the new hostname',
        'if ! grep -q "$HOSTNAME" /etc/hosts; then',
        '    sudo sed -i "s/127.0.0.1.*/127.0.0.1 localhost $HOSTNAME/" /etc/hosts',
        'fi',
        '',
        '# Verify the change',
        'CURRENT_HOSTNAME=$(hostname)',
        'if [ "$CURRENT_HOSTNAME" = "$HOSTNAME" ]; then',
        '    echo "Successfully set hostname to $HOSTNAME"',
        'else',
        '    echo "Warning: hostname command returned $CURRENT_HOSTNAME instead of $HOSTNAME"',
        '    echo "Hostname will be fully applied after reboot"',
        'fi'
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
