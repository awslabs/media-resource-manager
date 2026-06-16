// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { EC2Client, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');

// Helper to create EC2 client for specific region
function getEC2Client(region) {
    if (region && region !== process.env.AWS_REGION) {
        return new EC2Client({ region });
    }
    return new EC2Client();
}

exports.handler = async (event) => {
    const { instanceId, region } = event;
    const ec2 = getEC2Client(region);
    const result = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const state = result.Reservations[0].Instances[0].State.Name;
    console.log(`Instance ${instanceId} state: ${state} (region: ${region || 'primary'})`);
    return { ...event, instanceState: state, isRunning: state === 'running' };
};