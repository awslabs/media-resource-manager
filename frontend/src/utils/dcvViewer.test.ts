// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createViewerSession, postCreateSession, SESSION_START_RETRIES, sessionNameFor, viewerSessionFromResponse,
} from './dcvViewer';
import { setApiUrl } from './api';

/** A sign-in credential shaped like the console's (header.payload.signature, unexpired). */
const SIGN_IN_JWT = `h.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.s`;
const LB_GATEWAY = 'https://mrm-gw-0123456789abcdef.elb.us-east-1.amazonaws.com';

describe('viewerSessionFromResponse', () => {
  it('connects through browserGatewayUrl (CloudFront) and is not direct', () => {
    const s = viewerSessionFromResponse({
      sessionId: 'console',
      connectionToken: 'tok',
      connectionUrl: `${LB_GATEWAY}:8443/?authToken=tok#console`,
      browserGatewayUrl: 'https://d111111abcdef8.cloudfront.net',
    });
    expect(s).toEqual({
      sessionId: 'console',
      authToken: 'tok',
      serverUrl: 'https://d111111abcdef8.cloudfront.net',
      direct: false,
      untrustedCertificateLikely: false,
    });
  });

  it('falls back to the gateway origin when browserGatewayUrl is missing (hub not updated)', () => {
    const s = viewerSessionFromResponse({
      sessionId: 'console',
      connectionToken: 'tok',
      connectionUrl: `${LB_GATEWAY}:8443/?authToken=tok#console`,
    });
    expect(s.serverUrl).toBe(`${LB_GATEWAY}:8443`);
    expect(s.direct).toBe(true);
    expect(s.untrustedCertificateLikely).toBe(true);
  });

  it('treats browserGatewayUrl equal to the gateway as direct', () => {
    const s = viewerSessionFromResponse({
      sessionId: 'console',
      connectionToken: 'tok',
      connectionUrl: `${LB_GATEWAY}:8443/?authToken=tok#console`,
      browserGatewayUrl: `${LB_GATEWAY}:8443`,
    });
    expect(s.direct).toBe(true);
    expect(s.untrustedCertificateLikely).toBe(true);
  });

  it('does not expect a certificate problem on a direct gateway with a custom domain', () => {
    const s = viewerSessionFromResponse({
      sessionId: 'console',
      connectionToken: 'tok',
      connectionUrl: 'https://dcv.example.com:8443/?authToken=tok#console',
      browserGatewayUrl: 'https://dcv.example.com:8443',
    });
    expect(s.direct).toBe(true);
    expect(s.untrustedCertificateLikely).toBe(false);
  });

  it('ignores a browserGatewayUrl that is not https', () => {
    const s = viewerSessionFromResponse({
      sessionId: 'console',
      connectionToken: 'tok',
      connectionUrl: 'https://dcv.example.com:8443/?authToken=tok#console',
      browserGatewayUrl: 'http://dcv.example.com',
    });
    expect(s.serverUrl).toBe('https://dcv.example.com:8443');
  });

  it('rejects a response without a token, session ID or gateway', () => {
    const base = { sessionId: 'console', connectionToken: 'tok', connectionUrl: 'https://dcv.example.com:8443/' };
    expect(() => viewerSessionFromResponse({ ...base, connectionToken: undefined })).toThrow(/incomplete/);
    expect(() => viewerSessionFromResponse({ ...base, sessionId: undefined })).toThrow(/incomplete/);
    expect(() => viewerSessionFromResponse({ ...base, connectionUrl: 'not a url' })).toThrow(/incomplete/);
  });
});

describe('sessionNameFor', () => {
  it('uses the name, then the email prefix, then User', () => {
    expect(sessionNameFor({ firstName: 'Ana', lastName: 'Li' })).toBe('Ana Li');
    expect(sessionNameFor({ email: 'ana@example.com' })).toBe('ana');
    expect(sessionNameFor(null)).toBe('User');
  });
});

describe('createViewerSession', () => {
  beforeEach(() => {
    setApiUrl('https://api.example.com/prod');
    sessionStorage.setItem('auth-token', SIGN_IN_JWT);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('posts create-session with the sign-in token and returns the viewer session', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      sessionId: 'console',
      connectionToken: 'tok',
      connectionUrl: 'https://dcv.example.com:8443/?authToken=tok#console',
      browserGatewayUrl: 'https://d111111abcdef8.cloudfront.net',
    }), { status: 200 }));

    const s = await createViewerSession('i-0123456789abcdef0', 'Ana Li');

    expect(s.serverUrl).toBe('https://d111111abcdef8.cloudfront.net');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/prod/dcv');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${SIGN_IN_JWT}` });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      action: 'create-session',
      serverId: 'i-0123456789abcdef0',
      sessionName: 'Ana Li',
      sessionType: 'console',
    });
  });

  it('surfaces the API error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'The server may still be initializing' }), { status: 500 }));
    await expect(createViewerSession('i-1', 'x')).rejects.toThrow('The server may still be initializing');
  });

  it('fails without a signed-in user', async () => {
    sessionStorage.clear();
    await expect(createViewerSession('i-1', 'x')).rejects.toThrow('No current user');
  });
});

describe('postCreateSession', () => {
  const starting = () => new Response(JSON.stringify({
    status: 'session-starting', sessionId: 's1', retryAfterSeconds: 5, error: 'The workstation session is still starting.',
  }), { status: 409 });
  const ready = () => new Response(JSON.stringify({
    sessionId: 's1', connectionToken: 'tok', connectionUrl: 'https://dcv.example.com:8443/?authToken=tok#s1',
  }), { status: 200 });

  beforeEach(() => {
    setApiUrl('https://api.example.com/prod');
    sessionStorage.setItem('auth-token', SIGN_IN_JWT);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('retries while the session is starting, then returns the session', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(starting())
      .mockResolvedValueOnce(starting())
      .mockResolvedValueOnce(ready());
    const onStarting = vi.fn();
    const wait = vi.fn().mockResolvedValue(undefined);

    const s = await createViewerSession('i-0123456789abcdef0', 'Ana Li', { onStarting, wait });

    expect(s.sessionId).toBe('s1');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onStarting).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(5000);
  });

  it('stops after a few retries and surfaces the starting message', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => starting());
    const wait = vi.fn().mockResolvedValue(undefined);

    const response = await postCreateSession('i-1', 'x', { wait });

    expect(response.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(SESSION_START_RETRIES + 1);
    expect((await response.json()).error).toMatch(/still starting/);
    await expect(createViewerSession('i-1', 'x', { wait })).rejects.toThrow(/still starting/);
  });

  it('does not retry other errors', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ error: 'conflict' }), { status: 409 }));
    const wait = vi.fn();

    const response = await postCreateSession('i-1', 'x', { wait });

    expect(response.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });
});
