// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sets a retention period on this deployment's Lambda log groups.
 *
 * Runs as a CloudFormation custom resource in the <ACRONYM>-Log-Retention
 * stack, which deploys after every other stack, and again whenever a regional
 * hub is created. For each region (the home region and every available
 * regional hub) it:
 *   1. finds this deployment's functions: names starting with one of
 *      FUNCTION_NAME_PREFIXES, tagged ManagedBy=MANAGED_BY,
 *   2. sets RETENTION_DAYS on their log groups that have no retention period,
 *   3. creates the log groups of functions that haven't run yet, with that
 *      retention period, so Lambda writes into them on the first run.
 * Log groups that already have a retention period are left alone.
 *
 * Functions are listed with the Lambda API rather than the Resource Groups
 * Tagging API, because the tagging API can take minutes to include functions
 * created earlier in the same deploy.
 */

const { LambdaClient, ListFunctionsCommand, ListTagsCommand } = require('@aws-sdk/client-lambda');
const {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  CreateLogGroupCommand,
  PutRetentionPolicyCommand,
} = require('@aws-sdk/client-cloudwatch-logs');
const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { ALLOWED_RETENTION_DAYS, hasAllowedPrefix, planRetention } = require('./retention');

const HOME_REGION = process.env.AWS_REGION;
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS);
const MANAGED_BY = process.env.MANAGED_BY;
const FUNCTION_PREFIXES = (process.env.FUNCTION_NAME_PREFIXES || '').split(',').filter(Boolean);
const REGIONAL_HUBS_TABLE_NAME = process.env.REGIONAL_HUBS_TABLE_NAME;
const MAX_ATTEMPTS = 8;

// Regions with an available regional hub, plus the home region.
async function listRegions() {
  const regions = new Set([HOME_REGION]);
  const dynamo = new DynamoDBClient({ region: HOME_REGION });
  let ExclusiveStartKey;
  do {
    const page = await dynamo.send(new ScanCommand({
      TableName: REGIONAL_HUBS_TABLE_NAME,
      ProjectionExpression: '#region, #status',
      ExpressionAttributeNames: { '#region': 'region', '#status': 'status' },
      ExclusiveStartKey,
    }));
    for (const item of page.Items || []) {
      if (item.status?.S === 'available' && item.region?.S) regions.add(item.region.S);
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return [...regions];
}

// This deployment's functions in a region. The name prefix narrows the list,
// and the ManagedBy tag excludes another app's functions that happen to share
// the acronym.
async function listDeploymentFunctions(lambda) {
  const candidates = [];
  let Marker;
  do {
    const page = await lambda.send(new ListFunctionsCommand({ Marker, MaxItems: 50 }));
    for (const fn of page.Functions || []) {
      if (hasAllowedPrefix(fn.FunctionName, FUNCTION_PREFIXES)) candidates.push(fn);
    }
    Marker = page.NextMarker;
  } while (Marker);

  const functions = [];
  for (const fn of candidates) {
    const { Tags } = await lambda.send(new ListTagsCommand({ Resource: fn.FunctionArn }));
    if (Tags?.ManagedBy === MANAGED_BY) {
      functions.push({ name: fn.FunctionName, logGroupName: fn.LoggingConfig?.LogGroup });
    }
  }
  return functions;
}

// Existing log groups under the function prefixes: name -> retentionInDays.
async function describeLogGroups(logs) {
  const groups = new Map();
  for (const prefix of FUNCTION_PREFIXES) {
    let nextToken;
    do {
      const page = await logs.send(new DescribeLogGroupsCommand({
        logGroupNamePrefix: `/aws/lambda/${prefix}`,
        nextToken,
      }));
      for (const group of page.logGroups || []) {
        groups.set(group.logGroupName, group.retentionInDays);
      }
      nextToken = page.nextToken;
    } while (nextToken);
  }
  return groups;
}

async function applyRetention(region) {
  const lambda = new LambdaClient({ region, maxAttempts: MAX_ATTEMPTS });
  const logs = new CloudWatchLogsClient({ region, maxAttempts: MAX_ATTEMPTS });

  const functions = await listDeploymentFunctions(lambda);
  const plan = planRetention({ functions, logGroups: await describeLogGroups(logs) });

  for (const logGroupName of plan.create) {
    try {
      await logs.send(new CreateLogGroupCommand({ logGroupName }));
    } catch (error) {
      // The function ran in the meantime and Lambda created the group.
      if (error.name !== 'ResourceAlreadyExistsException') throw error;
    }
  }
  for (const logGroupName of [...plan.create, ...plan.setRetention]) {
    await logs.send(new PutRetentionPolicyCommand({ logGroupName, retentionInDays: RETENTION_DAYS }));
  }

  const summary = {
    region,
    functions: functions.length,
    created: plan.create.length,
    retentionSet: plan.setRetention.length,
    alreadySet: plan.alreadySet.length,
    customLogGroup: plan.customLogGroup.length,
  };
  console.log('Log retention applied:', JSON.stringify(summary));
  return summary;
}

async function applyEverywhere() {
  if (!ALLOWED_RETENTION_DAYS.includes(RETENTION_DAYS)) {
    throw new Error(`RETENTION_DAYS must be one of ${ALLOWED_RETENTION_DAYS.join(', ')} (got ${process.env.RETENTION_DAYS})`);
  }
  const results = [];
  for (const region of await listRegions()) {
    try {
      results.push(await applyRetention(region));
    } catch (error) {
      // A failure in the home region fails the deploy, so it gets noticed. A
      // regional hub failure (for example a region that has been disabled)
      // is logged and doesn't block the rest.
      if (region === HOME_REGION) throw error;
      console.warn('Could not apply log retention in %s:', region, error.name, error.message);
      results.push({ region, error: error.name });
    }
  }
  return results;
}

exports.handler = async (event) => {
  console.log('Request:', JSON.stringify({
    requestType: event.RequestType,
    source: event.source,
    detailType: event['detail-type'],
  }));

  // Removing the custom resource leaves retention periods as they are.
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId };
  }

  const results = await applyEverywhere();
  const total = (key) => results.reduce((sum, result) => sum + (result[key] || 0), 0);
  return {
    PhysicalResourceId: event.PhysicalResourceId || 'lambda-log-retention',
    Data: {
      Regions: results.length,
      Created: total('created'),
      RetentionSet: total('retentionSet'),
      AlreadySet: total('alreadySet'),
      FailedRegions: results.filter(result => result.error).map(result => result.region).join(','),
    },
  };
};
