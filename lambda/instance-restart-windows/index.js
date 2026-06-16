// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { EC2Client, RebootInstancesCommand } = require('@aws-sdk/client-ec2');

// Helper to create EC2 client for specific region
function getEC2Client(region) {
    if (region && region !== process.env.AWS_REGION) {
        return new EC2Client({ region });
    }
    return new EC2Client();
}

exports.handler = async (event) => {
    console.log('Restarting instance after domain join:', JSON.stringify(event, null, 2));

    const { instanceId, region } = event;

    try {
        const ec2 = getEC2Client(region);
        await ec2.send(new RebootInstancesCommand({
            InstanceIds: [instanceId]
        }));

        console.log(`Instance ${instanceId} restart initiated in region ${region || 'primary'}`);

        return {
            ...event,
            restartInitiated: true
        };
    } catch (error) {
        console.error('Error restarting instance:', error);
        throw error;
    }
};