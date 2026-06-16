// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { SSMClient, SendCommandCommand, GetParametersByPathCommand } = require('@aws-sdk/client-ssm');

const ssm = new SSMClient();

exports.handler = async (event) => {
    console.log('Joining workstation to domain:', JSON.stringify(event, null, 2));

    const { instanceId } = event;
    const pascalCaseName = process.env.PASCAL_CASE_NAME;

    try {
        // Get Active Directory parameters
        const adParamsResponse = await ssm.send(new GetParametersByPathCommand({
            Path: `/${pascalCaseName}/Identity`,
            Recursive: true
        }));
        
        if (!adParamsResponse.Parameters || adParamsResponse.Parameters.length === 0) {
          throw new Error(`No Active Directory parameters found at path /${pascalCaseName}/Identity`);
        }
        
        const adParams = {};
        adParamsResponse.Parameters.forEach(param => {
          const key = param.Name.split('/').pop();
          adParams[key] = param.Value;
        });
        
        console.log('Found AD parameters:', Object.keys(adParams));
        
        // Validate required parameters exist
        const requiredParams = ['ActiveDirectoryId', 'ActiveDirectoryDomainName'];
        for (const param of requiredParams) {
          if (!adParams[param]) {
            throw new Error(`Required parameter ${param} not found in /${pascalCaseName}/Identity`);
          }
        }
        
        const commandParams = {
          DocumentName: 'AWS-JoinDirectoryServiceDomain-V2',
          InstanceIds: [instanceId],
          Parameters: {
            directoryId: [adParams.ActiveDirectoryId],
            directoryName: [adParams.ActiveDirectoryDomainName],
            dnsIpAddresses: adParams.ActiveDirectoryServerIP1 && adParams.ActiveDirectoryServerIP2 
              ? [adParams.ActiveDirectoryServerIP1, adParams.ActiveDirectoryServerIP2]
              : []
          },
          Comment: `Joining workstation ${instanceId} to domain ${adParams.ActiveDirectoryDomainName}`
        };
        
        const commandResult = await ssm.send(new SendCommandCommand(commandParams));
        const commandId = commandResult.Command.CommandId;
        
        return {
          ...event,
          domainJoinCommandId: commandId,
          directoryName: adParams.ActiveDirectoryDomainName
        };
    } catch (error) {
        console.error('Error joining domain:', error);
        throw error;
    }
};