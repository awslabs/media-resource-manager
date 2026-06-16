// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { SSMClient, SendCommandCommand } = require('@aws-sdk/client-ssm');

// Default SSM client for primary region
const ssm = new SSMClient();

// Helper to create SSM client for specific region
function getSSMClient(region) {
    if (region && region !== process.env.AWS_REGION) {
        return new SSMClient({ region });
    }
    return ssm;
}

exports.handler = async (event) => {
    console.log('Running SSM command:', JSON.stringify(event, null, 2));

    const { instanceId, region, documentName, parameters = {} } = event;
    
    // Use region-specific SSM client for sending commands to the instance
    const targetRegion = region || process.env.AWS_REGION;
    const regionalSsm = getSSMClient(targetRegion);
    
    const commandParams = {
      DocumentName: documentName,
      InstanceIds: [instanceId],
      Parameters: parameters,
      TimeoutSeconds: 300,
      Comment: `Running ${documentName} on workstation ${instanceId}`
    };
    
    console.log(`Sending SSM command ${documentName} to instance ${instanceId} in region ${targetRegion}`);
    const commandResult = await regionalSsm.send(new SendCommandCommand(commandParams));
    const commandId = commandResult.Command.CommandId;
    
    console.log('SSM command sent:', commandId);
    
    // Pass through all input fields plus the command result
    return {
      ...event,
      ssmCommandId: commandId,
      commandStarted: true
    };
};
