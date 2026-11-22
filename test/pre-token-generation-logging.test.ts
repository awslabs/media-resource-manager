// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The pre-token-generation trigger logs only the trigger source, the user
 * type, group counts and the error class: no email addresses, usernames,
 * attribute values or group names.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const preTokenTrigger = require('../lambda/pre-token-generation/index.js');

const EMAIL = 'jane.doe@example.com';
const USERNAME = 'okta_jane.doe@example.com';
const SUB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const GROUPS = ['MRM-Admins', 'Editors-Team-Secret'];

function federatedEvent(): any {
  return {
    version: '1',
    triggerSource: 'TokenGeneration_HostedAuth',
    region: 'us-east-1',
    userPoolId: 'us-east-1_EXAMPLE',
    userName: USERNAME,
    callerContext: { awsSdkVersion: 'aws-sdk-unknown-unknown', clientId: 'exampleclientid' },
    request: {
      userAttributes: {
        sub: SUB,
        email: EMAIL,
        email_verified: 'true',
        given_name: 'Jane',
        family_name: 'Doe',
        identities: JSON.stringify([{ providerName: 'Okta', userId: EMAIL }]),
        'custom:groups': JSON.stringify(GROUPS),
      },
      groupConfiguration: { groupsToOverride: ['NativeGroupName'] },
    },
    response: {},
  };
}

let logged: string;
let spies: jest.SpyInstance[];

beforeEach(() => {
  logged = '';
  const capture = (...args: unknown[]) => {
    logged += args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n';
  };
  spies = (['log', 'info', 'warn', 'error', 'debug'] as const)
    .map(level => jest.spyOn(console, level).mockImplementation(capture));
});

afterEach(() => {
  spies.forEach(s => s.mockRestore());
});

function expectNoUserData(text: string) {
  for (const value of [EMAIL, 'jane.doe', USERNAME, SUB, 'Jane', 'Doe', 'Okta', 'NativeGroupName', ...GROUPS]) {
    expect(text).not.toContain(value);
  }
}

describe('pre-token-generation logging', () => {
  it('logs the trigger source and group counts, and no user data', async () => {
    const result = await preTokenTrigger.handler(federatedEvent());
    expect(result.response.claimsOverrideDetails.groupOverrideDetails.groupsToOverride.sort())
      .toEqual(['NativeGroupName', ...GROUPS].sort());

    expect(logged).toContain('TokenGeneration_HostedAuth');
    expect(logged).toContain('"userType":"federated"');
    expect(logged).toContain('"nativeGroupCount":1');
    expect(logged).toContain('"samlGroupCount":2');
    expect(logged).toContain('"groupCount":3');
    expectNoUserData(logged);
  });

  it('logs no user data for a native user', async () => {
    const event = federatedEvent();
    delete event.request.userAttributes.identities;
    event.triggerSource = 'TokenGeneration_Authentication';
    await preTokenTrigger.handler(event);
    expect(logged).toContain('"userType":"native"');
    expect(logged).toContain('"groupCount":1');
    expectNoUserData(logged);
  });

  it('logs only the error class when the event cannot be read, and still fails', async () => {
    const event = federatedEvent();
    delete event.request;
    await expect(preTokenTrigger.handler(event)).rejects.toThrow(TypeError);
    expect(logged).toContain('"errorClass":"TypeError"');
    expect(logged).toContain('TokenGeneration_HostedAuth');
    expectNoUserData(logged);
  });
});
