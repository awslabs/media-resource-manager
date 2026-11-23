// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// scripts/deploy-pipeline.yaml: the buildspec keeps the deployment config
// (parameters.json) in an SSM String parameter, and the template exposes the
// settings the README lists. The buildspec shell blocks run here against a
// fake `aws` CLI that rejects values over the SSM limit, as SSM does.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');
const TEMPLATE_LINES = fs.readFileSync(path.join(ROOT, 'scripts', 'deploy-pipeline.yaml'), 'utf8').split('\n');
const EXAMPLE_PATH = path.join(ROOT, 'parameters.example.json');
const EXAMPLE: { ParameterKey: string; ParameterValue: string; Description?: string }[] =
  JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));
const SSM_LIMIT = 8192;
const CONFIG_PARAM = '/MediaResourceManager/DeploymentConfig/parameters';

const indent = (line: string) => line.length - line.trimStart().length;

/** Body of the first `- |` buildspec command after the line containing `marker`, de-indented. */
function commandAfter(marker: string): string {
  const start = TEMPLATE_LINES.findIndex(line => line.includes(marker));
  if (start < 0) throw new Error(`marker not found: ${marker}`);
  const dash = TEMPLATE_LINES.findIndex((line, i) => i > start && /^\s*- \|\s*$/.test(line));
  const body: string[] = [];
  for (let i = dash + 1; i < TEMPLATE_LINES.length; i++) {
    const line = TEMPLATE_LINES[i];
    if (line.trim() && indent(line) <= indent(TEMPLATE_LINES[dash])) break;
    body.push(line);
  }
  const pad = Math.min(...body.filter(line => line.trim()).map(indent));
  return body.map(line => line.slice(pad)).join('\n');
}

/** Lines of a top-level entry in the template's Parameters section. */
function parameter(name: string): string[] {
  const section = TEMPLATE_LINES.indexOf('Parameters:');
  const start = TEMPLATE_LINES.indexOf(`  ${name}:`, section);
  if (section < 0 || start < 0) throw new Error(`parameter not found: ${name}`);
  const end = TEMPLATE_LINES.findIndex((line, i) => i > start && line.trim() !== '' && indent(line) <= 2);
  return TEMPLATE_LINES.slice(start + 1, end);
}

const FAKE_AWS = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_AWS_LOG, JSON.stringify(args) + '\\n');
const opt = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (args[0] === 'ssm' && args[1] === 'get-parameter' && opt('--name') === process.env.FAKE_SSM_NAME && process.env.FAKE_SSM_VALUE) {
  process.stdout.write(process.env.FAKE_SSM_VALUE + '\\n');
  process.exit(0);
}
if (args[0] === 'ssm' && args[1] === 'put-parameter') {
  let value = opt('--value') || '';
  if (value.startsWith('file://')) value = fs.readFileSync(value.slice('file://'.length), 'utf8');
  if (process.env.FAKE_SSM_PUT_FAILS || Buffer.byteLength(value) > ${SSM_LIMIT}) {
    process.stderr.write('An error occurred (ValidationException) when calling the PutParameter operation\\n');
    process.exit(254);
  }
  fs.writeFileSync(process.env.FAKE_SSM_STORED, value);
  process.stdout.write('{"Version": 1, "Tier": "Advanced"}\\n');
  process.exit(0);
}
process.stderr.write('An error occurred (ParameterNotFound)\\n');
process.exit(254);
`;

interface Run { status: number | null; stdout: string; stderr: string; stored?: string; awsCalls: string[][]; dir: string }

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

function runBlock(block: string, opts: { parametersJson?: string; ssmValue?: string; putFails?: boolean; env?: Record<string, string> } = {}): Run {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrm-pipeline-'));
  tempDirs.push(dir);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'aws'), FAKE_AWS, { mode: 0o755 });
  fs.copyFileSync(EXAMPLE_PATH, path.join(dir, 'parameters.example.json'));
  if (opts.parametersJson !== undefined) fs.writeFileSync(path.join(dir, 'parameters.json'), opts.parametersJson);
  const log = path.join(dir, 'aws-calls.log');
  const storedPath = path.join(dir, 'ssm-stored.txt');
  const result = spawnSync('bash', ['-c', block], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      PROJECT_DIR: dir,
      PASCAL_CASE: 'MediaResourceManager',
      ACRONYM: 'MRM',
      SSM_CONFIG_PARAM: CONFIG_PARAM,
      FAKE_AWS_LOG: log,
      FAKE_SSM_STORED: storedPath,
      FAKE_SSM_NAME: CONFIG_PARAM,
      ...(opts.ssmValue ? { FAKE_SSM_VALUE: opts.ssmValue } : {}),
      ...(opts.putFails ? { FAKE_SSM_PUT_FAILS: '1' } : {}),
      ...(opts.env || {}),
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    stored: fs.existsSync(storedPath) ? fs.readFileSync(storedPath, 'utf8') : undefined,
    awsCalls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
    dir,
  };
}

const putCalls = (run: Run) => run.awsCalls.filter(args => args[0] === 'ssm' && args[1] === 'put-parameter');
const readParams = (run: Run) => JSON.parse(fs.readFileSync(path.join(run.dir, 'parameters.json'), 'utf8'));
const valueOf = (params: { ParameterKey: string; ParameterValue: string }[], key: string) =>
  params.find(p => p.ParameterKey === key)?.ParameterValue;

const SEED_BLOCK = commandAfter('# Restore parameters.json from SSM, or seed from CFN parameters');
const OVERRIDES_BLOCK = commandAfter('# Apply runtime parameter overrides');
const POST_BUILD_BLOCK = commandAfter('post_build:');

describe('deploy-pipeline.yaml: deployment config in SSM', () => {
  test('the first build seeds the example config to SSM under the 8192-byte limit', () => {
    const run = runBlock(SEED_BLOCK);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Configuration seeded to SSM');
    expect(run.stored).toBeDefined();
    expect(Buffer.byteLength(run.stored!)).toBeLessThanOrEqual(SSM_LIMIT);
    const stored = JSON.parse(run.stored!);
    expect(stored.map((p: any) => p.ParameterKey)).toEqual(EXAMPLE.map(p => p.ParameterKey));
    expect(stored.every((p: any) => Object.keys(p).sort().join() === 'ParameterKey,ParameterValue')).toBe(true);
    expect(valueOf(stored, 'VpcCidr')).toBe('10.1.0.0/16');
    expect(valueOf(stored, 'DcvBrowserPath')).toBe('cloudfront');
  });

  test('the first build fails when SSM rejects the seed', () => {
    const run = runBlock(SEED_BLOCK, { putFails: true });
    expect(run.status).not.toBe(0);
    expect(run.stdout).not.toContain('Configuration seeded to SSM');
    expect(run.stdout + run.stderr).toContain('could not save the deployment config to SSM');
  });

  test('a later build restores the stored config and does not re-seed it', () => {
    const saved = JSON.stringify(EXAMPLE.map(({ ParameterKey, ParameterValue }) => ({
      ParameterKey,
      ParameterValue: ParameterKey === 'DcvAllowedClientCidrs' ? '203.0.113.0/24' : ParameterValue,
    })));
    const run = runBlock(SEED_BLOCK, { ssmValue: saved });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Restored parameters.json from SSM');
    expect(putCalls(run)).toHaveLength(0);
    expect(valueOf(readParams(run), 'DcvAllowedClientCidrs')).toBe('203.0.113.0/24');
  });

  test('post_build saves a compact copy, without descriptions', () => {
    const run = runBlock(POST_BUILD_BLOCK, { parametersJson: fs.readFileSync(EXAMPLE_PATH, 'utf8') });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Configuration saved to SSM');
    expect(putCalls(run)[0]).toEqual(expect.arrayContaining(['--name', CONFIG_PARAM]));
    expect(Buffer.byteLength(run.stored!)).toBeLessThanOrEqual(SSM_LIMIT);
    expect(run.stored).not.toContain('"Description"');
  });

  test('post_build fails when SSM rejects the save', () => {
    const run = runBlock(POST_BUILD_BLOCK, { parametersJson: fs.readFileSync(EXAMPLE_PATH, 'utf8'), putFails: true });
    expect(run.status).not.toBe(0);
    expect(run.stdout).not.toContain('Configuration saved to SSM');
  });

  test('post_build fails with a clear message, before calling SSM, when the config is over the limit', () => {
    const big = JSON.stringify([...EXAMPLE, { ParameterKey: 'WafAllowedIps', ParameterValue: '203.0.113.0/24,'.repeat(600) }]);
    const run = runBlock(POST_BUILD_BLOCK, { parametersJson: big });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/over the 8192-byte SSM parameter limit/);
    expect(putCalls(run)).toHaveLength(0);
  });

  test('every put-parameter in the buildspec fails the build on error', () => {
    const statements: string[] = [];
    for (let i = 0; i < TEMPLATE_LINES.length; i++) {
      if (!/^\s*aws ssm put-parameter\b/.test(TEMPLATE_LINES[i])) continue;
      let statement = TEMPLATE_LINES[i];
      while (/\\\s*$/.test(TEMPLATE_LINES[i])) statement += '\n' + TEMPLATE_LINES[++i];
      statements.push(statement);
    }
    expect(statements.length).toBeGreaterThanOrEqual(6);
    for (const statement of statements) {
      // The one-time macOS subnet seed is best effort on purpose (--no-overwrite).
      if (statement.includes('--no-overwrite')) continue;
      expect(statement).toMatch(/\|\| \{ echo "ERROR: [^"]+"; exit 1; \}$/);
    }
  });
});

describe('deploy-pipeline.yaml: gateway settings', () => {
  const GATEWAY = {
    DcvBrowserPath: 'MRM_DCV_BROWSER_PATH',
    DcvHostedZoneId: 'MRM_DCV_HOSTED_ZONE_ID',
    DcvAllowedClientCidrs: 'MRM_DCV_ALLOWED_CLIENT_CIDRS',
    DcvAllowedPrefixListIds: 'MRM_DCV_ALLOWED_PREFIX_LIST_IDS',
  };

  const allowedPattern = (name: string) => {
    const line = parameter(name).find(l => l.trim().startsWith('AllowedPattern:'));
    if (!line) throw new Error(`${name} has no AllowedPattern`);
    return new RegExp(/AllowedPattern: '(.*)'$/.exec(line.trim())![1]);
  };

  test.each(Object.entries(GATEWAY))('%s is a pipeline parameter passed to the build as %s', (name, envVar) => {
    expect(parameter(name)).toEqual(expect.arrayContaining(["    Type: String", "    Default: ''"]));
    const envLine = TEMPLATE_LINES.indexOf(`          - Name: ${envVar}`);
    expect(envLine).toBeGreaterThan(0);
    expect(TEMPLATE_LINES[envLine + 1].trim()).toBe(`Value: !Ref ${name}`);
    expect(OVERRIDES_BLOCK).toContain(`${envVar}: '${name}',`);
    expect(TEMPLATE_LINES).toContain(`          - ${name}`); // console parameter group
  });

  test('DcvBrowserPath accepts only cloudfront, direct or empty', () => {
    expect(parameter('DcvBrowserPath').map(l => l.trim())).toContain("AllowedValues: ['', cloudfront, direct]");
  });

  test('DcvAllowedClientCidrs pattern accepts CIDR lists only', () => {
    const pattern = allowedPattern('DcvAllowedClientCidrs');
    for (const ok of ['', '203.0.113.0/24', '203.0.113.0/24,198.51.100.0/24', '203.0.113.0/24, 198.51.100.7/32']) {
      expect(pattern.test(ok)).toBe(true);
    }
    for (const bad of ['203.0.113.0', 'pl-0123456789abcdef0', '203.0.113.0/24,', 'any']) {
      expect(pattern.test(bad)).toBe(false);
    }
  });

  test('DcvAllowedPrefixListIds pattern accepts up to 2 prefix list IDs', () => {
    const pattern = allowedPattern('DcvAllowedPrefixListIds');
    for (const ok of ['', 'pl-0123456789abcdef0', 'pl-12345678,pl-0123456789abcdef0', 'pl-12345678, pl-abcdef12']) {
      expect(pattern.test(ok)).toBe(true);
    }
    for (const bad of ['pl-1,pl-2', 'pl-12345678,pl-23456789,pl-34567890', '203.0.113.0/24', 'pl-ABCDEF12']) {
      expect(pattern.test(bad)).toBe(false);
    }
  });

  test('the build applies the gateway settings from the pipeline parameters', () => {
    const saved = JSON.stringify(EXAMPLE.map(({ ParameterKey, ParameterValue }) => ({ ParameterKey, ParameterValue })));
    const run = runBlock(OVERRIDES_BLOCK, {
      parametersJson: saved,
      env: {
        MRM_DCV_BROWSER_PATH: 'direct',
        MRM_DCV_HOSTED_ZONE_ID: 'Z0123456789ABCDEFGHIJ',
        MRM_DCV_ALLOWED_CLIENT_CIDRS: '203.0.113.0/24',
        MRM_DCV_ALLOWED_PREFIX_LIST_IDS: 'pl-0123456789abcdef0',
      },
    });
    expect(run.status).toBe(0);
    const params = readParams(run);
    expect(valueOf(params, 'DcvBrowserPath')).toBe('direct');
    expect(valueOf(params, 'DcvHostedZoneId')).toBe('Z0123456789ABCDEFGHIJ');
    expect(valueOf(params, 'DcvAllowedClientCidrs')).toBe('203.0.113.0/24');
    expect(valueOf(params, 'DcvAllowedPrefixListIds')).toBe('pl-0123456789abcdef0');
  });

  test('empty gateway parameters keep the stored values', () => {
    const saved = JSON.stringify(EXAMPLE.map(({ ParameterKey, ParameterValue }) => ({
      ParameterKey,
      ParameterValue: ParameterKey === 'DcvAllowedClientCidrs' ? '198.51.100.0/24' : ParameterValue,
    })));
    const run = runBlock(OVERRIDES_BLOCK, { parametersJson: saved });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('No overrides to apply');
    expect(valueOf(readParams(run), 'DcvAllowedClientCidrs')).toBe('198.51.100.0/24');
  });

  test('every parameter in the README pipeline table is a template parameter', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const table = readme.slice(readme.indexOf('**2. Available Parameters:**'), readme.indexOf('**How `ProductName` drives naming:**'));
    const names = [...table.matchAll(/^\| `(\w+)` \|/gm)].map(m => m[1]);
    expect(names).toEqual(expect.arrayContaining(Object.keys(GATEWAY)));
    for (const name of names) expect(() => parameter(name)).not.toThrow();
  });
});
