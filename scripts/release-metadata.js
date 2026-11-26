#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Fills in the computed fields of a release's entry in releases.json.
 *
 * Usage: node scripts/release-metadata.js <version> [--ref <git-ref>]
 *
 * <version> is the release being prepared (for example 1.7.0). <git-ref> is
 * the commit to describe (default HEAD); pass a tag to backfill an older
 * release. The entry must already exist with the fields a person writes:
 * sessionsDisconnect, adminAction and notes. This script sets:
 *
 * - pipelineTemplateChanged: scripts/deploy-pipeline.yaml differs from the
 *   previous release tag.
 * - hubFingerprint: the regional hub templateVersion this release deploys
 *   (lib/regional-hub-version.ts), or null when it can't be reproduced.
 * - hubUpdate: hubs built by the previous release show Update available
 *   after this one deploys.
 *
 * scripts/upgrade.sh reads the file at the target tag to plan an upgrade.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'releases.json');
const FINGERPRINT_MODULE = 'lib/regional-hub-version.ts';
// Folders the hub fingerprint covers, including the folders that
// lambda/generate-regional-hub-template links to.
const HUB_PATHS = [
  'lambda/generate-regional-hub-template',
  'lambda/dcv-session-manager',
  'lambda/dcv-readiness-check-windows',
  'lambda/dcv-readiness-check-linux',
  'lambda/dcv-readiness-check-macos',
  'lambda/dcv-session-cleanup',
  'lambda/configure-ontap-cifs',
  'ssm-documents',
  'user-data',
];

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
}

/** Whether git diff --quiet reports a difference for the paths. */
function differs(a, b, paths) {
  try {
    git(['diff', '--quiet', a, b, '--', ...paths]);
    return false;
  } catch (err) {
    if (err.status === 1) return true;
    throw err;
  }
}

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? m.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * The hub fingerprint of `ref`, computed with this checkout's fingerprint
 * code on a clean export of the ref. Null when the ref computes it
 * differently (the code isn't the same) or has none.
 */
function hubFingerprint(ref, fingerprint) {
  if (differs(ref, 'HEAD', [FINGERPRINT_MODULE])) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrm-release-metadata-'));
  try {
    const tar = path.join(dir, 'src.tar');
    git(['archive', '--format=tar', '-o', tar, ref, '--', ...HUB_PATHS]);
    execFileSync('tar', ['-xf', tar, '-C', dir]);
    return fingerprint(path.join(dir, 'lambda'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  const version = (args[0] || '').replace(/^v/, '');
  const refIdx = args.indexOf('--ref');
  const ref = refIdx >= 0 ? args[refIdx + 1] : 'HEAD';
  if (!parseVersion(version) || !ref) {
    console.error('Usage: node scripts/release-metadata.js <version> [--ref <git-ref>]');
    process.exit(2);
  }

  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const entry = data.releases.find(r => r.version === version);
  if (!entry) {
    console.error(`releases.json has no entry for ${version}. Add one with sessionsDisconnect, adminAction and notes (see docs/DEVELOPMENT.md).`);
    process.exit(1);
  }
  const missing = [];
  if (typeof entry.sessionsDisconnect !== 'boolean') missing.push('sessionsDisconnect (true or false)');
  if (typeof entry.adminAction !== 'boolean') missing.push('adminAction (true or false)');
  if (typeof entry.notes !== 'string' || !entry.notes.trim()) missing.push('notes');
  if (missing.length) {
    console.error(`releases.json entry ${version} is missing: ${missing.join(', ')}`);
    process.exit(1);
  }

  const previous = git(['tag', '-l', 'v*']).split('\n')
    .filter(t => parseVersion(t) && compareVersions(t, version) < 0)
    .sort(compareVersions)
    .pop();
  if (!previous) {
    console.error(`No release tag before ${version} to compare with.`);
    process.exit(1);
  }

  require('ts-node').register({ transpileOnly: true });
  const { fingerprintRegionalHubCode } = require(path.join(ROOT, FINGERPRINT_MODULE));

  const fp = hubFingerprint(ref, fingerprintRegionalHubCode);
  const previousFp = hubFingerprint(previous, fingerprintRegionalHubCode);
  // Compare fingerprints when both are known. Otherwise any change to the
  // hub code, or to how the fingerprint is computed, changes it.
  const hubUpdate = fp && previousFp
    ? fp !== previousFp
    : differs(previous, ref, [...HUB_PATHS, FINGERPRINT_MODULE]);

  entry.pipelineTemplateChanged = differs(previous, ref, ['scripts/deploy-pipeline.yaml']);
  entry.hubUpdate = hubUpdate;
  entry.hubFingerprint = fp;
  const ordered = {
    version: entry.version,
    pipelineTemplateChanged: entry.pipelineTemplateChanged,
    hubUpdate: entry.hubUpdate,
    hubFingerprint: entry.hubFingerprint,
    sessionsDisconnect: entry.sessionsDisconnect,
    adminAction: entry.adminAction,
    notes: entry.notes,
  };
  data.releases[data.releases.indexOf(entry)] = ordered;
  data.releases.sort((a, b) => compareVersions(b.version, a.version));
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
  console.log(`${version} (compared with ${previous}): pipelineTemplateChanged=${ordered.pipelineTemplateChanged} hubUpdate=${hubUpdate} hubFingerprint=${fp}`);
}

main();
