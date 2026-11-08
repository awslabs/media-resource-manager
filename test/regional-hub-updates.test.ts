// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for regional hub update detection (lambda/shared/regional-hub-updates.js)
 * and the template version fingerprint (lib/regional-hub-version.ts).
 */
import { regionalHubTemplateVersion, REGIONAL_HUB_LAMBDAS } from '../lib/regional-hub-version';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isUpdateAvailable, decideUpdateOutcome, reconcileUpdatingHubs, UPDATE_START_TIMEOUT_MS } =
  require('../lambda/shared/regional-hub-updates.js');

const CURRENT = 'aaaaaaaaaaaaaaaa';
const STARTED = '2026-11-08T12:00:00.000Z';
const startedMs = Date.parse(STARTED);

describe('isUpdateAvailable', () => {
  const hub = { region: 'us-west-2', status: 'available', templateVersion: CURRENT };

  it('is false for a hub on the current version', () => {
    expect(isUpdateAvailable(hub, CURRENT)).toBe(false);
  });

  it('is true for a hub on another version, or with none (created before versions were saved)', () => {
    expect(isUpdateAvailable({ ...hub, templateVersion: 'bbbbbbbbbbbbbbbb' }, CURRENT)).toBe(true);
    expect(isUpdateAvailable({ ...hub, templateVersion: undefined }, CURRENT)).toBe(true);
  });

  it('is true after a failed update, so it can be retried', () => {
    expect(isUpdateAvailable({ ...hub, status: 'update_failed', templateVersion: 'old' }, CURRENT)).toBe(true);
  });

  it('is false while a hub is changing, for the primary region, and without a current version', () => {
    for (const status of ['creating', 'updating', 'deleting', 'failed']) {
      expect(isUpdateAvailable({ ...hub, status, templateVersion: 'old' }, CURRENT)).toBe(false);
    }
    expect(isUpdateAvailable({ ...hub, isPrimary: true, templateVersion: 'old' }, CURRENT)).toBe(false);
    expect(isUpdateAvailable({ ...hub, templateVersion: 'old' }, undefined)).toBe(false);
  });
});

describe('decideUpdateOutcome', () => {
  const hub = { region: 'us-west-2', status: 'updating', updateStartedAt: STARTED, pendingTemplateVersion: CURRENT };
  const stack = (StackStatus: string, LastUpdatedTime = '2026-11-08T12:01:00.000Z', extra = {}) =>
    ({ StackStatus, LastUpdatedTime, CreationTime: '2026-07-01T14:00:00.000Z', ...extra });

  it('waits while the stack update is running', () => {
    expect(decideUpdateOutcome(hub, stack('UPDATE_IN_PROGRESS'), startedMs + 60000)).toBeNull();
    expect(decideUpdateOutcome(hub, stack('UPDATE_ROLLBACK_IN_PROGRESS'), startedMs + 60000)).toBeNull();
  });

  it('records the new version when the update succeeds', () => {
    expect(decideUpdateOutcome(hub, stack('UPDATE_COMPLETE'), startedMs + 600000))
      .toEqual({ status: 'available', templateVersion: CURRENT });
  });

  it('records the reason when the update rolls back or fails', () => {
    expect(decideUpdateOutcome(hub, stack('UPDATE_ROLLBACK_COMPLETE', undefined, { StackStatusReason: 'Resource failed' }), startedMs + 600000))
      .toEqual({ status: 'update_failed', lastError: 'Resource failed' });
    expect(decideUpdateOutcome(hub, stack('UPDATE_FAILED'), startedMs + 600000))
      .toEqual({ status: 'update_failed', lastError: 'The stack update ended in UPDATE_FAILED.' });
  });

  it('ignores an earlier stack result until the update reaches CloudFormation', () => {
    const earlier = stack('UPDATE_COMPLETE', '2026-11-01T09:00:00.000Z');
    expect(decideUpdateOutcome(hub, earlier, startedMs + 60000)).toBeNull();
    expect(decideUpdateOutcome(hub, earlier, startedMs + UPDATE_START_TIMEOUT_MS + 1000))
      .toEqual({ status: 'update_failed', lastError: 'The stack update did not start.' });
  });

  it('settles hubs left in updating before updateStartedAt existed', () => {
    const legacy = { region: 'us-west-2', status: 'updating', updatedAt: '2026-11-08T12:00:05.000Z' };
    expect(decideUpdateOutcome(legacy, stack('UPDATE_COMPLETE', '2026-11-08T12:00:04.000Z'), startedMs + 600000))
      .toEqual({ status: 'available', templateVersion: undefined });
  });

  it('fails when the stack no longer exists', () => {
    expect(decideUpdateOutcome(hub, null, startedMs)).toEqual({ status: 'update_failed', lastError: 'The regional hub stack was not found.' });
  });
});

describe('reconcileUpdatingHubs', () => {
  it('leaves hubs alone when none is updating, without loading the CloudFormation SDK', async () => {
    const hubs = [{ region: 'us-west-2', status: 'available' }];
    const docClient = { send: jest.fn() };
    await expect(reconcileUpdatingHubs(hubs, { docClient, tableName: 't', UpdateCommand: jest.fn() })).resolves.toBe(hubs);
    expect(docClient.send).not.toHaveBeenCalled();
  });
});

describe('regionalHubTemplateVersion', () => {
  it('is a stable 16-character fingerprint', () => {
    const version = regionalHubTemplateVersion();
    expect(version).toMatch(/^[0-9a-f]{16}$/);
    expect(regionalHubTemplateVersion()).toBe(version);
  });

  it('covers the Lambdas copied into regional hubs', () => {
    expect(REGIONAL_HUB_LAMBDAS).toEqual(expect.arrayContaining(['dcv-session-manager', 'dcv-session-cleanup', 'configure-ontap-cifs']));
  });
});
