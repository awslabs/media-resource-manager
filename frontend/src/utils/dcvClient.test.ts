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
} from './dcvClient';

const LINK = 'dcv://workstation.example.com:8444/?authToken=test#session';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
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

  it('opens the link in a hidden iframe and reports launched when the window loses focus', async () => {
    const result = launchDcvClient(LINK, { method: 'iframe' });

    const iframe = document.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe!.style.display).toBe('none');
    expect(iframe!.getAttribute('src')).toBe(LINK);

    window.dispatchEvent(new Event('blur'));
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

  it('settles once: a blur after the timeout does not change the result', async () => {
    const result = launchDcvClient(LINK, { method: 'iframe' });
    vi.advanceTimersByTime(DCV_LAUNCH_TIMEOUT_MS);
    window.dispatchEvent(new Event('blur'));
    await expect(result).resolves.toBe('not-detected');
  });

  it('clears the timeout when the launch is detected', async () => {
    const result = launchDcvClient(LINK, { method: 'iframe' });
    window.dispatchEvent(new Event('blur'));
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses a top-level navigation by default outside Firefox, with no iframe', async () => {
    // jsdom prints "Not implemented: navigation" for the dcv:// link; the
    // launcher must still run its detection and clean up.
    const result = launchDcvClient(LINK, { method: 'top' });
    expect(document.querySelector('iframe')).toBeNull();

    window.dispatchEvent(new Event('blur'));
    await expect(result).resolves.toBe('launched');
    expectListenersRemoved();
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
