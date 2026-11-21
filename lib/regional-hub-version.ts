// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as crypto from 'crypto';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';

/** Lambdas whose code is copied into every regional hub. */
export const REGIONAL_HUB_LAMBDAS = [
  'dcv-session-manager',
  'dcv-readiness-check-windows',
  'dcv-readiness-check-linux',
  'dcv-readiness-check-macos',
  'dcv-session-cleanup',
  'configure-ontap-cifs',
];

const LAMBDA_ROOT = path.join(__dirname, '..', 'lambda');

/**
 * Installed and generated files, left out of the fingerprint. Installing a
 * dependency that compiles native code (ssh2 in configure-ontap-cifs) writes
 * different files on every build. package-lock.json is still included, so a
 * dependency update still changes the fingerprint.
 */
export const FINGERPRINT_EXCLUDE = ['node_modules', '__pycache__', '*.pyc'];

let cachedVersion: string | undefined;

/**
 * Fingerprint of the regional hub source files under `lambdaRoot`: the
 * template generator (including its SSM documents and user data, which it
 * links to) and the Lambdas copied into each hub.
 */
export function fingerprintRegionalHubCode(lambdaRoot: string): string {
  const parts = ['generate-regional-hub-template', ...REGIONAL_HUB_LAMBDAS]
    .map(dir => `${dir}=${cdk.FileSystem.fingerprint(path.join(lambdaRoot, dir), { exclude: FINGERPRINT_EXCLUDE })}`);
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Fingerprint of the code a regional hub is built from.
 *
 * It is saved on a hub when the hub is created or updated. A hub whose saved
 * version differs from this one is running older code and needs an update.
 * It changes only when that code changes, not on every release or build.
 */
export function regionalHubTemplateVersion(): string {
  if (!cachedVersion) {
    cachedVersion = fingerprintRegionalHubCode(LAMBDA_ROOT);
  }
  return cachedVersion;
}
