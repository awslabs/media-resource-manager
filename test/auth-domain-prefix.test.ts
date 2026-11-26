// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The Cognito domain prefix is "<acronym>-<first 8 digits of the account>".
 * Without an account at synth time the account is an unresolved token, and the
 * construct stops with a clear error instead of an invalid prefix (#156). With
 * an account, the prefix is unchanged, so existing installs keep their domain.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AuthConstruct, AuthConstructProps } from '../lib/constructs/auth-construct';

function authIn(env: cdk.Environment | undefined, props: Partial<AuthConstructProps> = {}) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'AuthDomainTestStack', { env });
  new AuthConstruct(stack, 'Auth', {
    pascalCaseName: 'MediaResourceManager',
    acronym: 'MRM',
    adminGroupName: 'MRM-Admins',
    ...props,
  });
  return stack;
}

describe('AuthConstruct Cognito domain prefix', () => {
  it('stops with a clear error when the account is unresolved', () => {
    expect(() => authIn(undefined)).toThrow(
      /The AWS account is unknown, so the Cognito domain prefix cannot be built\..*CDK_DEFAULT_ACCOUNT/);
    expect(() => authIn({ region: 'us-east-1' })).toThrow(/The AWS account is unknown/);
  });

  it('keeps the prefix "<acronym>-<first 8 account digits>" when the account is set', () => {
    const template = Template.fromStack(authIn({ account: '123456789012', region: 'us-east-1' }));
    template.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', { Domain: 'mrm-12345678' });
  });

  it('needs no account when Cognito sign-in is off', () => {
    const stack = authIn(undefined, { useCognitoAuth: false });
    Template.fromStack(stack).resourceCountIs('AWS::Cognito::UserPoolDomain', 0);
  });
});
