// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { CognitoIdentityProviderClient, ListIdentityProvidersCommand } = require('@aws-sdk/client-cognito-identity-provider');

const s3 = new S3Client({});
const ssm = new SSMClient({});
const cognito = new CognitoIdentityProviderClient({});

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: 'config-generator' };
  }
  
  try {
    // Get pascal case name from environment variable
    const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
    
    const apiUrlParam = await ssm.send(new GetParameterCommand({
      Name: `/${pascalCaseName}/Workstation/ApiUrl`
    }));
    
    // Get authentication mode
    let useCognitoAuth = true; // default
    try {
      const authModeParam = await ssm.send(new GetParameterCommand({
        Name: `/${pascalCaseName}/Auth/UseCognitoAuth`
      }));
      useCognitoAuth = authModeParam.Parameter.Value === 'true';
    } catch (error) {
      console.log('Auth mode parameter not found, defaulting to Cognito');
    }

    // Get Cognito values if using Cognito auth
    let cognitoConfig = {};
    let identityProviders = [];
    if (useCognitoAuth) {
      try {
        const [userPoolId, clientId, domain, adminGroupName] = await Promise.all([
          ssm.send(new GetParameterCommand({ Name: `/${pascalCaseName}/Auth/UserPoolId` })),
          ssm.send(new GetParameterCommand({ Name: `/${pascalCaseName}/Auth/UserPoolClientId` })),
          ssm.send(new GetParameterCommand({ Name: `/${pascalCaseName}/Auth/CognitoDomain` })),
          ssm.send(new GetParameterCommand({ Name: `/${pascalCaseName}/Auth/AdminGroupName` }))
        ]);
        
        cognitoConfig = {
          cognitoUserPoolId: userPoolId.Parameter.Value,
          cognitoClientId: clientId.Parameter.Value,
          cognitoDomain: domain.Parameter.Value,
          adminGroupName: adminGroupName.Parameter.Value,
        };
        
        // Fetch identity providers from Cognito
        try {
          const providersResult = await cognito.send(new ListIdentityProvidersCommand({
            UserPoolId: userPoolId.Parameter.Value,
            MaxResults: 10
          }));
          identityProviders = (providersResult.Providers || []).map(p => p.ProviderName);
          console.log('Found identity providers:', identityProviders);
        } catch (idpError) {
          console.log('Could not fetch identity providers:', idpError.message);
        }
      } catch (error) {
        console.log('Cognito parameters not found:', error);
      }
    }

    // Get Identity Pool ID for S3 Storage Browser and S3 Watchfolder app
    let identityPoolId = null;
    try {
      const identityPoolParam = await ssm.send(new GetParameterCommand({
        Name: `/${pascalCaseName}/Auth/IdentityPoolId`
      }));
      identityPoolId = identityPoolParam.Parameter.Value;
      console.log('Found Identity Pool ID:', identityPoolId);
    } catch (error) {
      console.log('Identity Pool ID parameter not found:', error.message);
    }

    // Get Media Bucket name for S3 Storage Browser
    let mediaBucketName = null;
    try {
      const mediaBucketParam = await ssm.send(new GetParameterCommand({
        Name: `/${pascalCaseName}/Storage/MediaBucketName`
      }));
      mediaBucketName = mediaBucketParam.Parameter.Value;
      console.log('Found Media Bucket:', mediaBucketName);
    } catch (error) {
      console.log('Media Bucket parameter not found:', error.message);
    }
    
    const config = {
      region: process.env.AWS_REGION,
      apiUrl: apiUrlParam.Parameter.Value,
      userTableName: process.env.USER_TABLE_NAME,
      workstationTableName: process.env.WORKSTATION_TABLE_NAME,
      productName: process.env.PRODUCT_NAME || 'Media Resource Manager',
      acronym: process.env.PRODUCT_ACRONYM || 'MRM',
      useCognitoAuth,
      enableBedrockFeatures: process.env.ENABLE_BEDROCK_FEATURES !== 'false',
      identityProviders,
      identityPoolId,
      mediaBucketName,
      ...cognitoConfig
    };
    
    console.log('Generated config:', JSON.stringify(config, null, 2));
    
    // Determine bucket name based on event source
    let bucketName;
    if (event.ResourceProperties && event.ResourceProperties.BucketName) {
      // CloudFormation Custom Resource event
      bucketName = event.ResourceProperties.BucketName;
    } else {
      // EventBridge event - use environment variable
      bucketName = process.env.BUCKET_NAME;
    }
    
    if (!bucketName) {
      throw new Error('Bucket name not available in event or environment');
    }
    
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: 'config.json',
      Body: JSON.stringify(config, null, 2),
      ContentType: 'application/json'
    });
    
    await s3.send(command);
    console.log(`Successfully uploaded config.json to S3 bucket: ${bucketName}`);
    
    return { PhysicalResourceId: 'config-generator' };
  } catch (error) {
    console.error('Error generating config:', error);
    throw error;
  }
};
