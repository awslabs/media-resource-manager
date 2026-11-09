// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the log redaction helper (lambda/shared/log-redact.js) and
 * for packaging it with the Lambdas that use it.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Template } from 'aws-cdk-lib/assertions';
import { lambdaCodeWithShared } from '../lib/lambda-code';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { redactForLog, REDACTED } = require('../lambda/shared/log-redact.js');

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

describe('lambdaCodeWithShared', () => {
  it('packages only the function folder and lambda/shared', () => {
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrm-lambda-code-'));
    try {
      const app = new cdk.App({ outdir });
      const stack = new cdk.Stack(app, 'LambdaCodeTest');
      new lambda.Function(stack, 'Fn', { runtime: lambda.Runtime.NODEJS_22_X, ...lambdaCodeWithShared('software-library') });
      Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', { Handler: 'software-library/index.handler' });
      app.synth();

      const assetDir = fs.readdirSync(outdir).find(name => name.startsWith('asset.'))!;
      const files: string[] = [];
      const walk = (dir: string, rel: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const relPath = path.join(rel, entry.name);
          if (entry.isDirectory()) walk(path.join(dir, entry.name), relPath); else files.push(relPath);
        }
      };
      walk(path.join(outdir, assetDir), '');
      expect(files).toContain(path.join('software-library', 'index.js'));
      expect(files).toContain(path.join('shared', 'log-redact.js'));
      expect(files.every(file => file.startsWith(`software-library${path.sep}`) || file.startsWith(`shared${path.sep}`))).toBe(true);
    } finally {
      fs.rmSync(outdir, { recursive: true, force: true });
    }
  });

  it('rejects directory names that would change the package', () => {
    for (const dir of ['shared', '../lib', 'a/b', '*', '']) {
      expect(() => lambdaCodeWithShared(dir)).toThrow(/invalid Lambda directory/);
    }
  });
});

describe('Lambdas that use lambda/shared', () => {
  const usesShared = fs.readdirSync(LAMBDA_DIR)
    .filter(dir => fs.existsSync(path.join(LAMBDA_DIR, dir, 'index.js')))
    .filter(dir => fs.readFileSync(path.join(LAMBDA_DIR, dir, 'index.js'), 'utf8').includes("require('../shared/"));
  const cdkSource = ['api-stack.ts', 'datasync-stack.ts', 'storage-stack.ts']
    .map(file => fs.readFileSync(path.join(__dirname, '..', 'lib', file), 'utf8'))
    .join('\n');

  it('include the API handlers that log their event', () => {
    expect(usesShared.length).toBeGreaterThanOrEqual(34);
  });

  it('are packaged with lambdaCodeWithShared, so shared/ is in their package', () => {
    for (const dir of usesShared) {
      expect({ dir, packagedWithShared: cdkSource.includes(`lambdaCodeWithShared('${dir}')`) })
        .toEqual({ dir, packagedWithShared: true });
    }
  });

  it('have no leftover copies of the shared module', () => {
    const copies = fs.readdirSync(LAMBDA_DIR).filter(dir => dir !== 'shared' && fs.existsSync(path.join(LAMBDA_DIR, dir, 'log-redact.js')));
    expect(copies).toEqual([]);
  });
});
