// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The DCV client prompt: layout, Connect / Cancel / Connect (PR #80 live
 * test), and Try again cleanup. Renders the real hook and Ant Design Modal
 * with react-dom + act.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useDcvClientPrompt } from './DcvClientPrompt';
import { DCV_CLIENT_DOWNLOAD_URL, DCV_LAUNCH_TIMEOUT_MS } from '../utils/dcvClient';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let connect: (dcvUrl: string, browserUrl?: string) => Promise<void>;
let modalOpen = false;
let browserSessionsEnabled = true;

function Harness() {
  const prompt = useDcvClientPrompt(browserSessionsEnabled);
  connect = prompt.connectWithClient;
  modalOpen = (prompt.promptModal as React.ReactElement<{ open?: boolean }>).props.open === true;
  return prompt.promptModal;
}

/** The dialog's `open` prop from the latest render. */
function promptVisible(): boolean {
  return modalOpen;
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button "${label}"`);
  return found as HTMLButtonElement;
}

function footerButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll('.ant-modal-footer button'));
}

async function connectAndTimeOut(duringLaunch?: () => void) {
  let done!: Promise<void>;
  await act(async () => {
    done = connect('dcv://ws.example.com:8444/?authToken=t#s', 'https://ws.example.com:8443/?authToken=t#s');
    duringLaunch?.();
  });
  await act(async () => {
    vi.advanceTimersByTime(DCV_LAUNCH_TIMEOUT_MS);
    await done;
  });
}

describe('useDcvClientPrompt', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    browserSessionsEnabled = true;
    vi.useFakeTimers();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: false, media: query, onchange: null,
        addListener: () => {}, removeListener: () => {},
        addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
      }),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Harness />));
  });

  function rerender() {
    act(() => root.render(<Harness />));
  }

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('shows the prompt again on a second connect after Cancel', async () => {
    await connectAndTimeOut();
    expect(promptVisible()).toBe(true);

    await act(async () => {
      button('Cancel').click();
      vi.advanceTimersByTime(1000);
    });
    expect(promptVisible()).toBe(false);

    await connectAndTimeOut();
    expect(promptVisible()).toBe(true);
  });

  it('shows the prompt again when the second connect only blurs the window briefly', async () => {
    // The browser window keeps focus overall: a blur from a browser or OS
    // prompt, or DevTools, that hands focus straight back.
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    await connectAndTimeOut();
    expect(promptVisible()).toBe(true);

    await act(async () => {
      button('Cancel').click();
      vi.advanceTimersByTime(1000);
    });
    expect(promptVisible()).toBe(false);

    await connectAndTimeOut(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    });
    expect(promptVisible()).toBe(true);
  });

  it('shows the title, one line with a download link, and Cancel / Connect in browser / Try again', async () => {
    await connectAndTimeOut();

    expect(document.querySelector('.ant-modal-title')?.textContent).toBe("DCV client didn't open");
    const body = document.querySelector('.ant-modal-body')!;
    expect(body.textContent?.replace(/\s+/g, ' ').trim()).toBe('Install the Amazon DCV client, then try again. Download the DCV client');
    const link = body.querySelector('a')!;
    expect(link.getAttribute('href')).toBe(DCV_CLIENT_DOWNLOAD_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent?.trim()).toBe('Download the DCV client');
    expect(link.querySelector('.anticon-download')).not.toBeNull();

    const buttons = footerButtons();
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['Cancel', 'Connect in browser', 'Try again']);
    expect(buttons[2].classList.contains('ant-btn-primary')).toBe(true);
    expect(buttons[0].classList.contains('ant-btn-primary')).toBe(false);
  });

  it('hides Connect in browser when browser sessions are off', async () => {
    browserSessionsEnabled = false;
    rerender();
    await connectAndTimeOut();
    expect(footerButtons().map((b) => b.textContent?.trim())).toEqual(['Cancel', 'Try again']);
  });

  it('shows Try again as loading while it retries', async () => {
    await connectAndTimeOut();
    await act(async () => {
      button('Try again').click();
    });
    expect(footerButtons()[2].classList.contains('ant-btn-loading')).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(DCV_LAUNCH_TIMEOUT_MS);
    });
    expect(footerButtons()[2].classList.contains('ant-btn-loading')).toBe(false);
    expect(promptVisible()).toBe(true);
  });

  it('Cancel stops a running Try again launch: its listeners and timer are removed', async () => {
    await connectAndTimeOut();
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const timeouts = vi.spyOn(globalThis, 'clearTimeout');

    await act(async () => {
      button('Try again').click();
    });
    const blur = add.mock.calls.find((call: unknown[]) => call[0] === 'blur');
    expect(blur).toBeDefined();
    expect(remove).not.toHaveBeenCalledWith('blur', blur![1]);

    await act(async () => {
      button('Cancel').click();
    });
    expect(remove).toHaveBeenCalledWith('blur', blur![1]);
    expect(timeouts).toHaveBeenCalled();
    expect(promptVisible()).toBe(false);

    // A blur after Cancel reaches no launcher, and Connect still prompts.
    add.mockClear();
    await connectAndTimeOut();
    expect(promptVisible()).toBe(true);
  });
});
