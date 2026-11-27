// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';
import * as path from 'path';

/**
 * releases.json is read by scripts/upgrade.sh at the target tag. Every entry
 * needs all fields with the right types, versions are newest first, and
 * every release in CHANGELOG.md from 1.4.0 on has an entry.
 */

const ROOT = path.join(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'releases.json'), 'utf8'));
const releases: Record<string, unknown>[] = data.releases;

const parse = (v: string) => v.split('.').map(Number);
const cmp = (a: string, b: string) => {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

describe('releases.json', () => {
  test('has schema version 1 and complete entries', () => {
    expect(data.schemaVersion).toBe(1);
    for (const r of releases) {
      expect(r.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(typeof r.pipelineTemplateChanged).toBe('boolean');
      expect(typeof r.hubUpdate).toBe('boolean');
      expect(r.hubFingerprint === null || /^[0-9a-f]{16}$/.test(String(r.hubFingerprint))).toBe(true);
      expect(typeof r.sessionsDisconnect).toBe('boolean');
      expect(typeof r.adminAction).toBe('boolean');
      expect(typeof r.notes).toBe('string');
      expect(String(r.notes).trim()).not.toBe('');
    }
  });

  test('lists versions once, newest first', () => {
    const versions = releases.map(r => String(r.version));
    expect([...versions].sort((a, b) => cmp(b, a))).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
  });

  test('has an entry for every CHANGELOG release from 1.4.0 on', () => {
    const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
    const released = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map(m => m[1]).filter(v => cmp(v, '1.4.0') >= 0);
    expect(released.length).toBeGreaterThan(0);
    const versions = new Set(releases.map(r => r.version));
    expect(released.filter(v => !versions.has(v))).toEqual([]);
  });
});
