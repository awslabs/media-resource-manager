// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { S3Client, ListBucketsCommand, GetBucketLocationCommand } = require('@aws-sdk/client-s3');

const s3Client = new S3Client({ region: process.env.AWS_REGION });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,OPTIONS'
};

exports.handler = async (event) => {
  console.log('StorageConfig event:', JSON.stringify(event, null, 2));
  
  const path = event.path || event.resource || '';
  
  // Handle /storage/config endpoint - returns workstation role ARN for cross-account bucket policy
  if (path.endsWith('/config')) {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        workstationRoleArn: process.env.WORKSTATION_ROLE_ARN,
        accountId: process.env.AWS_ACCOUNT_ID,
      })
    };
  }
  
  // Handle /storage/s3-buckets endpoint - list S3 buckets in the account
  if (path.endsWith('/s3-buckets')) {
    try {
      const listResult = await s3Client.send(new ListBucketsCommand({}));
      const buckets = listResult.Buckets || [];
      console.log('Buckets found:', buckets.length);
      
      // Get location for each bucket
      const bucketsWithLocation = await Promise.all(
        buckets.map(async (bucket) => {
          try {
            const locationResult = await s3Client.send(new GetBucketLocationCommand({
              Bucket: bucket.Name
            }));
            const region = locationResult.LocationConstraint || 'us-east-1';
            return {
              name: bucket.Name,
              arn: `arn:aws:s3:::${bucket.Name}`,
              region,
              creationDate: bucket.CreationDate?.toISOString()
            };
          } catch (error) {
            console.warn('Could not get location for bucket', bucket.Name + ':', error.message);
            return {
              name: bucket.Name,
              arn: `arn:aws:s3:::${bucket.Name}`,
              region: 'unknown',
              creationDate: bucket.CreationDate?.toISOString()
            };
          }
        })
      );
      
      // Optionally filter by region
      const regionFilter = event.queryStringParameters?.region;
      const filteredBuckets = regionFilter
        ? bucketsWithLocation.filter(b => b.region === regionFilter)
        : bucketsWithLocation;
      
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify(filteredBuckets)
      };
    } catch (error) {
      console.error('Error listing S3 buckets:', error);
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'Failed to list S3 buckets',
          details: error.message
        })
      };
    }
  }
  
  // Unknown endpoint
  return {
    statusCode: 404,
    headers: corsHeaders,
    body: JSON.stringify({ error: 'Not found' })
  };
};
