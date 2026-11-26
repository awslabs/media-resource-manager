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

let connect: (dcvUrl: string, instanceId?: string) => Promise<void>;
let modalOpen = false;
let browserSessionsEnabled = true;

function Harness() {
  const prompt = useDcvClientPrompt(browserSessionsEnabled);
  connect = prompt.connectWithClient;
  // promptModal holds the install prompt first, then the #139 "didn't connect" message.
  const [installPrompt] = React.Children.toArray(
    (prompt.promptModal as React.ReactElement<{ children: React.ReactNode }>).props.children,
  ) as React.ReactElement<{ open?: boolean }>[];
  modalOpen = installPrompt.props.open === true;
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
    done = connect('dcv://ws.example.com:8444/?authToken=t#s', 'i-0123456789abcdef0');
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
    const paragraphs = Array.from(body.querySelectorAll('div.ant-typography'));
    expect(paragraphs.map((el) => el.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Install the Amazon DCV client, then try again.',
      'Download the DCV client',
    ]);
    // The link has its own line and doesn't wrap mid-phrase.
    const link = paragraphs[1].querySelector('a')!;
    expect(link).not.toBeNull();
    expect(paragraphs[0].querySelector('a')).toBeNull();
    expect(link.style.whiteSpace).toBe('nowrap');
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

  it('Connect in browser opens the console viewer in a new tab, keeping the opener, and closes the dialog', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await connectAndTimeOut();
    await act(async () => {
      button('Connect in browser').click();
    });
    expect(open).toHaveBeenCalledWith('/connect/i-0123456789abcdef0', '_blank');
    expect(promptVisible()).toBe(false);
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

  it('puts the initial focus on Try again on every open, not on the close button', async () => {
    await connectAndTimeOut();
    expect(document.activeElement?.textContent?.trim()).toBe('Try again');

    await act(async () => {
      button('Cancel').click();
      vi.advanceTimersByTime(1000);
    });
    await connectAndTimeOut();
    expect(promptVisible()).toBe(true);
    expect(document.activeElement?.textContent?.trim()).toBe('Try again');
    expect(document.activeElement?.classList.contains('ant-modal-close')).toBe(false);
  });

  it('still closes on Esc and on the close button', async () => {
    await connectAndTimeOut();
    await act(async () => {
      (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(promptVisible()).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await connectAndTimeOut();
    expect(promptVisible()).toBe(true);
    await act(async () => {
      (document.querySelector('.ant-modal-close') as HTMLButtonElement).click();
    });
    expect(promptVisible()).toBe(false);
  });
});
