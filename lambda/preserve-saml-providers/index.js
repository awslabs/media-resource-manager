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

const { CognitoIdentityProviderClient, ListIdentityProvidersCommand, UpdateUserPoolClientCommand, DescribeUserPoolClientCommand } = require('@aws-sdk/client-cognito-identity-provider');
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

    // Fetch the current client configuration first, then override only the
    // fields this custom resource is responsible for (SupportedIdentityProviders,
    // callback/logout URLs, allowed OAuth flows). UpdateUserPoolClient is a
    // full replace, so any field we omit is reset to defaults. In particular,
    // WriteAttributes and ReadAttributes must be preserved to keep the
    // privilege-attribute restriction that lib/constructs/auth-construct.ts
    // sets to prevent user self-elevation via UpdateUserAttributes on
    // custom:isAdmin, custom:groups, or custom:department.
    const describeResponse = await cognitoClient.send(new DescribeUserPoolClientCommand({
      UserPoolId: userPoolId,
      ClientId: clientId,
    }));
    const currentClient = describeResponse.UserPoolClient;
    console.log('Current WriteAttributes:', currentClient.WriteAttributes);
    console.log('Current ReadAttributes:', currentClient.ReadAttributes);

    // Enforce the CDK-declared WriteAttributes on every run. UpdateUserPoolClient
    // is a full replace, so if any prior deploy (or any operator action) stripped
    // WriteAttributes to defaults, this heals it. If the env var is unset we
    // fall back to preserving whatever is currently set, to avoid regressing
    // in tenants that intentionally use custom writeAttributes.
    const enforcedWriteAttrsRaw = process.env.ENFORCED_WRITE_ATTRIBUTES || '';
    const enforcedWriteAttrs = enforcedWriteAttrsRaw
      ? enforcedWriteAttrsRaw.split(',').map(s => s.trim()).filter(Boolean)
      : currentClient.WriteAttributes;
    console.log('Enforcing WriteAttributes:', enforcedWriteAttrs);

    await cognitoClient.send(new UpdateUserPoolClientCommand({
      UserPoolId: userPoolId,
      ClientId: clientId,
      // Fields owned by this custom resource:
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
      // Enforce the desired WriteAttributes (self-healing). Preserve the rest
      // of the CDK-managed configuration by echoing the current values back:
      WriteAttributes: enforcedWriteAttrs,
      ClientName: currentClient.ClientName,
      ReadAttributes: currentClient.ReadAttributes,
      RefreshTokenValidity: currentClient.RefreshTokenValidity,
      AccessTokenValidity: currentClient.AccessTokenValidity,
      IdTokenValidity: currentClient.IdTokenValidity,
      TokenValidityUnits: currentClient.TokenValidityUnits,
      PreventUserExistenceErrors: currentClient.PreventUserExistenceErrors,
      EnableTokenRevocation: currentClient.EnableTokenRevocation,
      EnablePropagateAdditionalUserContextData: currentClient.EnablePropagateAdditionalUserContextData,
      AuthSessionValidity: currentClient.AuthSessionValidity,
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
