// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for admin-signal hardening in the JWT authorizer and
 * pre-token-generation trigger.
 *
 * These tests lock in the fix for the self-elevation issue reported by VAPT
 * (icyousse@) during verification of the SIM P498186948 authorization fix:
 * a non-admin user can call UpdateUserAttributes with their own access token
 * to set custom:isAdmin=true (or custom:groups="MRM-Admins", or
 * custom:department="Admin") and then log in with an ID token that our
 * authorizer previously treated as admin.
 *
 * Fix design:
 * 1. UserPoolClient writeAttributes is restricted at the CDK layer so end-user
 *    tokens can no longer mutate custom:* claims via UpdateUserAttributes.
 *    (Enforced by lib/constructs/auth-construct.ts; verified indirectly here
 *    by asserting that the authorizer no longer trusts any claim that CDK
 *    formerly allowed end users to write.)
 * 2. jwt-authorizer.isAdminUser trusts ONLY cognito:groups, not
 *    custom:isAdmin, custom:department, or the raw 'groups' claim.
 * 3. pre-token-generation merges custom:groups into cognito:groups ONLY for
 *    federated (SAML) users; for native Cognito users, custom:groups is
 *    ignored even if it contains a privileged group name.
 *
 * See GHSA-58q4-fcw9-2778.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isAdminUser } = require('../lambda/jwt-authorizer/index.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const preTokenGeneration = require('../lambda/pre-token-generation/index.js');

const ADMIN_GROUP_ENV = process.env.ADMIN_GROUP_NAME;
beforeEach(() => {
  process.env.ADMIN_GROUP_NAME = 'MRM-Admins';
});
afterAll(() => {
  if (ADMIN_GROUP_ENV === undefined) {
    delete process.env.ADMIN_GROUP_NAME;
  } else {
    process.env.ADMIN_GROUP_NAME = ADMIN_GROUP_ENV;
  }
});

describe('isAdminUser: cognito:groups is the sole admin signal', () => {
  it('grants admin when the user is in the configured admin group via cognito:groups', () => {
    expect(isAdminUser({ 'cognito:groups': ['MRM-Admins'] })).toBe(true);
  });

  it('grants admin case-insensitively', () => {
    expect(isAdminUser({ 'cognito:groups': ['mrm-admins'] })).toBe(true);
    expect(isAdminUser({ 'cognito:groups': ['MRM-ADMINS'] })).toBe(true);
  });

  it('accepts comma-separated string form of cognito:groups', () => {
    expect(isAdminUser({ 'cognito:groups': 'MRM-Admins,SomeOtherGroup' })).toBe(true);
  });

  it('accepts multiple admin group names via ADMIN_GROUP_NAME env', () => {
    process.env.ADMIN_GROUP_NAME = 'MRM-Admins,other-admin-group';
    expect(isAdminUser({ 'cognito:groups': ['other-admin-group'] })).toBe(true);
  });

  it('denies admin when cognito:groups is empty', () => {
    expect(isAdminUser({ 'cognito:groups': [] })).toBe(false);
    expect(isAdminUser({ 'cognito:groups': '' })).toBe(false);
    expect(isAdminUser({})).toBe(false);
  });

  it('denies admin when cognito:groups contains only non-admin groups', () => {
    expect(isAdminUser({ 'cognito:groups': ['MRM-Users', 'ReadOnly'] })).toBe(false);
  });
});

describe('isAdminUser: refuses user-writable claims as admin signals', () => {
  // These are the exact self-elevation attack vectors closed by the fix.
  // A pre-fix authorizer trusted custom:isAdmin outright, and fell back to
  // custom:department. After the fix, neither claim influences the outcome.

  it('IGNORES custom:isAdmin=true when user is not in the admin group', () => {
    expect(isAdminUser({
      'cognito:groups': ['MRM-Users'],
      'custom:isAdmin': 'true',
    })).toBe(false);
  });

  it('IGNORES custom:isAdmin=true when no groups are present at all', () => {
    expect(isAdminUser({
      'custom:isAdmin': 'true',
    })).toBe(false);
  });

  it('IGNORES custom:department=Admin fallback', () => {
    expect(isAdminUser({
      'cognito:groups': [],
      'custom:department': 'Admin',
    })).toBe(false);
  });

  it('IGNORES custom:department=IT fallback', () => {
    expect(isAdminUser({
      'cognito:groups': [],
      'custom:department': 'IT',
    })).toBe(false);
  });

  it('IGNORES the raw "groups" claim (non-standard, unauthenticated source)', () => {
    expect(isAdminUser({
      'cognito:groups': [],
      groups: ['MRM-Admins'],
    })).toBe(false);
  });

  it('IGNORES custom:groups when NOT merged into cognito:groups (native-user path)', () => {
    // A native user whose custom:groups was self-written is NOT admin because
    // the pre-token-generation trigger will not merge it (federated-only merge).
    // Even if the merge were bypassed and custom:groups reached the authorizer
    // directly, isAdminUser must not trust it.
    expect(isAdminUser({
      'cognito:groups': [],
      'custom:groups': 'MRM-Admins',
    })).toBe(false);
  });

  it('grants admin when user is in the group AND has custom:isAdmin=true (still admin, but by group, not attribute)', () => {
    // Legitimate admin user with a stale attribute should still be admin,
    // because the group membership is the authoritative signal.
    expect(isAdminUser({
      'cognito:groups': ['MRM-Admins'],
      'custom:isAdmin': 'true',
    })).toBe(true);
  });
});

describe('pre-token-generation: federated-only custom:groups merge', () => {
  function eventFor(userAttributes: Record<string, string>, existingGroups: string[] = []): any {
    return {
      request: {
        userAttributes,
        groupConfiguration: {
          groupsToOverride: existingGroups,
        },
      },
    };
  }

  function claimsFrom(result: any): string[] {
    return result?.response?.claimsOverrideDetails?.groupOverrideDetails?.groupsToOverride ?? [];
  }

  it('federated user: merges custom:groups into cognito:groups', async () => {
    const result = await preTokenGeneration.handler(eventFor({
      identities: '[{"providerName":"Okta","userId":"user@example.com"}]',
      'custom:groups': 'MRM-Admins,Editor',
    }));
    expect(claimsFrom(result).sort()).toEqual(['Editor', 'MRM-Admins'].sort());
  });

  it('federated user: merges JSON-array-formatted custom:groups', async () => {
    const result = await preTokenGeneration.handler(eventFor({
      identities: '[{"providerName":"IdentityCenter","userId":"user@example.com"}]',
      'custom:groups': '["MRM-Admins","Editor"]',
    }));
    expect(claimsFrom(result).sort()).toEqual(['Editor', 'MRM-Admins'].sort());
  });

  it('federated user: preserves existing native Cognito group membership', async () => {
    const result = await preTokenGeneration.handler(eventFor(
      {
        identities: '[{"providerName":"Okta","userId":"user@example.com"}]',
        'custom:groups': 'MRM-Admins',
      },
      ['ExistingNativeGroup']
    ));
    expect(claimsFrom(result).sort()).toEqual(['ExistingNativeGroup', 'MRM-Admins'].sort());
  });

  it('native user: IGNORES custom:groups even when set to a privileged value', async () => {
    // This is the regression test for the self-elevation attack: a native
    // Cognito user with a self-written custom:groups="MRM-Admins" must not
    // end up with MRM-Admins in cognito:groups.
    const result = await preTokenGeneration.handler(eventFor({
      'custom:groups': 'MRM-Admins',
      // No identities attribute → not federated
    }));
    expect(claimsFrom(result)).toEqual([]);
  });

  it('native user: preserves native Cognito group membership even when custom:groups is set', async () => {
    const result = await preTokenGeneration.handler(eventFor(
      { 'custom:groups': 'MRM-Admins' },
      ['MRM-Users']
    ));
    expect(claimsFrom(result)).toEqual(['MRM-Users']);
  });

  it('native user: with no attributes, returns no groups', async () => {
    const result = await preTokenGeneration.handler(eventFor({}));
    expect(claimsFrom(result)).toEqual([]);
  });

  it('federated user with empty identities string is treated as native', async () => {
    // Defensive: an empty identities value should not open the merge path.
    const result = await preTokenGeneration.handler(eventFor({
      identities: '',
      'custom:groups': 'MRM-Admins',
    }));
    expect(claimsFrom(result)).toEqual([]);
  });

  it('deduplicates when custom:groups and existingGroups overlap', async () => {
    const result = await preTokenGeneration.handler(eventFor(
      {
        identities: '[{"providerName":"Okta","userId":"user@example.com"}]',
        'custom:groups': 'MRM-Admins,Editor',
      },
      ['MRM-Admins']
    ));
    expect(claimsFrom(result).sort()).toEqual(['Editor', 'MRM-Admins'].sort());
  });
});
