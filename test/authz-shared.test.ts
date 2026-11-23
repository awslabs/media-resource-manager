// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * authz.js exists once, in lambda/shared/. These checks keep it that way and
 * keep shared code out of the regional hub Lambdas, which a hub builds from
 * their own folders, so they can't load lambda/shared/.
 */
import * as fs from 'fs';
import * as path from 'path';
import { REGIONAL_HUB_LAMBDAS } from '../lib/regional-hub-version';

const LAMBDA_DIR = path.join(__dirname, '..', 'lambda');
const HUB_LAMBDAS = ['generate-regional-hub-template', ...REGIONAL_HUB_LAMBDAS];

const lambdaDirs = fs.readdirSync(LAMBDA_DIR, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name !== 'shared')
  .map(entry => entry.name);

/** Source files of one Lambda folder, without its node_modules. */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (/\.(js|mjs|cjs|ts|py)$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(path.join(LAMBDA_DIR, dir));
  return files;
}

const sourceOf = (dir: string) => sourceFiles(dir).map(file => fs.readFileSync(file, 'utf8')).join('\n');

describe('authz.js in lambda/shared', () => {
  const cdkSource = ['api-stack.ts', 'datasync-stack.ts', 'storage-stack.ts']
    .map(file => fs.readFileSync(path.join(__dirname, '..', 'lib', file), 'utf8'))
    .join('\n');
  const usesAuthz = lambdaDirs.filter(dir => sourceOf(dir).includes("require('../shared/authz')"));

  it('is required by the API Lambdas that check the caller', () => {
    expect(usesAuthz.length).toBeGreaterThanOrEqual(26);
  });

  it('has no copy in a Lambda folder outside the regional hub', () => {
    const copies = lambdaDirs
      .filter(dir => !HUB_LAMBDAS.includes(dir))
      .filter(dir => fs.existsSync(path.join(LAMBDA_DIR, dir, 'authz.js')));
    expect(copies).toEqual([]);
  });

  it('is never loaded from a local copy', () => {
    const local = lambdaDirs.filter(dir => /require\(\s*['"]\.\/authz(\.js)?['"]\s*\)/.test(sourceOf(dir)));
    expect(local).toEqual([]);
  });

  it('is packaged with every Lambda that requires it', () => {
    for (const dir of usesAuthz) {
      expect({ dir, packagedWithShared: cdkSource.includes(`lambdaCodeWithShared('${dir}')`) })
        .toEqual({ dir, packagedWithShared: true });
    }
  });
});

describe('regional hub Lambdas', () => {
  it.each(HUB_LAMBDAS)('%s does not use lambda/shared', dir => {
    expect(sourceOf(dir)).not.toMatch(/\.\.\/shared\b|from\s+shared\b|import\s+shared\b/);
  });
});
