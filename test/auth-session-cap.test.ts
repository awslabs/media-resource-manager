// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Cognito sign-ins last at most 12 hours, the same cap as AD sign-ins
 * (SESSION_MAX_SECONDS in lambda/ldap-auth).
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AuthConstruct } from '../lib/constructs/auth-construct';

function synthClient() {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'AuthTestStack', { env: { account: '123456789012', region: 'us-east-1' } });
  new AuthConstruct(stack, 'Auth', {
    pascalCaseName: 'MediaResourceManager',
    acronym: 'MRM',
    adminGroupName: 'MRM-Admins',
  });
  const clients = Template.fromStack(stack).findResources('AWS::Cognito::UserPoolClient');
  expect(Object.keys(clients)).toHaveLength(1);
  return Object.values(clients)[0].Properties;
}

describe('Cognito session cap', () => {
  it('expires the refresh token 12 hours (720 minutes) after sign-in', () => {
    const client = synthClient();
    expect(client.RefreshTokenValidity).toBe(720);
    expect(client.TokenValidityUnits).toEqual({ RefreshToken: 'minutes' });
  });

  it('leaves the ID and access tokens at the Cognito default of 1 hour', () => {
    const client = synthClient();
    expect(client.AccessTokenValidity).toBeUndefined();
    expect(client.IdTokenValidity).toBeUndefined();
  });
});
