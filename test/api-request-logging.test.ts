// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Lambdas behind API Gateway log a request summary (method, resource
 * template, request ID) instead of the event. Headers, the authorizer
 * context, the caller's identity and the body are not logged.
 */

import * as fs from 'fs';
import * as path from 'path';

export {}; // module scope, so names here don't clash with other test files

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn().mockImplementation(() => ({ send: mockSend })) }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  ScanCommand: jest.fn(), GetCommand: jest.fn(), UpdateCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: jest.fn().mockImplementation(() => ({ send: mockSend })), DescribeVpcsCommand: jest.fn(),
}), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { requestSummary } = require('../lambda/shared/log-redact');

/** The Lambdas wired to API Gateway routes in lib/api-stack.ts that summarize the event. */
const API_HANDLERS = [
  'cancel-install-script', 'chat-requirements', 'create-regional-hub', 'create-storage',
  'datasync-create-location', 'datasync-create-task', 'datasync-delete-location', 'datasync-delete-task',
  'datasync-get-executions', 'datasync-list-locations', 'datasync-list-s3-buckets', 'datasync-list-tasks',
  'datasync-start-execution', 'datasync-update-task', 'delete-regional-hub', 'delete-storage',
  'fsx-nfs-mount-manager', 'get-availability-zones', 'get-regional-hub', 'get-storage',
  'identity-center-sync', 'image-manager', 'install-script-progress', 'invoke-install-script-agent',
  'list-regional-hubs', 'list-storage', 's3-mount-manager', 'software-library',
  'storage-list-s3-buckets', 'update-regional-hub', 'update-storage', 'user-details-manager',
  'workstation-manager',
];

// Made-up values, each checked for absence in the logs.
// A JWT-shaped test token, built at run time so no token literal is in the source.
const b64url = (s: string) => Buffer.from(s).toString('base64url');
const TOKEN = `${b64url('{"alg":"RS256"}')}.${b64url('{"sub":"test"}')}.${b64url('signature-test')}`;
const VALUES = [TOKEN, 'session=test-cookie-value', 'api-test-user@example.invalid', 'api-test-user',
  '198.51.100.7', 'TestAgent/1.0', 'test-body-marker'];

function apiEvent(): any {
  return {
    resource: '/regional-hubs', path: '/regional-hubs', httpMethod: 'GET',
    headers: { Authorization: `Bearer ${TOKEN}`, Cookie: 'session=test-cookie-value', 'User-Agent': 'TestAgent/1.0', 'X-Forwarded-For': '198.51.100.7' },
    multiValueHeaders: { Authorization: [`Bearer ${TOKEN}`] },
    queryStringParameters: null,
    requestContext: {
      requestId: 'req-test-0001',
      authorizer: { username: 'api-test-user', email: 'api-test-user@example.invalid', isAdmin: 'true' },
      identity: { sourceIp: '198.51.100.7', userAgent: 'TestAgent/1.0' },
    },
    body: JSON.stringify({ note: 'test-body-marker' }),
  };
}

function expectNoRequestData(text: string) {
  for (const v of VALUES) expect(text).not.toContain(v);
  expect(text).not.toMatch(/"headers"|"multiValueHeaders"|authorization|"authorizer"|"identity"|"body"/i);
}

describe('requestSummary', () => {
  it('keeps the method, resource template and request ID of an API Gateway request', () => {
    const summary = requestSummary(apiEvent());
    expect(summary).toEqual({ method: 'GET', resource: '/regional-hubs', requestId: 'req-test-0001' });
    expectNoRequestData(JSON.stringify(summary));
  });

  it('logs the resource template, not a path with an ID in it', () => {
    const e = { ...apiEvent(), resource: '/users/{id}', path: '/users/api-test-user@example.invalid' };
    expect(requestSummary(e).resource).toBe('/users/{id}');
  });

  it('keeps only the field names of any other event', () => {
    expect(requestSummary({ storageId: 'st-1', username: 'api-test-user' })).toEqual({ eventKeys: ['storageId', 'username'] });
    expect(requestSummary(undefined)).toEqual({ eventType: 'undefined' });
  });
});

describe('API handler logging', () => {
  it('every API handler logs requestSummary(event), not the event or its headers', () => {
    const logCall = /console\.(log|info|debug|warn|error)\(([^;]*)/g;
    for (const dir of API_HANDLERS) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'lambda', dir, 'index.js'), 'utf8');
      expect({ dir, summarizes: src.includes('requestSummary(event)') }).toEqual({ dir, summarizes: true });
      for (const [, , args] of src.matchAll(logCall)) {
        expect({ dir, args }).not.toEqual(expect.objectContaining({
          args: expect.stringMatching(/redactForLog\(event\)|JSON\.stringify\(event\b|event\.headers|requestContext\??\.authorizer/),
        }));
      }
    }
  });

  it('list-regional-hubs logs no headers, token, authorizer context or caller identity', async () => {
    mockSend.mockResolvedValue({ Items: [] });
    let logged = '';
    const capture = (...args: unknown[]) => { logged += args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n'; };
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(l => jest.spyOn(console, l).mockImplementation(capture));
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const handler = require('../lambda/list-regional-hubs/index.js').handler;
      const res = await handler(apiEvent());
      expect(res.statusCode).toBe(200);
    } finally {
      spies.forEach(s => s.mockRestore());
    }
    expect(logged).toContain('"method":"GET"');
    expect(logged).toContain('"requestId":"req-test-0001"');
    expectNoRequestData(logged);
  });
});
