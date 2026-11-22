// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the Cognito CustomMessage trigger
 * (lambda/cognito-custom-message), which puts the login URL from SSM into
 * invite emails (#8).
 */
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: mockSend })),
  GetParameterCommand: jest.fn((input) => ({ input })),
}), { virtual: true });

process.env.FRONTEND_URL_PARAM_NAME = '/MediaResourceManager/Frontend/Url';
process.env.PRODUCT_NAME = 'Media Resource Manager';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/cognito-custom-message/index.js');

export {};

function inviteEvent(triggerSource = 'CustomMessage_AdminCreateUser') {
  return {
    triggerSource,
    userPoolId: 'us-east-1_EXAMPLE',
    request: {
      userAttributes: { email: 'person@example.com' },
      codeParameter: '{####}',
      usernameParameter: '{username}',
    },
    response: { smsMessage: null, emailMessage: null, emailSubject: null },
  };
}

function ssmReturns(value: string) {
  mockSend.mockResolvedValueOnce({ Parameter: { Value: value } });
}

describe('cognito-custom-message handler', () => {
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    mockSend.mockReset();
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('builds the invite with the login URL from SSM', async () => {
    ssmReturns('https://d111111abcdef8.cloudfront.net');
    const result = await handler(inviteEvent());

    expect(mockSend).toHaveBeenCalledWith({ input: { Name: '/MediaResourceManager/Frontend/Url' } });
    expect(result.response.emailSubject).toBe("You're invited to Media Resource Manager");
    expect(result.response.emailMessage).toContain(
      '<a href="https://d111111abcdef8.cloudfront.net">https://d111111abcdef8.cloudfront.net</a>');
    expect(result.response.emailMessage).toContain('{username}');
    expect(result.response.emailMessage).toContain('{####}');
    expect(result.response.emailMessage).not.toMatch(/check deployment outputs/i);
  });

  it('uses a custom domain from SSM as the login URL', async () => {
    ssmReturns('https://mrm.example.com');
    const result = await handler(inviteEvent());
    expect(result.response.emailMessage).toContain(
      '<a href="https://mrm.example.com">https://mrm.example.com</a>');
    expect(result.response.emailMessage).not.toContain('cloudfront.net');
  });

  it('puts a non-default product name in the subject and the HTML-escaped body', async () => {
    const original = process.env.PRODUCT_NAME;
    process.env.PRODUCT_NAME = 'Acme & <Studio> Manager';
    try {
      ssmReturns('https://mrm.example.com');
      const result = await handler(inviteEvent());
      // The subject is plain text, so it keeps the name as typed.
      expect(result.response.emailSubject).toBe("You're invited to Acme & <Studio> Manager");
      expect(result.response.emailMessage).toContain('<strong>Acme &amp; &lt;Studio&gt; Manager</strong>');
      expect(result.response.emailMessage).not.toContain('<Studio>');
      expect(result.response.emailMessage).not.toContain('Media Resource Manager');
    } finally {
      process.env.PRODUCT_NAME = original;
    }
  });

  it('escapes HTML in the URL', async () => {
    ssmReturns('https://example.com/"><script>');
    const result = await handler(inviteEvent());
    expect(result.response.emailMessage).not.toContain('<script>');
    expect(result.response.emailMessage).toContain('&quot;&gt;&lt;script&gt;');
  });

  it.each([
    ['the install-time placeholder', 'https://placeholder.cloudfront.net'],
    ['a non-https URL', 'http://d111111abcdef8.cloudfront.net'],
    ['an empty value', ''],
  ])('keeps the pool template for %s', async (_name, value) => {
    ssmReturns(value);
    const result = await handler(inviteEvent());
    expect(result.response.emailMessage).toBeNull();
  });

  it('keeps the pool template when SSM fails, so the invite still goes out', async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    const result = await handler(inviteEvent());
    expect(result.response.emailMessage).toBeNull();
  });

  it('leaves other messages alone without reading SSM', async () => {
    const result = await handler(inviteEvent('CustomMessage_ForgotPassword'));
    expect(mockSend).not.toHaveBeenCalled();
    expect(result.response.emailMessage).toBeNull();
  });

  it('never logs the email address', async () => {
    ssmReturns('https://d111111abcdef8.cloudfront.net');
    await handler(inviteEvent());
    ssmReturns('https://placeholder.cloudfront.net');
    await handler(inviteEvent());
    const logged = JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls]);
    expect(logged).not.toContain('person@example.com');
  });
});
