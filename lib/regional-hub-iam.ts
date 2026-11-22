// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * IAM policies for regional hub stacks (issue #62).
 *
 * - The CFN policy is what CloudFormation may do with the RegionalHub CFN
 *   service role when it creates, updates or deletes a hub stack.
 * - The boundary is the permissions boundary every hub IAM role must carry.
 *   It caps a hub role at what hub roles use today, so the CFN role can't
 *   create a role with more access than that, whatever the template says.
 *
 * Hub resource names come from lambda/generate-regional-hub-template. When a
 * hub template adds a resource type or a name pattern, update these policies;
 * test/regional-hub-iam.test.ts fails until they cover it.
 */

import * as iam from 'aws-cdk-lib/aws-iam';

export interface RegionalHubIamNames {
  account: string;
  /** The primary region. Hubs are never deployed here. */
  primaryRegion: string;
  /** PascalCase product name, the hub template's ProductName parameter. */
  productName: string;
  /** Acronym, the hub template's Acronym parameter. */
  acronym: string;
  /** KMS key that encrypts the primary region's DynamoDB tables, if any. */
  dynamoDbKmsKeyArn?: string;
}

/** AWS managed policies that hub roles attach. */
export const HUB_MANAGED_POLICY_ARNS = [
  'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
  'arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy',
  'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
  'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
];

export function boundaryPolicyName(productName: string): string {
  return `${productName}-RegionalHub-Boundary`;
}

/** The CFN policy is two managed policies, since one can't pass 6,144 characters. */
export function cfnPolicyName(productName: string): string {
  return `${productName}-RegionalHub-CFN-Policy`;
}

export function cfnIamPolicyName(productName: string): string {
  return `${productName}-RegionalHub-CFN-IAM-Policy`;
}

export function cfnRoleName(productName: string): string {
  return `${productName}-RegionalHub-CFN-Role`;
}

function allow(sid: string, actions: string[], resources: string[], conditions?: Record<string, unknown>) {
  return new iam.PolicyStatement({ sid, effect: iam.Effect.ALLOW, actions, resources, conditions });
}

function deny(sid: string, actions: string[], resources: string[], conditions?: Record<string, unknown>) {
  return new iam.PolicyStatement({ sid, effect: iam.Effect.DENY, actions, resources, conditions });
}

/**
 * Policies for the CloudFormation service role that deploys hub stacks:
 * `services` (cfnPolicyName) for everything but IAM, `iam` (cfnIamPolicyName)
 * for hub roles and instance profiles.
 */
export function regionalHubCfnPolicyDocuments(n: RegionalHubIamNames): { services: iam.PolicyDocument; iam: iam.PolicyDocument } {
  return { services: cfnServicesDocument(n), iam: cfnIamDocument(n) };
}

function cfnServicesDocument(n: RegionalHubIamNames): iam.PolicyDocument {
  const { account, primaryRegion, productName: pn, acronym } = n;
  const ac = acronym.toLowerCase();
  return new iam.PolicyDocument({
    statements: [
      allow('Read', [
        'autoscaling:Describe*', 'ec2:Describe*', 'ec2:Get*', 'elasticloadbalancing:Describe*', 'iam:GetAccountSummary',
        'lambda:GetAccountSettings', 'license-manager:GetLicenseConfiguration', 'license-manager:ListLicenseConfigurations',
        'logs:Describe*', 's3:ListAllMyBuckets', 'ssm:DescribeParameters',
      ], ['*']),
      // EC2 networking and launch templates can't be scoped by name.
      // RunInstances: Auto Scaling validates a launch template with a dry run.
      allow('Ec2', [
        'ec2:AllocateAddress', 'ec2:AssociateAddress', 'ec2:AssociateRouteTable', 'ec2:AttachInternetGateway',
        'ec2:AuthorizeSecurityGroupEgress', 'ec2:AuthorizeSecurityGroupIngress', 'ec2:CreateInternetGateway',
        'ec2:CreateLaunchTemplate', 'ec2:CreateLaunchTemplateVersion', 'ec2:CreateNatGateway', 'ec2:CreateRoute',
        'ec2:CreateRouteTable', 'ec2:CreateSecurityGroup', 'ec2:CreateSubnet', 'ec2:CreateTags', 'ec2:CreateVpc',
        'ec2:CreateVpcEndpoint', 'ec2:DeleteInternetGateway', 'ec2:DeleteLaunchTemplate', 'ec2:DeleteLaunchTemplateVersions',
        'ec2:DeleteNatGateway', 'ec2:DeleteRoute', 'ec2:DeleteRouteTable', 'ec2:DeleteSecurityGroup', 'ec2:DeleteSubnet',
        'ec2:DeleteTags', 'ec2:DeleteVpc', 'ec2:DeleteVpcEndpoints', 'ec2:DetachInternetGateway', 'ec2:DisassociateAddress',
        'ec2:DisassociateRouteTable', 'ec2:ModifyLaunchTemplate', 'ec2:ModifySecurityGroupRules', 'ec2:ModifySubnetAttribute',
        'ec2:ModifySecurityGroupAttribute', 'ec2:ModifyVpcAttribute', 'ec2:ModifyVpcEndpoint', 'ec2:ReleaseAddress',
        'ec2:ReplaceRoute', 'ec2:ReplaceRouteTableAssociation', 'ec2:ResetSecurityGroupAttribute',
        'ec2:RevokeSecurityGroupEgress', 'ec2:RevokeSecurityGroupIngress',
        'ec2:RunInstances', 'ec2:UpdateSecurityGroupRuleDescriptionsEgress', 'ec2:UpdateSecurityGroupRuleDescriptionsIngress',
      ], ['*']),
      allow('HubResources', [
        'autoscaling:*', 'elasticloadbalancing:*', 'events:*', 'lambda:*', 'logs:*', 'resource-groups:*', 's3:*',
      ], [
        `arn:aws:autoscaling:*:${account}:autoScalingGroup:*:autoScalingGroupName/${pn}-Regional-*`,
        `arn:aws:elasticloadbalancing:*:${account}:*/${ac}-reg-*`,
        `arn:aws:events:*:${account}:rule/${acronym}-regional-*`,
        `arn:aws:lambda:*:${account}:function:${ac}-regional-*`,
        `arn:aws:lambda:*:${account}:function:${pn}-Regional-*`,
        `arn:aws:logs:*:${account}:log-group:/aws/datasync/${acronym}`,
        `arn:aws:logs:*:${account}:log-group:/aws/datasync/${acronym}:*`,
        `arn:aws:resource-groups:*:${account}:group/${pn}-*`,
        `arn:aws:s3:::${ac}-regional-nlb-logs-${account}-*`,
        `arn:aws:s3:::${ac}-regional-nlb-logs-${account}-*/*`,
      ]),
      // Logs resource policies are per account and region, not per resource.
      allow('LogsResourcePolicy', ['logs:DeleteResourcePolicy', 'logs:PutResourcePolicy'], ['*']),
      // Lambda reads the hub function code with the caller's credentials.
      allow('LambdaCode', ['s3:GetObject', 's3:GetObjectVersion'], [`arn:aws:s3:::${ac}-lambda-assets-${account}-*/*`]),
      allow('Ssm', [
        'ssm:AddTagsToResource', 'ssm:CreateDocument', 'ssm:DeleteDocument', 'ssm:DeleteParameter', 'ssm:DescribeDocument',
        'ssm:GetDocument', 'ssm:GetParameter', 'ssm:GetParameters', 'ssm:ListTagsForResource', 'ssm:PutParameter',
        'ssm:RemoveTagsFromResource', 'ssm:UpdateDocument', 'ssm:UpdateDocumentDefaultVersion',
      ], [`arn:aws:ssm:*:${account}:document/${pn}-*`, `arn:aws:ssm:*:${account}:parameter/${pn}/*`]),
      // Public AMI parameters that launch templates resolve.
      allow('SsmPublicParameters', ['ssm:GetParameter', 'ssm:GetParameters'], ['arn:aws:ssm:*::parameter/aws/service/*']),
      // A hub is never in the primary region. IAM is global, so it's left out.
      new iam.PolicyStatement({
        sid: 'DenyPrimaryRegion',
        effect: iam.Effect.DENY,
        notActions: ['iam:*'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:RequestedRegion': primaryRegion } },
      }),
    ],
  });
}

function cfnIamDocument(n: RegionalHubIamNames): iam.PolicyDocument {
  const { account, productName: pn, acronym } = n;
  const boundaryArn = `arn:aws:iam::${account}:policy/${boundaryPolicyName(pn)}`;
  // Hub role and instance profile names: `<ProductName>-Regional-*`, or
  // `<Acronym>-Regional-*` when the name would pass 64 characters.
  const hubRoles = [`arn:aws:iam::${account}:role/${pn}-Regional-*`, `arn:aws:iam::${account}:role/${acronym}-Regional-*`];
  const hubProfiles = [
    `arn:aws:iam::${account}:instance-profile/${pn}-Regional-*`,
    `arn:aws:iam::${account}:instance-profile/${acronym}-Regional-*`,
  ];
  // The primary MRM-Regional-Hub stack's own roles are named by CDK
  // (`<Acronym>-Regional-Hub-*`), so they match the hub pattern above.
  // They, and the CFN role itself, are denied explicitly.
  const primaryIam = [
    `arn:aws:iam::${account}:role/${cfnRoleName(pn)}`,
    `arn:aws:iam::${account}:role/${acronym}-Regional-Hub-*`,
    `arn:aws:iam::${account}:instance-profile/${acronym}-Regional-Hub-*`,
  ];
  const iamWrites = ['iam:Add*', 'iam:Attach*', 'iam:Create*', 'iam:Delete*', 'iam:Detach*', 'iam:PassRole',
    'iam:Put*', 'iam:Remove*', 'iam:Tag*', 'iam:Untag*', 'iam:Update*'];
  return new iam.PolicyDocument({
    statements: [
      allow('IamRead', [
        'iam:GetInstanceProfile', 'iam:GetRole', 'iam:GetRolePolicy', 'iam:ListAttachedRolePolicies',
        'iam:ListInstanceProfilesForRole', 'iam:ListRolePolicies', 'iam:ListRoleTags',
      ], [...hubRoles, ...hubProfiles]),
      // Granting a hub role access needs the boundary on the role.
      allow('IamBoundedRoleWrites', ['iam:CreateRole', 'iam:PutRolePermissionsBoundary', 'iam:PutRolePolicy'], hubRoles, {
        StringEquals: { 'iam:PermissionsBoundary': boundaryArn },
      }),
      allow('IamBoundedAttach', ['iam:AttachRolePolicy'], hubRoles, {
        StringEquals: { 'iam:PermissionsBoundary': boundaryArn },
        ArnEquals: { 'iam:PolicyARN': HUB_MANAGED_POLICY_ARNS },
      }),
      allow('IamRoleWrites', [
        'iam:DeleteRole', 'iam:DeleteRolePolicy', 'iam:DetachRolePolicy', 'iam:TagRole', 'iam:UntagRole',
        'iam:UpdateAssumeRolePolicy', 'iam:UpdateRole', 'iam:UpdateRoleDescription',
      ], hubRoles),
      allow('IamInstanceProfiles', [
        'iam:AddRoleToInstanceProfile', 'iam:CreateInstanceProfile', 'iam:DeleteInstanceProfile',
        'iam:RemoveRoleFromInstanceProfile', 'iam:TagInstanceProfile', 'iam:UntagInstanceProfile',
      ], hubProfiles),
      // IfExists: AddRoleToInstanceProfile checks PassRole too.
      allow('IamPassHubRoles', ['iam:PassRole'], hubRoles, {
        StringEqualsIfExists: { 'iam:PassedToService': ['ec2.amazonaws.com', 'lambda.amazonaws.com'] },
      }),
      allow('IamServiceLinkedRoles', ['iam:CreateServiceLinkedRole'], ['arn:aws:iam::*:role/aws-service-role/*'], {
        StringEquals: { 'iam:AWSServiceName': ['autoscaling.amazonaws.com', 'elasticloadbalancing.amazonaws.com'] },
      }),
      deny('DenyBoundaryRemoval', ['iam:DeleteRolePermissionsBoundary', 'iam:DeleteUserPermissionsBoundary'], ['*']),
      deny('DenyPolicyChanges', [
        'iam:CreatePolicyVersion', 'iam:DeletePolicy', 'iam:DeletePolicyVersion', 'iam:SetDefaultPolicyVersion',
      ], [`arn:aws:iam::${account}:policy/${pn}-RegionalHub-*`]),
      deny('DenyPrimaryIamChanges', iamWrites, primaryIam),
    ],
  });
}

/** Permissions boundary for every IAM role in a hub stack. */
export function regionalHubBoundaryDocument(n: RegionalHubIamNames): iam.PolicyDocument {
  const { account, primaryRegion, productName: pn, acronym } = n;
  const ac = acronym.toLowerCase();
  const secret = (p: string) => `arn:aws:secretsmanager:*:${account}:secret:/${pn}/${p}/*`;
  const statements = [
    // The AWS managed policies hub roles attach (SSM agent, CloudWatch agent,
    // Lambda logging and VPC access), plus the read and agent calls the hub
    // roles' own policies make. No ssm:SendCommand and no IAM writes.
    allow('AgentsAndReads', [
      'cloudwatch:PutMetricData', 'cloudwatch:PutProfileRecords',
      'ec2:AssignPrivateIpAddresses', 'ec2:CreateNetworkInterface', 'ec2:DeleteNetworkInterface', 'ec2:Describe*',
      'ec2:UnassignPrivateIpAddresses', 'ec2messages:*', 'fsx:DescribeStorageVirtualMachines',
      'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:DescribeLogGroups', 'logs:DescribeLogStreams',
      'logs:PutLogEvents', 'logs:PutRetentionPolicy',
      'ssm:DescribeAssociation', 'ssm:DescribeDocument', 'ssm:DescribeParameters', 'ssm:GetDeployablePatchSnapshotForInstance',
      'ssm:GetDocument', 'ssm:GetManifest', 'ssm:GetParameter', 'ssm:GetParameters', 'ssm:ListAssociations',
      'ssm:ListInstanceAssociations', 'ssm:PutComplianceItems', 'ssm:PutConfigurePackageResult', 'ssm:PutInventory',
      'ssm:UpdateAssociationStatus', 'ssm:UpdateInstanceAssociationStatus', 'ssm:UpdateInstanceInformation',
      'ssmmessages:*', 'xray:GetSamplingRules', 'xray:GetSamplingStatisticSummaries', 'xray:GetSamplingTargets',
      'xray:PutTelemetryRecords', 'xray:PutTraceSegments',
    ], ['*']),
    // macOS license configuration (custom resource in the hub).
    allow('LicenseManager', [
      'license-manager:CreateLicenseConfiguration', 'license-manager:DeleteLicenseConfiguration',
      'license-manager:GetLicenseConfiguration', 'license-manager:ListLicenseConfigurations',
      'license-manager:TagResource', 'license-manager:UpdateLicenseConfiguration',
    ], ['*']),
    allow('LicenseManagerServiceLinkedRole', ['iam:CreateServiceLinkedRole'],
      ['arn:aws:iam::*:role/aws-service-role/license-manager.amazonaws.com/*'],
      { StringEquals: { 'iam:AWSServiceName': 'license-manager.amazonaws.com' } }),
    allow('SsmParameterWrites', ['ssm:PutParameter'], [
      `arn:aws:ssm:*:${account}:parameter/${pn}/*`, `arn:aws:ssm:*:${account}:parameter/dcv-broker-*`,
    ]),
    // The DCV Session Manager broker keeps its state in the hub region.
    allow('HubRegionDynamoDb', ['dynamodb:*'], [`arn:aws:dynamodb:*:${account}:*`], {
      StringNotEquals: { 'aws:RequestedRegion': primaryRegion },
    }),
    // Hub Lambdas update the primary region's workstation records.
    allow('PrimaryDynamoDb', ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem'],
      [`arn:aws:dynamodb:${primaryRegion}:${account}:table/*`]),
    allow('PrimaryDynamoDbScan', ['dynamodb:Scan'], [`arn:aws:dynamodb:${primaryRegion}:${account}:table/*workstation*`]),
    allow('ReadSecrets', ['secretsmanager:GetSecretValue'], [
      secret('DCV/ConnectionGateway'), secret('Workstation'), secret('Storage'),
    ]),
    allow('TlsCertificateReplica', [
      'secretsmanager:CreateSecret', 'secretsmanager:DeleteSecret', 'secretsmanager:DescribeSecret',
      'secretsmanager:PutSecretValue', 'secretsmanager:TagResource', 'secretsmanager:UpdateSecret',
    ], [secret('DCV/ConnectionGateway')]),
    allow('StorageSecretUpdate', ['secretsmanager:UpdateSecret'], [secret('Storage')]),
    allow('DcvLicense', ['s3:GetObject'], ['arn:aws:s3:::dcv-license.*/*']),
    allow('EmptyNlbLogsBucket', ['s3:DeleteObject', 's3:DeleteObjectVersion', 's3:ListBucket', 's3:ListBucketVersions'], [
      `arn:aws:s3:::${ac}-regional-nlb-logs-${account}-*`, `arn:aws:s3:::${ac}-regional-nlb-logs-${account}-*/*`,
    ]),
  ];
  if (n.dynamoDbKmsKeyArn) {
    statements.push(allow('DynamoDbKey', ['kms:Decrypt', 'kms:GenerateDataKey'], [n.dynamoDbKmsKeyArn]));
  }
  return new iam.PolicyDocument({ statements });
}
