// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { IAMClient, PutRolePolicyCommand, GetRoleCommand } = require('@aws-sdk/client-iam');
const iam = new IAMClient();

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event));
  
  const policyName = process.env.POLICY_NAME;
  const policyDocument = process.env.POLICY_DOCUMENT;
  const targetRoleNames = JSON.parse(process.env.TARGET_ROLE_NAMES || '[]');
  
  // Extract the role name from the CloudTrail event
  const createdRoleName = event.detail?.requestParameters?.roleName;
  
  if (!createdRoleName) {
    console.log('No role name in event, skipping');
    return { statusCode: 200, body: 'No role name in event' };
  }
  
  // Check if this is one of our target roles
  if (!targetRoleNames.includes(createdRoleName)) {
    console.log(`Role ${createdRoleName} is not a target role, skipping`);
    return { statusCode: 200, body: 'Not a target role' };
  }
  
  console.log(`Target role ${createdRoleName} was created, applying policy ${policyName}`);
  
  try {
    // Wait a moment for the role to be fully available
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Verify the role exists
    await iam.send(new GetRoleCommand({ RoleName: createdRoleName }));
    
    // Apply the policy
    await iam.send(new PutRolePolicyCommand({
      RoleName: createdRoleName,
      PolicyName: policyName,
      PolicyDocument: policyDocument
    }));
    
    console.log(`Successfully applied policy ${policyName} to role ${createdRoleName}`);
    return { statusCode: 200, body: 'Policy applied successfully' };
  } catch (error) {
    console.error('Error applying policy to', createdRoleName + ':', error);
    throw error;
  }
};
