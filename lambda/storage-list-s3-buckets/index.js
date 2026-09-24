// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { S3Client, ListBucketsCommand, GetBucketLocationCommand } = require('@aws-sdk/client-s3');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { requireAdmin } = require('./authz');

const s3Client = new S3Client({ region: process.env.AWS_REGION });
const ssmClient = new SSMClient({ region: process.env.AWS_REGION });

/**
 * Look up the Availability Zones this deployment has private subnets in by
 * reading /{pascalCaseName}/Network/PrivateSubnet{n}/AZ from SSM. Returns
 * an empty array on lookup failure so the UI degrades to free-form entry
 * instead of blocking storage creation entirely.
 */
async function listPrivateSubnetAzs() {
  const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
  try {
    const countResp = await ssmClient.send(new GetParameterCommand({
      Name: `/${pascalCaseName}/Network/PrivateSubnetCount`
    }));
    const count = parseInt(countResp.Parameter.Value, 10);
    const azs = [];
    for (let i = 1; i <= count; i++) {
      try {
        const r = await ssmClient.send(new GetParameterCommand({
          Name: `/${pascalCaseName}/Network/PrivateSubnet${i}/AZ`
        }));
        if (r.Parameter && r.Parameter.Value) azs.push(r.Parameter.Value);
      } catch (_) { /* skip - deployment may predate this parameter */ }
    }
    return azs;
  } catch (err) {
    console.warn(`listPrivateSubnetAzs: lookup failed (${err.name}); returning []`);
    return [];
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,OPTIONS'
};

exports.handler = async (event) => {
  console.log('StorageConfig event:', JSON.stringify(event, null, 2));

  const path = event.path || event.resource || '';

  // Handle /storage/config endpoint - returns workstation role ARN for cross-account bucket policy.
  // Available to any authenticated user because the frontend surfaces these
  // identifiers to help admins configure cross-account bucket policies, and
  // knowing an owned role ARN + account id does not itself confer any access.
  if (path.endsWith('/config')) {
    const availabilityZones = await listPrivateSubnetAzs();
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        workstationRoleArn: process.env.WORKSTATION_ROLE_ARN,
        accountId: process.env.AWS_ACCOUNT_ID,
        availabilityZones,
      })
    };
  }

  // Handle /storage/s3-buckets endpoint - list every S3 bucket in the account.
  // This enumerates non-MRM buckets too so it must be admin-only; regular
  // users have no legitimate reason to see the account-wide bucket inventory.
  if (path.endsWith('/s3-buckets')) {
    const denial = requireAdmin(event);
    if (denial) return denial;
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
