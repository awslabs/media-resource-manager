// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const { DirectoryServiceClient, ResetUserPasswordCommand } = require('@aws-sdk/client-directory-service');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { getCallerIdentity, unauthorized } = require('./authz');

const directoryService = new DirectoryServiceClient({});
const ssm = new SSMClient({});
const lambdaClient = new LambdaClient({});

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

function jsonResponse(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
    body: JSON.stringify(bodyObj)
  };
}

// Verify a caller-supplied current password by invoking the ldap-auth Lambda
// with the same event shape it accepts on POST /auth/ldap. Returns true when
// the credential is accepted (statusCode 200); false in all other cases
// (401, invocation failure, missing configuration).
async function verifyCurrentPassword(username, currentPassword) {
  const functionName = process.env.LDAP_AUTH_FUNCTION_NAME;
  if (!functionName) {
    console.error('LDAP_AUTH_FUNCTION_NAME is not configured; cannot verify current password');
    return false;
  }
  try {
    const payload = {
      httpMethod: 'POST',
      body: JSON.stringify({ username, password: currentPassword })
    };
    const response = await lambdaClient.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(payload))
    }));
    if (response.FunctionError) {
      console.error('ldap-auth invocation returned FunctionError:', response.FunctionError);
      return false;
    }
    if (!response.Payload) {
      return false;
    }
    const parsed = JSON.parse(Buffer.from(response.Payload).toString('utf8'));
    return parsed && parsed.statusCode === 200;
  } catch (err) {
    console.error('LDAP auth verification failed:', err.message);
    return false;
  }
}

exports.handler = async (event) => {
  console.log('Change password request received');

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  try {
    // SECURITY: the target user is derived from the authenticated caller
    // context, NOT from the request body. Any `username` field in the body
    // is intentionally ignored. See GHSA-58q4-fcw9-2778 / SIM P498186948.
    const { username: callerUsername, tokenType } = getCallerIdentity(event);
    if (!callerUsername) {
      return unauthorized('Missing authenticated caller');
    }

    // This endpoint resets a directory-service password. In Cognito auth
    // mode, password changes go through the identity provider, not this
    // route. Fail closed rather than attempting a directory reset for a
    // caller whose credential does not live in the directory.
    if (tokenType === 'cognito') {
      return jsonResponse(400, {
        error: 'Password changes for federated users must be performed through your identity provider.'
      });
    }

    const { currentPassword, newPassword } = JSON.parse(event.body || '{}');

    if (!currentPassword || !newPassword) {
      return jsonResponse(400, { error: 'Current password and new password are required' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return jsonResponse(400, { error: 'Password must be at least 8 characters long' });
    }
    if (currentPassword === newPassword) {
      return jsonResponse(400, { error: 'New password must differ from current password' });
    }

    // Verify the current password against LDAP. Possession of a valid
    // session token is NOT proof of password knowledge; a stolen or
    // replayed session must not be able to silently rewrite a credential.
    const currentIsValid = await verifyCurrentPassword(callerUsername, currentPassword);
    if (!currentIsValid) {
      // Deliberately vague message so this route does not become a
      // credential oracle distinguishing "wrong password" from other errors.
      return jsonResponse(401, { error: 'Current password is incorrect' });
    }

    // Look up the Managed AD directory ID
    const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
    const parameterName = `/${pascalCaseName}/Identity/ActiveDirectoryId`;
    const paramResponse = await ssm.send(new GetParameterCommand({ Name: parameterName }));
    const directoryId = paramResponse.Parameter.Value;
    console.log(`Resetting password for authenticated caller "${callerUsername}" in directory ${directoryId}`);

    // Reset ONLY the caller's own directory password.
    await directoryService.send(new ResetUserPasswordCommand({
      DirectoryId: directoryId,
      UserName: callerUsername,
      NewPassword: newPassword
    }));

    console.log(`Password changed successfully for user "${callerUsername}"`);
    return jsonResponse(200, { message: 'Password changed successfully', success: true });

  } catch (error) {
    console.error('Error changing password:', error);

    let errorMessage = 'Failed to change password';
    let statusCode = 500;
    if (error.name === 'InvalidPasswordException') {
      errorMessage = 'Password does not meet complexity requirements';
      statusCode = 400;
    } else if (error.name === 'EntityDoesNotExistException') {
      errorMessage = 'User not found';
      statusCode = 404;
    } else if (error.name === 'AccessDeniedException') {
      errorMessage = 'Access denied';
      statusCode = 403;
    } else if (error instanceof SyntaxError) {
      errorMessage = 'Invalid request body';
      statusCode = 400;
    }
    return jsonResponse(statusCode, { error: errorMessage, details: error.message });
  }
};
