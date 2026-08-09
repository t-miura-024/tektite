/**
 * ファイルツリーのファイル操作 UI テスト（M5: 作成・リネーム・移動・削除）。
 *
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TreeDirectory } from '@/domain/tree';
import type { VaultRef } from '@/domain/vault';

import { FileTree } from '@/ui/components/FileTree';

const vaultRef: VaultRef = { owner: 'owner', name: 'repo' };

const ROOT: TreeDirectory = {
  type: 'directory',
  name: '',
  path: '',
  children: [
    {
      type: 'directory',
      name: 'daily',
      path: 'daily',
      children: [{ type: 'file', name: '2026-08-07.md', path: 'daily/2026-08-07.md' }],
    },
    { type: 'file', name: 'a.md', path: 'a.md' },
    { type: 'file', name: 'logo.png', path: 'logo.png' },
  ],
};

interface Rendered {
  container: HTMLElement;
  root: Root;
  callbacks: {
    onCreateNote: ReturnType<typeof vi.fn>;
    onCreateDirectory: ReturnType<typeof vi.fn>;
    onRename: ReturnType<typeof vi.fn>;
    onMove: ReturnType<typeof vi.fn>;
    onDelete: ReturnType<typeof vi.fn>;
  };
}

async function renderTree(
  overrides: Partial<Parameters<typeof FileTree>[0]> = {},
): Promise<Rendered> {
  const callbacks = {
    onCreateNote: vi.fn(),
    onCreateDirectory: vi.fn(),
    onRename: vi.fn(),
    onMove: vi.fn(),
    onDelete: vi.fn(),
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <FileTree
        root={ROOT}
        vaultRef={vaultRef}
        expandedPaths={new Set([''])}
        selectedPath={null}
        onToggleDirectory={vi.fn()}
        onCreateNote={callbacks.onCreateNote}
        onCreateDirectory={callbacks.onCreateDirectory}
        onRename={callbacks.onRename}
        onMove={callbacks.onMove}
        onDelete={callbacks.onDelete}
        {...overrides}
      />,
    );
  });
  return { container, root, callbacks };
}

async function typeValue(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function findByTestId(container: HTMLElement, id: string): HTMLElement {
  const element = container.querySelector(`[data-testid="${id}"]`);
  if (element === null) {
    throw new Error(`data-testid="${id}" が見つかりません`);
  }
  return element as HTMLElement;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('FileTree のファイル操作', () => {
  it('新規ノート: フォームを開いて名前を確定すると onCreateNote が呼ばれる', async () => {
    const { container, root, callbacks } = await renderTree();

    await act(async () => {
      findByTestId(container, 'file-create-note-button').click();
    });
    const input = findByTestId(container, 'file-tree-editor-input') as HTMLInputElement;
    await typeValue(input, 'memo.md');
    await act(async () => {
      findByTestId(container, 'file-tree-editor-submit').click();
    });

    expect(callbacks.onCreateNote).toHaveBeenCalledWith('memo.md');
    expect(callbacks.onCreateDirectory).not.toHaveBeenCalled();
    root.unmount();
  });

  it('新規ノート: .md でない名前は検証エラーになり送信されない', async () => {
    const { container, root, callbacks } = await renderTree();

    await act(async () => {
      findByTestId(container, 'file-create-note-button').click();
    });
    const input = findByTestId(container, 'file-tree-editor-input') as HTMLInputElement;
    await typeValue(input, 'memo');
    await act(async () => {
      findByTestId(container, 'file-tree-editor-submit').click();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('.md');
    expect(callbacks.onCreateNote).not.toHaveBeenCalled();
    root.unmount();
  });

  it('新規フォルダー: 名前を確定すると onCreateDirectory が呼ばれる', async () => {
    const { container, root, callbacks } = await renderTree();

    await act(async () => {
      findByTestId(container, 'file-create-directory-button').click();
    });
    const input = findByTestId(container, 'file-tree-editor-input') as HTMLInputElement;
    await typeValue(input, 'archive');
    await act(async () => {
      findByTestId(container, 'file-tree-editor-submit').click();
    });

    expect(callbacks.onCreateDirectory).toHaveBeenCalledWith('archive');
    root.unmount();
  });

  it('リネーム: コンテキストメニューからインライン入力を開き、新しい名前で onRename が呼ばれる', async () => {
    const { container, root, callbacks } = await renderTree();

    const fileLink = [...container.querySelectorAll('a.file-tree-link')].find(
      (link) => link.textContent === 'a.md',
    );
    if (!fileLink) {
      throw new Error('a.md リンクが見つかりません');
    }
    await act(async () => {
      fileLink.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      findByTestId(container, 'file-menu-rename').click();
    });

    const input = findByTestId(container, 'file-rename-input') as HTMLInputElement;
    expect(input.value).toBe('a.md');
    await typeValue(input, 'b.md');
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });

    expect(callbacks.onRename).toHaveBeenCalledWith('a.md', 'file', 'b.md');
    root.unmount();
  });

  it('削除: 確認ダイアログの確定を挟まないと onDelete は呼ばれない', async () => {
    const { container, root, callbacks } = await renderTree();

    const fileLink = [...container.querySelectorAll('a.file-tree-link')].find(
      (link) => link.textContent === 'a.md',
    );
    if (!fileLink) {
      throw new Error('a.md リンクが見つかりません');
    }
    await act(async () => {
      fileLink.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      findByTestId(container, 'file-menu-delete').click();
    });
    expect(callbacks.onDelete).not.toHaveBeenCalled();

    // キャンセルでは呼ばれない
    const cancelButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'キャンセル',
    );
    await act(async () => {
      cancelButton?.click();
    });
    expect(callbacks.onDelete).not.toHaveBeenCalled();

    // 改めて開いて確定すると呼ばれる
    await act(async () => {
      fileLink.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      findByTestId(container, 'file-menu-delete').click();
    });
    await act(async () => {
      findByTestId(container, 'confirm-dialog-confirm').click();
    });
    expect(callbacks.onDelete).toHaveBeenCalledWith('a.md', 'file');
    root.unmount();
  });

  it('移動: 移動先ダイアログにルートとディレクトリが並び、ディレクトリ自身の配下は無効化される', async () => {
    const { container, root, callbacks } = await renderTree();

    const dirToggle = [...container.querySelectorAll('button.file-tree-toggle')].find((button) =>
      button.textContent?.includes('daily'),
    );
    if (!dirToggle) {
      throw new Error('daily トグルが見つかりません');
    }
    await act(async () => {
      dirToggle.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      findByTestId(container, 'file-menu-move').click();
    });

    // 移動先候補: ルート（''）と daily。daily は自身の配下のため無効
    const options = container.querySelectorAll('[data-testid="move-dialog-option"]');
    const blocked = container.querySelectorAll('[data-testid="move-dialog-blocked"]');
    expect(options.length).toBe(1); // ルートのみ
    expect(blocked.length).toBe(1); // daily は自身の配下として無効
    expect(blocked[0]?.textContent).toContain('daily');

    await act(async () => {
      findByTestId(container, 'move-dialog-confirm').click();
    });
    expect(callbacks.onMove).toHaveBeenCalledWith('daily', 'directory', '');
    root.unmount();
  });

  it('ファイルの移動は現在の親ディレクトリ（ルート含む）を選べない', async () => {
    const { container, root, callbacks } = await renderTree();

    const fileLink = [...container.querySelectorAll('a.file-tree-link')].find(
      (link) => link.textContent === 'logo.png',
    );
    if (!fileLink) {
      throw new Error('logo.png リンクが見つかりません');
    }
    await act(async () => {
      fileLink.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      findByTestId(container, 'file-menu-move').click();
    });

    // logo.png はルート直下のため、現在の親（Vault ルート）は無効。選べるのは daily のみ
    const options = container.querySelectorAll('[data-testid="move-dialog-option"]');
    const blocked = container.querySelectorAll('[data-testid="move-dialog-blocked"]');
    expect(options.length).toBe(1); // daily（現在の親のルートは無効）
    expect(blocked.length).toBe(1);
    expect(blocked[0]?.textContent).toContain('Vault ルート');
    await act(async () => {
      (options[0] as HTMLElement).click();
    });
    await act(async () => {
      findByTestId(container, 'move-dialog-confirm').click();
    });
    expect(callbacks.onMove).toHaveBeenCalledWith('logo.png', 'file', 'daily');
    root.unmount();
  });
});
