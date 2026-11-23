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

jest.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: jest.fn(),
  DescribeSubnetsCommand: jest.fn(input => ({ name: 'DescribeSubnets', input })),
  DescribeManagedPrefixListsCommand: jest.fn(input => ({ name: 'DescribeManagedPrefixLists', input })),
}), { virtual: true });
jest.mock('@aws-sdk/client-route-53', () => ({
  Route53Client: jest.fn(),
  GetHostedZoneCommand: jest.fn(input => ({ name: 'GetHostedZone', input })),
}), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const browserPath = require('../lambda/generate-regional-hub-template/gateway-browser-path.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const originLookup = require('../lambda/gateway-origin-lookup/index.js');

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
  return (Object.values(groups)[0] as any).Properties.SecurityGroupIngress;
}

function sessionManagerSgIngress(template: Template): any[] {
  const groups = template.findResources('AWS::EC2::SecurityGroup', {
    Properties: { GroupName: 'MediaResourceManager-DCV-SessionManager-SG' },
  });
  return (Object.values(groups)[0] as any).Properties.SecurityGroupIngress;
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
      MaxBatchSize: 1, MinInstancesInService: 1,
    }));
  });

  it('drops UDP 8443, keeps public TCP 8443 and UDP 8444, and scopes 8989 to the VPC', () => {
    const rules = gatewaySgIngress(template);
    expect(rules.find(r => r.IpProtocol === 'udp' && r.FromPort === 8443)).toBeUndefined();
    expect(rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ IpProtocol: 'tcp', FromPort: 8443, CidrIp: '0.0.0.0/0' }),
      expect.objectContaining({ IpProtocol: 'udp', FromPort: 8444, CidrIp: '0.0.0.0/0' }),
    ]));
    const health = rules.find(r => r.FromPort === 8989);
    expect(health.CidrIp).not.toBe('0.0.0.0/0');
    expect(JSON.stringify(health.CidrIp)).toContain('NetworkVpcCidr');
  });

  it('scopes the Session Manager 8443 and 8445 rules to the VPC', () => {
    const rules = sessionManagerSgIngress(template);
    for (const port of [8443, 8445]) {
      const rule = rules.find(r => r.FromPort === port && r.CidrIp);
      expect(rule.CidrIp).not.toBe('0.0.0.0/0');
      expect(JSON.stringify(rule.CidrIp)).toContain('NetworkVpcCidr');
    }
    expect(rules.filter(r => r.CidrIp === '0.0.0.0/0')).toEqual([]);
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
