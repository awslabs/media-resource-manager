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
  console.log('Checking macOS auto-login status:', JSON.stringify(event, null, 2));
  
  const { instanceId, autoLoginCommandId, autoLoginError, autoLoginRetryCount, autoLoginMaxRetriesExceeded, region } = event;
  const ssm = getSSMClient(region);
  
  // If max retries exceeded, pass through to let state machine handle it
  if (autoLoginMaxRetriesExceeded) {
    console.log('Max retries exceeded, passing through');
    return {
      ...event,
      autoLoginComplete: false,
      autoLoginInProgress: false,
      autoLoginNeedsRetry: false
    };
  }
  
  // If there was an error sending the command (e.g., SSM agent not ready), signal retry
  if (autoLoginError) {
    console.log(`Previous command failed with error: ${autoLoginError} (attempt ${autoLoginRetryCount || 'unknown'})`);
    return {
      ...event,
      autoLoginComplete: false,
      autoLoginInProgress: false,
      autoLoginNeedsRetry: true,
      autoLoginError: autoLoginError
    };
  }
  
  if (!autoLoginCommandId) {
    console.log('No command ID provided');
    return {
      ...event,
      autoLoginComplete: false,
      autoLoginInProgress: false,
      autoLoginNeedsRetry: true
    };
  }
  
  try {
    const result = await ssm.send(new GetCommandInvocationCommand({
      CommandId: autoLoginCommandId,
      InstanceId: instanceId
    }));
    
    const status = result.Status;
    console.log('Command status:', status);
    console.log('Output:', result.StandardOutputContent?.slice(-500));
    
    if (result.StandardErrorContent) {
      console.log('Errors:', result.StandardErrorContent?.slice(-500));
    }
    
    const isComplete = status === 'Success';
    const isFailed = status === 'Failed' || status === 'Cancelled' || status === 'TimedOut';
    const isInProgress = ['Pending', 'InProgress', 'Delayed'].includes(status);
    
    return {
      ...event,
      autoLoginComplete: isComplete,
      autoLoginInProgress: isInProgress,
      autoLoginFailed: isFailed,
      autoLoginNeedsRetry: false,
      commandStatus: status,
      standardOutput: (result.StandardOutputContent || '').slice(-500),
      standardError: (result.StandardErrorContent || '').slice(-500)
    };
  } catch (error) {
    console.error('Error checking command status:', error);
    
    // InvocationDoesNotExist means command hasn't started yet - keep polling
    if (error.name === 'InvocationDoesNotExist') {
      return {
        ...event,
        autoLoginComplete: false,
        autoLoginInProgress: true,
        autoLoginNeedsRetry: false
      };
    }
    
    // Other errors - signal retry
    return {
      ...event,
      autoLoginComplete: false,
      autoLoginInProgress: false,
      autoLoginNeedsRetry: true,
      autoLoginError: error.name
    };
  }
};
