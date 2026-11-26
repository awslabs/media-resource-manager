// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Primary DCV stack: token-only gateway, gateway rollout, security group
 * scope, the CloudFront browser path and the client allowlist
 * (lib/dcv-infrastructure-stack.ts, lambda/gateway-origin-lookup).
 */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DcvInfrastructureStack, DcvInfrastructureStackProps } from '../lib/dcv-infrastructure-stack';

const command = (name: string) => jest.fn((input: any) => ({ name, input }));
jest.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: jest.fn(),
  DescribeSubnetsCommand: command('DescribeSubnets'),
  DescribeManagedPrefixListsCommand: command('DescribeManagedPrefixLists'),
  DescribeVpcsCommand: command('DescribeVpcs'),
  CreateManagedPrefixListCommand: command('CreateManagedPrefixList'),
  GetManagedPrefixListEntriesCommand: command('GetManagedPrefixListEntries'),
  ModifyManagedPrefixListCommand: command('ModifyManagedPrefixList'),
  DeleteManagedPrefixListCommand: command('DeleteManagedPrefixList'),
}), { virtual: true });
jest.mock('@aws-sdk/client-route-53', () => ({
  Route53Client: jest.fn(),
  GetHostedZoneCommand: jest.fn(input => ({ name: 'GetHostedZone', input })),
}), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const browserPath = require('../lambda/generate-regional-hub-template/gateway-browser-path.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const originLookup = require('../lambda/gateway-origin-lookup/index.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vpcCidrPrefixList = require('../lambda/vpc-cidr-prefix-list/index.js');

function synth(props: Partial<DcvInfrastructureStackProps> = {}): Template {
  const app = new cdk.App();
  const stack = new DcvInfrastructureStack(app, 'Dcv', {
    env: { account: '123456789012', region: 'us-east-1' },
    productName: 'Media Resource Manager',
    pascalCaseName: 'MediaResourceManager',
    acronym: 'MRM',
    ...props,
  });
  return Template.fromStack(stack);
}

function gatewaySgIngress(template: Template): any[] {
  const groups = template.findResources('AWS::EC2::SecurityGroup', {
    Properties: { GroupName: 'MediaResourceManager-DCV-ConnectionGateway-SG' },
  });
  return (Object.values(groups)[0] as any).Properties.SecurityGroupIngress || [];
}

function sessionManagerSgIngress(template: Template): any[] {
  const groups = template.findResources('AWS::EC2::SecurityGroup', {
    Properties: { GroupName: 'MediaResourceManager-DCV-SessionManager-SG' },
  });
  return (Object.values(groups)[0] as any).Properties.SecurityGroupIngress || [];
}

function gatewayUserData(template: Template): string {
  const lts = template.findResources('AWS::EC2::LaunchTemplate');
  const [, lt] = Object.entries(lts).find(([id]) => id.startsWith('ConnectionGatewayLaunchTemplate'))!;
  return JSON.stringify((lt as any).Properties.LaunchTemplateData.UserData);
}

describe('primary gateway (default: CloudFront browser path)', () => {
  const template = synth();

  it('installs a token-only gateway', () => {
    const userData = gatewayUserData(template);
    expect(userData).not.toContain('nice-dcv-web-viewer');
    expect(userData).not.toContain('local-resources-path = \\"/usr/share/dcv/www\\"');
    expect(userData).toContain('(local-resources-path|url)');
  });

  it('replaces gateways one at a time when the launch template changes', () => {
    const asgs = template.findResources('AWS::AutoScaling::AutoScalingGroup');
    const [, asg] = Object.entries(asgs).find(([id]) => id.startsWith('ConnectionGatewayAsg'))!;
    expect((asg as any).UpdatePolicy.AutoScalingRollingUpdate).toEqual(expect.objectContaining({
      MaxBatchSize: 1, MinInstancesInService: 1, PauseTime: 'PT5M',
    }));
  });

  it('replaces a gateway that fails its target group health checks, after a 900 s grace period', () => {
    const asgs = template.findResources('AWS::AutoScaling::AutoScalingGroup');
    const [, asg] = Object.entries(asgs).find(([id]) => id.startsWith('ConnectionGatewayAsg'))!;
    const props = (asg as any).Properties;
    expect(props.HealthCheckType).toBe('ELB');
    expect(props.HealthCheckGracePeriod).toBe(900);
    // NLB TCP 8443, NLB UDP 8444 and the browser ALB HTTPS 8443 target groups.
    const tgIds = props.TargetGroupARNs.map((ref: any) => ref.Ref).sort();
    expect(tgIds).toHaveLength(3);
    expect(tgIds[0]).toMatch(/^ConnectionGatewayTargetGroup/);
    expect(tgIds[1]).toMatch(/^ConnectionGatewayUdpTargetGroup/);
    expect(tgIds[2]).toMatch(/^GatewayBrowserTargetGroup/);
  });

  it('replaces a Session Manager that fails its target group health checks, after a 1800 s grace period', () => {
    const asgs = template.findResources('AWS::AutoScaling::AutoScalingGroup');
    const [, asg] = Object.entries(asgs).find(([id]) => id.startsWith('SessionManagerAsg'))!;
    const props = (asg as any).Properties;
    expect(props.HealthCheckType).toBe('ELB');
    expect(props.HealthCheckGracePeriod).toBe(1800);
    // Agent 8445, API 8443 and resolver 8447 target groups.
    expect(props.TargetGroupARNs).toHaveLength(3);
    // No forced replacement of the running Session Manager on upgrade.
    expect((asg as any).UpdatePolicy?.AutoScalingRollingUpdate).toBeUndefined();
    expect((asg as any).UpdatePolicy?.AutoScalingReplacingUpdate).toBeUndefined();
  });

  it('gives the Session Manager user data that resumes after a restart, under the 16 KB limit', () => {
    const lts = template.findResources('AWS::EC2::LaunchTemplate');
    const [, lt] = Object.entries(lts).find(([id]) => id.startsWith('SessionManagerLaunchTemplate'))!;
    const userData = (lt as any).Properties.LaunchTemplateData.UserData['Fn::Base64'];
    expect(typeof userData).toBe('string');
    expect(Buffer.byteLength(userData, 'utf8')).toBeLessThan(16384);
    expect(userData).toContain('export PRODUCT_NAME="MediaResourceManager"');
    expect(userData).toContain('PER_BOOT_COPY="$PER_BOOT_DIR/mrm-session-manager-setup.sh"');
  });

  const vpcCidrsPrefixList = { 'Fn::GetAtt': ['VpcCidrPrefixList', 'PrefixListId'] };
  const ruleFromVpcCidrs = (groupIdPrefix: string, port: number) => {
    const rules = template.findResources('AWS::EC2::SecurityGroupIngress', {
      Properties: { FromPort: port, SourcePrefixListId: vpcCidrsPrefixList },
    });
    return Object.values(rules).map((r: any) => r.Properties)
      .filter(r => r.GroupId['Fn::GetAtt'][0].startsWith(groupIdPrefix));
  };

  it('drops UDP 8443, keeps public TCP 8443 and UDP 8444, and scopes 8989 to every VPC CIDR block', () => {
    const rules = gatewaySgIngress(template);
    expect(rules.find(r => r.IpProtocol === 'udp' && r.FromPort === 8443)).toBeUndefined();
    expect(rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ IpProtocol: 'tcp', FromPort: 8443, CidrIp: '0.0.0.0/0' }),
      expect.objectContaining({ IpProtocol: 'udp', FromPort: 8444, CidrIp: '0.0.0.0/0' }),
    ]));
    expect(rules.find(r => r.FromPort === 8989)).toBeUndefined();
    expect(ruleFromVpcCidrs('ConnectionGatewaySG', 8989)).toHaveLength(1);
  });

  it('scopes the Session Manager 8443 and 8445 rules to every VPC CIDR block', () => {
    const rules = sessionManagerSgIngress(template);
    expect(rules.filter(r => r.CidrIp === '0.0.0.0/0')).toEqual([]);
    for (const port of [8443, 8445]) {
      expect(rules.find(r => r.FromPort === port && r.CidrIp)).toBeUndefined();
      expect(ruleFromVpcCidrs('SessionManagerSG', port)).toHaveLength(1);
    }
  });

  it('keeps a prefix list of the VPC CIDR blocks, refreshed on every deploy', () => {
    template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
      VpcId: { Ref: Match.stringLikeRegexp('NetworkVpcId') },
      PrefixListName: 'MediaResourceManager-VpcCidrs',
      Refresh: Match.anyValue(),
    });
  });

  it('gives the browser ALB only the gateway web port (no health-port rule)', () => {
    const fromAlb = template.findResources('AWS::EC2::SecurityGroupIngress', {
      Properties: { SourceSecurityGroupId: { 'Fn::GetAtt': [Match.stringLikeRegexp('^GatewayBrowserAlbSG'), 'GroupId'] } },
    });
    expect(Object.values(fromAlb).map((r: any) => r.Properties.FromPort)).toEqual([8443]);
  });

  it('allows TCP 8443 on the gateway from the browser ALB security group', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp', FromPort: 8443, ToPort: 8443,
      GroupId: { 'Fn::GetAtt': [Match.stringLikeRegexp('^ConnectionGatewaySG'), 'GroupId'] },
      SourceSecurityGroupId: { 'Fn::GetAtt': [Match.stringLikeRegexp('^GatewayBrowserAlbSG'), 'GroupId'] },
    });
  });

  it('opens the ALB only to the CloudFront origin-facing prefix list on HTTP 80', () => {
    const albSgRef = { 'Fn::GetAtt': [Match.stringLikeRegexp('^GatewayBrowserAlbSG'), 'GroupId'] };
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupName: 'MediaResourceManager-DCV-Gateway-Browser-ALB-SG',
      SecurityGroupIngress: Match.absent(),
    });
    const ingress = template.findResources('AWS::EC2::SecurityGroupIngress', { Properties: { GroupId: albSgRef } });
    expect(Object.values(ingress).map((r: any) => r.Properties)).toEqual([expect.objectContaining({
      IpProtocol: 'tcp', FromPort: 80, ToPort: 80,
      SourcePrefixListId: { 'Fn::GetAtt': ['GatewayOriginLookup', 'PrefixListId'] },
    })]);
    const egress = template.findResources('AWS::EC2::SecurityGroupEgress', { Properties: { GroupId: albSgRef } });
    expect(Object.values(egress).map((r: any) => r.Properties)).toEqual([expect.objectContaining({
      IpProtocol: 'tcp', FromPort: 8443, ToPort: 8443,
      DestinationSecurityGroupId: { 'Fn::GetAtt': [expect.stringMatching(/^ConnectionGatewaySG/), 'GroupId'] },
    })]);
  });

  it('builds an internal ALB in the looked-up subnets, with HTTP 80 and no access logs', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Type: 'application',
      Scheme: 'internal',
      Subnets: { 'Fn::Split': [',', { 'Fn::GetAtt': ['GatewayOriginLookup', 'SubnetIds'] }] },
      LoadBalancerAttributes: Match.not(Match.arrayWith([Match.objectLike({ Key: 'access_logs.s3.enabled' })])),
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', { Port: 80, Protocol: 'HTTP' });
    template.hasResource('AWS::CloudFormation::CustomResource', {
      Properties: Match.objectLike({ ExcludedAzIds: browserPath.VPC_ORIGIN_EXCLUDED_AZ_IDS }),
    });
  });

  it('targets the gateway on HTTPS 8443 with an HTTPS / health check accepting 200-499', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Protocol: 'HTTPS', Port: 8443,
      HealthCheckProtocol: 'HTTPS', HealthCheckPath: '/', HealthCheckPort: 'traffic-port',
      Matcher: { HttpCode: '200-499' },
    });
    const asgs = template.findResources('AWS::AutoScaling::AutoScalingGroup');
    const [, asg] = Object.entries(asgs).find(([id]) => id.startsWith('ConnectionGatewayAsg'))!;
    expect(JSON.stringify((asg as any).Properties.TargetGroupARNs)).toContain('GatewayBrowserTargetGroup');
  });

  it('uses a VPC origin with TLSv1.2 and a distribution with the default certificate and no caching or logging', () => {
    template.hasResourceProperties('AWS::CloudFront::VpcOrigin', {
      VpcOriginEndpointConfig: Match.objectLike({ OriginProtocolPolicy: 'http-only', OriginSSLProtocols: ['TLSv1.2'] }),
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        ViewerCertificate: { CloudFrontDefaultCertificate: true },
        Logging: Match.absent(),
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'https-only',
          CachePolicyId: browserPath.MANAGED_CACHE_POLICY_CACHING_DISABLED,
          OriginRequestPolicyId: browserPath.MANAGED_ORIGIN_REQUEST_POLICY_ALL_VIEWER,
          FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })],
        }),
      }),
    });
    template.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionConfig: Match.objectLike({ Runtime: 'cloudfront-js-2.0' }),
    });
  });

  it('stores the browser gateway URL in SSM', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/MediaResourceManager/DCV/BrowserGatewayUrl',
      Value: { 'Fn::Join': ['', ['https://', { 'Fn::GetAtt': ['GatewayBrowserDistribution', 'DomainName'] }]] },
    });
  });
});

describe('primary gateway in direct mode', () => {
  const template = synth({ dcvBrowserPath: 'direct' });

  it('creates no CloudFront distribution, VPC origin or ALB', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 0);
    template.resourceCountIs('AWS::CloudFront::VpcOrigin', 0);
    template.resourcePropertiesCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', { Type: 'application' }, 0);
  });

  it('stores the gateway itself as the browser gateway URL', () => {
    const params = template.findResources('AWS::SSM::Parameter', {
      Properties: { Name: '/MediaResourceManager/DCV/BrowserGatewayUrl' },
    });
    const value = JSON.stringify((Object.values(params)[0] as any).Properties.Value);
    expect(value).toContain('DcvNetworkLoadBalancer');
    expect(value).toContain(':8443');
  });
});

describe('primary gateway with a hosted zone', () => {
  const template = synth({ dcvHostedZoneId: 'Z0123456789ABCDEFGHIJ' });

  it('adds a DNS-validated certificate and an HTTPS 443 listener, and CloudFront uses HTTPS', () => {
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      ValidationMethod: 'DNS',
      DomainValidationOptions: [Match.objectLike({ HostedZoneId: 'Z0123456789ABCDEFGHIJ' })],
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443, Protocol: 'HTTPS', SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
    });
    template.hasResourceProperties('AWS::CloudFront::VpcOrigin', {
      VpcOriginEndpointConfig: Match.objectLike({ OriginProtocolPolicy: 'https-only' }),
    });
    template.hasResourceProperties('AWS::Route53::RecordSet', { HostedZoneId: 'Z0123456789ABCDEFGHIJ', Type: 'A' });
  });
});

describe('primary gateway client allowlist', () => {
  it('limits TCP 8443 and UDP 8444 to the allowed CIDRs', () => {
    const rules = gatewaySgIngress(synth({ dcvAllowedClientCidrs: ['192.0.2.0/24'] }));
    expect(rules.filter(r => r.CidrIp === '0.0.0.0/0')).toEqual([]);
    expect(rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ IpProtocol: 'tcp', FromPort: 8443, CidrIp: '192.0.2.0/24' }),
      expect.objectContaining({ IpProtocol: 'udp', FromPort: 8444, CidrIp: '192.0.2.0/24' }),
    ]));
  });

  it('adds one security group per prefix list and protocol to the gateway launch template', () => {
    const template = synth({ dcvAllowedPrefixListIds: ['pl-11111111'] });
    const rules = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress', {
      Properties: { SourcePrefixListId: 'pl-11111111' },
    })).map((r: any) => r.Properties);
    expect(rules.map(r => `${r.IpProtocol}/${r.FromPort}`).sort()).toEqual(['tcp/8443', 'udp/8444']);
    // Each rule is in a security group of its own.
    expect(new Set(rules.map(r => JSON.stringify(r.GroupId))).size).toBe(2);
    const lts = template.findResources('AWS::EC2::LaunchTemplate');
    const [, lt] = Object.entries(lts).find(([id]) => id.startsWith('ConnectionGatewayLaunchTemplate'))!;
    expect((lt as any).Properties.LaunchTemplateData.SecurityGroupIds).toHaveLength(3);
    expect(gatewaySgIngress(template).filter(r => r.CidrIp === '0.0.0.0/0')).toEqual([]);
  });

  it('rejects invalid settings', () => {
    expect(() => synth({ dcvBrowserPath: 'public' })).toThrow(/DcvBrowserPath/);
    expect(() => synth({ dcvAllowedClientCidrs: ['10.0.0.0'] })).toThrow(/CIDR/);
  });
});

describe('gateway-origin-lookup', () => {
  const subnets = [
    { SubnetId: 'subnet-a', AvailabilityZoneId: 'use1-az1' },
    { SubnetId: 'subnet-b', AvailabilityZoneId: 'use1-az3' },
    { SubnetId: 'subnet-c', AvailabilityZoneId: 'use1-az4' },
    { SubnetId: 'subnet-d', AvailabilityZoneId: 'use1-az4' },
  ];
  const excluded = browserPath.VPC_ORIGIN_EXCLUDED_AZ_IDS;

  it('keeps one subnet per supported zone, in the given order', () => {
    const order = ['subnet-a', 'subnet-b', 'subnet-c', 'subnet-d'];
    expect(originLookup.selectSubnets(subnets, excluded, order).map((s: any) => s.SubnetId)).toEqual(['subnet-a', 'subnet-c']);
  });

  it('fails when fewer than two supported zones remain', () => {
    // use1-az3 is excluded, and two subnets in one zone count once.
    expect(() => originLookup.selectSubnets([subnets[1], subnets[2]], excluded, [])).toThrow(/at least two Availability Zones/);
    expect(() => originLookup.selectSubnets([subnets[2], subnets[3]], excluded, [])).toThrow(/at least two/);
  });

  it('returns the subnets, the prefix list and the hosted zone name', async () => {
    const ec2 = {
      send: jest.fn(async (cmd: any) => (cmd.name === 'DescribeSubnets'
        ? { Subnets: subnets }
        : { PrefixLists: [{ PrefixListId: 'pl-0123abcd' }] })),
    };
    const route53 = { send: jest.fn(async () => ({ HostedZone: { Name: 'example.com.' } })) };
    const data = await originLookup.lookup({
      SubnetIds: ['subnet-a', 'subnet-b', 'subnet-c', 'subnet-d'],
      ExcludedAzIds: excluded,
      PrefixListName: browserPath.CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST,
      HostedZoneId: 'Z0123',
    }, { ec2, route53 });
    expect(data).toEqual({ SubnetIds: 'subnet-a,subnet-c', PrefixListId: 'pl-0123abcd', HostedZoneName: 'example.com' });
  });
});

describe('vpc-cidr-prefix-list', () => {
  const vpc = {
    CidrBlock: '10.1.0.0/16',
    CidrBlockAssociationSet: [
      { CidrBlock: '10.1.0.0/16', CidrBlockState: { State: 'associated' } },
      { CidrBlock: '100.64.0.0/16', CidrBlockState: { State: 'associated' } },
      { CidrBlock: '100.65.0.0/16', CidrBlockState: { State: 'disassociating' } },
    ],
  };
  const props = { VpcId: 'vpc-1', PrefixListName: 'MediaResourceManager-VpcCidrs', TagKey: 'k', TagValue: 'true' };

  function fakeEc2(entries: string[] = [], maxEntries = 5) {
    const calls: any[] = [];
    const ec2 = {
      calls,
      send: jest.fn(async (cmd: any) => {
        calls.push(cmd);
        switch (cmd.name) {
          case 'DescribeVpcs': return { Vpcs: [vpc] };
          case 'CreateManagedPrefixList': return { PrefixList: { PrefixListId: 'pl-0abc' } };
          case 'DescribeManagedPrefixLists':
            return { PrefixLists: [{ PrefixListId: 'pl-0abc', State: 'modify-complete', Version: 3, MaxEntries: maxEntries }] };
          case 'GetManagedPrefixListEntries': return { Entries: entries.map(Cidr => ({ Cidr })) };
          default: return {};
        }
      }),
    };
    return ec2;
  }
  const noSleep = async () => undefined;

  it('lists every associated IPv4 CIDR block, primary first', async () => {
    expect(await vpcCidrPrefixList.vpcCidrs(fakeEc2(), 'vpc-1')).toEqual(['10.1.0.0/16', '100.64.0.0/16']);
  });

  it('creates the prefix list with those blocks and returns its ID', async () => {
    const ec2 = fakeEc2();
    const result = await vpcCidrPrefixList.handle({ RequestType: 'Create', ResourceProperties: props }, ec2, noSleep);
    expect(result).toEqual({ PhysicalResourceId: 'pl-0abc', Data: { PrefixListId: 'pl-0abc' } });
    const create = ec2.calls.find(c => c.name === 'CreateManagedPrefixList').input;
    expect(create.Entries.map((e: any) => e.Cidr)).toEqual(['10.1.0.0/16', '100.64.0.0/16']);
    expect(create.MaxEntries).toBe(5);
  });

  it('adds a block associated after the last deploy, and removes one that is gone', async () => {
    const ec2 = fakeEc2(['10.1.0.0/16', '172.16.0.0/16']);
    await vpcCidrPrefixList.handle({
      RequestType: 'Update', PhysicalResourceId: 'pl-0abc', ResourceProperties: props, OldResourceProperties: props,
    }, ec2, noSleep);
    const modify = ec2.calls.find(c => c.name === 'ModifyManagedPrefixList').input;
    expect(modify).toEqual(expect.objectContaining({
      PrefixListId: 'pl-0abc', CurrentVersion: 3,
      AddEntries: [expect.objectContaining({ Cidr: '100.64.0.0/16' })],
      RemoveEntries: [{ Cidr: '172.16.0.0/16' }],
    }));
  });

  it('changes nothing when the blocks match', async () => {
    const ec2 = fakeEc2(['10.1.0.0/16', '100.64.0.0/16']);
    await vpcCidrPrefixList.handle({
      RequestType: 'Update', PhysicalResourceId: 'pl-0abc', ResourceProperties: props, OldResourceProperties: props,
    }, ec2, noSleep);
    expect(ec2.calls.find(c => c.name === 'ModifyManagedPrefixList')).toBeUndefined();
  });

  it('raises MaxEntries before adding more blocks than it allows', async () => {
    const ec2 = fakeEc2(['10.1.0.0/16'], 1);
    await vpcCidrPrefixList.handle({
      RequestType: 'Update', PhysicalResourceId: 'pl-0abc', ResourceProperties: props, OldResourceProperties: props,
    }, ec2, noSleep);
    const modifies = ec2.calls.filter(c => c.name === 'ModifyManagedPrefixList').map(c => c.input);
    expect(modifies[0]).toEqual({ PrefixListId: 'pl-0abc', MaxEntries: 2 });
    expect(modifies[1].AddEntries).toHaveLength(1);
  });

  it('deletes the list, and ignores a failed create that left none', async () => {
    const ec2 = fakeEc2();
    await vpcCidrPrefixList.handle({ RequestType: 'Delete', PhysicalResourceId: 'pl-0abc', ResourceProperties: props }, ec2, noSleep);
    expect(ec2.calls.map(c => c.name)).toEqual(['DeleteManagedPrefixList']);
    const none = fakeEc2();
    await vpcCidrPrefixList.handle({ RequestType: 'Delete', PhysicalResourceId: 'abc-request', ResourceProperties: props }, none, noSleep);
    expect(none.calls).toEqual([]);
  });
});

describe('workstation instance role and SMB mount secrets', () => {
  const smbMountResource = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:/MediaResourceManager/Workstation/*/SmbMount-*';
  let statements: any[];
  beforeAll(() => {
    const template = synth();
    const roles = template.findResources('AWS::IAM::Role');
    const [roleId] = Object.entries(roles).find(([id]) => id.startsWith('WorkstationInstanceRole'))!;
    const policies = template.findResources('AWS::IAM::Policy');
    statements = Object.values(policies)
      .filter((p: any) => JSON.stringify(p.Properties.Roles).includes(`"${roleId}"`))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
  }, 120000);

  test('can read only the per-workstation SMB mount secrets path, with GetSecretValue only', () => {
    const smb = statements.filter(s => JSON.stringify(s.Resource).includes('SmbMount'));
    expect(smb).toEqual([{ Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: smbMountResource }]);
  });

  test('has no read on the AD service-account or storage secrets', () => {
    const text = JSON.stringify(statements);
    expect(text).not.toContain('/Identity/');
    expect(text).not.toContain('/Storage/');
  });
});
