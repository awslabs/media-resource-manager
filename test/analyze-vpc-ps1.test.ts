// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * scripts/analyze-vpc.ps1 writes each embedded node script to a temp file and
 * runs `node <file>`, so process.argv[1] is the file path. These tests run the
 * scripts the same way, with no PowerShell, so a script that reads its JSON
 * from argv[1] (the bug that broke the Windows analyzer) fails here.
 */

const PS1 = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'analyze-vpc.ps1'), 'utf8');

/** The body of the here-string assigned to `$<name> = @"`. */
function embedded(name: string): string {
  const m = PS1.match(new RegExp(`\\$${name} = @"\\r?\\n([\\s\\S]*?)\\r?\\n"@`));
  if (!m) throw new Error(`no $${name} here-string in analyze-vpc.ps1`);
  return m[1];
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrm-analyze-vpc-ps1-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function runAsPs1(script: string, env: Record<string, string>) {
  const file = path.join(dir, 'script.js');
  fs.writeFileSync(file, script);
  const r = spawnSync('node', [file], { cwd: dir, env: { ...process.env, ...env }, encoding: 'utf8' });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

const SUBNETS = [
  { SubnetId: 'subnet-0a01', AZ: 'us-east-1a', CidrBlock: '10.0.0.0/24', MapPublicIpOnLaunch: true, Name: 'public-a' },
  { SubnetId: 'subnet-0a02', AZ: 'us-east-1a', CidrBlock: '10.0.1.0/24', MapPublicIpOnLaunch: false, Name: 'app-a' },
  { SubnetId: 'subnet-0b01', AZ: 'us-east-1b', CidrBlock: '10.0.10.0/24', MapPublicIpOnLaunch: true, Name: 'public-b' },
  { SubnetId: 'subnet-0b02', AZ: 'us-east-1b', CidrBlock: '10.0.11.0/24', MapPublicIpOnLaunch: false, Name: 'app-b' },
];

describe('analyze-vpc.ps1 embedded node scripts', () => {
  test.each(['analysisScript', 'checkScript'])('$%s has no PowerShell variables or escapes in its JavaScript', name => {
    // `@"` here-strings expand $name and backtick escapes; these scripts must reach node unchanged.
    const matches = PS1.match(new RegExp(`\\$${name} = @"\\r?\\n[\\s\\S]*?\\r?\\n"@`, 'g')) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      const body = m.replace(/^[^\n]*\n/, '').replace(/\n"@$/, '');
      expect(body).not.toMatch(/[$`]/);
    }
  });

  test('subnet analysis reads its JSON from the environment, not argv[1], and exits 0 for one subnet per AZ', () => {
    const r = runAsPs1(embedded('analysisScript'), { MRM_SUBNETS_JSON: JSON.stringify(SUBNETS) });
    expect(r.output).not.toMatch(/SyntaxError/);
    expect(r.status).toBe(0);
    const analysis = JSON.parse(fs.readFileSync(path.join(dir, 'vpc-analysis.json'), 'utf8'));
    expect(analysis.subnets['us-east-1a'].private.map((s: { SubnetId: string }) => s.SubnetId)).toEqual(['subnet-0a02']);
  });

  test('subnet analysis exits 2 when an AZ has two private subnets', () => {
    const more = [...SUBNETS, { SubnetId: 'subnet-0a03', AZ: 'us-east-1a', CidrBlock: '10.0.2.0/24', MapPublicIpOnLaunch: false, Name: 'mgmt-a' }];
    const r = runAsPs1(embedded('analysisScript'), { MRM_SUBNETS_JSON: JSON.stringify(more) });
    expect(r.status).toBe(2);
  });

  test('NACL check reads its JSON from the environment, not argv[1]', () => {
    const nacls = [{ AclId: 'acl-0abc', Associations: ['subnet-0a02'], Entries: [{ Egress: true, RuleAction: 'allow', Protocol: '-1' }] }];
    const r = runAsPs1(embedded('checkScript'), { MRM_NACLS_JSON: JSON.stringify(nacls) });
    expect(r.output).not.toMatch(/SyntaxError/);
    expect(r.status).toBe(0);
    expect(r.output).toMatch(/All NACLs allow UDP traffic/);
  });

  test('egress check stops on a subnet with no default route and passes a NAT route', () => {
    // Test-PrivateEgress's $checkScript is the second one in the file.
    const egress = [...PS1.matchAll(/\$checkScript = @"\r?\n([\s\S]*?)\r?\n"@/g)][1][1];
    const env = {
      MRM_ROUTE_TABLES: JSON.stringify([
        { RouteTableId: 'rtb-0main', Associations: [{ Main: true }], Routes: [] },
        { RouteTableId: 'rtb-0a02', Associations: [{ SubnetId: 'subnet-0a02' }], Routes: [{ DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-0a', State: 'active' }] },
      ]),
      MRM_SUBNETS: JSON.stringify(SUBNETS),
      MRM_EGRESS_MODE: 'fail',
    };
    const bad = runAsPs1(egress, { ...env, MRM_PRIVATE_IDS: 'subnet-0a02,subnet-0b02' });
    expect(bad.status).toBe(1);
    expect(bad.output).toContain('ERROR subnet-0b02 (us-east-1b): route table rtb-0main (VPC main route table) -> no default route');
    const good = runAsPs1(egress, { ...env, MRM_PRIVATE_IDS: 'subnet-0a02' });
    expect(good.status).toBe(0);
    expect(good.output).toContain('OK subnet-0a02 (us-east-1a): route table rtb-0a02 -> NAT gateway nat-0a');
  });
});
