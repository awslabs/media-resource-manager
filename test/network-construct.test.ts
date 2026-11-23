// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NetworkConstruct } from '../lib/constructs/network-construct';

/**
 * NetworkConstruct reads parameters.json from the working directory. Managed
 * AD, AD Connector and the resolver endpoint take privateSubnets[0] and [1],
 * so the construct must stop with a clear message when an imported VPC gives
 * fewer than two private subnets in different AZs (#18).
 */

const ENV = { account: '123456789012', region: 'us-east-1' };
const VPC_ID = 'vpc-0abc1234def567890';

let workDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrm-network-'));
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

function writeParams(params: Record<string, string>): void {
  const list = Object.entries(params).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue }));
  fs.writeFileSync(path.join(workDir, 'parameters.json'), JSON.stringify(list));
}

function build(context: Record<string, unknown> = {}): { app: cdk.App; network: NetworkConstruct } {
  const app = new cdk.App({ context });
  const stack = new cdk.Stack(app, 'TestNetwork', { env: ENV });
  const network = new NetworkConstruct(stack, 'Network', { pascalCaseName: 'MediaResourceManager' });
  return { app, network };
}

describe('NetworkConstruct private subnet guard', () => {
  test('accepts one private and one public subnet per AZ in two AZs', () => {
    writeParams({
      VpcId: VPC_ID,
      VpcCidr: '10.0.0.0/16',
      AvailabilityZones: 'us-east-1a,us-east-1b',
      PrivateSubnetIds: 'subnet-0a1,subnet-0b1',
      PublicSubnetIds: 'subnet-0a9,subnet-0b9',
    });
    const { network } = build();
    expect(network.privateSubnets.map(s => s.availabilityZone)).toEqual(['us-east-1a', 'us-east-1b']);
  });

  test('rejects a single private subnet', () => {
    writeParams({
      VpcId: VPC_ID,
      AvailabilityZones: 'us-east-1a',
      PrivateSubnetIds: 'subnet-0a1',
    });
    expect(() => build()).toThrow(/found 1 private subnet\(s\).*PrivateSubnetIds/);
  });

  test('rejects two private subnets in the same AZ', () => {
    writeParams({
      VpcId: VPC_ID,
      AvailabilityZones: 'us-east-1a',
      PrivateSubnetIds: 'subnet-0a1,subnet-0a2',
    });
    expect(() => build()).toThrow(/both in us-east-1a; they must be in different Availability Zones/);
  });

  test('rejects a subnet count that is not a multiple of the AZ count', () => {
    writeParams({
      VpcId: VPC_ID,
      AvailabilityZones: 'us-east-1a,us-east-1b',
      PrivateSubnetIds: 'subnet-0a1,subnet-0b1,subnet-0a2',
    });
    expect(() => build()).toThrow(/PrivateSubnetIds has 3 and PublicSubnetIds has 0 subnet\(s\), but AvailabilityZones lists 2/);
  });

  test('rejects a VPC lookup that finds no private subnets (NAT instance routes count as isolated)', () => {
    writeParams({ VpcId: VPC_ID });
    // First pass: no context, so CDK records the lookup it needs.
    const missing = build().app.synth().manifest.missing ?? [];
    const key = missing.find(m => m.provider === 'vpc-provider')?.key;
    expect(key).toBeDefined();

    const isolatedOnly = {
      vpcId: VPC_ID,
      vpcCidrBlock: '10.0.0.0/16',
      ownerAccountId: ENV.account,
      availabilityZones: [],
      subnetGroups: [
        {
          name: 'Public',
          type: 'Public',
          subnets: [
            { subnetId: 'subnet-0a9', cidr: '10.0.0.0/24', availabilityZone: 'us-east-1a', routeTableId: 'rtb-0a9' },
            { subnetId: 'subnet-0b9', cidr: '10.0.1.0/24', availabilityZone: 'us-east-1b', routeTableId: 'rtb-0b9' },
          ],
        },
        {
          name: 'Isolated',
          type: 'Isolated',
          subnets: [
            { subnetId: 'subnet-0a1', cidr: '10.0.2.0/24', availabilityZone: 'us-east-1a', routeTableId: 'rtb-0a1' },
            { subnetId: 'subnet-0b1', cidr: '10.0.3.0/24', availabilityZone: 'us-east-1b', routeTableId: 'rtb-0b1' },
          ],
        },
      ],
    };
    expect(() => build({ [key!]: isolatedOnly })).toThrow(/found 0 private subnet\(s\).*aws-cdk:subnet-type=Private/);
  });

  test('leaves a VPC that MRM creates alone', () => {
    writeParams({ VpcId: '', VpcCidr: '10.1.0.0/16' });
    const { network } = build();
    expect(network.privateSubnets.length).toBeGreaterThanOrEqual(2);
  });
});
