// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { SSMClient, DescribeInstanceInformationCommand } = require('@aws-sdk/client-ssm');

// Helper to create SSM client for specific region
function getSSMClient(region) {
    if (region && region !== process.env.AWS_REGION) {
        return new SSMClient({ region });
    }
    return new SSMClient();
}

exports.handler = async (event) => {
    console.log('Checking SSM readiness:', JSON.stringify(event, null, 2));

    const { instanceId, region } = event;
    const ssm = getSSMClient(region);

    try {
        const result = await ssm.send(new DescribeInstanceInformationCommand({
            Filters: [{
                Key: 'InstanceIds',
                Values: [instanceId]
            }]
        }));

        const isSSMReady = result.InstanceInformationList && result.InstanceInformationList.length > 0;

        console.log('Instance ' + instanceId + ' SSM ready: ' + isSSMReady + ' (region: ' + (region || 'primary') + ')');

        return {
            ...event,
            isSSMReady
        };
    } catch (error) {
        console.log('SSM not ready for instance ' + instanceId + ': ' + error.message);
        return {
            ...event,
            isSSMReady: false
        };
    }
};