// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DirectoryServiceClient, ResetUserPasswordCommand } = require('@aws-sdk/client-directory-service');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const directoryService = new DirectoryServiceClient({});
const ssm = new SSMClient({});

exports.handler = async (event) => {
  console.log('Change password request:', JSON.stringify(event, null, 2));
  
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'POST,OPTIONS'
  };
  
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: ''
    };
  }
  
  try {
    const { username, currentPassword, newPassword } = JSON.parse(event.body || '{}');
    
    // Validate input
    if (!username || !newPassword) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Username and new password are required' })
      };
    }
    
    // Validate password strength
    if (newPassword.length < 8) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Password must be at least 8 characters long' })
      };
    }
    
    // Get directory ID from SSM Parameter Store
    const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
    const parameterName = `/${pascalCaseName}/Identity/ActiveDirectoryId`;
    
    const paramResponse = await ssm.send(new GetParameterCommand({
      Name: parameterName
    }));
    
    const directoryId = paramResponse.Parameter.Value;
    console.log(`Using directory ID: ${directoryId}`);
    
    // Reset user password using Directory Service
    await directoryService.send(new ResetUserPasswordCommand({
      DirectoryId: directoryId,
      UserName: username,
      NewPassword: newPassword
    }));
    
    console.log(`Password changed successfully for user: ${username}`);
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ 
        message: 'Password changed successfully',
        success: true 
      })
    };
    
  } catch (error) {
    console.error('Error changing password:', error);
    
    // Handle specific error cases
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
    }
    
    return {
      statusCode,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ 
        error: errorMessage,
        details: error.message 
      })
    };
  }
};
