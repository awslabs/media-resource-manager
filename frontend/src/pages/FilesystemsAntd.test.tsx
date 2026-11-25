// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deleting storage from the Filesystems page: when the API says FSx keeps a
 * final backup, the page shows it with the file system or volume ID, the
 * Region and the commands to find and delete the backup. The API, the layout
 * and the Actions dropdown are mocked; the page, its table and modal are real.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const FINAL_BACKUP = {
  resourceType: 'file system',
  resourceId: 'fs-0123456789abcdef0',
  region: 'us-west-2',
  message: 'FSx keeps a final backup of file system fs-0123456789abcdef0 in us-west-2 until you delete it, and bills it for its storage. The backup appears when the deletion finishes.',
  findCommand: 'aws fsx describe-backups --region us-west-2 --filters Name=file-system-id,Values=fs-0123456789abcdef0',
  deleteCommand: 'aws fsx delete-backup --region us-west-2 --backup-id <backup-id>',
};

let deleteBody: Record<string, unknown>;
const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response;

vi.mock('../utils/api', () => ({
  apiCall: vi.fn(async (endpoint: string, options: RequestInit = {}) => {
    if (options.method === 'DELETE') return json(deleteBody);
    if (endpoint === 'storage') {
      return json([{ storageId: 'st-1', name: 'projects', type: 'fsx-windows', status: 'available', region: 'us-west-2', fsxFileSystemId: 'fs-0123456789abcdef0' }]);
    }
    return json([]);
  }),
}));
vi.mock('../utils/auth', () => ({ getAuthToken: () => 'token' }));
vi.mock('../utils/storageApi', () => ({
  listStorageS3Buckets: vi.fn(async () => []),
  getStorageConfig: vi.fn(async () => ({})),
  getStoragePricing: vi.fn(async () => null),
}));
vi.mock('../components/AppLayoutAntd', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
// Render the Actions menu items as buttons, so the test needn't hover.
vi.mock('antd', async (importOriginal) => {
  const antd = await importOriginal<typeof import('antd')>();
  return {
    ...antd,
    Dropdown: ({ menu, children }: { menu: { items: any[] }; children: React.ReactNode }) => (
      <div>
        {children}
        {menu.items.filter((i) => i && i.label).map((i) => (
          <button key={i.key} data-menu-item={i.key} disabled={i.disabled} onClick={i.onClick}>{i.label}</button>
        ))}
      </div>
    ),
  };
});

// eslint-disable-next-line import/first
import FilesystemsAntd from './FilesystemsAntd';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.matchMedia = window.matchMedia || ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function deleteFirstRow() {
  await act(async () => {
    root.render(<FilesystemsAntd user={{}} isAdmin onSignOut={() => undefined} config={{ region: 'us-east-1' }} />);
  });
  await flush();
  const rowCheckbox = container.querySelector('tbody input[type="checkbox"]') as HTMLInputElement;
  expect(rowCheckbox).toBeTruthy();
  await act(async () => { rowCheckbox.click(); });
  const deleteItem = container.querySelector('button[data-menu-item="delete"]') as HTMLButtonElement;
  await act(async () => { deleteItem.click(); });
  await flush();
  const dialog = document.querySelector('.ant-modal') as HTMLElement;
  expect(dialog.textContent).toContain('FSx keeps a final backup of each deleted FSx for Windows file system');
  const ok = Array.from(document.querySelectorAll('.ant-modal-footer button')).find((b) => b.textContent?.trim() === 'Delete') as HTMLButtonElement;
  await act(async () => { ok.click(); });
  await flush();
}

describe('FilesystemsAntd storage delete', () => {
  it('shows the final backup with its file system, Region and commands', async () => {
    deleteBody = { success: true, message: 'Storage deletion started', storageId: 'st-1', status: 'deleting', finalBackup: FINAL_BACKUP };
    await deleteFirstRow();
    const details = document.querySelector('[data-testid="final-backup-details"]') as HTMLElement;
    expect(details).toBeTruthy();
    expect(details.textContent).toContain(FINAL_BACKUP.message);
    expect(details.textContent).toContain(FINAL_BACKUP.findCommand);
    expect(details.textContent).toContain(FINAL_BACKUP.deleteCommand);
    expect(document.body.textContent).toContain('Deletion started for 1 resource(s)');
  });

  it('shows only the started message when no backup is kept', async () => {
    deleteBody = { success: true, message: 'Storage deletion started', storageId: 'st-1', status: 'deleting' };
    await deleteFirstRow();
    expect(document.querySelector('[data-testid="final-backup-details"]')).toBeNull();
    expect(document.body.textContent).toContain('Deletion started for 1 resource(s)');
  });
});
