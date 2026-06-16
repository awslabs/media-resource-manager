// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { SSMClient, PutParameterCommand } = require('@aws-sdk/client-ssm');

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: 'frontend-url-updater' };
  }
  
  const ssm = new SSMClient();
  const cloudfrontUrl = event.ResourceProperties.CloudFrontUrl;
  const customFrontendUrl = event.ResourceProperties.CustomFrontendUrl;
  const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
  
  // Use custom frontend URL if provided, otherwise use CloudFront URL
  const frontendUrl = customFrontendUrl || cloudfrontUrl;
  
  // Update SSM parameter with frontend URL
  // This triggers EventBridge which invokes the CORS updater Lambda
  // The CORS updater also updates Cognito callback URLs
  await ssm.send(new PutParameterCommand({
    Name: `/${pascalCaseName}/Frontend/Url`,
    Value: frontendUrl,
    Overwrite: true,
    Description: customFrontendUrl 
      ? 'Custom frontend URL for CORS and Cognito configuration'
      : 'CloudFront URL for CORS and Cognito configuration'
  }));
  
  console.log(`Updated parameter with frontend URL: ${frontendUrl}`);
  
  return { PhysicalResourceId: 'frontend-url-updater' };
};
