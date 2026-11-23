// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The /connect/:instanceId viewer page with the Web UI SDK mocked: it starts
 * the session itself, passes the token straight to DCVViewer, keeps it out of
 * the URL and storage, and shows the right error and retry UI.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DCVViewerProps } from 'dcv-ui';
import { setApiUrl } from '../utils/api';

vi.mock('dcv', () => ({ default: { LogLevel: { WARN: 3 } } }));

const viewerProps: DCVViewerProps[] = [];
vi.mock('dcv-ui', () => ({
  DCVViewer: (props: DCVViewerProps) => {
    viewerProps.push(props);
    return <div data-testid="mock-viewer" />;
  },
}));

import ConnectViewer, { dcvSdkBaseUrl, MODIFIER_KEYS, releaseModifierKeys } from './ConnectViewer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SIGN_IN_JWT = `h.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.s`;
const DCV_TOKEN = 'dcv-connection-token-value';
const LB_GATEWAY = 'https://mrm-gw-0123456789abcdef.elb.us-east-1.amazonaws.com';

function sessionResponse(browserGatewayUrl?: string) {
  return new Response(JSON.stringify({
    sessionId: 'console',
    connectionToken: DCV_TOKEN,
    connectionUrl: `${LB_GATEWAY}:8443/?authToken=${DCV_TOKEN}#console`,
    quicConnectionUrl: `${LB_GATEWAY}:8444/?authToken=${DCV_TOKEN}#console`,
    ...(browserGatewayUrl ? { browserGatewayUrl } : {}),
  }), { status: 200 });
}

describe('dcvSdkBaseUrl', () => {
  // The SDK prefixes any baseUrl that doesn't start with "http" with the
  // page's directory (/connect/<id>/), so it must be absolute.
  it('is an absolute URL at the site root, whatever route the viewer is on', () => {
    expect(dcvSdkBaseUrl('https://console.example.com')).toBe('https://console.example.com/dcvsdk/dcvjs');
    expect(dcvSdkBaseUrl('https://console.example.com/')).toBe('https://console.example.com/dcvsdk/dcvjs');
    expect(dcvSdkBaseUrl()).toMatch(/^https?:\/\//);
  });
});

describe('ConnectViewer', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    viewerProps.length = 0;
    setApiUrl('https://api.example.com/prod');
    sessionStorage.setItem('auth-token', SIGN_IN_JWT);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: false, media: query, onchange: null,
        addListener: () => {}, removeListener: () => {},
        addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
      }),
    });
    fetchMock = vi.spyOn(globalThis, 'fetch');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    sessionStorage.clear();
    localStorage.clear();
  });

  async function render() {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/connect/i-0123456789abcdef0']}>
          <Routes>
            <Route path="/connect/:instanceId" element={<ConnectViewer user={{ firstName: 'Ana', lastName: 'Li' }} />} />
          </Routes>
        </MemoryRouter>,
      );
    });
  }

  const lastViewer = () => viewerProps[viewerProps.length - 1];

  it('gives the SDK an absolute base URL at the site root when the page is on the nested /connect/<id> route', async () => {
    // The SDK resolves a base URL that doesn't start with http against the
    // page's directory; on /connect/<id> that loaded index.html as the workers.
    window.history.pushState({}, '', '/connect/i-0123456789abcdef0');
    try {
      fetchMock.mockResolvedValue(sessionResponse('https://d111111abcdef8.cloudfront.net'));
      await render();
      const { baseUrl } = lastViewer().dcv;
      expect(baseUrl).toBe(`${window.location.origin}/dcvsdk/dcvjs`);
      expect(baseUrl).toMatch(/^https?:\/\//);
      expect(baseUrl).not.toContain('/connect/');
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('starts the session and hands the token straight to DCVViewer through CloudFront', async () => {
    fetchMock.mockResolvedValue(sessionResponse('https://d111111abcdef8.cloudfront.net'));
    await render();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ action: 'create-session', serverId: 'i-0123456789abcdef0', sessionName: 'Ana Li' });

    expect(container.querySelector('[data-testid="mock-viewer"]')).not.toBeNull();
    expect(lastViewer().dcv).toMatchObject({
      sessionId: 'console',
      authToken: DCV_TOKEN,
      serverUrl: 'https://d111111abcdef8.cloudfront.net',
      baseUrl: `${window.location.origin}/dcvsdk/dcvjs`,
      logLevel: 3,
    });
  });

  it('keeps the DCV token out of the URL and browser storage', async () => {
    fetchMock.mockResolvedValue(sessionResponse('https://d111111abcdef8.cloudfront.net'));
    await render();
    expect(window.location.href).not.toContain(DCV_TOKEN);
    const stored = [
      ...Object.keys(sessionStorage).map((k) => sessionStorage.getItem(k)),
      ...Object.keys(localStorage).map((k) => localStorage.getItem(k)),
    ].join('\n');
    expect(stored).not.toContain(DCV_TOKEN);
  });

  it('shows a gateway error with Retry and the trust-the-gateway prompt in direct mode', async () => {
    fetchMock.mockResolvedValue(sessionResponse());
    await render();
    expect(lastViewer().dcv.serverUrl).toBe(`${LB_GATEWAY}:8443`);

    await act(async () => lastViewer().dcv.onDisconnect!({ code: 5, message: 'Could not connect' }));
    expect(container.textContent).toContain("Couldn't reach the workstation's gateway");
    expect(container.textContent).toContain('Could not connect');
    const trust = container.querySelector('[data-testid="trust-gateway"] a') as HTMLAnchorElement;
    expect(trust).not.toBeNull();
    expect(trust.getAttribute('href')).toBe(`${LB_GATEWAY}:8443/`);
    expect(trust.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.querySelector('[data-testid="mock-viewer"]')).toBeNull();

    // Retry starts a new session (a fresh token).
    fetchMock.mockResolvedValue(sessionResponse());
    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Retry')!;
    await act(async () => retry.click());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="mock-viewer"]')).not.toBeNull();
  });

  it('does not show the trust prompt when connecting through CloudFront', async () => {
    fetchMock.mockResolvedValue(sessionResponse('https://d111111abcdef8.cloudfront.net'));
    await render();
    await act(async () => lastViewer().dcv.onDisconnect!({ message: 'Could not connect' }));
    expect(container.textContent).toContain("Couldn't reach the workstation's gateway");
    expect(container.querySelector('[data-testid="trust-gateway"]')).toBeNull();
  });

  it('shows Reconnect after an established session closes', async () => {
    fetchMock.mockResolvedValue(sessionResponse('https://d111111abcdef8.cloudfront.net'));
    await render();
    await act(async () => lastViewer().dcv.onConnectionEstablished!({}));
    await act(async () => lastViewer().dcv.onDisconnect!({ message: 'Closed by the server' }));
    expect(container.textContent).toContain('The session was disconnected');
    expect(container.textContent).toContain('Closed by the server');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.trim() === 'Reconnect')).toBe(true);
  });

  it('does not re-render DCVViewer when the connection opens', async () => {
    fetchMock.mockResolvedValue(sessionResponse('https://d111111abcdef8.cloudfront.net'));
    await render();
    const renders = viewerProps.length;
    const first = lastViewer();
    await act(async () => lastViewer().dcv.onConnectionEstablished!({}));
    expect(viewerProps.length).toBe(renders);
    expect(lastViewer().dcv).toBe(first.dcv);
  });

  describe('modifier keys on page hide', () => {
    const fakeConnection = () => ({ latchModifierKey: vi.fn((_key: string, _location: number, _isDown: boolean) => true) });

    async function connect(conn: unknown) {
      fetchMock.mockResolvedValue(sessionResponse('https://d111111abcdef8.cloudfront.net'));
      await render();
      await act(async () => lastViewer().dcv.onConnectionEstablished!(conn));
    }

    function setVisibility(state: DocumentVisibilityState) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    }

    afterEach(() => {
      delete (document as any).visibilityState;
    });

    it('sends a keyup for every modifier on pagehide, before the SDK disconnects', async () => {
      const conn = fakeConnection();
      // Stands in for the SDK's own pagehide listener, which disconnects.
      // It is added first and in the bubble phase, as the SDK does.
      let releasesBeforeDisconnect = -1;
      const sdkDisconnect = () => { releasesBeforeDisconnect = conn.latchModifierKey.mock.calls.length; };
      window.addEventListener('pagehide', sdkDisconnect);
      try {
        await connect(conn);
        window.dispatchEvent(new Event('pagehide'));
      } finally {
        window.removeEventListener('pagehide', sdkDisconnect);
      }

      expect(conn.latchModifierKey).toHaveBeenCalledTimes(MODIFIER_KEYS.length);
      for (const [key, location] of MODIFIER_KEYS) {
        expect(conn.latchModifierKey).toHaveBeenCalledWith(key, location, false);
      }
      expect(conn.latchModifierKey).toHaveBeenCalledWith('Meta', 1, false);
      expect(conn.latchModifierKey.mock.calls.every((call) => call[2] === false)).toBe(true);
      expect(releasesBeforeDisconnect).toBe(MODIFIER_KEYS.length);
    });

    it('sends the keyups when the page becomes hidden, not when it becomes visible', async () => {
      const conn = fakeConnection();
      await connect(conn);
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(conn.latchModifierKey).not.toHaveBeenCalled();
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(conn.latchModifierKey).toHaveBeenCalledTimes(MODIFIER_KEYS.length);
    });

    it('sends nothing before the connection opens or after it closes', async () => {
      const conn = fakeConnection();
      fetchMock.mockResolvedValue(sessionResponse('https://d111111abcdef8.cloudfront.net'));
      await render();
      window.dispatchEvent(new Event('pagehide'));
      await act(async () => lastViewer().dcv.onConnectionEstablished!(conn));
      await act(async () => lastViewer().dcv.onDisconnect!({ message: 'Closed by the server' }));
      window.dispatchEvent(new Event('pagehide'));
      expect(conn.latchModifierKey).not.toHaveBeenCalled();
    });

    it('keeps releasing the other modifiers when one call throws', async () => {
      const conn = fakeConnection();
      conn.latchModifierKey.mockImplementationOnce(() => { throw new Error('channel closed'); });
      await connect(conn);
      expect(() => window.dispatchEvent(new Event('pagehide'))).not.toThrow();
      expect(conn.latchModifierKey).toHaveBeenCalledTimes(MODIFIER_KEYS.length);
    });
  });

  it('releaseModifierKeys does nothing without a connection', () => {
    expect(() => releaseModifierKeys(null)).not.toThrow();
  });

  it('shows the API error and Retry when the session cannot start', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'Workstation is not running' }), { status: 400 }));
    await render();
    expect(container.textContent).toContain("Couldn't start the session");
    expect(container.textContent).toContain('Workstation is not running');
    expect(container.querySelector('[data-testid="mock-viewer"]')).toBeNull();
  });
});
