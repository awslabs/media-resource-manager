// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { SSMClient, SendCommandCommand, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');

// Helper to create SSM client for specific region
function getSSMClient(region) {
    if (region && region !== process.env.AWS_REGION) {
        return new SSMClient({ region });
    }
    return new SSMClient();
}

// Get Session Manager endpoint - from regional hub for satellite regions, SSM parameter for primary
async function getSessionManagerEndpoint(region, pascalCaseName) {
    const primaryRegion = process.env.AWS_REGION;
    
    // For satellite regions, look up from regional hubs DynamoDB table
    if (region && region !== primaryRegion) {
        console.log(`Looking up Session Manager endpoint for satellite region: ${region}`);
        const dynamodb = new DynamoDBClient({ region: primaryRegion }); // Table is in primary region
        const tableName = process.env.REGIONAL_HUBS_TABLE_NAME;
        
        const result = await dynamodb.send(new GetItemCommand({
            TableName: tableName,
            Key: { region: { S: region } }
        }));
        
        if (result.Item && result.Item.sessionManagerEndpoint) {
            const endpoint = result.Item.sessionManagerEndpoint.S;
            console.log(`Found regional Session Manager endpoint: ${endpoint}`);
            return endpoint;
        }
        
        console.warn(`No regional hub found for ${region}, falling back to primary region endpoint`);
    }
    
    // Primary region - use SSM parameter
    const primarySsm = new SSMClient();
    const sessMgrResult = await primarySsm.send(new GetParameterCommand({
        Name: '/' + pascalCaseName + '/DCV/SessionManager/Endpoint'
    }));
    return sessMgrResult.Parameter.Value;
}

exports.handler = async (event) => {
    const { instanceId, documentName, phase, region } = event;
    console.log('Running SSM command:', documentName, 'on', instanceId, '(region:', region || 'primary', ')');

    const ssm = getSSMClient(region);
    let parameters = {};

    // Phase 1 needs Session Manager DNS and Admin Password Secret ARN
    if (phase === 1) {
        const pascalCaseName = process.env.PASCAL_CASE_NAME;
        
        // Get Session Manager endpoint (regional for satellite regions, primary otherwise)
        const sessMgrDns = await getSessionManagerEndpoint(region, pascalCaseName);
        
        // Admin password secret ARN is always in primary region
        const primarySsm = new SSMClient();
        const secretArnResult = await primarySsm.send(new GetParameterCommand({
            Name: '/' + pascalCaseName + '/Workstation/StandaloneAdminPasswordSecretArn'
        }));
        
        parameters = {
            SessMgrDNS: [sessMgrDns],
            AdminPasswordSecretArn: [secretArnResult.Parameter.Value]
        };
        
        console.log(`Phase 1 parameters: SessMgrDNS=${sessMgrDns}`);
    }

    const result = await ssm.send(new SendCommandCommand({
        DocumentName: documentName,
        InstanceIds: [instanceId],
        Parameters: parameters,
        Comment: 'Linux DCV Phase ' + phase + ' on ' + instanceId
    }));

    return { ...event, ssmCommandId: result.Command.CommandId, commandPhase: phase };
};