// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom Resource Lambda to preserve SAML identity providers after CDK deployment.
 * 
 * CDK resets the UserPoolClient's supportedIdentityProviders to just COGNITO,
 * removing any SAML providers (Okta, IdentityCenter) that were added via CLI.
 * This Lambda lists existing providers and updates the client to include them.
 * 
 * It also reads the actual frontend URL from SSM Parameter Store to set the
 * correct callback/logout URLs (since CDK uses placeholders for fresh deployments).
 */

const { CognitoIdentityProviderClient, ListIdentityProvidersCommand, UpdateUserPoolClientCommand } = require('@aws-sdk/client-cognito-identity-provider');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const https = require('https');
const url = require('url');

const cognitoClient = new CognitoIdentityProviderClient();
const ssmClient = new SSMClient();

async function sendResponse(event, status, data = {}) {
  const responseBody = JSON.stringify({
    Status: status,
    Reason: data.Reason || `See CloudWatch Log Stream: ${process.env.AWS_LAMBDA_LOG_STREAM_NAME}`,
    PhysicalResourceId: event.PhysicalResourceId || 'preserve-saml-providers',
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
      console.log(`Response status: ${res.statusCode}`);
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
  console.log('Event:', JSON.stringify(event, null, 2));
  
  const userPoolId = process.env.USER_POOL_ID;
  const clientId = process.env.CLIENT_ID;
  const frontendUrlParamName = process.env.FRONTEND_URL_PARAM_NAME;
  
  // For Delete events, just return success (nothing to clean up)
  if (event.RequestType === 'Delete') {
    await sendResponse(event, 'SUCCESS', { Message: 'Delete - nothing to do' });
    return;
  }
  
  try {
    // Get the actual frontend URL from SSM Parameter Store
    let frontendUrl = 'https://placeholder.cloudfront.net';
    try {
      const ssmResponse = await ssmClient.send(new GetParameterCommand({
        Name: frontendUrlParamName,
      }));
      frontendUrl = ssmResponse.Parameter.Value;
      console.log('Got frontend URL from SSM:', frontendUrl);
    } catch (ssmError) {
      console.log('Could not get frontend URL from SSM, using placeholder:', ssmError.message);
    }
    
    // Build callback/logout URLs with the actual frontend URL
    const callbackUrls = [frontendUrl, `${frontendUrl}/`, 'http://localhost:3000', 'http://localhost:3000/'];
    const logoutUrls = [frontendUrl, `${frontendUrl}/`, 'http://localhost:3000', 'http://localhost:3000/'];
    
    // List all identity providers in the user pool
    console.log('Listing identity providers for user pool:', userPoolId);
    const listResponse = await cognitoClient.send(new ListIdentityProvidersCommand({
      UserPoolId: userPoolId,
      MaxResults: 60,
    }));
    
    const providers = listResponse.Providers || [];
    console.log('Found providers:', providers.map(p => p.ProviderName));
    
    // Build list of supported providers (always include COGNITO)
    const supportedProviders = ['COGNITO'];
    for (const provider of providers) {
      if (!supportedProviders.includes(provider.ProviderName)) {
        supportedProviders.push(provider.ProviderName);
      }
    }
    
    console.log('Updating client with supported providers:', supportedProviders);
    console.log('Callback URLs:', callbackUrls);
    
    // Update the user pool client to include all providers
    await cognitoClient.send(new UpdateUserPoolClientCommand({
      UserPoolId: userPoolId,
      ClientId: clientId,
      SupportedIdentityProviders: supportedProviders,
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthScopes: ['email', 'openid', 'profile'],
      CallbackURLs: callbackUrls,
      LogoutURLs: logoutUrls,
      ExplicitAuthFlows: [
        'ALLOW_USER_SRP_AUTH',
        'ALLOW_ADMIN_USER_PASSWORD_AUTH',
        'ALLOW_USER_PASSWORD_AUTH',
        'ALLOW_REFRESH_TOKEN_AUTH',
      ],
    }));
    
    console.log('Successfully updated user pool client with SAML providers');
    
    await sendResponse(event, 'SUCCESS', {
      SupportedProviders: supportedProviders.join(','),
      FrontendUrl: frontendUrl,
    });
  } catch (error) {
    console.error('Error preserving SAML providers:', error);
    await sendResponse(event, 'FAILED', {
      Reason: error.message,
    });
  }
};
