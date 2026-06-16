// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { SSMClient, GetCommandInvocationCommand } = require('@aws-sdk/client-ssm');

const ssm = new SSMClient();

exports.handler = async (event) => {
    console.log('Checking domain join status:', JSON.stringify(event, null, 2));

    const { instanceId, domainJoinCommandId } = event;

    try {
        const result = await ssm.send(new GetCommandInvocationCommand({
            CommandId: domainJoinCommandId,
            InstanceId: instanceId
        }));

        const status = result.Status;
        console.log('Domain join command status: ' + status);

        if (status === 'Success') {
            console.log('Domain join completed successfully');
            return {
                ...event,
                domainJoinComplete: true,
                domainJoinStatus: status
            };
        } else if (status === 'InProgress') {
            console.log('Domain join still in progress');
            return {
                ...event,
                domainJoinComplete: false,
                domainJoinStatus: status
            };
        } else {
            console.log('Domain join failed with status: ' + status);
            console.log('Command output:', result.StandardOutputContent);
            console.log('Command error:', result.StandardErrorContent);
            return {
                ...event,
                domainJoinComplete: false,
                domainJoinStatus: status,
                error: `Domain join failed: \${status}`
              };
            }
          } catch (error) {
            console.error('Error checking domain join status:', error);
            return {
              ...event,
              domainJoinComplete: false,
              error: error.message
            };
          }
        };