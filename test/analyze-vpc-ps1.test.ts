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
  test.each(['analysisScript', 'checkScript', 'validateScript'])('$%s has no PowerShell variables or escapes in its JavaScript', name => {
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

  test('subnet analysis counts a subnet routed to an internet gateway as public, even without public IPs', () => {
    const mgmt = { SubnetId: 'subnet-0a03', AZ: 'us-east-1a', CidrBlock: '10.0.2.0/24', MapPublicIpOnLaunch: false, Name: 'mgmt-a' };
    const routeTables = [
      { RouteTableId: 'rtb-0main', Associations: [{ Main: true }], Routes: [{ DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-0a', State: 'active' }] },
      { RouteTableId: 'rtb-0igw', Associations: [{ SubnetId: 'subnet-0a03' }], Routes: [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-0abc', State: 'active' }] },
    ];
    const r = runAsPs1(embedded('analysisScript'), {
      MRM_SUBNETS_JSON: JSON.stringify([...SUBNETS, mgmt]),
      MRM_CLASSIFY_ROUTE_TABLES: JSON.stringify(routeTables),
    });
    // Two public subnets in us-east-1a, so a selection is needed
    expect(r.status).toBe(2);
    const analysis = JSON.parse(fs.readFileSync(path.join(dir, 'vpc-analysis.json'), 'utf8'));
    const ids = (list: Array<{ SubnetId: string }>) => list.map(s => s.SubnetId);
    expect(ids(analysis.subnets['us-east-1a'].public)).toEqual(['subnet-0a01', 'subnet-0a03']);
    expect(ids(analysis.subnets['us-east-1a'].private)).toEqual(['subnet-0a02']);
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

describe('analyze-vpc.ps1 explicit PrivateSubnetIds', () => {
  const OTHER_VPC_SUBNET = 'subnet-0f99';
  const base = {
    MRM_SUBNETS_JSON: JSON.stringify(SUBNETS),
    MRM_VPC_ID: 'vpc-0abc',
    MRM_SEL_PRIVATE: 'subnet-0a02,subnet-0b02',
    MRM_SEL_PUBLIC: 'subnet-0a01,subnet-0b01',
    MRM_SEL_AZS: 'us-east-1a,us-east-1b',
  };
  const validate = (env: Record<string, string>) => {
    const r = runAsPs1(embedded('validateScript'), { ...base, ...env });
    const file = path.join(dir, 'selected-subnets.json');
    return { ...r, selection: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined };
  };

  test('keeps a valid list in the given order', () => {
    const r = validate({});
    expect(r.status).toBe(0);
    expect(r.selection).toEqual({
      privateSubnetIds: ['subnet-0a02', 'subnet-0b02'],
      publicSubnetIds: ['subnet-0a01', 'subnet-0b01'],
      availabilityZones: ['us-east-1a', 'us-east-1b'],
    });
  });

  test('takes the AZ order from PrivateSubnetIds when AvailabilityZones is empty', () => {
    const r = validate({ MRM_SEL_PRIVATE: 'subnet-0b02,subnet-0a02', MRM_SEL_PUBLIC: 'subnet-0b01,subnet-0a01', MRM_SEL_AZS: '' });
    expect(r.status).toBe(0);
    expect(r.selection.availabilityZones).toEqual(['us-east-1b', 'us-east-1a']);
  });

  test.each<[string, Record<string, string>, string]>([
    ['a subnet outside the VPC', { MRM_SEL_PRIVATE: `subnet-0a02,${OTHER_VPC_SUBNET}` }, `${OTHER_VPC_SUBNET} is not in VPC vpc-0abc`],
    ['a value that is not a subnet ID', { MRM_SEL_PRIVATE: "subnet-0a02,subnet-0b02');process.exit(0);('" }, 'is not a subnet ID'],
    ['two private subnets in one AZ', { MRM_SEL_PRIVATE: 'subnet-0a02,subnet-0a01', MRM_SEL_PUBLIC: '' }, 'PrivateSubnetIds has more than one subnet in an AZ'],
    ['one private subnet', { MRM_SEL_PRIVATE: 'subnet-0a02', MRM_SEL_PUBLIC: '', MRM_SEL_AZS: '' }, 'needs one subnet per AZ in at least 2 AZs'],
    ['AvailabilityZones in a different order', { MRM_SEL_AZS: 'us-east-1b,us-east-1a' }, 'PrivateSubnetIds[0] subnet-0a02 is in us-east-1a, expected us-east-1b'],
    ['public subnets in a different AZ order', { MRM_SEL_PUBLIC: 'subnet-0b01,subnet-0a01' }, 'PublicSubnetIds[0] subnet-0b01 is in us-east-1b, expected us-east-1a'],
    ['a subnet listed twice', { MRM_SEL_PUBLIC: 'subnet-0a02,subnet-0b01' }, 'listed more than once: subnet-0a02'],
  ])('stops on %s and writes no selection', (_name, env, message) => {
    const r = validate(env);
    expect(r.status).toBe(1);
    expect(r.output).toContain(message);
    expect(r.selection).toBeUndefined();
  });

  test('accepts subnets that match the deployed ones', () => {
    const r = validate({ MRM_DEPLOYED_PRIVATE: 'subnet-0a02,subnet-0b02', MRM_DEPLOYED_PUBLIC: 'subnet-0a01,subnet-0b01' });
    expect(r.status).toBe(0);
    expect(r.selection.privateSubnetIds).toEqual(['subnet-0a02', 'subnet-0b02']);
  });

  // Changing or reordering the deployed private subnets would replace Managed AD
  test.each<[string, Record<string, string>, string]>([
    ['different private subnets', { MRM_DEPLOYED_PRIVATE: 'subnet-0a03,subnet-0b03' }, 'PrivateSubnetIds'],
    ['the deployed private subnets in another order',
      { MRM_SEL_PRIVATE: 'subnet-0b02,subnet-0a02', MRM_SEL_PUBLIC: 'subnet-0b01,subnet-0a01', MRM_SEL_AZS: '', MRM_DEPLOYED_PRIVATE: 'subnet-0a02,subnet-0b02' },
      'PrivateSubnetIds'],
    ['different public subnets', { MRM_SEL_PUBLIC: '', MRM_DEPLOYED_PRIVATE: 'subnet-0a02,subnet-0b02', MRM_DEPLOYED_PUBLIC: 'subnet-0a01,subnet-0b01' }, 'PublicSubnetIds'],
  ])('stops on %s against the deployed install', (_name, env, key) => {
    const r = validate(env);
    expect(r.status).toBe(1);
    expect(r.output).toContain(`${key} differs from the subnets this install is deployed on`);
    if (key === 'PrivateSubnetIds') expect(r.output).toContain('replaces the Managed AD directory');
    expect(r.selection).toBeUndefined();
  });

  test('the main block validates explicit subnets before it analyzes or prompts', () => {
    const main = PS1.slice(PS1.indexOf('# Main execution'));
    const explicit = main.indexOf('if (Get-Param "PrivateSubnetIds")');
    expect(explicit).toBeGreaterThan(-1);
    expect(explicit).toBeLessThan(main.indexOf('Analyze-Vpc -VpcId'));
    const block = main.slice(explicit, main.indexOf('\n}', explicit));
    expect(block).toContain('if (-not (Test-ExplicitSubnets -VpcId $vpcId)) { exit 1 }');
    expect(block).toContain('Update-Parameters -VpcId $vpcId');
    expect(block).not.toMatch(/Select-Subnets|Save-SimpleSubnets|Analyze-Vpc/);
  });

  /** The JavaScript of the `node -p "..."` call in function <name>. */
  const nodeP = (fn: string) => {
    const body = PS1.slice(PS1.indexOf(`function ${fn} {`));
    const m = body.match(/node -p "([^"]*)"/);
    if (!m) throw new Error(`no node -p in ${fn}`);
    return m[1];
  };

  test('Get-Param and Get-PascalCase read parameters.json and cdk.json as analyze-vpc.sh does', () => {
    fs.writeFileSync(path.join(dir, 'parameters.json'), JSON.stringify([{ ParameterKey: 'PrivateSubnetIds', ParameterValue: ' subnet-0a02, subnet-0b02 ' }]));
    const param = spawnSync('node', ['-p', nodeP('Get-Param')], { cwd: dir, env: { ...process.env, MRM_PARAM_KEY: 'PrivateSubnetIds' }, encoding: 'utf8' });
    expect(param.stdout.trim()).toBe('subnet-0a02,subnet-0b02');

    const pascal = () => spawnSync('node', ['-p', nodeP('Get-PascalCase')], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    expect(pascal()).toBe('MediaResourceManager');
    fs.writeFileSync(path.join(dir, 'cdk.json'), JSON.stringify({ context: { productName: 'Studio Media-Hub 2' } }));
    expect(pascal()).toBe('StudioMediaHub2');
  });
});
