// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the DCV client launcher (issue #69). jsdom can't open a
 * `dcv://` link, so these drive the detection with synthetic blur and
 * visibilitychange events and fake timers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DCV_LAUNCH_TIMEOUT_MS,
  defaultLaunchMethod,
  launchDcvClient,
  toDcvClientUrl,
  nativeClientUrl,
  parseNativeClientTransport,
  parseNativeClientTransportOverride,
  browserViewerPath,
  openBrowserViewer,
} from './dcvClient';

const LINK = 'dcv://workstation.example.com:8444/?authToken=test#session';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

/** The window loses focus to another app (the DCV client) and stays unfocused. */
function blurAway() {
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  window.dispatchEvent(new Event('blur'));
}

describe('launchDcvClient', () => {
  let addWindow: ReturnType<typeof vi.spyOn>;
  let removeWindow: ReturnType<typeof vi.spyOn>;
  let addDocument: ReturnType<typeof vi.spyOn>;
  let removeDocument: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
    addWindow = vi.spyOn(window, 'addEventListener');
    removeWindow = vi.spyOn(window, 'removeEventListener');
    addDocument = vi.spyOn(document, 'addEventListener');
    removeDocument = vi.spyOn(document, 'removeEventListener');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  /** Every listener the launcher added has been removed again. */
  function expectListenersRemoved() {
    const blur = addWindow.mock.calls.find((call: unknown[]) => call[0] === 'blur');
    const visibility = addDocument.mock.calls.find((call: unknown[]) => call[0] === 'visibilitychange');
    expect(blur).toBeDefined();
    expect(visibility).toBeDefined();
    expect(removeWindow).toHaveBeenCalledWith('blur', blur![1]);
    expect(removeDocument).toHaveBeenCalledWith('visibilitychange', visibility![1]);
  }

  it('opens the link in a hidden iframe and reports launched when the window loses focus and stays unfocused', async () => {
    const result = launchDcvClient(LINK, { method: 'iframe' });

    const iframe = document.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe!.style.display).toBe('none');
    expect(iframe!.getAttribute('src')).toBe(LINK);

    blurAway();
    vi.advanceTimersByTime(DCV_LAUNCH_TIMEOUT_MS);
    await expect(result).resolves.toBe('launched');
    expect(document.querySelector('iframe')).toBeNull();
    expectListenersRemoved();
  });

  it('reports launched when the page becomes hidden', async () => {
    const result = launchDcvClient(LINK, { method: 'iframe' });

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await expect(result).resolves.toBe('launched');
    expect(document.querySelector('iframe')).toBeNull();
    expectListenersRemoved();
  });

  it('does not count a blur that hands focus back (a prompt or DevTools) as a launch', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const result = launchDcvClient(LINK, { method: 'top' });

    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(DCV_LAUNCH_TIMEOUT_MS);
    await expect(result).resolves.toBe('not-detected');
    expectListenersRemoved();
  });

  it('ignores a visibilitychange that leaves the page visible', async () => {
    const result = launchDcvClient(LINK, { method: 'iframe' });

    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(DCV_LAUNCH_TIMEOUT_MS);
    await expect(result).resolves.toBe('not-detected');
  });

  it('reports not-detected after about 3.5 seconds with no blur, and cleans up', async () => {
    const result = launchDcvClient(LINK, { method: 'iframe' });
    let settled = false;
    result.then(() => (settled = true));

    vi.advanceTimersByTime(DCV_LAUNCH_TIMEOUT_MS - 1);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(document.querySelector('iframe')).not.toBeNull();

    vi.advanceTimersByTime(1);
    await expect(result).resolves.toBe('not-detected');
    expect(document.querySelector('iframe')).toBeNull();
    expectListenersRemoved();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles once: a hidden page after the timeout does not change the result', async () => {
    const result = launchDcvClient(LINK, { method: 'iframe' });
    vi.advanceTimersByTime(DCV_LAUNCH_TIMEOUT_MS);
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await expect(result).resolves.toBe('not-detected');
  });

  it('clears the timeout when the page becomes hidden', async () => {
    const result = launchDcvClient(LINK, { method: 'iframe' });
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses a top-level navigation by default outside Firefox, with no iframe', async () => {
    // jsdom prints "Not implemented: navigation" for the dcv:// link; the
    // launcher must still run its detection and clean up.
    const result = launchDcvClient(LINK, { method: 'top' });
    expect(document.querySelector('iframe')).toBeNull();

    blurAway();
    vi.advanceTimersByTime(DCV_LAUNCH_TIMEOUT_MS);
    await expect(result).resolves.toBe('launched');
    expectListenersRemoved();
  });
});

describe('launchDcvClient abort', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('stops at once when aborted: not-detected, iframe, listeners and timer removed', async () => {
    const removeWindow = vi.spyOn(window, 'removeEventListener');
    const removeDocument = vi.spyOn(document, 'removeEventListener');
    const controller = new AbortController();
    const result = launchDcvClient(LINK, { method: 'iframe', signal: controller.signal });
    expect(document.querySelector('iframe')).not.toBeNull();

    controller.abort();
    await expect(result).resolves.toBe('not-detected');
    expect(document.querySelector('iframe')).toBeNull();
    expect(removeWindow).toHaveBeenCalledWith('blur', expect.any(Function));
    expect(removeDocument).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not open the link when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(launchDcvClient(LINK, { method: 'iframe', signal: controller.signal })).resolves.toBe('not-detected');
    expect(document.querySelector('iframe')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('defaultLaunchMethod', () => {
  it('uses an iframe in Firefox and a top-level navigation in Chromium browsers', () => {
    expect(defaultLaunchMethod('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0')).toBe('iframe');
    expect(defaultLaunchMethod('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')).toBe('top');
    expect(defaultLaunchMethod('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0')).toBe('top');
  });
});

describe('toDcvClientUrl', () => {
  it('swaps only the leading https:// for dcv://', () => {
    expect(toDcvClientUrl('https://ws.example.com:8444/?q=https://x#s')).toBe('dcv://ws.example.com:8444/?q=https://x#s');
  });
});

describe('nativeClientUrl', () => {
  const session = {
    connectionUrl: 'https://gw.example.com:8443/?authToken=t#s',
    quicConnectionUrl: 'https://gw.example.com:8444/?authToken=t#s',
  };

  it('uses the QUIC URL by default, with webPort so Auto can fall back to TCP (#47)', () => {
    expect(nativeClientUrl(session)).toBe('dcv://gw.example.com:8444/?authToken=t&webPort=8443#s');
    expect(nativeClientUrl(session, 'quic')).toBe('dcv://gw.example.com:8444/?authToken=t&webPort=8443#s');
  });

  it('uses the TCP URL with transport=websocket for websocket, even when a QUIC URL exists (#47)', () => {
    expect(nativeClientUrl(session, 'websocket')).toBe('dcv://gw.example.com:8443/?authToken=t&transport=websocket#s');
  });

  it('leaves the token exactly as the session manager wrote it', () => {
    const raw = 'abc-_.~XYZ019/+=';
    expect(nativeClientUrl({
      connectionUrl: `https://gw.example.com:8443/?authToken=${raw}#s`,
      quicConnectionUrl: `https://gw.example.com:8444/?authToken=${raw}#s`,
    })).toBe(`dcv://gw.example.com:8444/?authToken=${raw}&webPort=8443#s`);
  });

  it('adds a query when the URL has none', () => {
    expect(nativeClientUrl({ connectionUrl: 'https://gw.example.com:8443/#s' }, 'websocket'))
      .toBe('dcv://gw.example.com:8443/?transport=websocket#s');
  });

  it('falls back to connectionUrl when there is no QUIC URL', () => {
    expect(nativeClientUrl({ connectionUrl: session.connectionUrl }, 'quic')).toBe('dcv://gw.example.com:8443/?authToken=t#s');
  });

  it('throws when the response has no usable URL', () => {
    expect(() => nativeClientUrl({})).toThrow(/no connection URL/);
    expect(() => nativeClientUrl({ quicConnectionUrl: session.quicConnectionUrl }, 'websocket')).toThrow(/no connection URL/);
  });

  describe('with the protocol POST /dcv resolved (#138)', () => {
    const tcp = 'dcv://gw.example.com:8443/?authToken=t&transport=websocket#s';
    const quic = 'dcv://gw.example.com:8444/?authToken=t&webPort=8443#s';

    it('connects over TCP when an override resolved to websocket, though Settings say QUIC', () => {
      expect(nativeClientUrl({ ...session, nativeClientTransport: 'websocket' }, 'quic')).toBe(tcp);
    });

    it('connects over QUIC when an override resolved to quic, though Settings say TCP', () => {
      expect(nativeClientUrl({ ...session, nativeClientTransport: 'quic' }, 'websocket')).toBe(quic);
    });

    it('uses the Settings value when the response has no resolved protocol', () => {
      expect(nativeClientUrl(session, 'websocket')).toBe(tcp);
      expect(nativeClientUrl(session, 'quic')).toBe(quic);
    });

    it('treats an unknown resolved value as QUIC, like GET /settings', () => {
      expect(nativeClientUrl({ ...session, nativeClientTransport: 'tcp' }, 'websocket')).toBe(quic);
    });
  });
});

describe('parseNativeClientTransportOverride', () => {
  it('keeps quic and websocket and maps anything else to no override', () => {
    expect(parseNativeClientTransportOverride('websocket')).toBe('websocket');
    expect(parseNativeClientTransportOverride('quic')).toBe('quic');
    expect(parseNativeClientTransportOverride(null)).toBeNull();
    expect(parseNativeClientTransportOverride(undefined)).toBeNull();
    expect(parseNativeClientTransportOverride('tcp')).toBeNull();
  });
});

describe('parseNativeClientTransport', () => {
  it('accepts websocket and maps anything else to quic', () => {
    expect(parseNativeClientTransport('websocket')).toBe('websocket');
    expect(parseNativeClientTransport('quic')).toBe('quic');
    expect(parseNativeClientTransport(undefined)).toBe('quic');
    expect(parseNativeClientTransport('tcp')).toBe('quic');
  });
});

describe('browser viewer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('builds an encoded /connect path', () => {
    expect(browserViewerPath('i-0123456789abcdef0')).toBe('/connect/i-0123456789abcdef0');
    expect(browserViewerPath('a/b?c')).toBe('/connect/a%2Fb%3Fc');
  });

  it('opens the viewer in a new tab without noopener, so the sign-in in sessionStorage is copied', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openBrowserViewer('i-0123456789abcdef0');
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('/connect/i-0123456789abcdef0', '_blank');
  });
});
