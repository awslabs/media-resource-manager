// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Decides which Lambda log groups need a retention period. No AWS SDK
 * dependency, so the unit tests can load it.
 *
 * Lambda creates /aws/lambda/<function> on a function's first run, outside
 * CloudFormation and without a retention period, so its events are kept
 * forever. This sets one on the log groups of this deployment's functions.
 */

// Values CloudWatch Logs accepts for retentionInDays.
const ALLOWED_RETENTION_DAYS = [
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653,
];

function logGroupNameForFunction(functionName) {
  return `/aws/lambda/${functionName}`;
}

function hasAllowedPrefix(functionName, prefixes) {
  return prefixes.some(prefix => functionName.startsWith(prefix));
}

/**
 * Plan the changes for one region.
 *
 * @param {object} input
 * @param {{ name: string, logGroupName?: string }[]} input.functions this
 *   deployment's functions (already filtered by name prefix and ManagedBy
 *   tag), with the log group from their logging configuration
 * @param {Map<string, number|undefined>} input.logGroups existing log group
 *   name -> retentionInDays (undefined when none is set)
 * @returns {{ create: string[], setRetention: string[], alreadySet: string[], customLogGroup: string[] }}
 *   create: log groups that don't exist yet (the function hasn't run), to be
 *   created with the retention period. setRetention: existing groups without
 *   one. alreadySet: groups that already have a retention period, which are
 *   left alone whatever it is. customLogGroup: functions that log to a group
 *   CDK declares itself, which are skipped.
 */
function planRetention({ functions, logGroups }) {
  const plan = { create: [], setRetention: [], alreadySet: [], customLogGroup: [] };
  const byName = new Map(functions.map(fn => [fn.name, fn]));
  for (const name of [...byName.keys()].sort()) {
    const logGroupName = logGroupNameForFunction(name);
    const configured = byName.get(name).logGroupName;
    if (configured && configured !== logGroupName) {
      plan.customLogGroup.push(name);
    } else if (!logGroups.has(logGroupName)) {
      plan.create.push(logGroupName);
    } else if (logGroups.get(logGroupName) === undefined) {
      plan.setRetention.push(logGroupName);
    } else {
      plan.alreadySet.push(logGroupName);
    }
  }
  return plan;
}

module.exports = {
  ALLOWED_RETENTION_DAYS,
  logGroupNameForFunction,
  hasAllowedPrefix,
  planRetention,
};
