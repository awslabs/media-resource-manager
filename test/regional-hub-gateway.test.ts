// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Regional hub template: token-only gateway, gateway rollout, security group
 * scope, the CloudFront browser path and the client allowlist
 * (lambda/generate-regional-hub-template).
 */
// The Lambda runtime provides this client. The repo doesn't install it.
jest.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: jest.fn(),
  GetTemplateCommand: jest.fn(),
}), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateCloudFormationTemplate } = require('../lambda/generate-regional-hub-template/index.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const browserPath = require('../lambda/generate-regional-hub-template/gateway-browser-path.js');

// A module, so its helpers don't clash with other test files' globals.
export {};

const PREFIX_LIST = 'pl-0123456789abcdef0';

function generate(overrides: Record<string, unknown> = {}) {
  return generateCloudFormationTemplate({
    productName: 'MediaResourceManager',
    acronym: 'MRM',
    region: 'us-east-1',
    displayName: 'US East (N. Virginia)',
    vpcCidr: '10.2.0.0/16',
    availabilityZones: ['use1-az1', 'use1-az3', 'use1-az4'],
    primaryRegion: 'us-east-2',
    enableWindows: true,
    enableLinux: true,
    enableMacOS: false,
    lambdaAssets: {},
    originFacingPrefixListId: PREFIX_LIST,
    ...overrides,
  });
}

function userData(template: any): string {
  return template.Resources.ConnectionGatewayLaunchTemplate.Properties.LaunchTemplateData.UserData['Fn::Base64'];
}

function ingressOf(template: any, logicalId: string): any[] {
  return template.Resources[logicalId].Properties.SecurityGroupIngress;
}

function resourcesOfType(template: any, type: string): [string, any][] {
  return Object.entries(template.Resources).filter(([, r]: [string, any]) => r.Type === type);
}

describe('hub gateway install script', () => {
  const script = userData(generate());

  it('installs only the connection gateway, not the web viewer', () => {
    expect(script).not.toContain('nice-dcv-web-viewer');
    expect(script).toContain('for package_pattern in "nice-dcv-connection-gateway.$package_extension"; do');
  });

  it('serves no web resources: no local-resources-path, and deletes url in [web-resources]', () => {
    expect(script).not.toContain('local-resources-path = "/usr/share/dcv/www"');
    expect(script).toContain(
      "sed -i -E '/^\\[web-resources\\]/,/^\\[/{/^[[:space:]]*(local-resources-path|url)[[:space:]]*=/d}' \"$CONFIG_FILE\"");
  });
});

describe('hub gateway ASG', () => {
  it('replaces gateways one at a time when the launch template changes', () => {
    const asg = generate().Resources.ConnectionGatewayASG;
    expect(asg.UpdatePolicy.AutoScalingRollingUpdate).toEqual(expect.objectContaining({
      MaxBatchSize: 1,
      MinInstancesInService: 1,
    }));
  });
});

describe('hub security groups', () => {
  it('drops the UDP 8443 gateway rule and scopes the health check to the VPC', () => {
    const rules = ingressOf(generate(), 'ConnectionGatewaySecurityGroup');
    expect(rules.find(r => r.IpProtocol === 'udp' && r.FromPort === 8443)).toBeUndefined();
    expect(rules.find(r => r.FromPort === 8989)).toEqual(expect.objectContaining({ CidrIp: { Ref: 'VpcCidr' } }));
  });

  it('keeps public TCP 8443 and UDP 8444 on the gateway when no allowlist is set', () => {
    const rules = ingressOf(generate(), 'ConnectionGatewaySecurityGroup');
    expect(rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ IpProtocol: 'tcp', FromPort: 8443, CidrIp: '0.0.0.0/0' }),
      expect.objectContaining({ IpProtocol: 'udp', FromPort: 8444, CidrIp: '0.0.0.0/0' }),
    ]));
  });

  it('scopes the Session Manager 8443 and 8445 rules to the VPC', () => {
    const rules = ingressOf(generate(), 'SessionManagerSecurityGroup');
    for (const port of [8443, 8445]) {
      expect(rules.find(r => r.FromPort === port)).toEqual(expect.objectContaining({ CidrIp: { Ref: 'VpcCidr' } }));
    }
    expect(rules.filter(r => r.CidrIp === '0.0.0.0/0')).toEqual([]);
  });

  it('allows the gateway web port from the browser ALB security group', () => {
    const rule = generate().Resources.ConnectionGatewaySGFromBrowserAlb.Properties;
    expect(rule).toEqual(expect.objectContaining({
      GroupId: { Ref: 'ConnectionGatewaySecurityGroup' },
      IpProtocol: 'tcp', FromPort: 8443, ToPort: 8443,
      SourceSecurityGroupId: { Ref: 'GatewayBrowserAlbSecurityGroup' },
    }));
  });
});

describe('hub VPC CIDR blocks', () => {
  it('creates the VPC with one CIDR block, so VpcCidr covers it', () => {
    expect(resourcesOfType(generate(), 'AWS::EC2::VPCCidrBlock')).toEqual([]);
  });

  it('adds the narrowed rules for each additional CIDR block of an existing hub VPC', () => {
    const template = generate({ additionalVpcCidrs: ['100.64.0.0/16'] });
    const sm = ingressOf(template, 'SessionManagerSecurityGroup');
    for (const port of [8443, 8445]) {
      expect(sm).toContainEqual(expect.objectContaining({ FromPort: port, CidrIp: '100.64.0.0/16' }));
      expect(sm).toContainEqual(expect.objectContaining({ FromPort: port, CidrIp: { Ref: 'VpcCidr' } }));
    }
    expect(ingressOf(template, 'ConnectionGatewaySecurityGroup'))
      .toContainEqual(expect.objectContaining({ FromPort: 8989, CidrIp: '100.64.0.0/16' }));
  });

  it('reads the additional blocks from DescribeVpcs, skipping the primary and disassociated ones', () => {
    const vpc = {
      CidrBlock: '10.2.0.0/16',
      CidrBlockAssociationSet: [
        { CidrBlock: '10.2.0.0/16', CidrBlockState: { State: 'associated' } },
        { CidrBlock: '100.64.0.0/16', CidrBlockState: { State: 'associated' } },
        { CidrBlock: '100.65.0.0/16', CidrBlockState: { State: 'disassociated' } },
      ],
    };
    expect(browserPath.additionalVpcCidrs(vpc, '10.2.0.0/16')).toEqual(['100.64.0.0/16']);
    expect(browserPath.additionalVpcCidrs(undefined, '10.2.0.0/16')).toEqual([]);
  });
});

describe('hub CloudFront browser path', () => {
  const template = generate();
  const r = template.Resources;

  it('puts an internal ALB with HTTP 80 in subnets outside the excluded AZ IDs', () => {
    expect(r.GatewayBrowserAlb.Properties).toEqual(expect.objectContaining({
      Type: 'application',
      Scheme: 'internal',
      // use1-az3 (PrivateSubnet2) is excluded.
      Subnets: [{ Ref: 'PrivateSubnet1' }, { Ref: 'PrivateSubnet3' }],
    }));
    expect(r.GatewayBrowserListener.Properties).toEqual(expect.objectContaining({ Port: 80, Protocol: 'HTTP' }));
    expect(r.GatewayBrowserAlb.Properties.Name.length).toBeLessThanOrEqual(32);
  });

  it('opens the ALB only to the CloudFront origin-facing prefix list and only toward the gateway', () => {
    const sg = r.GatewayBrowserAlbSecurityGroup.Properties;
    expect(sg.SecurityGroupIngress).toEqual([
      expect.objectContaining({ IpProtocol: 'tcp', FromPort: 80, ToPort: 80, SourcePrefixListId: PREFIX_LIST }),
    ]);
    expect(r.GatewayBrowserAlbEgressToGateway.Properties).toEqual(expect.objectContaining({
      FromPort: 8443, DestinationSecurityGroupId: { Ref: 'ConnectionGatewaySecurityGroup' },
    }));
  });

  it('forwards to the gateway on HTTPS 8443 with an HTTPS / health check that accepts 200-499', () => {
    expect(r.GatewayBrowserTargetGroup.Properties).toEqual(expect.objectContaining({
      Protocol: 'HTTPS', Port: 8443, HealthCheckProtocol: 'HTTPS', HealthCheckPath: '/',
      Matcher: { HttpCode: '200-499' },
    }));
    expect(r.ConnectionGatewayASG.Properties.TargetGroupARNs).toContainEqual({ Ref: 'GatewayBrowserTargetGroup' });
  });

  it('uses a VPC origin with TLSv1.2 only', () => {
    expect(r.GatewayBrowserVpcOrigin.Properties.VpcOriginEndpointConfig).toEqual(expect.objectContaining({
      Arn: { Ref: 'GatewayBrowserAlb' },
      OriginProtocolPolicy: 'http-only',
      OriginSSLProtocols: ['TLSv1.2'],
    }));
  });

  it('builds the distribution with the default certificate, no caching, AllViewer and no logging', () => {
    const config = r.GatewayBrowserDistribution.Properties.DistributionConfig;
    expect(config.ViewerCertificate).toEqual({ CloudFrontDefaultCertificate: true });
    expect(config.Logging).toBeUndefined();
    expect(config.Origins[0].VpcOriginConfig.VpcOriginId).toEqual({ Ref: 'GatewayBrowserVpcOrigin' });
    expect(config.DefaultCacheBehavior).toEqual(expect.objectContaining({
      ViewerProtocolPolicy: 'https-only',
      CachePolicyId: browserPath.MANAGED_CACHE_POLICY_CACHING_DISABLED,
      OriginRequestPolicyId: browserPath.MANAGED_ORIGIN_REQUEST_POLICY_ALL_VIEWER,
      FunctionAssociations: [expect.objectContaining({ EventType: 'viewer-request' })],
    }));
  });

  it('adds no access logs to the ALB', () => {
    const keys = r.GatewayBrowserAlb.Properties.LoadBalancerAttributes.map((a: any) => a.Key);
    expect(keys.filter((k: string) => k.startsWith('access_logs'))).toEqual([]);
  });

  it('outputs the browser gateway URL and stores it in SSM', () => {
    const url = { 'Fn::Join': ['', ['https://', { 'Fn::GetAtt': ['GatewayBrowserDistribution', 'DomainName'] }]] };
    expect(template.Outputs.BrowserGatewayUrl.Value).toEqual(url);
    expect(r.BrowserGatewayUrlParameter.Properties).toEqual(expect.objectContaining({
      Name: { 'Fn::Sub': '/${ProductName}/DCV/BrowserGatewayUrl' }, Value: url,
    }));
  });

  it('fails clearly when fewer than two zones support VPC origins', () => {
    expect(() => generate({ availabilityZones: ['use1-az3', 'use1-az1'] })).toThrow(/at least two Availability Zones/);
  });

  it('requires the origin-facing prefix list', () => {
    expect(() => generate({ originFacingPrefixListId: undefined })).toThrow(/originFacingPrefixListId/);
  });
});

describe('hub delete: wait for CloudFront network interfaces', () => {
  const r = generate().Resources;

  it('is deleted after the VPC origin and before the origin subnets', () => {
    // Delete runs in reverse dependency order.
    expect(r.GatewayBrowserVpcOrigin.DependsOn).toContain('GatewayBrowserEniWait');
    expect(r.GatewayBrowserEniWait.DependsOn).toEqual(['PrivateSubnet1', 'PrivateSubnet3']);
    expect(r.GatewayBrowserEniWait.Properties.VpcId).toEqual({ Ref: 'VPC' });
    expect(r.GatewayBrowserEniWaitFunction.Properties.Role).toEqual({ 'Fn::GetAtt': ['CleanupLambdaRole', 'Arn'] });
  });

  function loadHandler(pages: string[][]) {
    const calls: any[] = [];
    const responses: string[] = [];
    const fakeRequire = (name: string) => {
      if (name === '@aws-sdk/client-ec2') {
        return {
          EC2Client: function EC2Client() {
            return { send: async (cmd: any) => {
              calls.push(cmd.input);
              const ids = pages.length > 1 ? pages.shift()! : pages[0];
              return { NetworkInterfaces: [
                ...ids.map(id => ({ NetworkInterfaceId: id, InterfaceType: 'cloudfront_managed' })),
                { NetworkInterfaceId: 'eni-lambda', InterfaceType: 'lambda' },
              ] };
            } };
          },
          DescribeNetworkInterfacesCommand: function Cmd(this: any, input: any) { this.input = input; },
        };
      }
      if (name === 'https') {
        return { request: (_opts: any, cb: any) => ({
          on: () => undefined,
          end: (body: string) => { responses.push(body); cb({ resume: () => undefined, on: (_e: string, done: () => void) => done() }); },
        }) };
      }
      throw new Error(name);
    };
    const module = { exports: {} as any };
    // eslint-disable-next-line no-new-func
    new Function('require', 'exports', 'module', browserPath.ENI_WAIT_FUNCTION_CODE)(fakeRequire, module.exports, module);
    return { handler: module.exports.handler, calls, responses };
  }
  const event = (RequestType: string) => ({
    RequestType, ResponseURL: 'https://example.com/response?x=1', StackId: 's', RequestId: 'r', LogicalResourceId: 'l',
    ResourceProperties: { VpcId: 'vpc-1' },
  });

  it('waits on delete until no CloudFront network interface is left, then reports success', async () => {
    jest.useFakeTimers();
    try {
      const { handler, calls, responses } = loadHandler([['eni-a', 'eni-b'], []]);
      const done = handler(event('Delete'), { logStreamName: 'log' });
      await jest.advanceTimersByTimeAsync(15000);
      await done;
      expect(calls).toHaveLength(2);
      expect(calls[0].Filters).toEqual([{ Name: 'vpc-id', Values: ['vpc-1'] }]);
      expect(JSON.parse(responses[0]).Status).toBe('SUCCESS');
    } finally {
      jest.useRealTimers();
    }
  });

  it('does nothing on create', async () => {
    const { handler, calls, responses } = loadHandler([['eni-a']]);
    await handler(event('Create'), { logStreamName: 'log' });
    expect(calls).toHaveLength(0);
    expect(JSON.parse(responses[0]).Status).toBe('SUCCESS');
  });
});

describe('hub with a hosted zone', () => {
  const r = generate({ hostedZone: { id: 'Z0123456789ABCDEFGHIJ', name: 'example.com' } }).Resources;
  const name = 'dcv-gateway-origin.us-east-1.example.com';

  it('validates an ACM certificate through the zone and listens on HTTPS 443', () => {
    expect(r.GatewayBrowserOriginCertificate.Properties).toEqual(expect.objectContaining({
      DomainName: name, ValidationMethod: 'DNS',
      DomainValidationOptions: [{ DomainName: name, HostedZoneId: 'Z0123456789ABCDEFGHIJ' }],
    }));
    expect(r.GatewayBrowserListener.Properties).toEqual(expect.objectContaining({ Port: 443, Protocol: 'HTTPS' }));
    expect(r.GatewayBrowserAlbSecurityGroup.Properties.SecurityGroupIngress[0].FromPort).toBe(443);
  });

  it('makes CloudFront connect to the origin by name over HTTPS', () => {
    expect(r.GatewayBrowserVpcOrigin.Properties.VpcOriginEndpointConfig.OriginProtocolPolicy).toBe('https-only');
    expect(r.GatewayBrowserDistribution.Properties.DistributionConfig.Origins[0].DomainName).toBe(name);
    expect(r.GatewayBrowserOriginRecord.Properties).toEqual(expect.objectContaining({ Name: name, Type: 'A' }));
  });
});

describe('hub in direct mode', () => {
  const template = generate({ gatewayBrowserPath: 'direct', originFacingPrefixListId: undefined });

  it('creates no CloudFront or ALB resources', () => {
    expect(resourcesOfType(template, 'AWS::CloudFront::Distribution')).toEqual([]);
    expect(resourcesOfType(template, 'AWS::CloudFront::VpcOrigin')).toEqual([]);
    expect(template.Resources.GatewayBrowserAlb).toBeUndefined();
    expect(template.Resources.ConnectionGatewaySGFromBrowserAlb).toBeUndefined();
  });

  it('outputs the gateway itself as the browser gateway URL', () => {
    const value = template.Outputs.BrowserGatewayUrl.Value;
    expect(JSON.stringify(value)).toContain('ConnectionGatewayNLB');
    expect(JSON.stringify(value)).toContain(':8443');
  });
});

describe('hub client allowlist', () => {
  it('limits TCP 8443 and UDP 8444 to the allowed CIDRs', () => {
    const template = generate({ allowedClientCidrs: ['192.0.2.0/24'] });
    const rules = ingressOf(template, 'ConnectionGatewaySecurityGroup');
    expect(rules.filter(r => r.CidrIp === '0.0.0.0/0')).toEqual([]);
    expect(rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ IpProtocol: 'tcp', FromPort: 8443, CidrIp: '192.0.2.0/24' }),
      expect.objectContaining({ IpProtocol: 'udp', FromPort: 8444, CidrIp: '192.0.2.0/24' }),
    ]));
  });

  it('puts each prefix list and protocol in a security group of its own on the gateway', () => {
    const template = generate({ allowedPrefixListIds: ['pl-11111111', 'pl-22222222'] });
    const groups = Object.keys(template.Resources).filter(id => id.startsWith('ConnectionGatewayAllowedPrefixList'));
    expect(groups).toHaveLength(4);
    for (const id of groups) {
      expect(template.Resources[id].Properties.SecurityGroupIngress).toHaveLength(1);
    }
    const sgIds = template.Resources.ConnectionGatewayLaunchTemplate.Properties.LaunchTemplateData.SecurityGroupIds;
    expect(sgIds).toHaveLength(5);
    expect(ingressOf(template, 'ConnectionGatewaySecurityGroup').filter(r => r.CidrIp === '0.0.0.0/0')).toEqual([]);
  });
});

describe('gateway-browser-path settings', () => {
  it('defaults the browser path to cloudfront and rejects unknown values', () => {
    expect(browserPath.parseBrowserPath(undefined)).toBe('cloudfront');
    expect(browserPath.parseBrowserPath(' Direct ')).toBe('direct');
    expect(() => browserPath.parseBrowserPath('nlb')).toThrow(/DcvBrowserPath/);
  });

  it('validates allowlist CIDRs and prefix list IDs', () => {
    expect(browserPath.parseAllowedClientCidrs('192.0.2.0/24, 198.51.100.7/32')).toEqual(['192.0.2.0/24', '198.51.100.7/32']);
    expect(() => browserPath.parseAllowedClientCidrs('0.0.0.0/0')).toThrow(/empty/);
    expect(() => browserPath.parseAllowedClientCidrs('300.0.0.0/8')).toThrow(/IPv4/);
    expect(() => browserPath.parseAllowedPrefixListIds('pl-1,pl-2')).toThrow(/prefix list ID/);
    expect(() => browserPath.parseAllowedPrefixListIds(['pl-11111111', 'pl-22222222', 'pl-33333333'])).toThrow(/at most 2/);
  });

  it('answers CORS preflights in the CloudFront Function and passes everything else on', () => {
    // eslint-disable-next-line no-new-func
    const handler = new Function(`${browserPath.CORS_PREFLIGHT_FUNCTION_CODE}; return handler;`)();
    const preflight = handler({ request: { method: 'OPTIONS', headers: {
      origin: { value: 'https://console.example.com' },
      'access-control-request-method': { value: 'POST' },
      'access-control-request-headers': { value: 'content-type' },
    } } });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-headers']).toEqual({ value: 'content-type' });

    const plainOptions = { method: 'OPTIONS', headers: {} };
    expect(handler({ request: plainOptions })).toBe(plainOptions);
    const get = { method: 'GET', headers: { origin: { value: 'https://console.example.com' } } };
    expect(handler({ request: get })).toBe(get);
  });
});
