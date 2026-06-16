// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { SSMClient, SendCommandCommand } = require('@aws-sdk/client-ssm');

// Max retries for SSM command - reduced since SSM readiness is now checked before calling this
const MAX_AUTOLOGIN_RETRIES = 5; // 5 retries as a safety net (SSM should already be ready)

// Helper to create SSM client for specific region
function getSSMClient(region) {
  if (region && region !== process.env.AWS_REGION) {
    return new SSMClient({ region });
  }
  return new SSMClient();
}

exports.handler = async (event) => {
  console.log('Configuring macOS auto-login:', JSON.stringify(event, null, 2));
  
  const { instanceId, region } = event;
  
  // Track retry count
  const retryCount = (event.autoLoginRetryCount || 0) + 1;
  console.log(`macOS autologin attempt ${retryCount}/${MAX_AUTOLOGIN_RETRIES}`);
  
  // Check if we've exceeded max retries
  if (retryCount > MAX_AUTOLOGIN_RETRIES) {
    console.log(`Max retries (${MAX_AUTOLOGIN_RETRIES}) exceeded, continuing without autologin config`);
    return {
      ...event,
      autoLoginRetryCount: retryCount,
      autoLoginCommandId: null,
      autoLoginMaxRetriesExceeded: true,
      autoLoginComplete: false,
      autoLoginError: 'MaxRetriesExceeded',
      autoLoginErrorMessage: `SSM agent not ready after ${MAX_AUTOLOGIN_RETRIES} attempts`
    };
  }
  
  const ssm = getSSMClient(region);
  
  // Shell script to configure macOS autologin on workstation start
  const commands = [
    '#!/bin/bash',
    'set -e',
    'echo "=== Configuring macOS autologin on workstation start ==="',
    '',
    'DEFAULT_USER="ec2-user"',
    '',
    '# Configure autologin user',
    'sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser "$DEFAULT_USER"',
    '',
    '# Disable screensaver and sleep',
    'sudo defaults write /Library/Preferences/com.apple.screensaver idleTime 0',
    'sudo defaults write /Library/Preferences/com.apple.screensaver askForPassword 0',
    'sudo pmset -a displaysleep 0',
    'sudo pmset -a sleep 0',
    '',
    '# Check if user is already logged in',
    'LOGGED_IN_USER=$(stat -f "%Su" /dev/console 2>/dev/null || echo "none")',
    'echo "Currently logged in user: $LOGGED_IN_USER"',
    '',
    'if [ "$LOGGED_IN_USER" = "$DEFAULT_USER" ]; then',
    '  echo "SUCCESS: $DEFAULT_USER is already logged in"',
    '  exit 0',
    'fi',
    '',
    '# User not logged in - this is expected on fresh start',
    '# The autologin settings are configured, user will be logged in on next GUI restart',
    'echo "Autologin configured for $DEFAULT_USER"',
    'echo "macOS autologin configuration complete!"'
  ];
  
  try {
    const commandResult = await ssm.send(new SendCommandCommand({
      DocumentName: 'AWS-RunShellScript',
      InstanceIds: [instanceId],
      Parameters: { commands },
      TimeoutSeconds: 120,
      Comment: 'Configure macOS auto-login for workstation start'
    }));
    
    const commandId = commandResult.Command.CommandId;
    console.log('macOS auto-login configuration command sent, CommandId:', commandId);
    
    return {
      ...event,
      autoLoginRetryCount: retryCount,
      autoLoginCommandId: commandId,
      autoLoginMaxRetriesExceeded: false
    };
  } catch (error) {
    console.error('Error sending macOS auto-login configuration command:', error);
    // Return error info with retry count - let state machine handle retry
    return {
      ...event,
      autoLoginRetryCount: retryCount,
      autoLoginCommandId: null,
      autoLoginMaxRetriesExceeded: false,
      autoLoginError: error.name,
      autoLoginErrorMessage: error.message
    };
  }
};
