// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { SSMClient, SendCommandCommand } = require('@aws-sdk/client-ssm');

// Helper to create SSM client for specific region
function getSSMClient(region) {
    if (region && region !== process.env.AWS_REGION) {
        return new SSMClient({ region });
    }
    return new SSMClient();
}

/**
 * Reboots a macOS EC2 instance using SSM to run shutdown command.
 * 
 * IMPORTANT: We use SSM + shutdown command instead of EC2 RebootInstances API because:
 * - macOS auto-login requires a proper OS-level shutdown/restart sequence
 * - EC2 RebootInstances API may not trigger the same boot sequence that activates auto-login
 * - Using 'sudo shutdown -r now' ensures macOS goes through its normal restart flow
 *   which properly reads /etc/kcpassword and com.apple.loginwindow.autoLoginUser
 */
exports.handler = async (event) => {
    const { instanceId, region } = event;
    console.log(`Rebooting macOS instance via SSM: ${instanceId} (region: ${region || 'primary'})`);
    console.log('Reason: Activating auto-login configuration');
    
    const ssm = getSSMClient(region);
    
    // Use SSM to run shutdown command - this triggers a proper macOS restart
    // that will activate auto-login settings
    const command = await ssm.send(new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: 'AWS-RunShellScript',
        Comment: `Reboot macOS instance ${instanceId} for auto-login activation`,
        Parameters: {
            commands: [
                '#!/bin/bash',
                'echo "Initiating macOS reboot for auto-login activation..."',
                // Small delay to ensure SSM command is acknowledged before reboot
                'sleep 2',
                'sudo shutdown -r now'
            ]
        },
        TimeoutSeconds: 60
    }));
    
    console.log('Reboot command sent via SSM, CommandId:', command.Command?.CommandId);
    console.log('Instance will reboot momentarily');
    
    return { 
        ...event, 
        rebootInitiated: true,
        rebootCommandId: command.Command?.CommandId 
    };
};
