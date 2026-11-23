// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser path to the DCV Connection Gateway, shared by the primary stack
 * (lib/dcv-infrastructure-stack.ts) and the regional hub template.
 *
 * 'cloudfront' (default): one CloudFront distribution per gateway Region. Its
 * origin is a CloudFront VPC origin on an internal Application Load Balancer,
 * which forwards to the gateway on TCP 8443. Browsers get a publicly trusted
 * certificate (*.cloudfront.net) and the gateway's web port needs no public
 * listener for browser sessions.
 *
 * 'direct': browsers connect to the gateway's NLB on TCP 8443, as before.
 *
 * Native clients use the gateway NLB in both modes (UDP 8444, and TCP 8443).
 */

const BROWSER_PATHS = ['cloudfront', 'direct'];
const DEFAULT_BROWSER_PATH = 'cloudfront';

// Availability Zone IDs where CloudFront VPC origins aren't supported
// (Amazon CloudFront Developer Guide, "Supported AWS Regions for VPC origins").
// The origin load balancer must not use subnets in these zones.
const VPC_ORIGIN_EXCLUDED_AZ_IDS = ['use1-az3', 'usw1-az2', 'apne1-az3', 'cac1-az3'];

// AWS-managed prefix list of CloudFront's origin-facing addresses. Its ID
// differs per Region, so it is looked up by name. It counts as 55 rules.
const CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST = 'com.amazonaws.global.cloudfront.origin-facing';

// CloudFront managed policies.
const MANAGED_CACHE_POLICY_CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const MANAGED_ORIGIN_REQUEST_POLICY_ALL_VIEWER = '216adef6-5c7f-47e4-b989-5492eafa07d3';
const MANAGED_RESPONSE_HEADERS_POLICY_SIMPLE_CORS = '60669652-455b-4ae9-85a4-c4c02393f86c';

// One security group per prefix list and protocol, so each list fits the
// rules-per-security-group quota. With the gateway's own group that is
// 1 + 2 x 2 = 5 groups, the default per-ENI limit.
const MAX_ALLOWED_PREFIX_LISTS = 2;

/**
 * Answers CORS preflights for the gateway's HTTP routes (file transfer,
 * printing). The gateway itself rejects preflights unless private config keys
 * are set. Every other request goes to the gateway unchanged.
 *
 * `*` is safe here: the gateway uses no cookies or other ambient credentials.
 * Each request carries its own DCV session token, which the workstation checks.
 */
const CORS_PREFLIGHT_FUNCTION_CODE = [
  'function handler(event) {',
  '  var request = event.request;',
  '  var headers = request.headers;',
  "  if (request.method === 'OPTIONS' && headers.origin && headers['access-control-request-method']) {",
  '    var response = {',
  '      statusCode: 204,',
  "      statusDescription: 'No Content',",
  '      headers: {',
  "        'access-control-allow-origin': { value: '*' },",
  "        'access-control-allow-methods': { value: 'GET, POST, DELETE' },",
  "        'access-control-max-age': { value: '600' }",
  '      }',
  '    };',
  "    var requested = headers['access-control-request-headers'];",
  "    if (requested) { response.headers['access-control-allow-headers'] = { value: requested.value }; }",
  '    return response;',
  '  }',
  '  return request;',
  '}',
].join('\n');

/** Comma-separated text or an array, as a list of trimmed, non-empty strings. */
function parseList(value) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : String(value).split(',');
  return items.map(item => String(item).trim()).filter(Boolean);
}

function parseBrowserPath(value) {
  const path = (value === undefined || value === null || String(value).trim() === '')
    ? DEFAULT_BROWSER_PATH
    : String(value).trim().toLowerCase();
  if (!BROWSER_PATHS.includes(path)) {
    throw new Error(`DcvBrowserPath must be one of ${BROWSER_PATHS.join(', ')} (got: ${value})`);
  }
  return path;
}

function parseAllowedClientCidrs(value) {
  const cidrs = parseList(value);
  for (const cidr of cidrs) {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr);
    if (!match || match.slice(1, 5).some(octet => Number(octet) > 255) || Number(match[5]) > 32) {
      throw new Error(`DcvAllowedClientCidrs: '${cidr}' is not an IPv4 CIDR block`);
    }
    if (Number(match[5]) === 0) {
      throw new Error("DcvAllowedClientCidrs: leave the setting empty instead of using a /0 block");
    }
  }
  return cidrs;
}

function parseAllowedPrefixListIds(value) {
  const ids = parseList(value);
  for (const id of ids) {
    if (!/^pl-[0-9a-f]{8,17}$/.test(id)) {
      throw new Error(`DcvAllowedPrefixListIds: '${id}' is not a prefix list ID`);
    }
  }
  if (ids.length > MAX_ALLOWED_PREFIX_LISTS) {
    throw new Error(`DcvAllowedPrefixListIds: at most ${MAX_ALLOWED_PREFIX_LISTS} prefix lists are supported`);
  }
  return ids;
}

/**
 * Subnets the origin load balancer may use: those not in an excluded AZ ID.
 * @param {{ ref: any, azId: string }[]} subnets
 */
function selectVpcOriginSubnets(subnets) {
  const allowed = subnets.filter(subnet => !VPC_ORIGIN_EXCLUDED_AZ_IDS.includes(subnet.azId));
  if (allowed.length < 2) {
    throw new Error(
      'The CloudFront browser path needs private subnets in at least two Availability Zones that support ' +
      `CloudFront VPC origins (not ${VPC_ORIGIN_EXCLUDED_AZ_IDS.join(', ')}). ` +
      'Choose other zones, or set DcvBrowserPath to direct.');
  }
  return allowed;
}

/**
 * Associated IPv4 CIDR blocks of a VPC (DescribeVpcs shape) other than
 * `primaryCidr`, in association order.
 */
function additionalVpcCidrs(vpc, primaryCidr) {
  if (!vpc) return [];
  const cidrs = [vpc.CidrBlock, ...(vpc.CidrBlockAssociationSet || [])
    .filter(a => a.CidrBlockState && a.CidrBlockState.State === 'associated')
    .map(a => a.CidrBlock)];
  return [...new Set(cidrs.filter(c => c && c !== primaryCidr))];
}

/** DNS name of the origin load balancer when a hosted zone is set. */
function originDomainName(region, hostedZoneName) {
  return `dcv-gateway-origin.${region}.${String(hostedZoneName).replace(/\.$/, '')}`;
}

/**
 * Gateway security group ingress for clients (TCP 8443 and UDP 8444) and the
 * extra security groups for prefix lists, as raw CloudFormation.
 *
 * @param {object} o
 * @param {string[]} o.allowedClientCidrs
 * @param {string[]} o.allowedPrefixListIds
 * @param {any} o.vpcRef        `{ Ref: 'VPC' }`
 * @returns {{ ingress: object[], resources: object, extraSecurityGroupRefs: object[] }}
 */
function gatewayClientIngressTemplate({ allowedClientCidrs, allowedPrefixListIds, vpcRef }) {
  const restricted = allowedClientCidrs.length > 0 || allowedPrefixListIds.length > 0;
  const ingress = restricted
    ? allowedClientCidrs.flatMap(cidr => [
      { IpProtocol: 'tcp', FromPort: 8443, ToPort: 8443, CidrIp: cidr, Description: 'DCV TCP from allowed client network' },
      { IpProtocol: 'udp', FromPort: 8444, ToPort: 8444, CidrIp: cidr, Description: 'DCV QUIC from allowed client network' },
    ])
    : [
      { IpProtocol: 'tcp', FromPort: 8443, ToPort: 8443, CidrIp: '0.0.0.0/0', Description: 'DCV TCP from internet' },
      { IpProtocol: 'udp', FromPort: 8444, ToPort: 8444, CidrIp: '0.0.0.0/0', Description: 'DCV QUIC from internet' },
    ];

  const resources = {};
  const extraSecurityGroupRefs = [];
  allowedPrefixListIds.forEach((prefixListId, i) => {
    for (const [proto, port, label] of [['tcp', 8443, 'Tcp'], ['udp', 8444, 'Udp']]) {
      const logicalId = `ConnectionGatewayAllowedPrefixList${i + 1}${label}SecurityGroup`;
      resources[logicalId] = {
        Type: 'AWS::EC2::SecurityGroup',
        Properties: {
          GroupDescription: `DCV Connection Gateway ${proto.toUpperCase()} ${port} from allowed prefix list ${i + 1}`,
          VpcId: vpcRef,
          SecurityGroupIngress: [{
            IpProtocol: proto, FromPort: port, ToPort: port, SourcePrefixListId: prefixListId,
            Description: `DCV ${label === 'Tcp' ? 'TCP' : 'QUIC'} from allowed prefix list`,
          }],
          Tags: [{ Key: 'Name', Value: { 'Fn::Sub': `\${ProductName}-Regional-ConnectionGateway-PL${i + 1}-${label}-SG` } }],
        },
      };
      extraSecurityGroupRefs.push({ Ref: logicalId });
    }
  });
  return { ingress, resources, extraSecurityGroupRefs };
}

/**
 * Hub template resources for the CloudFront browser path.
 *
 * @param {object} o
 * @param {string} o.acronymLower
 * @param {string} o.region
 * @param {string} o.regionCode
 * @param {object[]} o.albSubnetRefs        subnets outside the excluded AZ IDs
 * @param {string} o.originFacingPrefixListId
 * @param {{ id: string, name: string } | null} o.hostedZone
 * @param {(purpose: string) => string} o.albName
 * @param {(purpose: string) => string} o.targetGroupName
 * @returns {{ resources: object, targetGroupRef: object, distributionDomain: object }}
 */
function cloudFrontBrowserPathTemplate(o) {
  const https = Boolean(o.hostedZone);
  const originName = https ? originDomainName(o.region, o.hostedZone.name) : null;
  const listenerPort = https ? 443 : 80;
  const tags = [{ Key: 'Name', Value: { 'Fn::Sub': '${ProductName}-Regional-Gateway-Browser' } }];

  const resources = {
    GatewayBrowserAlbSecurityGroup: {
      Type: 'AWS::EC2::SecurityGroup',
      Properties: {
        GroupName: { 'Fn::Sub': '${ProductName}-Regional-Gateway-Browser-ALB-SG' },
        GroupDescription: 'Gateway browser-path load balancer, reachable only from CloudFront',
        VpcId: { Ref: 'VPC' },
        SecurityGroupIngress: [{
          IpProtocol: 'tcp', FromPort: listenerPort, ToPort: listenerPort,
          SourcePrefixListId: o.originFacingPrefixListId,
          Description: 'CloudFront origin-facing (VPC origin)',
        }],
        // Replaced by the rule below; a security group created without egress
        // rules gets allow-all.
        SecurityGroupEgress: [{ IpProtocol: 'icmp', FromPort: 252, ToPort: 86, CidrIp: '255.255.255.255/32', Description: 'Disallow all traffic' }],
        Tags: [{ Key: 'Name', Value: { 'Fn::Sub': '${ProductName}-Regional-Gateway-Browser-ALB-SG' } }],
      },
    },
    GatewayBrowserAlbEgressToGateway: {
      Type: 'AWS::EC2::SecurityGroupEgress',
      Properties: {
        GroupId: { Ref: 'GatewayBrowserAlbSecurityGroup' },
        IpProtocol: 'tcp', FromPort: 8443, ToPort: 8443,
        DestinationSecurityGroupId: { Ref: 'ConnectionGatewaySecurityGroup' },
        Description: 'Gateway web port',
      },
    },
    ConnectionGatewaySGFromBrowserAlb: {
      Type: 'AWS::EC2::SecurityGroupIngress',
      Properties: {
        GroupId: { Ref: 'ConnectionGatewaySecurityGroup' },
        IpProtocol: 'tcp', FromPort: 8443, ToPort: 8443,
        SourceSecurityGroupId: { Ref: 'GatewayBrowserAlbSecurityGroup' },
        Description: 'DCV browser sessions from the CloudFront origin load balancer',
      },
    },
    GatewayBrowserAlb: {
      Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
      Properties: {
        Name: o.albName('gw-web'),
        Type: 'application',
        Scheme: 'internal',
        IpAddressType: 'ipv4',
        Subnets: o.albSubnetRefs,
        SecurityGroups: [{ Ref: 'GatewayBrowserAlbSecurityGroup' }],
        // No access logs by default: the first browser request carries the
        // DCV session token in its query string.
        LoadBalancerAttributes: [
          { Key: 'idle_timeout.timeout_seconds', Value: '60' },
          { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
        ],
        Tags: tags,
      },
    },
    GatewayBrowserTargetGroup: {
      Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
      Properties: {
        Name: o.targetGroupName('gw-web'),
        VpcId: { Ref: 'VPC' },
        TargetType: 'instance',
        Protocol: 'HTTPS',
        Port: 8443,
        ProtocolVersion: 'HTTP1',
        // The gateway's health port (8989) accepts TCP and sends nothing, and
        // ALB health checks are HTTP(S) only, so check the web port. A
        // token-only gateway answers GET / with 404.
        HealthCheckProtocol: 'HTTPS',
        HealthCheckPort: 'traffic-port',
        HealthCheckPath: '/',
        HealthCheckIntervalSeconds: 10,
        HealthyThresholdCount: 2,
        UnhealthyThresholdCount: 2,
        Matcher: { HttpCode: '200-499' },
        TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '30' }],
        Tags: tags,
      },
    },
    GatewayBrowserListener: {
      Type: 'AWS::ElasticLoadBalancingV2::Listener',
      Properties: {
        LoadBalancerArn: { Ref: 'GatewayBrowserAlb' },
        Port: listenerPort,
        Protocol: https ? 'HTTPS' : 'HTTP',
        ...(https ? {
          Certificates: [{ CertificateArn: { Ref: 'GatewayBrowserOriginCertificate' } }],
          SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
        } : {}),
        DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: 'GatewayBrowserTargetGroup' } }],
      },
    },
    GatewayBrowserVpcOrigin: {
      Type: 'AWS::CloudFront::VpcOrigin',
      DependsOn: 'GatewayBrowserListener',
      Properties: {
        VpcOriginEndpointConfig: {
          Name: `${o.acronymLower}-gateway-${o.region}`,
          Arn: { Ref: 'GatewayBrowserAlb' },
          HTTPPort: 80,
          HTTPSPort: 443,
          OriginProtocolPolicy: https ? 'https-only' : 'http-only',
          OriginSSLProtocols: ['TLSv1.2'],
        },
        Tags: tags,
      },
    },
    GatewayBrowserCorsFunction: {
      Type: 'AWS::CloudFront::Function',
      Properties: {
        Name: `${o.acronymLower}-gateway-cors-${o.regionCode}`,
        AutoPublish: true,
        FunctionConfig: { Comment: 'Answers CORS preflights for the DCV gateway', Runtime: 'cloudfront-js-2.0' },
        FunctionCode: CORS_PREFLIGHT_FUNCTION_CODE,
      },
    },
    GatewayBrowserDistribution: {
      Type: 'AWS::CloudFront::Distribution',
      Properties: {
        DistributionConfig: {
          Comment: { 'Fn::Sub': `\${ProductName} DCV gateway browser path (${o.region})` },
          Enabled: true,
          HttpVersion: 'http2',
          IPV6Enabled: false,
          PriceClass: 'PriceClass_All',
          ViewerCertificate: { CloudFrontDefaultCertificate: true },
          // No standard logging: the first browser request carries the DCV
          // session token in its query string.
          Origins: [{
            Id: 'gateway-alb',
            DomainName: https ? originName : { 'Fn::GetAtt': ['GatewayBrowserAlb', 'DNSName'] },
            VpcOriginConfig: {
              VpcOriginId: { Ref: 'GatewayBrowserVpcOrigin' },
              OriginReadTimeout: 30,
              OriginKeepaliveTimeout: 5,
            },
          }],
          DefaultCacheBehavior: {
            TargetOriginId: 'gateway-alb',
            ViewerProtocolPolicy: 'https-only',
            AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'],
            CachedMethods: ['GET', 'HEAD'],
            Compress: false,
            CachePolicyId: MANAGED_CACHE_POLICY_CACHING_DISABLED,
            OriginRequestPolicyId: MANAGED_ORIGIN_REQUEST_POLICY_ALL_VIEWER,
            ResponseHeadersPolicyId: MANAGED_RESPONSE_HEADERS_POLICY_SIMPLE_CORS,
            FunctionAssociations: [{
              EventType: 'viewer-request',
              FunctionARN: { 'Fn::GetAtt': ['GatewayBrowserCorsFunction', 'FunctionMetadata.FunctionARN'] },
            }],
          },
        },
        Tags: tags,
      },
    },
  };

  if (https) {
    resources.GatewayBrowserOriginCertificate = {
      Type: 'AWS::CertificateManager::Certificate',
      Properties: {
        DomainName: originName,
        ValidationMethod: 'DNS',
        DomainValidationOptions: [{ DomainName: originName, HostedZoneId: o.hostedZone.id }],
        Tags: tags,
      },
    };
    resources.GatewayBrowserOriginRecord = {
      Type: 'AWS::Route53::RecordSet',
      Properties: {
        HostedZoneId: o.hostedZone.id,
        Name: originName,
        Type: 'A',
        AliasTarget: {
          DNSName: { 'Fn::GetAtt': ['GatewayBrowserAlb', 'DNSName'] },
          HostedZoneId: { 'Fn::GetAtt': ['GatewayBrowserAlb', 'CanonicalHostedZoneID'] },
          EvaluateTargetHealth: false,
        },
      },
    };
    resources.GatewayBrowserVpcOrigin.DependsOn = ['GatewayBrowserListener', 'GatewayBrowserOriginRecord'];
  }

  return {
    resources,
    targetGroupRef: { Ref: 'GatewayBrowserTargetGroup' },
    distributionDomain: { 'Fn::GetAtt': ['GatewayBrowserDistribution', 'DomainName'] },
  };
}

module.exports = {
  BROWSER_PATHS,
  DEFAULT_BROWSER_PATH,
  VPC_ORIGIN_EXCLUDED_AZ_IDS,
  CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST,
  MANAGED_CACHE_POLICY_CACHING_DISABLED,
  MANAGED_ORIGIN_REQUEST_POLICY_ALL_VIEWER,
  MANAGED_RESPONSE_HEADERS_POLICY_SIMPLE_CORS,
  MAX_ALLOWED_PREFIX_LISTS,
  CORS_PREFLIGHT_FUNCTION_CODE,
  parseList,
  parseBrowserPath,
  parseAllowedClientCidrs,
  parseAllowedPrefixListIds,
  selectVpcOriginSubnets,
  additionalVpcCidrs,
  originDomainName,
  gatewayClientIngressTemplate,
  cloudFrontBrowserPathTemplate,
};
