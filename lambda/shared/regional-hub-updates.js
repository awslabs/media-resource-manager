// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regional hub update state, shared by the list and get regional hub APIs.
 *
 * A hub saves `templateVersion`, the fingerprint of the code it was built
 * from, when it is created or an update finishes. REGIONAL_HUB_TEMPLATE_VERSION
 * is the current fingerprint (set by CDK). A hub with a different or missing
 * version runs older code and needs an update.
 *
 * An update sets the hub to 'updating' and starts a CloudFormation stack
 * update in the hub's region. Nothing is notified when that finishes, so
 * reading a hub that is 'updating' checks its stack and records the result.
 */

const UPDATABLE_STATUSES = ['available', 'update_failed'];

// How long an update may take to reach CloudFormation (template generation
// copies the regional Lambda code first) before it counts as failed.
const UPDATE_START_TIMEOUT_MS = 15 * 60 * 1000;

// Hubs set to 'updating' before updateStartedAt existed only have updatedAt,
// which was written just after the stack update started.
const LEGACY_START_SKEW_MS = 5 * 60 * 1000;

/** Whether the console should offer an update for this hub. */
function isUpdateAvailable(hub, currentVersion) {
  return Boolean(currentVersion) &&
    !hub.isPrimary &&
    UPDATABLE_STATUSES.includes(hub.status) &&
    hub.templateVersion !== currentVersion;
}

/**
 * Work out what an 'updating' hub's stack says about the update.
 *
 * @param {object} hub the hub record (status 'updating')
 * @param {object|null} stack the stack from DescribeStacks, or null if it doesn't exist
 * @param {number} nowMs current time
 * @returns {null | { status: string, templateVersion?: string, lastError?: string }}
 *   null while the update is still running or hasn't reached CloudFormation yet
 */
function decideUpdateOutcome(hub, stack, nowMs) {
  if (!stack) {
    return { status: 'update_failed', lastError: 'The regional hub stack was not found.' };
  }
  const stackStatus = stack.StackStatus || '';
  if (stackStatus.endsWith('_IN_PROGRESS')) return null;

  const startedAt = hub.updateStartedAt
    ? Date.parse(hub.updateStartedAt)
    : Date.parse(hub.updatedAt) - LEGACY_START_SKEW_MS;
  const stackChangedAt = Date.parse(stack.LastUpdatedTime || stack.CreationTime);
  if (Number.isFinite(startedAt) && !(stackChangedAt >= startedAt)) {
    // The stack hasn't changed since the update started.
    if (nowMs - startedAt > UPDATE_START_TIMEOUT_MS) {
      return { status: 'update_failed', lastError: 'The stack update did not start.' };
    }
    return null;
  }

  if (stackStatus === 'UPDATE_COMPLETE') {
    return { status: 'available', templateVersion: hub.pendingTemplateVersion };
  }
  return {
    status: 'update_failed',
    lastError: stack.StackStatusReason || `The stack update ended in ${stackStatus}.`,
  };
}

/**
 * Check the stack of every hub that is 'updating' and save the result.
 * Returns the hubs with their status brought up to date. Failures are logged
 * and leave that hub as it was.
 *
 * @param {object[]} hubs hub records
 * @param {{ docClient: object, tableName: string, UpdateCommand: Function, nowMs?: number }} deps
 */
async function reconcileUpdatingHubs(hubs, { docClient, tableName, UpdateCommand, nowMs = Date.now() }) {
  const updating = hubs.filter(hub => hub.status === 'updating' && hub.cloudFormationStackName);
  if (updating.length === 0) return hubs;

  // Loaded only when needed. Provided by the Lambda runtime.
  // eslint-disable-next-line global-require
  const { CloudFormationClient, DescribeStacksCommand } = require('@aws-sdk/client-cloudformation');
  const results = new Map();

  await Promise.all(updating.map(async (hub) => {
    try {
      const cfn = new CloudFormationClient({ region: hub.region });
      let stack = null;
      try {
        const described = await cfn.send(new DescribeStacksCommand({ StackName: hub.cloudFormationStackName }));
        stack = described.Stacks?.[0] || null;
      } catch (error) {
        if (!/does not exist/i.test(error.message || '')) throw error;
      }

      const outcome = decideUpdateOutcome(hub, stack, nowMs);
      if (!outcome) return;

      const now = new Date(nowMs).toISOString();
      const names = { '#status': 'status' };
      const values = { ':status': outcome.status, ':updatedAt': now, ':updating': 'updating' };
      const set = ['#status = :status', 'updatedAt = :updatedAt'];
      const remove = ['pendingTemplateVersion', 'updateStartedAt'];
      if (outcome.templateVersion) {
        set.push('templateVersion = :templateVersion');
        values[':templateVersion'] = outcome.templateVersion;
      }
      if (outcome.lastError) {
        set.push('lastError = :lastError');
        values[':lastError'] = outcome.lastError;
      } else {
        remove.push('lastError');
      }

      await docClient.send(new UpdateCommand({
        TableName: tableName,
        Key: { region: hub.region },
        UpdateExpression: `SET ${set.join(', ')} REMOVE ${remove.join(', ')}`,
        // Another request may have recorded the result already.
        ConditionExpression: '#status = :updating',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }));

      const updated = { ...hub, status: outcome.status, updatedAt: now };
      delete updated.pendingTemplateVersion;
      delete updated.updateStartedAt;
      if (outcome.templateVersion) updated.templateVersion = outcome.templateVersion;
      if (outcome.lastError) updated.lastError = outcome.lastError; else delete updated.lastError;
      results.set(hub.region, updated);
      console.log('Regional hub %s update finished: %s', hub.region, outcome.status);
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') return;
      console.warn('Could not check the update of regional hub %s:', hub.region, error.name, error.message);
    }
  }));

  return hubs.map(hub => results.get(hub.region) || hub);
}

module.exports = {
  UPDATABLE_STATUSES,
  UPDATE_START_TIMEOUT_MS,
  isUpdateAvailable,
  decideUpdateOutcome,
  reconcileUpdatingHubs,
};
