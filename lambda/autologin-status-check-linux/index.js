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
  console.log('Checking Linux auto-login config status:', JSON.stringify(event, null, 2));
  
  const { instanceId, autoLoginCommandId, region } = event;
  const ssm = getSSMClient(region);
  
  try {
    const result = await ssm.send(new GetCommandInvocationCommand({
      CommandId: autoLoginCommandId,
      InstanceId: instanceId
    }));
    
    const status = result.Status;
    console.log('Linux auto-login config command status:', status);
    
    if (status === 'Success') {
      console.log('Linux auto-login configuration completed successfully');
      console.log('Output:', result.StandardOutputContent);
      return {
        ...event,
        autoLoginComplete: true,
        autoLoginInProgress: false,
        autoLoginStatus: status
      };
    } else if (status === 'InProgress' || status === 'Pending' || status === 'Delayed') {
      console.log('Linux auto-login configuration still in progress');
      return {
        ...event,
        autoLoginComplete: false,
        autoLoginInProgress: true,
        autoLoginStatus: status
      };
    } else {
      console.log('Linux auto-login configuration failed with status:', status);
      console.log('Output:', result.StandardOutputContent);
      console.log('Error:', result.StandardErrorContent);
      return {
        ...event,
        autoLoginComplete: false,
        autoLoginInProgress: false,
        autoLoginStatus: status,
        error: 'Linux auto-login configuration failed: ' + status
      };
    }
  } catch (error) {
    console.error('Error checking Linux auto-login config status:', error);
    // If we get InvocationDoesNotExist, the command hasn't started yet - treat as in progress
    if (error.name === 'InvocationDoesNotExist') {
      console.log('Command invocation not found yet, treating as in progress');
      return {
        ...event,
        autoLoginComplete: false,
        autoLoginInProgress: true,
        autoLoginStatus: 'Pending'
      };
    }
    return {
      ...event,
      autoLoginComplete: false,
      autoLoginInProgress: false,
      error: error.message
    };
  }
};
