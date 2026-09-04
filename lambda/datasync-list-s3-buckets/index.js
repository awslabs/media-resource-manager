// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { S3Client, ListBucketsCommand, GetBucketLocationCommand } = require('@aws-sdk/client-s3');
const { requireAdmin } = require('./authz');

const s3Client = new S3Client({ region: process.env.AWS_REGION });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,OPTIONS'
};

exports.handler = async (event) => {
  console.log('ListS3Buckets event:', JSON.stringify(event, null, 2));

  // Handle /datasync/config endpoint - returns DataSync role ARN for cross-account bucket policy.
  // Same rationale as /storage/config: exposing an owned role ARN + account
  // id does not itself confer any access, so this stays available to any
  // authenticated user.
  if (event.resource === '/datasync/config' || event.path?.endsWith('/config')) {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        dataSyncRoleArn: process.env.DATASYNC_ROLE_ARN,
        accountId: process.env.AWS_ACCOUNT_ID,
      })
    };
  }

  // The remaining code path lists every S3 bucket in the account, including
  // buckets unrelated to MRM. Regular users have no legitimate reason to see
  // that account-wide inventory, so gate it to admins.
  const denial = requireAdmin(event);
  if (denial) return denial;

  try {
    // List all buckets in the account
    const listResult = await s3Client.send(new ListBucketsCommand({}));
    
    const buckets = listResult.Buckets || [];
    console.log('Buckets found:', buckets.length);
    
    // Get location for each bucket (to filter by region if needed)
    const bucketsWithLocation = await Promise.all(
      buckets.map(async (bucket) => {
        try {
          const locationResult = await s3Client.send(new GetBucketLocationCommand({
            Bucket: bucket.Name
          }));
          
          // LocationConstraint is null for us-east-1
          const region = locationResult.LocationConstraint || 'us-east-1';
          
          return {
            name: bucket.Name,
            arn: `arn:aws:s3:::${bucket.Name}`,
            region,
            creationDate: bucket.CreationDate?.toISOString()
          };
        } catch (error) {
          // If we can't get location, still return the bucket
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
};
