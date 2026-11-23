// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Runs the deploy pipeline's "apply runtime parameter overrides" step (the
 * inline node script in scripts/deploy-pipeline.yaml) against a saved
 * parameters.json. Checks the PrivateSubnetIds / PublicSubnetIds stack
 * parameters (#18) and that new subnet IDs clear the saved route tables, so
 * deploy.sh reruns the VPC analyzer on them.
 */

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'deploy-pipeline.yaml'), 'utf8');

function overridesScript(): string {
  const marker = TEMPLATE.indexOf('const envMap = {');
  const start = TEMPLATE.lastIndexOf('node -e "', marker) + 'node -e "'.length;
  const end = TEMPLATE.indexOf('\n                    "\n', marker);
  return TEMPLATE.slice(start, end);
}

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrm-pipeline-overrides-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function run(saved: Record<string, string>, env: Record<string, string>): Record<string, string> {
  const list = Object.entries(saved).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue }));
  fs.writeFileSync(path.join(workDir, 'parameters.json'), JSON.stringify(list));
  const childEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...env };
  const result = spawnSync('node', ['-e', overridesScript()], { cwd: workDir, env: childEnv, encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  const out = JSON.parse(fs.readFileSync(path.join(workDir, 'parameters.json'), 'utf8')) as { ParameterKey: string; ParameterValue: string }[];
  return Object.fromEntries(out.map(p => [p.ParameterKey, p.ParameterValue]));
}

const SAVED = {
  VpcId: 'vpc-0abc1234def567890',
  PrivateSubnetIds: 'subnet-0a02,subnet-0b02',
  PublicSubnetIds: 'subnet-0a01,subnet-0b01',
  PrivateRouteTableIds: 'rtb-0a02,rtb-0b02',
};

describe('deploy pipeline parameter overrides', () => {
  test('the script is passed to bash unchanged (no $, backtick or backslash)', () => {
    expect(overridesScript()).toContain('MRM_PRIVATE_SUBNET_IDS');
    expect(overridesScript()).not.toMatch(/[$`\\]/);
  });

  test('applies the subnet stack parameters to a first-run config', () => {
    const out = run(
      { VpcId: 'vpc-0abc1234def567890' },
      { MRM_PRIVATE_SUBNET_IDS: 'subnet-0a02,subnet-0b02', MRM_PUBLIC_SUBNET_IDS: 'subnet-0a01,subnet-0b01' },
    );
    expect(out.PrivateSubnetIds).toBe('subnet-0a02,subnet-0b02');
    expect(out.PublicSubnetIds).toBe('subnet-0a01,subnet-0b01');
  });

  test('clears the saved route tables when PrivateSubnetIds changes', () => {
    const out = run(SAVED, { MRM_PRIVATE_SUBNET_IDS: 'subnet-0a03,subnet-0b03' });
    expect(out.PrivateSubnetIds).toBe('subnet-0a03,subnet-0b03');
    expect(out.PrivateRouteTableIds).toBe('');
  });

  test('keeps the route tables when PrivateSubnetIds is unchanged or unset', () => {
    expect(run(SAVED, { MRM_PRIVATE_SUBNET_IDS: SAVED.PrivateSubnetIds })).toEqual(SAVED);
    expect(run(SAVED, {})).toEqual(SAVED);
  });

  test('keeps route tables that the same build overrides explicitly', () => {
    const out = run(SAVED, {
      MRM_PARAM_OVERRIDES: JSON.stringify({ PrivateSubnetIds: 'subnet-0a03,subnet-0b03', PrivateRouteTableIds: 'rtb-0mgmt,rtb-0mgmt' }),
    });
    expect(out.PrivateSubnetIds).toBe('subnet-0a03,subnet-0b03');
    expect(out.PrivateRouteTableIds).toBe('rtb-0mgmt,rtb-0mgmt');
  });
});
