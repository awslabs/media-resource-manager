// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  CognitoIdentityProviderClient,
  CreateGroupCommand,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminGetUserCommand,
} = require('@aws-sdk/client-cognito-identity-provider');
const https = require('https');
const url = require('url');

const cognito = new CognitoIdentityProviderClient();

async function sendResponse(event, status, data = {}) {
  const responseBody = JSON.stringify({
    Status: status,
    Reason: data.Reason || `See CloudWatch Log Stream: ${process.env.AWS_LAMBDA_LOG_STREAM_NAME}`,
    PhysicalResourceId: event.PhysicalResourceId || 'admin-setup',
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data,
  });

  const parsedUrl = url.parse(event.ResponseURL);
  const options = {
    hostname: parsedUrl.hostname,
    port: 443,
    path: parsedUrl.path,
    method: 'PUT',
    headers: {
      'Content-Type': '',
      'Content-Length': responseBody.length,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      console.log(`CloudFormation response status: ${res.statusCode}`);
      resolve();
    });
    req.on('error', (err) => {
      console.error('Error sending response:', err);
      reject(err);
    });
    req.write(responseBody);
    req.end();
  });
}

exports.handler = async (event) => {
  // The event holds AdminEmails (personal data) and the pre-signed
  // ResponseURL, so log only what identifies the request.
  console.log('Event:', JSON.stringify({
    RequestType: event.RequestType,
    LogicalResourceId: event.LogicalResourceId,
    RequestId: event.RequestId,
  }));

  if (event.RequestType === 'Delete') {
    await sendResponse(event, 'SUCCESS', { Message: 'Delete - nothing to do' });
    return;
  }

  try {
    const userPoolId = event.ResourceProperties.UserPoolId;
    const groups = JSON.parse(event.ResourceProperties.Groups || '[]');
    const emails = JSON.parse(event.ResourceProperties.AdminEmails || '[]');

    // Create admin groups (idempotent — skips if group already exists)
    for (const groupName of groups) {
      try {
        await cognito.send(new CreateGroupCommand({
          UserPoolId: userPoolId,
          GroupName: groupName,
          Description: 'Admin group (auto-created)',
        }));
        console.log('Created group:', groupName);
      } catch (err) {
        if (err.name === 'GroupExistsException') {
          console.log('Group already exists:', groupName);
        } else {
          throw err;
        }
      }
    }

    // Create admin users (idempotent — skips if user already exists)
    const firstGroup = groups.length > 0 ? groups[0] : null;

    // Users are logged by their position in AdminEmails, not their address.
    for (const [index, email] of emails.entries()) {
      const user = `AdminEmails[${index}]`;
      try {
        await cognito.send(new AdminGetUserCommand({
          UserPoolId: userPoolId,
          Username: email,
        }));
        console.log('User already exists:', user);
      } catch (err) {
        if (err.name === 'UserNotFoundException') {
          await cognito.send(new AdminCreateUserCommand({
            UserPoolId: userPoolId,
            Username: email,
            UserAttributes: [
              { Name: 'email', Value: email },
              { Name: 'email_verified', Value: 'true' },
              { Name: 'given_name', Value: 'Admin' },
              { Name: 'family_name', Value: 'User' },
            ],
            DesiredDeliveryMediums: ['EMAIL'],
          }));
          console.log('Created user:', user);
        } else {
          throw err;
        }
      }

      // Add user to admin group
      if (firstGroup) {
        try {
          await cognito.send(new AdminAddUserToGroupCommand({
            UserPoolId: userPoolId,
            Username: email,
            GroupName: firstGroup,
          }));
          console.log('Added', user, 'to group:', firstGroup);
        } catch (err) {
          console.warn('Could not add user to group:', err.message);
        }
      }
    }

    await sendResponse(event, 'SUCCESS', {
      GroupsCreated: groups.join(','),
      UsersProcessed: emails.join(','),
    });
  } catch (error) {
    console.error('Error in admin setup:', error);
    await sendResponse(event, 'FAILED', { Reason: error.message });
  }
};
