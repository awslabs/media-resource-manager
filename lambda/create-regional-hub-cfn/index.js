// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { CloudFormationClient, CreateStackCommand } = require('@aws-sdk/client-cloudformation');

/**
 * CloudFormation Worker Lambda - Creates CloudFormation stack in target region
 * Called by the Regional Hub Creation State Machine
 */
exports.handler = async (event) => {
  console.log('CreateRegionalHubCfn event:', JSON.stringify(event, null, 2));
  
  const { region, stackName, templateUrl, parameters } = event;
  
  if (!region || !stackName || !templateUrl) {
    throw new Error('Missing required parameters: region, stackName, templateUrl');
  }
  
  // Get the CloudFormation service role ARN from environment
  const cfnServiceRoleArn = process.env.CFN_SERVICE_ROLE_ARN;
  if (!cfnServiceRoleArn) {
    throw new Error('CFN_SERVICE_ROLE_ARN environment variable not set');
  }
  
  // Create CloudFormation client for the TARGET region
  const cfn = new CloudFormationClient({ region });
  
  try {
    // Create the stack in the target region using the service role
    const createResult = await cfn.send(new CreateStackCommand({
      StackName: stackName,
      TemplateURL: templateUrl,
      Parameters: parameters || [],
      Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
      RoleARN: cfnServiceRoleArn,
      Tags: [
        { Key: 'ManagedBy', Value: process.env.PRODUCT_NAME || 'MediaResourceManager' },
        { Key: 'CreatedBy', Value: 'RegionalHubStateMachine' }
      ]
    }));
    
    console.log('Stack creation initiated:', createResult.StackId);
    
    return {
      stackId: createResult.StackId,
      stackName,
      region,
      status: 'CREATE_IN_PROGRESS'
    };
  } catch (error) {
    console.error('Error creating stack:', error);
    throw error;
  }
};
