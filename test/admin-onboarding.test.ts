// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * First sign-in on a new install: admin users are seeded after the real login
 * URL exists (#20), invites carry that URL (#8), and an install with no
 * AdminEmails is warned at synth time (#20).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AuthConstruct, AuthConstructProps } from '../lib/constructs/auth-construct';
import { FrontendStack } from '../lib/frontend-stack';

const env = { account: '123456789012', region: 'us-east-1' };

function synthAuth(props: Partial<AuthConstructProps> = {}) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'AuthTestStack', { env });
  const auth = new AuthConstruct(stack, 'Auth', {
    pascalCaseName: 'MediaResourceManager',
    acronym: 'MRM',
    adminGroupName: 'MRM-Admins',
    ...props,
  });
  return { stack, auth, template: Template.fromStack(stack) };
}

// The Frontend stack deploys the built frontend, which unit tests don't build.
const fakeDist = fs.mkdtempSync(path.join(os.tmpdir(), 'mrm-frontend-dist-'));
fs.writeFileSync(path.join(fakeDist, 'index.html'), '<html></html>');
afterAll(() => fs.rmSync(fakeDist, { recursive: true, force: true }));

function synthFrontend(adminSetup?: { groups: string[]; emails: string[] }) {
  const realAsset = s3deploy.Source.asset;
  jest.spyOn(s3deploy.Source, 'asset').mockImplementation((p, options) =>
    realAsset.call(s3deploy.Source, p === './frontend/dist' ? fakeDist : p, options));
  const app = new cdk.App();
  const stack = new FrontendStack(app, 'FrontendTestStack', {
    env,
    productName: 'Media Resource Manager',
    pascalCaseName: 'MediaResourceManager',
    acronym: 'MRM',
    adminSetup,
  });
  return Template.fromStack(stack);
}

describe('AuthConstruct invite and admin seeding', () => {
  it('invite template has no "check deployment outputs" placeholder', () => {
    const { template } = synthAuth({ adminEmails: 'admin@example.com' });
    const pools = template.findResources('AWS::Cognito::UserPool');
    const [pool] = Object.values(pools);
    const message = pool.Properties.AdminCreateUserConfig.InviteMessageTemplate.EmailMessage;
    expect(message).not.toMatch(/check deployment outputs/i);
    expect(message).toContain('{username}');
    expect(message).toContain('{####}');
  });

  it('adds a CustomMessage trigger and keeps the pre-token-generation trigger', () => {
    const { template } = synthAuth();
    const [pool] = Object.values(template.findResources('AWS::Cognito::UserPool'));
    const functionId = (name: string) => Object.keys(template.findResources('AWS::Lambda::Function', {
      Properties: { FunctionName: name },
    }))[0];
    // Losing PreTokenGeneration would break admin sign-in (it maps admin groups).
    expect(pool.Properties.LambdaConfig).toEqual({
      PreTokenGeneration: { 'Fn::GetAtt': [functionId('mrm-pre-token-generation'), 'Arn'] },
      CustomMessage: { 'Fn::GetAtt': [functionId('mrm-cognito-custom-message'), 'Arn'] },
    });
  });

  it('lets the CustomMessage function read only the Frontend/Url parameter', () => {
    const { template } = synthAuth();
    const functions = template.findResources('AWS::Lambda::Function', {
      Properties: { FunctionName: 'mrm-cognito-custom-message' },
    });
    expect(Object.keys(functions)).toHaveLength(1);
    const role = functions[Object.keys(functions)[0]].Properties.Role['Fn::GetAtt'][0];
    const policies = Object.values(template.findResources('AWS::IAM::Policy'))
      .filter(p => p.Properties.Roles.some((r: { Ref: string }) => r.Ref === role));
    const statements = policies.flatMap(p => p.Properties.PolicyDocument.Statement);
    expect(statements).toEqual([{
      Action: 'ssm:GetParameter',
      Effect: 'Allow',
      Resource: 'arn:aws:ssm:us-east-1:123456789012:parameter/MediaResourceManager/Frontend/Url',
    }]);
  });

  it('no longer seeds admins in the Infrastructure stack', () => {
    const { template, auth } = synthAuth({ adminEmails: 'admin@example.com' });
    expect(template.findResources('AWS::CloudFormation::CustomResource', {
      Properties: { Groups: Match.anyValue() },
    })).toEqual({});
    expect(auth.adminSetup).toEqual({ groups: ['MRM-Admins'], emails: ['admin@example.com'] });
  });

  it('warns at synth time when AdminEmails is empty', () => {
    const { stack } = synthAuth({ adminEmails: '' });
    Annotations.fromStack(stack).hasWarning('/AuthTestStack/Auth', Match.stringLikeRegexp('AdminEmails is empty'));
  });

  it('does not warn when AdminEmails is set', () => {
    const { stack } = synthAuth({ adminEmails: 'admin@example.com' });
    Annotations.fromStack(stack).hasNoWarning('*', Match.stringLikeRegexp('AdminEmails is empty'));
  });

  it('creates no trigger, seeding or warning without Cognito', () => {
    const { stack, auth, template } = synthAuth({ useCognitoAuth: false });
    template.resourceCountIs('AWS::Cognito::UserPool', 0);
    expect(auth.adminSetup).toBeUndefined();
    Annotations.fromStack(stack).hasNoWarning('*', Match.anyValue());
  });
});

describe('FrontendStack AdminSetup', () => {
  afterEach(() => jest.restoreAllMocks());

  it('runs after UpdateFrontendUrlParameter, so invites carry the real URL', () => {
    const template = synthFrontend({ groups: ['MRM-Admins'], emails: ['admin@example.com'] });
    const [urlParameterId] = Object.keys(template.findResources('AWS::CloudFormation::CustomResource', {
      Properties: { CloudFrontUrl: Match.anyValue() },
    }));
    const adminSetup = template.findResources('AWS::CloudFormation::CustomResource', {
      Properties: { Groups: '["MRM-Admins"]', AdminEmails: '["admin@example.com"]' },
    });
    expect(Object.keys(adminSetup)).toHaveLength(1);
    expect(Object.values(adminSetup)[0].DependsOn).toContain(urlParameterId);
  });

  it('reads the User Pool ID from SSM, not a cross-stack export', () => {
    const template = synthFrontend({ groups: ['MRM-Admins'], emails: [] });
    const parameters = template.toJSON().Parameters;
    expect(Object.values(parameters)).toContainEqual(expect.objectContaining({
      Type: 'AWS::SSM::Parameter::Value<String>',
      Default: '/MediaResourceManager/Auth/UserPoolId',
    }));
    expect(JSON.stringify(template.toJSON())).not.toContain('Fn::ImportValue');
  });

  it('outputs the onboarding commands', () => {
    const template = synthFrontend({ groups: ['MRM-Admins'], emails: [] });
    const output = template.findOutputs('AdminOnboardingCommands');
    const value = JSON.stringify(Object.values(output)[0].Value);
    expect(value).toContain('admin-create-user');
    expect(value).toContain('Name=given_name');
    expect(value).toContain('admin-add-user-to-group');
    expect(value).toContain('--group-name MRM-Admins');
  });

  it('creates no AdminSetup without a local User Pool', () => {
    const template = synthFrontend(undefined);
    expect(template.findResources('AWS::CloudFormation::CustomResource', {
      Properties: { Groups: Match.anyValue() },
    })).toEqual({});
    expect(template.findOutputs('AdminOnboardingCommands')).toEqual({});
  });
});
