// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { SSMClient, GetCommandInvocationCommand } = require('@aws-sdk/client-ssm');

// Helper to create SSM client for specific region
function getSSMClient(region) {
    if (region && region !== process.env.AWS_REGION) {
        return new SSMClient({ region });
    }
    return new SSMClient();
}

exports.handler = async (event) => {
    const { instanceId, ssmCommandId, region } = event;
    const ssm = getSSMClient(region);

    console.log(`Checking SSM command ${ssmCommandId} for instance ${instanceId} in region ${region || 'default'}`);

    try {
        const result = await ssm.send(new GetCommandInvocationCommand({
            CommandId: ssmCommandId,
            InstanceId: instanceId
        }));

        const status = result.Status;
        console.log(`SSM command status: ${status}`);

        return {
            ...event,
            commandStatus: status,
            commandSucceeded: status === 'Success',
            commandFailed: status === 'Failed' || status === 'Cancelled' || status === 'TimedOut',
            commandInProgress: ['Pending', 'InProgress', 'Delayed'].includes(status),
            standardOutput: (result.StandardOutputContent || '').slice(-500),
            standardError: (result.StandardErrorContent || '').slice(-500)
        };
    } catch (e) {
        console.log(`Error checking SSM command (may not be registered yet): ${e.message}`);
        // Command may not be registered yet, return in-progress
        return {
            ...event,
            commandSucceeded: false,
            commandFailed: false,
            commandInProgress: true,
            error: e.message
        };
    }
};
