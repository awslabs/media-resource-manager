// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the Lambda log retention planning logic.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ALLOWED_RETENTION_DAYS, hasAllowedPrefix, planRetention } = require('../lambda/lambda-log-retention/retention.js');

describe('hasAllowedPrefix', () => {
  const prefixes = ['mrm-', 'MRM-', 'MediaResourceManager-'];

  it('matches the deployment name forms', () => {
    for (const name of ['mrm-software-library', 'MRM-Api-VolumeManagerFunction02410038', 'MediaResourceManager-Regional-EmptyBucket']) {
      expect(hasAllowedPrefix(name, prefixes)).toBe(true);
    }
  });

  it('does not match other functions', () => {
    for (const name of ['mrmx-tool', 'other-mrm-fn', 'Mrm-fn', 'MediaResourceManagerX-fn']) {
      expect(hasAllowedPrefix(name, prefixes)).toBe(false);
    }
  });
});

describe('planRetention', () => {
  it('sets retention where none is set, creates missing groups, and leaves existing settings alone', () => {
    const plan = planRetention({
      functions: [
        { name: 'mrm-software-library' },
        { name: 'mrm-image-manager', logGroupName: '/aws/lambda/mrm-image-manager' },
        { name: 'mrm-never-ran' },
        { name: 'mrm-operator-set' },
      ],
      logGroups: new Map<string, number | undefined>([
        ['/aws/lambda/mrm-software-library', undefined],
        ['/aws/lambda/mrm-image-manager', undefined],
        ['/aws/lambda/mrm-operator-set', 30],
      ]),
    });
    expect(plan).toEqual({
      create: ['/aws/lambda/mrm-never-ran'],
      setRetention: ['/aws/lambda/mrm-image-manager', '/aws/lambda/mrm-software-library'],
      alreadySet: ['/aws/lambda/mrm-operator-set'],
      customLogGroup: [],
    });
  });

  it('skips functions that log to a log group CDK declares', () => {
    const plan = planRetention({
      functions: [{ name: 'mrm-stack-cleanup', logGroupName: 'MRM-Infrastructure-CleanupFunctionLogGroup-abc' }],
      logGroups: new Map(),
    });
    expect(plan.customLogGroup).toEqual(['mrm-stack-cleanup']);
    expect(plan.create).toEqual([]);
  });

  it('lists each function once', () => {
    const plan = planRetention({
      functions: [{ name: 'mrm-a' }, { name: 'mrm-a' }],
      logGroups: new Map([['/aws/lambda/mrm-a', undefined]]),
    });
    expect(plan.setRetention).toEqual(['/aws/lambda/mrm-a']);
  });
});

describe('ALLOWED_RETENTION_DAYS', () => {
  it('matches the values CDK accepts, without "never expire"', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { RetentionDays } = require('aws-cdk-lib/aws-logs');
    const cdkValues = Object.values(RetentionDays)
      .filter(value => typeof value === 'number' && value !== RetentionDays.INFINITE)
      .sort((a, b) => (a as number) - (b as number));
    expect(ALLOWED_RETENTION_DAYS).toEqual(cdkValues);
  });
});
