// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Guard tests for the regional hub IAM policies (lib/regional-hub-iam.ts,
 * issue #62) against the hub template (lambda/generate-regional-hub-template).
 *
 * - Every resource type in the largest hub template must be in CFN_CALLS, and
 *   the CFN policy must allow the calls CloudFormation makes for it. A new
 *   resource type fails here until the policy and CFN_CALLS cover it.
 * - Every hub IAM role must carry the boundary, and the boundary must allow
 *   everything each hub role's own policies grant.
 *
 * The calls come from the CloudFormation registry schema's create, read,
 * update and delete handler permissions for each type, minus the ones for
 * features the hub template doesn't use (KMS keys, container images, EFS,
 * VPC Lattice, IPv6, replication and so on), plus Lambda's custom resource
 * invocations and the dry run Auto Scaling makes.
 *
 * `allowed` is a small policy evaluator: it matches actions, resources and the
 * condition operators these policies use, and an explicit Deny wins.
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Template } from 'aws-cdk-lib/assertions';
import {
  HUB_MANAGED_POLICY_ARNS, RegionalHubIamNames, regionalHubBoundaryDocument, regionalHubCfnPolicyDocuments,
} from '../lib/regional-hub-iam';
import { RegionalHubStack } from '../lib/regional-hub-stack';

// The Lambda runtime provides this client. The repo doesn't install it.
jest.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: jest.fn(),
  GetTemplateCommand: jest.fn(),
}), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateCloudFormationTemplate } = require('../lambda/generate-regional-hub-template/index.js');

const ACCOUNT = '123456789012';
const PRIMARY = 'us-east-1';
const KMS_KEY = `arn:aws:kms:${PRIMARY}:${ACCOUNT}:key/00000000-0000-0000-0000-000000000000`;
const HUB_LAMBDAS = ['dcvSessionManager', 'dcvReadinessCheckWindows', 'dcvReadinessCheckLinux', 'dcvReadinessCheckMacos',
  'dcvSessionCleanup', 'configureOntapCifs'];

const HOSTED_ZONE = { id: 'Z0EXAMPLE0ZONE0ID', name: 'example.com' };

const VARIANTS = [
  { productName: 'MediaResourceManager', acronym: 'MRM', region: 'us-west-2' },
  // Long enough that hub IAM names fall back to the acronym.
  { productName: 'ExampleVeryLongProductNameForIam', acronym: 'EVL', region: 'ap-southeast-1' },
];

// ---------- policy evaluator ----------

type Ctx = Record<string, string | string[]>;
type Statement = { Effect: string; Action?: string | string[]; NotAction?: string | string[];
  Resource: string | string[]; Condition?: Record<string, Record<string, string | string[]>> };

const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const glob = (pattern: string, value: string, flags = '') =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, flags).test(value);

function conditionsHold(condition: Statement['Condition'], ctx: Ctx): boolean {
  for (const [operator, keys] of Object.entries(condition || {})) {
    for (const [key, expected] of Object.entries(keys)) {
      const actual = ctx[key];
      const values = actual === undefined ? [] : list(actual);
      const equals = (x: string) => list(expected).includes(x);
      const like = (x: string) => list(expected).some(p => glob(p, x));
      const matches = actual !== undefined && !Array.isArray(actual) && equals(actual);
      switch (operator) {
        case 'StringEquals': case 'ArnEquals': if (!matches) return false; break;
        case 'StringEqualsIfExists': if (actual !== undefined && !matches) return false; break;
        case 'StringNotEquals': if (matches) return false; break;
        // A missing key makes ForAllValues true and ForAnyValue false, as in IAM.
        case 'ForAllValues:StringEquals': if (!values.every(equals)) return false; break;
        case 'ForAllValues:StringLike': if (!values.every(like)) return false; break;
        case 'ForAnyValue:StringLike': if (!values.some(like)) return false; break;
        default: throw new Error(`evaluator doesn't support ${operator}`);
      }
    }
  }
  return true;
}

function statementMatches(s: Statement, action: string, resource: string, ctx: Ctx): boolean {
  const actionHit = s.NotAction
    ? !list(s.NotAction).some(p => glob(p, action, 'i'))
    : list(s.Action).some(p => glob(p, action, 'i'));
  return actionHit && list(s.Resource).some(p => glob(p, resource)) && conditionsHold(s.Condition, ctx);
}

function allowed(doc: { Statement: Statement[] }, action: string, resource: string, ctx: Ctx = {}): boolean {
  const hits = doc.Statement.filter(s => statementMatches(s, action, resource, ctx));
  return hits.some(s => s.Effect === 'Allow') && !hits.some(s => s.Effect === 'Deny');
}

function render(doc: cdk.aws_iam.PolicyDocument): { Statement: Statement[] } {
  return new cdk.Stack().resolve(doc.toJSON());
}

// ---------- hub template ----------

function generate(v: typeof VARIANTS[number]) {
  const regionalBucket = `${v.acronym.toLowerCase()}-lambda-assets-${ACCOUNT}-${v.region}`;
  return generateCloudFormationTemplate({
    ...v,
    displayName: 'Test hub',
    vpcCidr: '10.1.0.0/16',
    availabilityZones: [`${v.region}a`, `${v.region}b`],
    primaryRegion: PRIMARY,
    dcvDomainName: 'dcv.example.com',
    enableWindows: true,
    enableLinux: true,
    enableMacOS: true,
    lambdaAssets: Object.fromEntries(HUB_LAMBDAS.map(n => [n, { bucket: regionalBucket, key: `lambda/${n}/0.zip` }])),
    // Gateway browser path (#103), largest variant: CloudFront with the HTTPS
    // origin hop and a client allowlist. A generator without it ignores these.
    gatewayBrowserPath: 'cloudfront',
    originFacingPrefixListId: 'pl-0a1b2c3d4e5f60718',
    hostedZone: HOSTED_ZONE,
    allowedClientCidrs: ['203.0.113.0/24'],
    allowedPrefixListIds: ['pl-0123456789abcdef0', 'pl-0fedcba9876543210'],
  });
}

const NAME_PROPERTY: Record<string, string> = {
  'AWS::IAM::Role': 'RoleName', 'AWS::IAM::InstanceProfile': 'InstanceProfileName',
  'AWS::Lambda::Function': 'FunctionName', 'AWS::S3::Bucket': 'BucketName', 'AWS::Logs::LogGroup': 'LogGroupName',
  'AWS::Events::Rule': 'Name', 'AWS::SSM::Document': 'Name', 'AWS::SSM::Parameter': 'Name',
  'AWS::ResourceGroups::Group': 'Name', 'AWS::ElasticLoadBalancingV2::LoadBalancer': 'Name',
  'AWS::ElasticLoadBalancingV2::TargetGroup': 'Name', 'AWS::AutoScaling::AutoScalingGroup': 'AutoScalingGroupName',
  'AWS::CloudFront::Function': 'Name',
};

const REF_IS_ARN = new Set(['AWS::ElasticLoadBalancingV2::LoadBalancer', 'AWS::ElasticLoadBalancingV2::TargetGroup',
  'AWS::CertificateManager::Certificate']);

/** Resolves the intrinsic functions the hub template uses, with every condition true. */
function resolver(template: any, v: typeof VARIANTS[number]) {
  const vars: Record<string, string> = {
    ProductName: v.productName, Acronym: v.acronym, PrimaryRegion: PRIMARY, DynamoDbKmsKeyArn: KMS_KEY,
    DcvDomainName: 'dcv.example.com', WorkstationTableName: 'workstation-instances',
    'AWS::Region': v.region, 'AWS::AccountId': ACCOUNT, 'AWS::Partition': 'aws',
  };
  const name = (id: string): string => {
    const r = template.Resources[id];
    const prop = NAME_PROPERTY[r.Type];
    if (!prop || r.Properties[prop] === undefined) throw new Error(`${id} (${r.Type}) has no name to check`);
    return resolve(r.Properties[prop]);
  };
  const arn = (id: string): string => {
    const r = template.Resources[id];
    // Types whose ARN holds a generated ID, not a name.
    switch (r.Type) {
      case 'AWS::CloudFront::Distribution': return `arn:aws:cloudfront::${ACCOUNT}:distribution/E0EXAMPLE0DIST`;
      case 'AWS::CloudFront::VpcOrigin': return `arn:aws:cloudfront::${ACCOUNT}:vpcorigin/vo_0EXAMPLE0ORIGIN`;
      case 'AWS::CertificateManager::Certificate':
        return `arn:aws:acm:${v.region}:${ACCOUNT}:certificate/00000000-0000-0000-0000-000000000001`;
      default: break;
    }
    const n = name(id);
    switch (r.Type) {
      case 'AWS::Lambda::Function': return `arn:aws:lambda:${v.region}:${ACCOUNT}:function:${n}`;
      case 'AWS::IAM::Role': return `arn:aws:iam::${ACCOUNT}:role/${n}`;
      case 'AWS::IAM::InstanceProfile': return `arn:aws:iam::${ACCOUNT}:instance-profile/${n}`;
      case 'AWS::S3::Bucket': return `arn:aws:s3:::${n}`;
      case 'AWS::Logs::LogGroup': return `arn:aws:logs:${v.region}:${ACCOUNT}:log-group:${n}`;
      case 'AWS::Events::Rule': return `arn:aws:events:${v.region}:${ACCOUNT}:rule/${n}`;
      case 'AWS::SSM::Document': return `arn:aws:ssm:${v.region}:${ACCOUNT}:document/${n}`;
      case 'AWS::SSM::Parameter': return `arn:aws:ssm:${v.region}:${ACCOUNT}:parameter${n}`;
      case 'AWS::ResourceGroups::Group': return `arn:aws:resource-groups:${v.region}:${ACCOUNT}:group/${n}`;
      case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
        return `arn:aws:elasticloadbalancing:${v.region}:${ACCOUNT}:loadbalancer/${r.Properties.Type === 'application' ? 'app' : 'net'}/${n}/0123456789abcdef`;
      case 'AWS::CloudFront::Function': return `arn:aws:cloudfront::${ACCOUNT}:function/${n}`;
      case 'AWS::ElasticLoadBalancingV2::TargetGroup':
        return `arn:aws:elasticloadbalancing:${v.region}:${ACCOUNT}:targetgroup/${n}/0123456789abcdef`;
      case 'AWS::AutoScaling::AutoScalingGroup':
        return `arn:aws:autoscaling:${v.region}:${ACCOUNT}:autoScalingGroup:0000:autoScalingGroupName/${n}`;
      default: throw new Error(`no ARN for ${r.Type}`);
    }
  };
  const ref = (id: string): string => {
    if (id in vars) return vars[id];
    const type = template.Resources[id].Type;
    if (REF_IS_ARN.has(type)) return arn(id);
    return NAME_PROPERTY[type] ? name(id) : `${id}-id`;
  };
  const sub = (s: string) => s.replace(/\$\{([^}]+)\}/g, (_, k: string) => {
    const [id, attr] = k.split('.');
    return attr ? arn(id) : ref(id);
  });
  function resolve(value: any): any {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === 'object') {
      if ('Ref' in value) return ref(value.Ref);
      if ('Fn::Sub' in value) return sub(Array.isArray(value['Fn::Sub']) ? value['Fn::Sub'][0] : value['Fn::Sub']);
      if ('Fn::GetAtt' in value) {
        const [id, attr] = value['Fn::GetAtt'];
        return /(Arn|ARN)$/.test(attr) ? arn(id) : `${id}.${attr}`;
      }
      if ('Fn::If' in value) return resolve(value['Fn::If'][1]);
      if ('Fn::Join' in value) return resolve(value['Fn::Join'][1]).join(value['Fn::Join'][0]);
      return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, resolve(x)]));
    }
    return value;
  }
  return { resolve, name, arn };
}

// ---------- what CloudFormation calls per resource type ----------

type Call = [action: string, resource: string, ctx?: Ctx];
const onAny = (actions: string[]): Call[] => actions.map(a => [a, '*']);
const on = (resource: string, actions: string[], ctx?: Ctx): Call[] => actions.map(a => [a, resource, ctx]);
const ec2Tags = ['ec2:CreateTags', 'ec2:DeleteTags'];

function cfnCalls(template: any, v: typeof VARIANTS[number]): Record<string, (id: string, r: any) => Call[]> {
  const { resolve, arn } = resolver(template, v);
  const roleOfProfile = (r: any) => resolve(r.Properties.Roles[0]);
  return {
    'AWS::EC2::VPC': () => onAny(['ec2:CreateVpc', 'ec2:DeleteVpc', 'ec2:ModifyVpcAttribute', 'ec2:DescribeVpcs',
      'ec2:DescribeVpcAttribute', 'ec2:DescribeNetworkAcls', 'ec2:DescribeSecurityGroups', ...ec2Tags]),
    'AWS::EC2::InternetGateway': () => onAny(['ec2:CreateInternetGateway', 'ec2:DeleteInternetGateway',
      'ec2:DescribeInternetGateways', ...ec2Tags]),
    'AWS::EC2::VPCGatewayAttachment': () => onAny(['ec2:AttachInternetGateway', 'ec2:DetachInternetGateway',
      'ec2:DescribeInternetGateways']),
    'AWS::EC2::Subnet': () => onAny(['ec2:CreateSubnet', 'ec2:DeleteSubnet', 'ec2:ModifySubnetAttribute',
      'ec2:DescribeSubnets', 'ec2:DescribeNetworkAcls', ...ec2Tags]),
    'AWS::EC2::SubnetRouteTableAssociation': () => onAny(['ec2:AssociateRouteTable', 'ec2:DisassociateRouteTable',
      'ec2:ReplaceRouteTableAssociation', 'ec2:DescribeRouteTables', 'ec2:DescribeSubnets']),
    'AWS::EC2::EIP': () => onAny(['ec2:AllocateAddress', 'ec2:ReleaseAddress', 'ec2:AssociateAddress',
      'ec2:DisassociateAddress', 'ec2:DescribeAddresses', ...ec2Tags]),
    'AWS::EC2::NatGateway': () => onAny(['ec2:CreateNatGateway', 'ec2:DeleteNatGateway', 'ec2:DescribeNatGateways', ...ec2Tags]),
    'AWS::EC2::RouteTable': () => onAny(['ec2:CreateRouteTable', 'ec2:DeleteRouteTable', 'ec2:DescribeRouteTables', ...ec2Tags]),
    'AWS::EC2::Route': () => onAny(['ec2:CreateRoute', 'ec2:DeleteRoute', 'ec2:ReplaceRoute', 'ec2:DescribeRouteTables',
      'ec2:DescribeNetworkInterfaces']),
    'AWS::EC2::SecurityGroup': () => onAny(['ec2:CreateSecurityGroup', 'ec2:DeleteSecurityGroup',
      'ec2:AuthorizeSecurityGroupIngress', 'ec2:AuthorizeSecurityGroupEgress', 'ec2:RevokeSecurityGroupIngress',
      'ec2:RevokeSecurityGroupEgress', 'ec2:UpdateSecurityGroupRuleDescriptionsIngress',
      'ec2:UpdateSecurityGroupRuleDescriptionsEgress', 'ec2:ModifySecurityGroupAttribute', 'ec2:ResetSecurityGroupAttribute',
      'ec2:DescribeSecurityGroups', 'ec2:DescribeInstances', ...ec2Tags]),
    'AWS::EC2::SecurityGroupIngress': () => onAny(['ec2:AuthorizeSecurityGroupIngress', 'ec2:RevokeSecurityGroupIngress',
      'ec2:UpdateSecurityGroupRuleDescriptionsIngress', 'ec2:DescribeSecurityGroups', 'ec2:DescribeSecurityGroupRules']),
    'AWS::EC2::VPCEndpoint': () => onAny(['ec2:CreateVpcEndpoint', 'ec2:DeleteVpcEndpoints', 'ec2:ModifyVpcEndpoint',
      'ec2:DescribeVpcEndpoints', 'ec2:DescribeSubnets', 'ec2:DescribeVpcs', 'ec2:DescribeSecurityGroups', ...ec2Tags]),
    'AWS::EC2::LaunchTemplate': () => onAny(['ec2:CreateLaunchTemplate', 'ec2:CreateLaunchTemplateVersion',
      'ec2:DeleteLaunchTemplate', 'ec2:DescribeLaunchTemplates', 'ec2:DescribeLaunchTemplateVersions', ...ec2Tags]),
    'AWS::AutoScaling::AutoScalingGroup': id => [
      ...on(arn(id), ['autoscaling:CreateAutoScalingGroup', 'autoscaling:UpdateAutoScalingGroup',
        'autoscaling:DeleteAutoScalingGroup', 'autoscaling:CreateOrUpdateTags', 'autoscaling:DeleteTags',
        'autoscaling:AttachLoadBalancerTargetGroups', 'autoscaling:DetachLoadBalancerTargetGroups',
        'autoscaling:SuspendProcesses', 'autoscaling:ResumeProcesses', 'autoscaling:PutLifecycleHook',
        'autoscaling:DeleteLifecycleHook', 'autoscaling:EnableMetricsCollection', 'autoscaling:DisableMetricsCollection',
        // Rolling update (the gateway ASG's UpdatePolicy)
        'autoscaling:SetDesiredCapacity', 'autoscaling:TerminateInstanceInAutoScalingGroup']),
      ...onAny(['autoscaling:DescribeAutoScalingGroups', 'autoscaling:DescribeScalingActivities', 'ec2:Describe*',
        'ec2:GetInstanceTypesFromInstanceRequirements', 'elasticloadbalancing:DescribeTargetGroups', 'ec2:RunInstances']),
      ['iam:CreateServiceLinkedRole', `arn:aws:iam::${ACCOUNT}:role/aws-service-role/autoscaling.amazonaws.com/x`,
        { 'iam:AWSServiceName': 'autoscaling.amazonaws.com' }],
    ],
    'AWS::ElasticLoadBalancingV2::LoadBalancer': id => [
      ...on(arn(id), ['elasticloadbalancing:CreateLoadBalancer', 'elasticloadbalancing:DeleteLoadBalancer',
        'elasticloadbalancing:ModifyLoadBalancerAttributes', 'elasticloadbalancing:SetSubnets',
        'elasticloadbalancing:SetSecurityGroups', 'elasticloadbalancing:SetIpAddressType',
        'elasticloadbalancing:ModifyCapacityReservation', 'elasticloadbalancing:AddTags', 'elasticloadbalancing:RemoveTags']),
      ...onAny(['elasticloadbalancing:DescribeLoadBalancers', 'elasticloadbalancing:DescribeLoadBalancerAttributes',
        'elasticloadbalancing:DescribeTags', 'elasticloadbalancing:DescribeCapacityReservation']),
      ['iam:CreateServiceLinkedRole', `arn:aws:iam::${ACCOUNT}:role/aws-service-role/elasticloadbalancing.amazonaws.com/x`,
        { 'iam:AWSServiceName': 'elasticloadbalancing.amazonaws.com' }],
    ],
    'AWS::ElasticLoadBalancingV2::TargetGroup': id => [
      ...on(arn(id), ['elasticloadbalancing:CreateTargetGroup', 'elasticloadbalancing:DeleteTargetGroup',
        'elasticloadbalancing:ModifyTargetGroup', 'elasticloadbalancing:ModifyTargetGroupAttributes',
        'elasticloadbalancing:RegisterTargets', 'elasticloadbalancing:DeregisterTargets',
        'elasticloadbalancing:AddTags', 'elasticloadbalancing:RemoveTags']),
      ...onAny(['elasticloadbalancing:DescribeTargetGroups', 'elasticloadbalancing:DescribeTargetGroupAttributes',
        'elasticloadbalancing:DescribeTargetHealth']),
    ],
    'AWS::ElasticLoadBalancingV2::Listener': (_, r) => {
      const lb = resolve(r.Properties.LoadBalancerArn) as string;
      const listener = lb.replace(':loadbalancer/', ':listener/') + '/fedcba9876543210';
      return [
        ...on(lb, ['elasticloadbalancing:CreateListener']),
        ...on(listener, ['elasticloadbalancing:DeleteListener', 'elasticloadbalancing:ModifyListener',
          'elasticloadbalancing:ModifyListenerAttributes', 'elasticloadbalancing:AddTags', 'elasticloadbalancing:RemoveTags']),
        ...onAny(['elasticloadbalancing:DescribeListeners', 'elasticloadbalancing:DescribeListenerAttributes']),
      ];
    },
    'AWS::IAM::Role': id => {
      const r = template.Resources[id];
      const ctx = { 'iam:PermissionsBoundary': resolve(r.Properties.PermissionsBoundary) };
      return [
        ...on(arn(id), ['iam:CreateRole', 'iam:PutRolePolicy', 'iam:PutRolePermissionsBoundary'], ctx),
        // Seen in CloudTrail when CloudFormation plans a role change.
        ['iam:GetPolicy', resolve(r.Properties.PermissionsBoundary)],
        ['iam:ListEntitiesForPolicy', resolve(r.Properties.PermissionsBoundary)],
        ...resolve(r.Properties.ManagedPolicyArns || []).map((p: string): Call => ['iam:GetPolicy', p]),
        ...resolve(r.Properties.ManagedPolicyArns || []).map((p: string): Call =>
          ['iam:AttachRolePolicy', arn(id), { ...ctx, 'iam:PolicyARN': p }]),
        ...on(arn(id), ['iam:GetRole', 'iam:GetRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies',
          'iam:DeleteRolePolicy', 'iam:DetachRolePolicy', 'iam:DeleteRole', 'iam:TagRole', 'iam:UntagRole',
          'iam:UpdateAssumeRolePolicy', 'iam:UpdateRole', 'iam:UpdateRoleDescription']),
      ];
    },
    'AWS::IAM::InstanceProfile': (id, r) => [
      ...on(arn(id), ['iam:CreateInstanceProfile', 'iam:DeleteInstanceProfile', 'iam:GetInstanceProfile',
        'iam:AddRoleToInstanceProfile', 'iam:RemoveRoleFromInstanceProfile']),
      // AddRoleToInstanceProfile, and Auto Scaling launching from a template.
      [`iam:PassRole`, `arn:aws:iam::${ACCOUNT}:role/${roleOfProfile(r)}`],
      [`iam:PassRole`, `arn:aws:iam::${ACCOUNT}:role/${roleOfProfile(r)}`, { 'iam:PassedToService': 'ec2.amazonaws.com' }],
    ],
    'AWS::Lambda::Function': (id, r) => {
      const code = resolve(r.Properties.Code);
      return [
        ...on(arn(id), ['lambda:CreateFunction', 'lambda:DeleteFunction', 'lambda:GetFunction', 'lambda:UpdateFunctionCode',
          'lambda:UpdateFunctionConfiguration', 'lambda:PutFunctionConcurrency', 'lambda:DeleteFunctionConcurrency',
          'lambda:GetFunctionCodeSigningConfig', 'lambda:GetFunctionRecursionConfig', 'lambda:GetRuntimeManagementConfig',
          'lambda:TagResource', 'lambda:UntagResource', 'lambda:ListTags']),
        ['lambda:GetAccountSettings', '*'],
        ['iam:PassRole', resolve(r.Properties.Role), { 'iam:PassedToService': 'lambda.amazonaws.com' }],
        ...(code.S3Bucket ? on(`arn:aws:s3:::${code.S3Bucket}/${code.S3Key}`, ['s3:GetObject', 's3:GetObjectVersion']) : []),
      ];
    },
    'AWS::Lambda::Permission': (_, r) => {
      const fn = resolve(r.Properties.FunctionName) as string;
      const fnArn = fn.startsWith('arn:') ? fn : `arn:aws:lambda:${v.region}:${ACCOUNT}:function:${fn}`;
      return on(fnArn, ['lambda:AddPermission', 'lambda:RemovePermission', 'lambda:GetPolicy']);
    },
    'AWS::Events::Rule': id => on(arn(id), ['events:PutRule', 'events:DeleteRule', 'events:DescribeRule',
      'events:PutTargets', 'events:RemoveTargets', 'events:ListTargetsByRule', 'events:TagResource',
      'events:UntagResource', 'events:ListTagsForResource']),
    'AWS::Logs::LogGroup': id => [
      ...on(arn(id), ['logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:TagResource', 'logs:UntagResource',
        'logs:ListTagsForResource']),
      ...on(`${arn(id)}:*`, ['logs:PutRetentionPolicy', 'logs:DeleteRetentionPolicy', 'logs:DescribeIndexPolicies']),
      ...onAny(['logs:DescribeLogGroups']),
    ],
    'AWS::Logs::ResourcePolicy': () => onAny(['logs:PutResourcePolicy', 'logs:DeleteResourcePolicy',
      'logs:DescribeResourcePolicies']),
    'AWS::ResourceGroups::Group': id => [
      ...on(arn(id), ['resource-groups:CreateGroup', 'resource-groups:DeleteGroup', 'resource-groups:GetGroup',
        'resource-groups:GetGroupConfiguration', 'resource-groups:PutGroupConfiguration', 'resource-groups:GetGroupQuery',
        'resource-groups:UpdateGroup', 'resource-groups:ListGroupResources', 'resource-groups:Tag',
        'resource-groups:Untag', 'resource-groups:GetTags']),
      ...onAny(['license-manager:GetLicenseConfiguration']),
    ],
    'AWS::S3::Bucket': id => [
      ...on(arn(id), ['s3:CreateBucket', 's3:DeleteBucket', 's3:PutBucketTagging', 's3:GetBucketTagging',
        's3:PutEncryptionConfiguration', 's3:GetEncryptionConfiguration', 's3:PutBucketPublicAccessBlock',
        's3:GetBucketPublicAccessBlock', 's3:PutBucketVersioning', 's3:GetBucketVersioning',
        's3:PutLifecycleConfiguration', 's3:GetLifecycleConfiguration', 's3:ListBucket', 's3:TagResource',
        's3:UntagResource', 's3:GetBucketCORS', 's3:GetBucketWebsite', 's3:GetBucketLogging']),
      ...onAny(['s3:ListAllMyBuckets']),
    ],
    'AWS::S3::BucketPolicy': (_, r) => on(`arn:aws:s3:::${resolve(r.Properties.Bucket)}`,
      ['s3:PutBucketPolicy', 's3:DeleteBucketPolicy', 's3:GetBucketPolicy']),
    'AWS::SSM::Document': id => on(arn(id), ['ssm:CreateDocument', 'ssm:DeleteDocument', 'ssm:UpdateDocument',
      'ssm:UpdateDocumentDefaultVersion', 'ssm:DescribeDocument', 'ssm:GetDocument', 'ssm:AddTagsToResource',
      'ssm:RemoveTagsFromResource', 'ssm:ListTagsForResource']),
    'AWS::SSM::Parameter': id => [
      ...on(arn(id), ['ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:GetParameters', 'ssm:AddTagsToResource',
        'ssm:RemoveTagsFromResource', 'ssm:ListTagsForResource']),
      ...onAny(['ssm:DescribeParameters']),
    ],
    // CloudFormation invokes a custom resource's Lambda with the stack's role.
    'Custom::EmptyBucket': (_, r) => on(resolve(r.Properties.ServiceToken), ['lambda:InvokeFunction']),
    'Custom::LicenseConfiguration': (_, r) => on(resolve(r.Properties.ServiceToken), ['lambda:InvokeFunction']),
    'Custom::TlsCertReplication': (_, r) => on(resolve(r.Properties.ServiceToken), ['lambda:InvokeFunction']),
    // ---- gateway browser path (#103) ----
    'Custom::GatewayBrowserEniWait': (_, r) => on(resolve(r.Properties.ServiceToken), ['lambda:InvokeFunction']),
    'AWS::EC2::SecurityGroupEgress': () => onAny(['ec2:AuthorizeSecurityGroupEgress', 'ec2:RevokeSecurityGroupEgress',
      'ec2:UpdateSecurityGroupRuleDescriptionsEgress', 'ec2:DescribeSecurityGroupRules']),
    'AWS::CloudFront::VpcOrigin': id => [
      ...on(arn(id), ['cloudfront:CreateVpcOrigin', 'cloudfront:GetVpcOrigin', 'cloudfront:UpdateVpcOrigin',
        'cloudfront:DeleteVpcOrigin', 'cloudfront:TagResource', 'cloudfront:UntagResource', 'cloudfront:ListTagsForResource']),
      ...onAny(['ec2:DescribeInstances', 'ec2:DescribeInternetGateways', 'elasticloadbalancing:DescribeLoadBalancers']),
      ['iam:CreateServiceLinkedRole', `arn:aws:iam::${ACCOUNT}:role/aws-service-role/vpcorigin.cloudfront.amazonaws.com/x`,
        { 'iam:AWSServiceName': 'vpcorigin.cloudfront.amazonaws.com' }],
      ['sts:AssumeRole', `arn:aws:iam::${ACCOUNT}:role/aws-service-role/vpcorigin.cloudfront.amazonaws.com/AWSServiceRoleForCloudFrontVPCOrigin`],
    ],
    'AWS::CloudFront::Function': id => on(arn(id), ['cloudfront:CreateFunction', 'cloudfront:PublishFunction',
      'cloudfront:DescribeFunction', 'cloudfront:GetFunction', 'cloudfront:UpdateFunction', 'cloudfront:DeleteFunction',
      'cloudfront:TagResource', 'cloudfront:UntagResource', 'cloudfront:ListTagsForResource']),
    'AWS::CloudFront::Distribution': (id, r) => {
      const behavior = r.Properties.DistributionConfig.DefaultCacheBehavior;
      const vpcOrigins = r.Properties.DistributionConfig.Origins
        .filter((o: any) => o.VpcOriginConfig).map((o: any) => arn(o.VpcOriginConfig.VpcOriginId.Ref));
      return [
        ...on(arn(id), ['cloudfront:CreateDistribution', 'cloudfront:CreateDistributionWithTags', 'cloudfront:GetDistribution',
          'cloudfront:GetDistributionConfig', 'cloudfront:UpdateDistribution', 'cloudfront:DeleteDistribution',
          'cloudfront:TagResource', 'cloudfront:UntagResource', 'cloudfront:ListTagsForResource']),
        ...vpcOrigins.flatMap((o: string) => on(o, ['cloudfront:GetVpcOrigin'])),
        ['cloudfront:GetCachePolicy', `arn:aws:cloudfront::${ACCOUNT}:cache-policy/${behavior.CachePolicyId}`],
        ['cloudfront:GetOriginRequestPolicy', `arn:aws:cloudfront::${ACCOUNT}:origin-request-policy/${behavior.OriginRequestPolicyId}`],
        ['cloudfront:GetResponseHeadersPolicy',
          `arn:aws:cloudfront::${ACCOUNT}:response-headers-policy/${behavior.ResponseHeadersPolicyId}`],
      ];
    },
    'AWS::CertificateManager::Certificate': (id, r) => {
      const domain = resolve(r.Properties.DomainName) as string;
      const zone = resolve(r.Properties.DomainValidationOptions[0].HostedZoneId);
      return [
        ['acm:RequestCertificate', '*', { 'acm:DomainNames': [domain] }],
        ...on(arn(id), ['acm:DescribeCertificate', 'acm:AddTagsToCertificate', 'acm:RemoveTagsFromCertificate',
          'acm:ListTagsForCertificate', 'acm:UpdateCertificateOptions', 'acm:DeleteCertificate']),
        // CloudFormation writes the DNS validation record.
        ['route53:ChangeResourceRecordSets', `arn:aws:route53:::hostedzone/${zone}`, {
          'route53:ChangeResourceRecordSetsNormalizedRecordNames': [`_0a1b2c3d.${domain}`.toLowerCase()],
          'route53:ChangeResourceRecordSetsRecordTypes': ['CNAME'],
        }],
        ['route53:GetChange', 'arn:aws:route53:::change/C0EXAMPLE'],
      ];
    },
    'AWS::Route53::RecordSet': (_, r) => {
      const zone = `arn:aws:route53:::hostedzone/${resolve(r.Properties.HostedZoneId)}`;
      return [
        ['route53:ListHostedZones', '*'],
        ...on(zone, ['route53:GetHostedZone', 'route53:ListResourceRecordSets']),
        ['route53:ChangeResourceRecordSets', zone, {
          'route53:ChangeResourceRecordSetsNormalizedRecordNames': [(resolve(r.Properties.Name) as string).toLowerCase().replace(/\.$/, '')],
          'route53:ChangeResourceRecordSetsRecordTypes': [r.Properties.Type],
        }],
        ['route53:GetChange', 'arn:aws:route53:::change/C0EXAMPLE'],
      ];
    },
  };
}

/** The four AWS managed policies' actions (Nov 2026), which the boundary must cover. */
const MANAGED_POLICY_ACTIONS: Record<string, string[]> = {
  'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore': ['ssm:DescribeAssociation',
    'ssm:GetDeployablePatchSnapshotForInstance', 'ssm:GetDocument', 'ssm:DescribeDocument', 'ssm:GetManifest',
    'ssm:GetParameter', 'ssm:GetParameters', 'ssm:ListAssociations', 'ssm:ListInstanceAssociations', 'ssm:PutInventory',
    'ssm:PutComplianceItems', 'ssm:PutConfigurePackageResult', 'ssm:UpdateAssociationStatus',
    'ssm:UpdateInstanceAssociationStatus', 'ssm:UpdateInstanceInformation', 'ssmmessages:CreateControlChannel',
    'ssmmessages:CreateDataChannel', 'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel',
    'ec2messages:AcknowledgeMessage', 'ec2messages:DeleteMessage', 'ec2messages:FailMessage', 'ec2messages:GetEndpoint',
    'ec2messages:GetMessages', 'ec2messages:SendReply'],
  'arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy': ['cloudwatch:PutMetricData', 'cloudwatch:PutProfileRecords',
    'ec2:DescribeVolumes', 'ec2:DescribeTags', 'logs:PutLogEvents', 'logs:PutRetentionPolicy', 'logs:DescribeLogStreams',
    'logs:DescribeLogGroups', 'logs:CreateLogStream', 'logs:CreateLogGroup', 'xray:PutTraceSegments',
    'xray:PutTelemetryRecords', 'xray:GetSamplingRules', 'xray:GetSamplingTargets', 'xray:GetSamplingStatisticSummaries'],
  'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole': ['logs:CreateLogGroup', 'logs:CreateLogStream',
    'logs:PutLogEvents'],
  'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole': ['logs:CreateLogGroup', 'logs:CreateLogStream',
    'logs:PutLogEvents', 'ec2:CreateNetworkInterface', 'ec2:DescribeNetworkInterfaces', 'ec2:DescribeSubnets',
    'ec2:DeleteNetworkInterface', 'ec2:AssignPrivateIpAddresses', 'ec2:UnassignPrivateIpAddresses'],
};

/** Region an AWS request for `resource` goes to. */
function requestRegion(action: string, resource: string, hubRegion: string): string {
  // Global services' calls count as us-east-1.
  if (/^(iam|cloudfront|route53|sts):/.test(action)) return 'us-east-1';
  return resource.split(':')[3] || hubRegion;
}

describe.each(VARIANTS)('regional hub IAM ($productName, $region)', (v) => {
  const names: RegionalHubIamNames = {
    account: ACCOUNT, primaryRegion: PRIMARY, productName: v.productName, acronym: v.acronym, dynamoDbKmsKeyArn: KMS_KEY,
  };
  const cfnParts = regionalHubCfnPolicyDocuments(names);
  const cfnServices = render(cfnParts.services);
  const cfnIam = render(cfnParts.iam);
  const cfnEdge = render(cfnParts.edge);
  // The role has both policies, so they're evaluated together.
  const cfn = { Statement: [...cfnServices.Statement, ...cfnIam.Statement, ...cfnEdge.Statement] };
  const boundary = render(regionalHubBoundaryDocument(names));
  const boundaryArn = `arn:aws:iam::${ACCOUNT}:policy/${v.productName}-RegionalHub-Boundary`;
  const template = generate(v);
  const resources = Object.entries(template.Resources) as [string, any][];
  const calls = cfnCalls(template, v);
  const { resolve } = resolver(template, v);

  it('knows every resource type in the hub template', () => {
    const unknown = [...new Set(resources.map(([, r]) => r.Type))].filter(t => !calls[t]);
    // Add the type to CFN_CALLS (cfnCalls) and the CFN policy in lib/regional-hub-iam.ts.
    expect(unknown).toEqual([]);
  });

  it('lets CloudFormation create, update and delete every hub resource', () => {
    const denied: string[] = [];
    for (const [id, r] of resources) {
      for (const [action, resource, ctx] of calls[r.Type](id, r)) {
        const full = { 'aws:RequestedRegion': requestRegion(action, resource, v.region), ...ctx };
        if (!allowed(cfn, action, resource, full)) denied.push(`${id}: ${action} on ${resource}`);
      }
    }
    expect(denied).toEqual([]);
  });

  it('lets CloudFormation resolve the public AMI parameters', () => {
    const refs = [...JSON.stringify(template).matchAll(/\{\{resolve:ssm:([^}]+)\}\}/g)].map(m => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const p of refs) {
      expect(allowed(cfn, 'ssm:GetParameters', `arn:aws:ssm:${v.region}::parameter${p}`,
        { 'aws:RequestedRegion': v.region })).toBe(true);
    }
  });

  it('puts the boundary on every hub role', () => {
    const roles = resources.filter(([, r]) => r.Type === 'AWS::IAM::Role');
    expect(roles.length).toBeGreaterThan(0);
    for (const [, r] of roles) expect(resolve(r.Properties.PermissionsBoundary)).toBe(boundaryArn);
  });

  it('only attaches managed policies the CFN policy and boundary allow', () => {
    for (const [, r] of resources.filter(([, x]) => x.Type === 'AWS::IAM::Role')) {
      for (const p of resolve(r.Properties.ManagedPolicyArns || [])) expect(HUB_MANAGED_POLICY_ARNS).toContain(p);
    }
  });

  it('has a boundary that covers what each hub role grants', () => {
    const outside: string[] = [];
    for (const [id, r] of resources.filter(([, x]) => x.Type === 'AWS::IAM::Role')) {
      for (const policy of resolve(r.Properties.Policies || [])) {
        for (const s of policy.PolicyDocument.Statement) {
          if (s.Effect !== 'Allow') continue;
          for (const action of list(s.Action)) {
            for (const resource of list(s.Resource)) {
              const ctx = { 'aws:RequestedRegion': requestRegion(action, resource, v.region), ...(s.Condition ? {
                'iam:AWSServiceName': s.Condition.StringEquals['iam:AWSServiceName'] } : {}) };
              if (!allowed(boundary, action, resource, ctx)) outside.push(`${id}: ${action} on ${resource}`);
            }
          }
        }
      }
      for (const p of resolve(r.Properties.ManagedPolicyArns || [])) {
        for (const action of MANAGED_POLICY_ACTIONS[p]) {
          if (!allowed(boundary, action, '*', { 'aws:RequestedRegion': v.region })) outside.push(`${id}: ${p} ${action}`);
        }
      }
    }
    expect(outside).toEqual([]);
  });

  it('can only create or grant a hub role that has the boundary', () => {
    const role = `arn:aws:iam::${ACCOUNT}:role/${v.productName}-Regional-Workstation-Role-x`;
    const other = `arn:aws:iam::${ACCOUNT}:policy/Other`;
    for (const action of ['iam:CreateRole', 'iam:PutRolePolicy', 'iam:PutRolePermissionsBoundary', 'iam:AttachRolePolicy']) {
      expect(allowed(cfn, action, role, {})).toBe(false);
      expect(allowed(cfn, action, role, { 'iam:PermissionsBoundary': other })).toBe(false);
    }
    expect(allowed(cfn, 'iam:AttachRolePolicy', role, {
      'iam:PermissionsBoundary': boundaryArn, 'iam:PolicyARN': 'arn:aws:iam::aws:policy/AdministratorAccess',
    })).toBe(false);
    expect(allowed(cfn, 'iam:DeleteRolePermissionsBoundary', role, {})).toBe(false);
  });

  it("can't change its own role, the policies or the primary stack's roles", () => {
    const ctx = { 'iam:PermissionsBoundary': boundaryArn };
    const protectedRoles = [
      `arn:aws:iam::${ACCOUNT}:role/${v.productName}-RegionalHub-CFN-Role`,
      `arn:aws:iam::${ACCOUNT}:role/${v.acronym}-Regional-Hub-CreateRegionalHubCfnFunctionServic-ABC123`,
    ];
    for (const role of protectedRoles) {
      for (const action of ['iam:PutRolePolicy', 'iam:AttachRolePolicy', 'iam:UpdateAssumeRolePolicy', 'iam:DeleteRole',
        'iam:DeleteRolePolicy', 'iam:PassRole', 'iam:TagRole']) {
        expect(`${action} ${role} ${allowed(cfn, action, role, ctx)}`).toBe(`${action} ${role} false`);
      }
    }
    for (const policy of ['Boundary', 'CFN-Policy']) {
      for (const action of ['iam:CreatePolicyVersion', 'iam:SetDefaultPolicyVersion', 'iam:DeletePolicy']) {
        expect(allowed(cfn, action, `arn:aws:iam::${ACCOUNT}:policy/${v.productName}-RegionalHub-${policy}`)).toBe(false);
      }
    }
  });

  it('does nothing in the primary region except IAM', () => {
    const ctx = { 'aws:RequestedRegion': PRIMARY };
    expect(allowed(cfn, 'ec2:CreateVpc', '*', ctx)).toBe(false);
    expect(allowed(cfn, 'lambda:UpdateFunctionCode', `arn:aws:lambda:${PRIMARY}:${ACCOUNT}:function:${v.acronym.toLowerCase()}-regional-x`, ctx)).toBe(false);
    expect(allowed(cfn, 'ssm:UpdateDocument', `arn:aws:ssm:${PRIMARY}:${ACCOUNT}:document/${v.productName}-Windows-DCV-Install`, ctx)).toBe(false);
    expect(allowed(cfn, 'iam:GetRole', `arn:aws:iam::${ACCOUNT}:role/${v.productName}-Regional-Workstation-Role`, ctx)).toBe(true);
  });

  it('caps hub roles below admin', () => {
    const hub = { 'aws:RequestedRegion': v.region };
    expect(allowed(boundary, 'ssm:SendCommand', '*', hub)).toBe(false);
    expect(allowed(boundary, 'iam:PutRolePolicy', '*', hub)).toBe(false);
    expect(allowed(boundary, 'iam:CreateRole', '*', hub)).toBe(false);
    expect(allowed(boundary, 's3:GetObject', `arn:aws:s3:::any-bucket/x`, hub)).toBe(false);
    expect(allowed(boundary, 'secretsmanager:GetSecretValue',
      `arn:aws:secretsmanager:${PRIMARY}:${ACCOUNT}:secret:/${v.productName}/Identity/x`, { 'aws:RequestedRegion': PRIMARY })).toBe(false);
    expect(allowed(boundary, 'dynamodb:DeleteTable', `arn:aws:dynamodb:${PRIMARY}:${ACCOUNT}:table/x`,
      { 'aws:RequestedRegion': PRIMARY })).toBe(false);
    expect(allowed(boundary, 'dynamodb:Scan', `arn:aws:dynamodb:${PRIMARY}:${ACCOUNT}:table/users`,
      { 'aws:RequestedRegion': PRIMARY })).toBe(false);
  });

  it('limits the gateway browser path to hub names, outside the primary Region', () => {
    const global = { 'aws:RequestedRegion': 'us-east-1' };
    const zone = 'arn:aws:route53:::hostedzone/Z0EXAMPLE0ZONE0ID';
    const records = (names: string[], types = ['A']) => ({ ...global,
      'route53:ChangeResourceRecordSetsNormalizedRecordNames': names, 'route53:ChangeResourceRecordSetsRecordTypes': types });
    const ac = v.acronym.toLowerCase();
    const hubCode = v.region.replace(/-/g, '');
    // CloudFront and Route 53 calls count as us-east-1, the primary Region here.
    expect(allowed(cfn, 'cloudfront:CreateDistributionWithTags', `arn:aws:cloudfront::${ACCOUNT}:distribution/E1`, global)).toBe(true);
    expect(allowed(cfn, 'cloudfront:UpdateFunction', `arn:aws:cloudfront::${ACCOUNT}:function/${ac}-gateway-cors-${hubCode}`, global)).toBe(true);
    expect(allowed(cfn, 'cloudfront:UpdateFunction', `arn:aws:cloudfront::${ACCOUNT}:function/${ac}-gateway-cors-useast1`, global)).toBe(false);
    expect(allowed(cfn, 'cloudfront:UpdateFunction', `arn:aws:cloudfront::${ACCOUNT}:function/other`, global)).toBe(false);
    expect(allowed(cfn, 'route53:ChangeResourceRecordSets', zone,
      records([`dcv-gateway-origin.${v.region}.example.com`]))).toBe(true);
    expect(allowed(cfn, 'route53:ChangeResourceRecordSets', zone,
      records([`_0a1b.dcv-gateway-origin.${v.region}.example.com`], ['CNAME']))).toBe(true);
    expect(allowed(cfn, 'route53:ChangeResourceRecordSets', zone, records(['www.example.com']))).toBe(false);
    expect(allowed(cfn, 'route53:ChangeResourceRecordSets', zone,
      records([`dcv-gateway-origin.${v.region}.example.com`, 'www.example.com']))).toBe(false);
    expect(allowed(cfn, 'route53:ChangeResourceRecordSets', zone,
      records([`dcv-gateway-origin.${v.region}.example.com`], ['TXT']))).toBe(false);
    expect(allowed(cfn, 'route53:ChangeResourceRecordSets', zone,
      records([`dcv-gateway-origin.${PRIMARY}.example.com`]))).toBe(false);
    expect(allowed(cfn, 'route53:ChangeResourceRecordSets', zone,
      records([`_0a1b.dcv-gateway-origin.${PRIMARY}.example.com`], ['CNAME']))).toBe(false);
    // ACM in the hub Region only, for the origin name only.
    const hub = { 'aws:RequestedRegion': v.region };
    expect(allowed(cfn, 'acm:RequestCertificate', '*', { ...hub, 'acm:DomainNames': [`dcv-gateway-origin.${v.region}.example.com`] })).toBe(true);
    expect(allowed(cfn, 'acm:RequestCertificate', '*', { ...hub, 'acm:DomainNames': ['www.example.com'] })).toBe(false);
    expect(allowed(cfn, 'acm:RequestCertificate', '*',
      { 'aws:RequestedRegion': PRIMARY, 'acm:DomainNames': [`dcv-gateway-origin.${PRIMARY}.example.com`] })).toBe(false);
    // sts:AssumeRole only on CloudFront's VPC origin service-linked role.
    expect(allowed(cfn, 'sts:AssumeRole', `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-deploy-role-${ACCOUNT}-${PRIMARY}`, global)).toBe(false);
    expect(allowed(cfn, 'iam:CreateServiceLinkedRole', `arn:aws:iam::${ACCOUNT}:role/aws-service-role/x`,
      { 'iam:AWSServiceName': 'vpcorigin.cloudfront.amazonaws.com' })).toBe(true);
  });

  it('fits each managed policy in the 6,144-character limit', () => {
    for (const doc of [cfnServices, cfnIam, cfnEdge, boundary]) expect(JSON.stringify(doc).length).toBeLessThanOrEqual(6144);
  });
});

describe('RegionalHubStack CFN role', () => {
  it('uses the scoped policy instead of AdministratorAccess and creates the boundary', () => {
    const app = new cdk.App();
    const env = { account: ACCOUNT, region: PRIMARY };
    const tables = new cdk.Stack(app, 'Tables', { env });
    const table = (id: string) => new dynamodb.Table(tables, id, {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
    });
    const stack = new RegionalHubStack(app, 'Hub', {
      env, regionalHubsTable: table('Hubs'), amiTable: table('Amis'), workstationTable: table('Workstations'),
      pascalCaseName: 'MediaResourceManager', acronym: 'MRM',
    });
    const t = Template.fromStack(stack);
    expect(JSON.stringify(t.toJSON())).not.toContain('AdministratorAccess');
    t.hasResourceProperties('AWS::IAM::ManagedPolicy', { ManagedPolicyName: 'MediaResourceManager-RegionalHub-Boundary' });
    const idOf = (name: string) => {
      const [id] = Object.keys(t.findResources('AWS::IAM::ManagedPolicy', { Properties: { ManagedPolicyName: name } }));
      expect(id).toBeDefined();
      return id;
    };
    t.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'MediaResourceManager-RegionalHub-CFN-Role',
      ManagedPolicyArns: [
        { Ref: idOf('MediaResourceManager-RegionalHub-CFN-Policy') },
        { Ref: idOf('MediaResourceManager-RegionalHub-CFN-IAM-Policy') },
        { Ref: idOf('MediaResourceManager-RegionalHub-CFN-Edge-Policy') },
      ],
    });
  });
});
