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
    const { instanceId, region } = event;
    console.log(`Rebooting instance: ${instanceId} in region: ${region || 'primary'}`);
    const ec2 = getEC2Client(region);
    await ec2.send(new RebootInstancesCommand({ InstanceIds: [instanceId] }));
    return { ...event, rebootInitiated: true };
};