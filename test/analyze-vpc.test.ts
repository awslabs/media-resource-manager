// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Runs scripts/analyze-vpc.sh in bash with a stub `aws` on the PATH and stdin
 * closed (as in CodeBuild). Covers an imported VPC with several private
 * subnets per AZ (#18): explicit PrivateSubnetIds are validated without a
 * prompt, a fresh install without them stops with exit 3 and the candidate
 * subnets, and an existing install keeps its VPC lookup.
 */

const SCRIPT = path.join(__dirname, '..', 'scripts', 'analyze-vpc.sh');
const VPC_ID = 'vpc-0abc1234def567890';

// Two AZs. Per AZ: a public subnet, an "app" subnet with a default route to a
// NAT gateway (1a) or a NAT instance's network interface (1b), and a "mgmt"
// subnet routed to the internet gateway without public IPs. The analyzer
// counts app and mgmt as private, so it needs a selection.
const MULTI_SUBNETS = [
  { SubnetId: 'subnet-0a01', AZ: 'us-east-1a', CidrBlock: '10.0.0.0/24', MapPublicIpOnLaunch: true, Name: 'public-a' },
  { SubnetId: 'subnet-0a02', AZ: 'us-east-1a', CidrBlock: '10.0.1.0/24', MapPublicIpOnLaunch: false, Name: 'app-a' },
  { SubnetId: 'subnet-0a03', AZ: 'us-east-1a', CidrBlock: '10.0.2.0/24', MapPublicIpOnLaunch: false, Name: 'mgmt-a' },
  { SubnetId: 'subnet-0b01', AZ: 'us-east-1b', CidrBlock: '10.0.10.0/24', MapPublicIpOnLaunch: true, Name: 'public-b' },
  { SubnetId: 'subnet-0b02', AZ: 'us-east-1b', CidrBlock: '10.0.11.0/24', MapPublicIpOnLaunch: false, Name: 'app-b' },
  { SubnetId: 'subnet-0b03', AZ: 'us-east-1b', CidrBlock: '10.0.12.0/24', MapPublicIpOnLaunch: false, Name: 'mgmt-b' },
];
const SIMPLE_SUBNETS = MULTI_SUBNETS.filter(s => !s.Name.startsWith('mgmt'));

const ROUTE_TABLES = [
  { RouteTableId: 'rtb-0main', Associations: [{ Main: true }], Routes: [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-0abc' }] },
  { RouteTableId: 'rtb-0a02', Associations: [{ Main: false, SubnetId: 'subnet-0a02' }], Routes: [{ DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-0a' }] },
  { RouteTableId: 'rtb-0b02', Associations: [{ Main: false, SubnetId: 'subnet-0b02' }], Routes: [{ DestinationCidrBlock: '0.0.0.0/0', NetworkInterfaceId: 'eni-abc1b' }] },
  {
    RouteTableId: 'rtb-0mgmt',
    Associations: [{ Main: false, SubnetId: 'subnet-0a03' }, { Main: false, SubnetId: 'subnet-0b03' }],
    Routes: [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-0abc' }],
  },
];

const AWS_STUB = `#!/bin/bash
echo "aws $*" >> "$STUB_DIR/calls.log"
case "$1 $2" in
  "configure get") echo us-east-1 ;;
  "ec2 describe-subnets") cat "$STUB_DIR/subnets.json" ;;
  "ec2 describe-vpcs") echo 10.0.0.0/16 ;;
  "ec2 describe-network-acls") echo '[]' ;;
  "ec2 describe-route-tables")
    sid=$(printf '%s\\n' "$@" | sed -n 's/^Name=association.subnet-id,Values=//p')
    if [ -n "$sid" ]; then
      rt=$(node -e "const t = require(process.env.STUB_DIR + '/route-tables.json').find(t => t.Associations.some(a => a.SubnetId === process.argv[1])); console.log(t ? t.RouteTableId : 'None')" "$sid")
      echo "$rt"
    elif [ -f "$STUB_DIR/route-tables-fail" ]; then
      echo "An error occurred (UnauthorizedOperation) when calling the DescribeRouteTables operation" >&2; exit 254
    else
      cat "$STUB_DIR/route-tables.json"
    fi ;;
  "cloudformation describe-stacks")
    if [ -f "$STUB_DIR/stack-status" ]; then cat "$STUB_DIR/stack-status"
    else echo "An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id $4 does not exist" >&2; exit 254; fi ;;
  "ssm get-parameter")
    f="$STUB_DIR/deployed-$(basename "$4")"
    if [ -f "$f" ]; then cat "$f"
    else echo "An error occurred (ParameterNotFound) when calling the GetParameter operation: " >&2; exit 254; fi ;;
  *) echo "unexpected aws call: $*" >&2; exit 99 ;;
esac
`;

/** ROUTE_TABLES with the routes of one table replaced, or its subnet associations removed. */
function withTable(id: string, change: { Routes?: object[]; unassociate?: boolean }): object[] {
  return ROUTE_TABLES.map(t => {
    if (t.RouteTableId !== id) return t;
    return {
      ...t,
      ...(change.Routes ? { Routes: change.Routes } : {}),
      ...(change.unassociate ? { Associations: [] } : {}),
    };
  });
}

interface RunOptions {
  params: Record<string, string>;
  subnets?: object[];
  routeTables?: object[];
  /** Make describe-route-tables for the whole VPC fail. */
  failRouteTables?: boolean;
  /** Arguments to the script, e.g. --check-egress. */
  args?: string[];
  stackStatus?: string;
  /** Values of /<PascalName>/Network/<key> in SSM, i.e. the subnets the install is deployed on. */
  deployed?: { PrivateSubnetIds?: string; PublicSubnetIds?: string };
  productName?: string;
}

interface RunResult {
  status: number | null;
  output: string;
  params: Record<string, string>;
  calls: string;
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrm-analyze-vpc-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function run(opts: RunOptions): RunResult {
  const stubDir = path.join(root, 'stub');
  const workDir = path.join(root, 'work');
  fs.mkdirSync(stubDir);
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(stubDir, 'aws'), AWS_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(stubDir, 'subnets.json'), JSON.stringify(opts.subnets ?? MULTI_SUBNETS));
  fs.writeFileSync(path.join(stubDir, 'route-tables.json'), JSON.stringify(opts.routeTables ?? ROUTE_TABLES));
  fs.writeFileSync(path.join(stubDir, 'calls.log'), '');
  if (opts.failRouteTables) fs.writeFileSync(path.join(stubDir, 'route-tables-fail'), '');
  if (opts.stackStatus) fs.writeFileSync(path.join(stubDir, 'stack-status'), opts.stackStatus);
  for (const [key, value] of Object.entries(opts.deployed ?? {})) {
    fs.writeFileSync(path.join(stubDir, `deployed-${key}`), value);
  }
  if (opts.productName) {
    fs.writeFileSync(path.join(workDir, 'cdk.json'), JSON.stringify({ context: { productName: opts.productName } }));
  }
  const list = Object.entries(opts.params).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue }));
  fs.writeFileSync(path.join(workDir, 'parameters.json'), JSON.stringify(list, null, 2));

  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, STUB_DIR: stubDir };
  delete env.ACRONYM;
  delete env.PASCAL_CASE;
  const result = spawnSync('bash', [SCRIPT, ...(opts.args ?? [])], { cwd: workDir, env, input: '', encoding: 'utf8', timeout: 60000 });

  const saved = JSON.parse(fs.readFileSync(path.join(workDir, 'parameters.json'), 'utf8')) as { ParameterKey: string; ParameterValue: string }[];
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    params: Object.fromEntries(saved.map(p => [p.ParameterKey, p.ParameterValue])),
    calls: fs.readFileSync(path.join(stubDir, 'calls.log'), 'utf8'),
  };
}

describe('analyze-vpc.sh', () => {
  test('validates explicit subnet IDs without a prompt and writes their route tables', () => {
    const r = run({
      params: { VpcId: VPC_ID, AvailabilityZones: '', PrivateSubnetIds: 'subnet-0a02,subnet-0b02', PublicSubnetIds: 'subnet-0a01,subnet-0b01' },
    });
    expect(r.status).toBe(0);
    expect(r.output).not.toMatch(/Select private subnet/);
    expect(r.params.PrivateSubnetIds).toBe('subnet-0a02,subnet-0b02');
    expect(r.params.PublicSubnetIds).toBe('subnet-0a01,subnet-0b01');
    expect(r.params.AvailabilityZones).toBe('us-east-1a,us-east-1b');
    expect(r.params.PrivateRouteTableIds).toBe('rtb-0a02,rtb-0b02');
    expect(r.params.VpcCidr).toBe('10.0.0.0/16');
  });

  test('accepts explicit subnet IDs that match the deployed ones', () => {
    const r = run({
      params: {
        VpcId: VPC_ID,
        AvailabilityZones: 'us-east-1a,us-east-1b',
        PrivateSubnetIds: 'subnet-0a02, subnet-0b02',
        PublicSubnetIds: 'subnet-0a01,subnet-0b01',
      },
      deployed: { PrivateSubnetIds: 'subnet-0a02,subnet-0b02\n', PublicSubnetIds: 'subnet-0a01,subnet-0b01\n' },
    });
    expect(r.status).toBe(0);
    expect(r.params.PrivateRouteTableIds).toBe('rtb-0a02,rtb-0b02');
    expect(r.calls).toMatch(/ssm get-parameter --name \/MediaResourceManager\/Network\/PrivateSubnetIds/);
    expect(r.calls).toMatch(/ssm get-parameter --name \/MediaResourceManager\/Network\/PublicSubnetIds/);
  });

  test('lists a route table shared by both private subnets once', () => {
    const r = run({
      params: { VpcId: VPC_ID, PrivateSubnetIds: 'subnet-0a03,subnet-0b03' },
      routeTables: withTable('rtb-0mgmt', { Routes: [{ DestinationCidrBlock: '0.0.0.0/0', TransitGatewayId: 'tgw-0abc' }] }),
    });
    expect(r.status).toBe(0);
    expect(r.params.PrivateRouteTableIds).toBe('rtb-0mgmt');
  });

  test('rejects a subnet in the wrong AZ position and leaves parameters.json alone', () => {
    const params = { VpcId: VPC_ID, AvailabilityZones: 'us-east-1b,us-east-1a', PrivateSubnetIds: 'subnet-0a02,subnet-0b02' };
    const r = run({ params });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/PrivateSubnetIds\[0\] subnet-0a02 is in us-east-1a, expected us-east-1b/);
    expect(r.params).toEqual(params);
  });

  test('rejects a subnet that is not in the VPC', () => {
    const r = run({ params: { VpcId: VPC_ID, PrivateSubnetIds: 'subnet-0a02,subnet-0ffff' } });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/subnet-0ffff is not in VPC vpc-0abc1234def567890/);
    expect(r.params.PrivateRouteTableIds).toBeUndefined();
  });

  // Changing or reordering the deployed subnets would replace Managed AD (private)
  // or move the DCV gateway load balancer (public), so each case must stop.
  test.each<{ name: string; params: Record<string, string>; deployed: RunOptions['deployed']; key: string; shown: string }>([
    {
      name: 'different private subnets',
      params: { AvailabilityZones: '', PrivateSubnetIds: 'subnet-0a02,subnet-0b02' },
      deployed: { PrivateSubnetIds: 'subnet-0a03,subnet-0b03' },
      key: 'PrivateSubnetIds',
      shown: 'subnet-0a03,subnet-0b03',
    },
    {
      name: 'reordered private subnets',
      params: { AvailabilityZones: 'us-east-1b,us-east-1a', PrivateSubnetIds: 'subnet-0b02,subnet-0a02' },
      deployed: { PrivateSubnetIds: 'subnet-0a02,subnet-0b02' },
      key: 'PrivateSubnetIds',
      shown: 'subnet-0a02,subnet-0b02',
    },
    {
      name: 'different public subnets',
      params: { AvailabilityZones: '', PrivateSubnetIds: 'subnet-0a02,subnet-0b02', PublicSubnetIds: 'subnet-0a03,subnet-0b03' },
      deployed: { PrivateSubnetIds: 'subnet-0a02,subnet-0b02', PublicSubnetIds: 'subnet-0a01,subnet-0b01' },
      key: 'PublicSubnetIds',
      shown: 'subnet-0a01,subnet-0b01',
    },
    {
      name: 'public subnets left out',
      params: { AvailabilityZones: '', PrivateSubnetIds: 'subnet-0a02,subnet-0b02' },
      deployed: { PrivateSubnetIds: 'subnet-0a02,subnet-0b02', PublicSubnetIds: 'subnet-0a01,subnet-0b01' },
      key: 'PublicSubnetIds',
      shown: 'subnet-0a01,subnet-0b01',
    },
  ])('stops on $name against the deployed install', ({ params: given, deployed, key, shown }) => {
    const params = { VpcId: VPC_ID, ...given };
    const r = run({ params, deployed });
    expect(r.status).toBe(1);
    expect(r.output).toContain(`${key} differs from the subnets this install is deployed on`);
    expect(r.output).toMatch(new RegExp(`Deployed: +${shown}`));
    expect(r.params).toEqual(params);
  });

  test('exits 3 on a fresh install that needs a selection and has no terminal', () => {
    const params = { VpcId: VPC_ID };
    const r = run({ params });
    expect(r.status).toBe(3);
    expect(r.output).toMatch(/PrivateSubnetIds and PublicSubnetIds/);
    expect(r.output).toMatch(/MRM_PARAM_OVERRIDES/);
    expect(r.output).toMatch(/subnet-0a02 .*-> NAT gateway nat-0a/);
    expect(r.output).toMatch(/subnet-0b02 .*-> network interface eni-abc1b/);
    expect(r.output).toMatch(/subnet-0a03 .*-> internet gateway igw-0abc/);
    expect(r.output).toMatch(/subnet-0a01 .*-> internet gateway igw-0abc/);
    expect(r.calls).toMatch(/describe-stacks --stack-name MRM-Infrastructure/);
    expect(r.params).toEqual(params);
  });

  test('treats a rolled-back first deploy as a fresh install', () => {
    const r = run({ params: { VpcId: VPC_ID }, stackStatus: 'ROLLBACK_COMPLETE' });
    expect(r.status).toBe(3);
  });

  test('keeps the VPC lookup of an existing install that has no subnet IDs', () => {
    const params = { VpcId: VPC_ID };
    const r = run({ params, stackStatus: 'UPDATE_COMPLETE', productName: 'Studio  Workstations' });
    expect(r.status).toBe(0);
    expect(r.output).toMatch(/SW-Infrastructure exists \(UPDATE_COMPLETE\): keeping the VPC lookup/);
    expect(r.params).toEqual(params);
  });

  test('saves the subnets of a VPC with one subnet of each type per AZ, as before', () => {
    const r = run({ params: { VpcId: VPC_ID }, subnets: SIMPLE_SUBNETS });
    expect(r.status).toBe(0);
    expect(r.params.PrivateSubnetIds).toBe('subnet-0a02,subnet-0b02');
    expect(r.params.PublicSubnetIds).toBe('subnet-0a01,subnet-0b01');
    expect(r.params.AvailabilityZones).toBe('us-east-1a,us-east-1b');
    expect(r.params.PrivateRouteTableIds).toBe('rtb-0a02,rtb-0b02');
    expect(r.calls).not.toMatch(/describe-stacks/);
  });

  test('does nothing when MRM creates the VPC', () => {
    const r = run({ params: { VpcId: '' } });
    expect(r.status).toBe(0);
    expect(r.calls).toBe('');
  });
});

// A private subnet without outbound internet access breaks the DCV Connection
// Gateway and workstations that launch in it, so the analyzer must stop.
describe('analyze-vpc.sh private subnet egress check', () => {
  const EXPLICIT = { VpcId: VPC_ID, PrivateSubnetIds: 'subnet-0a02,subnet-0b02', PublicSubnetIds: 'subnet-0a01,subnet-0b01' };
  const defaultRoute = (route: object) => [{ DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'local' }, { DestinationCidrBlock: '0.0.0.0/0', ...route }];

  test.each<{ name: string; routes: object[]; shown: RegExp }>([
    { name: 'a NAT gateway', routes: defaultRoute({ NatGatewayId: 'nat-0b', State: 'active' }), shown: /subnet-0b02 \(us-east-1b\): route table rtb-0b02 -> NAT gateway nat-0b/ },
    { name: 'a transit gateway', routes: defaultRoute({ TransitGatewayId: 'tgw-0abc', State: 'active' }), shown: /-> transit gateway tgw-0abc/ },
    { name: 'a NAT instance', routes: defaultRoute({ InstanceId: 'i-abcnat', NetworkInterfaceId: 'eni-abcnat', State: 'active' }), shown: /-> instance i-abcnat/ },
    { name: 'a firewall or Gateway Load Balancer endpoint', routes: defaultRoute({ GatewayId: 'vpce-0abc', State: 'active' }), shown: /-> VPC endpoint vpce-0abc/ },
    {
      name: 'a Cloud WAN core network',
      routes: defaultRoute({ CoreNetworkArn: 'arn:aws:networkmanager::123456789012:core-network/core-network-0abc', State: 'active' }),
      shown: /-> Cloud WAN core network arn:aws:networkmanager::123456789012:core-network\/core-network-0abc/,
    },
  ])('accepts a private subnet whose default route goes to $name', ({ routes, shown }) => {
    const r = run({ params: EXPLICIT, routeTables: withTable('rtb-0b02', { Routes: routes }) });
    expect(r.status).toBe(0);
    expect(r.output).toMatch(shown);
    expect(r.params.PrivateRouteTableIds).toBe('rtb-0a02,rtb-0b02');
  });

  test.each<{ name: string; routes: object[]; shown: string }>([
    { name: 'no default route', routes: [{ DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'local' }], shown: 'no default route' },
    { name: 'a blackholed NAT gateway', routes: defaultRoute({ NatGatewayId: 'nat-0gone', State: 'blackhole' }), shown: 'NAT gateway nat-0gone (blackhole)' },
    { name: 'only an internet gateway', routes: defaultRoute({ GatewayId: 'igw-0abc', State: 'active' }), shown: 'internet gateway igw-0abc' },
    { name: 'VPC peering', routes: defaultRoute({ VpcPeeringConnectionId: 'pcx-0abc', State: 'active' }), shown: 'VPC peering pcx-0abc' },
    { name: 'a blackholed firewall endpoint', routes: defaultRoute({ GatewayId: 'vpce-0abc', State: 'blackhole' }), shown: 'VPC endpoint vpce-0abc (blackhole)' },
  ])('stops on explicit subnets when one has $name and leaves parameters.json alone', ({ routes, shown }) => {
    const r = run({ params: EXPLICIT, routeTables: withTable('rtb-0b02', { Routes: routes }) });
    expect(r.status).toBe(1);
    expect(r.output).toContain(`subnet-0b02 (us-east-1b): route table rtb-0b02 -> ${shown}`);
    expect(r.output).toMatch(/subnet-0a02 \(us-east-1a\): route table rtb-0a02 -> NAT gateway nat-0a/);
    expect(r.output).toMatch(/A private subnet has no outbound internet access/);
    expect(r.output).toMatch(/0\.0\.0\.0\/0 route to a NAT gateway, NAT instance, transit gateway, firewall/);
    expect(r.params).toEqual(EXPLICIT);
  });

  test('checks a subnet without its own route table against the VPC main route table', () => {
    const r = run({ params: EXPLICIT, routeTables: withTable('rtb-0b02', { unassociate: true }) });
    expect(r.status).toBe(1);
    expect(r.output).toContain('subnet-0b02 (us-east-1b): route table rtb-0main (VPC main route table) -> internet gateway igw-0abc');
    expect(r.params).toEqual(EXPLICIT);
  });

  test('stops on the subnets it picks itself in a VPC with one subnet of each type per AZ', () => {
    const params = { VpcId: VPC_ID };
    const r = run({
      params,
      subnets: SIMPLE_SUBNETS,
      routeTables: withTable('rtb-0a02', { Routes: [{ DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'local' }] }),
    });
    expect(r.status).toBe(1);
    expect(r.output).toContain('subnet-0a02 (us-east-1a): route table rtb-0a02 -> no default route');
    expect(r.params).toEqual(params);
  });

  test('warns but continues on a default route it cannot verify', () => {
    const r = run({ params: EXPLICIT, routeTables: withTable('rtb-0b02', { Routes: defaultRoute({ GatewayId: 'vgw-0abc', State: 'active' }) }) });
    expect(r.status).toBe(0);
    expect(r.output).toMatch(/subnet-0b02 \(us-east-1b\): route table rtb-0b02 -> gateway vgw-0abc\. Check that this target/);
    expect(r.params.PrivateSubnetIds).toBe('subnet-0a02,subnet-0b02');
  });

  test('stops when it cannot read the route tables', () => {
    const r = run({ params: EXPLICIT, failRouteTables: true });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/Could not read the route tables of VPC vpc-0abc1234def567890/);
    expect(r.params).toEqual(EXPLICIT);
  });
});

// deploy.sh runs --check-egress when the subnets are already saved: the same
// check on the deployed subnets, as a warning that never stops the build.
describe('analyze-vpc.sh --check-egress', () => {
  const SAVED = { VpcId: VPC_ID, PrivateSubnetIds: 'subnet-0a02,subnet-0b02', PrivateRouteTableIds: 'rtb-0a02,rtb-0b02' };

  test('warns about a saved private subnet without outbound access and exits 0', () => {
    const r = run({
      params: SAVED,
      args: ['--check-egress'],
      routeTables: withTable('rtb-0b02', { Routes: [{ DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'local' }] }),
    });
    expect(r.status).toBe(0);
    expect(r.output).toContain('WARNING: subnet-0b02 (us-east-1b): route table rtb-0b02 -> no default route');
    expect(r.output).toMatch(/a private subnet this install is deployed on has no outbound internet access/);
    expect(r.output).toMatch(/The deployment continues/);
    expect(r.output).not.toMatch(/❌/);
    expect(r.params).toEqual(SAVED);
    expect(r.calls.split('\n').filter(Boolean).every(c => /^aws (ec2 describe-|configure get)/.test(c))).toBe(true);
  });

  test('lists saved private subnets with outbound access', () => {
    const r = run({ params: SAVED, args: ['--check-egress'] });
    expect(r.status).toBe(0);
    expect(r.output).toMatch(/subnet-0a02 \(us-east-1a\): route table rtb-0a02 -> NAT gateway nat-0a/);
    expect(r.output).not.toMatch(/WARNING/);
    expect(r.params).toEqual(SAVED);
  });

  test('warns and exits 0 when it cannot read the route tables', () => {
    const r = run({ params: SAVED, args: ['--check-egress'], failRouteTables: true });
    expect(r.status).toBe(0);
    expect(r.output).toMatch(/Could not read the route tables of VPC vpc-0abc1234def567890 to check the private subnets/);
  });

  test('does nothing without saved private subnets', () => {
    const r = run({ params: { VpcId: VPC_ID }, args: ['--check-egress'] });
    expect(r.status).toBe(0);
    expect(r.calls).toBe('');
  });
});
