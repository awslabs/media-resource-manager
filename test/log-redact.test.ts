// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the log redaction helper. Like authz.js, the helper is
 * copied byte-identical into every Lambda that logs its event; one copy is
 * tested here, and the last test checks that the copies match.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { redactForLog, REDACTED } = require('../lambda/workstation-manager/log-redact.js');

const JWT = 'eyJraWQiOiJhYmMifQ.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLXZhbHVl';
const LAMBDA_DIR = path.join(__dirname, '..', 'lambda');

function apiEvent(body: unknown) {
  return {
    httpMethod: 'POST',
    path: '/images/software',
    headers: {
      Authorization: `Bearer ${JWT}`,
      'Content-Type': 'application/json',
      Cookie: 'session=abc',
      'X-Amz-Security-Token': 'IQoJb3JpZ2lu',
      'x-api-key': 'key-123',
    },
    multiValueHeaders: { Authorization: [`Bearer ${JWT}`], Accept: ['*/*'] },
    queryStringParameters: { token: 'query-token', page: '2' },
    requestContext: {
      authorizer: { isAdmin: 'true', username: 'alice', email: 'alice@example.com', tokenType: 'cognito' },
      identity: { sourceIp: '203.0.113.10' },
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

describe('redactForLog', () => {
  it('redacts credential headers and keeps the rest of the request', () => {
    const out = redactForLog(apiEvent({ name: 'Chrome' }));
    expect(out.headers).toEqual({
      Authorization: REDACTED,
      'Content-Type': 'application/json',
      Cookie: REDACTED,
      'X-Amz-Security-Token': REDACTED,
      'x-api-key': REDACTED,
    });
    expect(out.multiValueHeaders).toEqual({ Authorization: REDACTED, Accept: ['*/*'] });
    expect(out.queryStringParameters).toEqual({ token: REDACTED, page: '2' });
    expect(out.requestContext).toEqual(apiEvent({}).requestContext);
    expect(out.httpMethod).toBe('POST');
    expect(out.path).toBe('/images/software');
  });

  it('redacts credentials inside a JSON request body', () => {
    const out = redactForLog(apiEvent({
      name: 'share',
      password: 'hunter2',
      credentials: { username: 'svc', password: 'p' },
      secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:x',
      nested: { idToken: JWT, clientSecret: 's' },
    }));
    expect(JSON.parse(out.body)).toEqual({
      name: 'share',
      password: REDACTED,
      credentials: REDACTED,
      secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:x',
      nested: { idToken: REDACTED, clientSecret: REDACTED },
    });
  });

  it('removes tokens and signatures that appear inside other strings', () => {
    const out = redactForLog({
      note: `copied ${JWT} here`,
      url: 'https://gw.example.com:8443/?authToken=abc123#session-1',
      presigned: 'https://b.s3.amazonaws.com/k?X-Amz-Credential=AKIA%2F&X-Amz-Expires=3600&X-Amz-Signature=deadbeef',
    });
    expect(out.note).toBe(`copied ${REDACTED} here`);
    expect(out.url).toBe(`https://gw.example.com:8443/?authToken=${REDACTED}#session-1`);
    expect(out.presigned).toBe(
      `https://b.s3.amazonaws.com/k?X-Amz-Credential=${REDACTED}&X-Amz-Expires=3600&X-Amz-Signature=${REDACTED}`
    );
  });

  it('replaces bodies it cannot inspect', () => {
    expect(redactForLog({ body: 'user=a&password=b' }).body).toBe('[REDACTED: non-JSON body, 17 characters]');
    expect(redactForLog({ body: 'aGVsbG8=', isBase64Encoded: true }).body).toBe('[REDACTED: base64 body, 8 characters]');
    expect(redactForLog({ body: '' }).body).toBe('');
    expect(redactForLog({ body: null }).body).toBeNull();
  });

  it('keeps descriptive fields such as tokenType and secretName', () => {
    expect(redactForLog({ tokenType: 'ldap', secretName: 'ad-admin', passwordLastSetId: 'x' }))
      .toEqual({ tokenType: 'ldap', secretName: 'ad-admin', passwordLastSetId: 'x' });
  });

  it('keeps empty credential fields empty, so missing values stay visible', () => {
    expect(redactForLog({ Authorization: '', TaskToken: null })).toEqual({ Authorization: '', TaskToken: null });
  });

  it('does not change the original value', () => {
    const event = apiEvent({ password: 'hunter2' });
    const before = JSON.stringify(event);
    redactForLog(event);
    expect(JSON.stringify(event)).toBe(before);
  });

  it('handles primitives, arrays, and deep nesting', () => {
    expect(redactForLog(null)).toBeNull();
    expect(redactForLog(5)).toBe(5);
    expect(redactForLog([{ token: 'a' }, 'b'])).toEqual([{ token: REDACTED }, 'b']);
    let deep: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 30; i++) deep = { child: deep };
    expect(JSON.stringify(redactForLog(deep))).toContain('[REDACTED: nested too deeply]');
  });
});

describe('log-redact.js copies', () => {
  const handlers = fs.readdirSync(LAMBDA_DIR)
    .filter(dir => fs.existsSync(path.join(LAMBDA_DIR, dir, 'index.js')))
    .filter(dir => fs.readFileSync(path.join(LAMBDA_DIR, dir, 'index.js'), 'utf8').includes("require('./log-redact')"));

  it('is used by the API handlers', () => {
    expect(handlers.length).toBeGreaterThanOrEqual(34);
  });

  it('is present and byte-identical in every Lambda that requires it', () => {
    const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const reference = hash(path.join(LAMBDA_DIR, 'workstation-manager', 'log-redact.js'));
    for (const dir of handlers) {
      expect({ dir, hash: hash(path.join(LAMBDA_DIR, dir, 'log-redact.js')) }).toEqual({ dir, hash: reference });
    }
  });
});
