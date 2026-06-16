// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { SSMClient, SendCommandCommand, GetParameterCommand } = require('@aws-sdk/client-ssm');

// Default SSM client for primary region (parameter store lookups)
const ssm = new SSMClient();

// Helper to create SSM client for specific region
function getSSMClient(region) {
    if (region && region !== process.env.AWS_REGION) {
        return new SSMClient({ region });
    }
    return ssm;
}

exports.handler = async (event) => {
    console.log('Installing DCV and SM Agent:', JSON.stringify(event, null, 2));

    const { instanceId, region } = event;
    const pascalCaseName = process.env.PASCAL_CASE_NAME;
    
    // Use region-specific SSM client for sending commands to the instance
    const targetRegion = region || process.env.AWS_REGION;
    const regionalSsm = getSSMClient(targetRegion);

    // Get the Session Manager endpoint from SSM Parameter Store
    // For satellite regions, fetch from that region's parameter store to get the regional endpoint
    const parameterName = `/${pascalCaseName}/DCV/SessionManager/Endpoint`;
    console.log('Getting SSM parameter:', parameterName, 'from region:', targetRegion);
    
    const parameterSsm = getSSMClient(targetRegion);
    const getParameterResult = await parameterSsm.send(new GetParameterCommand({
      Name: parameterName
    }));
    const sessionManagerEndpoint = getParameterResult.Parameter.Value;
    
    console.log('Retrieved Session Manager endpoint:', sessionManagerEndpoint);
    
    // Use the custom SSM document name from environment or default
    const documentName = process.env.DCV_INSTALL_DOCUMENT_NAME || `${pascalCaseName}-Windows-DCV-Install`;
    
    const commandParams = {
      DocumentName: documentName,
      InstanceIds: [instanceId],
      Parameters: {
        SessMgrDNS: [sessionManagerEndpoint]
      },
      Comment: `Installing DCV and SMAgent on workstation ${instanceId}`
    };
    
    console.log(`Sending SSM command to instance ${instanceId} in region ${targetRegion}`);
    const commandResult = await regionalSsm.send(new SendCommandCommand(commandParams));
    const commandId = commandResult.Command.CommandId;
    
    console.log('SSM command sent:', commandId);
    
    return {
      ...event,
      ssmCommandId: commandId,
      installationStarted: true
    };
};