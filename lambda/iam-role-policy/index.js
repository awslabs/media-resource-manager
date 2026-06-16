// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { IAMClient, PutRolePolicyCommand, GetRoleCommand, DeleteRolePolicyCommand, ListRolesCommand } = require('@aws-sdk/client-iam');
const iam = new IAMClient();

// Helper to find role with any path prefix
async function findRole(roleName) {
  // Try common paths: root, /service-role/
  const pathsToTry = ['', '/service-role/'];
  
  for (const pathPrefix of pathsToTry) {
    try {
      const result = await iam.send(new GetRoleCommand({ RoleName: roleName }));
      console.log(`Found role ${roleName} at path ${result.Role.Path}`);
      return result.Role;
    } catch (error) {
      if (error.name !== 'NoSuchEntityException') {
        throw error;
      }
    }
  }
  return null;
}

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event));
  
  const { RoleName, RoleNames, PolicyName, PolicyDocument } = event.ResourceProperties;
  
  // Support both single RoleName and array of RoleNames
  const roleNames = RoleNames || (RoleName ? [RoleName] : []);
  
  if (roleNames.length === 0) {
    console.log('No role names provided');
    return { PhysicalResourceId: `no-roles-${PolicyName}` };
  }
  
  const results = [];
  
  for (const roleName of roleNames) {
    try {
      if (event.RequestType === 'Delete') {
        // Try to delete the policy from the role
        try {
          await iam.send(new DeleteRolePolicyCommand({
            RoleName: roleName,
            PolicyName
          }));
          console.log(`Deleted policy ${PolicyName} from role ${roleName}`);
        } catch (error) {
          if (error.name === 'NoSuchEntityException') {
            console.log(`Role ${roleName} or policy ${PolicyName} does not exist, skipping delete`);
          } else {
            console.warn('Failed to delete policy from', roleName + ':', error.message);
          }
        }
        results.push({ role: roleName, status: 'deleted' });
        continue;
      }
      
      // Check if role exists (handles different path prefixes)
      const role = await findRole(roleName);
      if (!role) {
        console.log(`Role ${roleName} does not exist in any path, skipping`);
        results.push({ role: roleName, status: 'skipped' });
        continue;
      }
      
      // Add policy to role
      await iam.send(new PutRolePolicyCommand({
        RoleName: roleName,
        PolicyName,
        PolicyDocument
      }));
      
      console.log(`Added policy ${PolicyName} to role ${roleName}`);
      results.push({ role: roleName, status: 'success' });
    } catch (error) {
      console.error('Error processing role', roleName + ':', error);
      results.push({ role: roleName, status: 'error', error: error.message });
    }
  }
  
  console.log('Results:', JSON.stringify(results));
  return { PhysicalResourceId: `ssm-roles-${PolicyName}` };
};
