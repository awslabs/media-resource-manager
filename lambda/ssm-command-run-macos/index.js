// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { SSMClient, SendCommandCommand, GetParameterCommand } = require('@aws-sdk/client-ssm');

// Helper to create SSM client for specific region
function getSSMClient(region) {
    if (region && region !== process.env.AWS_REGION) {
        return new SSMClient({ region });
    }
    return new SSMClient();
}

exports.handler = async (event) => {
    const { instanceId, documentName, phase, region } = event;
    console.log('Running SSM command:', documentName, 'on', instanceId, 'in region:', region || 'primary');

    let parameters = {};
    const pascalCaseName = process.env.PASCAL_CASE_NAME;

    if (phase === 1) {
        // Use regional SSM client to get the Session Manager endpoint
        // For satellite regions, the endpoint is written to SSM in that region by the regional hub
        const ssmForParams = getSSMClient(region);
        const sessMgrResult = await ssmForParams.send(new GetParameterCommand({
            Name: '/' + pascalCaseName + '/DCV/SessionManager/Endpoint'
        }));
        parameters = {
            SessMgrDNS: [sessMgrResult.Parameter.Value],
            BrokerPort: ['8445']
        };
        console.log(`Phase 1 parameters: SessMgrDNS=${sessMgrResult.Parameter.Value} (from region: ${region || 'primary'})`);
    } else if (phase === 2) {
        // Admin password secret ARN is always in primary region
        const primarySSM = new SSMClient();
        const secretArnResult = await primarySSM.send(new GetParameterCommand({
            Name: '/' + pascalCaseName + '/Workstation/StandaloneAdminPasswordSecretArn'
        }));
        parameters = {
            Username: ['ec2-user'],
            AdminPasswordSecretArn: [secretArnResult.Parameter.Value]
        };
    }

    // Use region-specific client for SSM commands to the instance
    const ssm = getSSMClient(region);
    console.log(`Sending SSM command to instance ${instanceId} in region ${region || 'primary'}`);

    const result = await ssm.send(new SendCommandCommand({
        DocumentName: documentName,
        InstanceIds: [instanceId],
        Parameters: parameters,
        Comment: 'macOS DCV Phase ' + phase + ' on ' + instanceId
    }));

    return { ...event, ssmCommandId: result.Command.CommandId, commandPhase: phase };
};
