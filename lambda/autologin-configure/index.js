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

exports.handler = async (event) => {
  console.log('Configuring auto-login for standalone workstation:', JSON.stringify(event, null, 2));
  
  const { instanceId, region } = event;
  const pascalCaseName = process.env.PASCAL_CASE_NAME;
  const primaryRegion = process.env.AWS_REGION || 'us-east-1';
  const ssm = getSSMClient(region);
  
  // Use regional SSM document for auto-login configuration
  // The document is deployed to each regional hub via CloudFormation
  const documentName = `${pascalCaseName}-Windows-AutoLoginConfigure`;
  
  try {
    const commandResult = await ssm.send(new SendCommandCommand({
      DocumentName: documentName,
      InstanceIds: [instanceId],
      Parameters: {
        PascalCaseName: [pascalCaseName],
        PrimaryRegion: [primaryRegion]
      },
      TimeoutSeconds: 600, // 10 minutes for PowerShell module loading
      Comment: 'Configure auto-login for standalone workstation'
    }));
    
    const commandId = commandResult.Command.CommandId;
    console.log('Auto-login configuration command sent, CommandId:', commandId);
    
    return {
      ...event,
      autoLoginCommandId: commandId
    };
  } catch (error) {
    console.error('Error sending auto-login configuration command:', error);
    throw error;
  }
};
