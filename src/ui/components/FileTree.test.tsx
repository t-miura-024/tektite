/**
 * ファイルツリーのファイル操作 UI テスト（M5: 作成・リネーム・移動・複製・削除）。
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
    onDuplicate: ReturnType<typeof vi.fn>;
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
    onDuplicate: vi.fn(),
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
        onDuplicate={callbacks.onDuplicate}
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

/** 指定した名前のツリー項目を右クリックしてメニューを開く */
async function openContextMenu(container: HTMLElement, name: string): Promise<void> {
  const item = [...container.querySelectorAll('a.file-tree-link, button.file-tree-toggle')].find(
    (element) => element.textContent?.includes(name),
  );
  if (!item) {
    throw new Error(`ツリー項目「${name}」が見つかりません`);
  }
  await act(async () => {
    item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('FileTree のファイル操作', () => {
  it('新規ノート: ツールバーのボタンで onCreateNote("") が呼ばれる（Obsidian 式）', async () => {
    const { container, root, callbacks } = await renderTree();

    await act(async () => {
      findByTestId(container, 'file-create-note-button').click();
    });

    expect(callbacks.onCreateNote).toHaveBeenCalledWith('');
    expect(callbacks.onCreateDirectory).not.toHaveBeenCalled();
    root.unmount();
  });

  it('新規ノート: フォルダのコンテキストメニューで onCreateNote(フォルダパス) が呼ばれる', async () => {
    const { container, root, callbacks } = await renderTree();

    await openContextMenu(container, 'daily');
    await act(async () => {
      findByTestId(container, 'file-menu-create-note').click();
    });

    expect(callbacks.onCreateNote).toHaveBeenCalledWith('daily');
    root.unmount();
  });

  it('新規ノート: ノートのコンテキストメニューには新規作成項目が出ない（Q1:1 出し分け）', async () => {
    const { container, root, callbacks } = await renderTree();

    await openContextMenu(container, 'a.md');
    expect(container.querySelector('[data-testid="file-menu-create-note"]')).toBeNull();
    expect(container.querySelector('[data-testid="file-menu-create-directory"]')).toBeNull();
    expect(callbacks.onCreateNote).not.toHaveBeenCalled();
    root.unmount();
  });

  it('空き領域の右クリック: 新規ノート / 新規フォルダ（ルート直下）のメニューが開く', async () => {
    const { container, root, callbacks } = await renderTree();

    await act(async () => {
      const region = container.querySelector('.file-tree-region');
      region?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      findByTestId(container, 'file-menu-create-note').click();
    });

    expect(callbacks.onCreateNote).toHaveBeenCalledWith('');
    root.unmount();
  });

  it('新規フォルダー: ツールバーのボタンで入力が開き、確定すると onCreateDirectory("", name) が呼ばれる', async () => {
    const { container, root, callbacks } = await renderTree();

    await act(async () => {
      findByTestId(container, 'file-create-directory-button').click();
    });
    const input = findByTestId(container, 'file-tree-editor-input') as HTMLInputElement;
    await typeValue(input, 'archive');
    await act(async () => {
      findByTestId(container, 'file-tree-editor-submit').click();
    });

    expect(callbacks.onCreateDirectory).toHaveBeenCalledWith('', 'archive');
    root.unmount();
  });

  it('新規フォルダー: フォルダのコンテキストメニューで対象フォルダ直下に作成する', async () => {
    const { container, root, callbacks } = await renderTree({
      expandedPaths: new Set(['', 'daily']),
    });

    await openContextMenu(container, 'daily');
    await act(async () => {
      findByTestId(container, 'file-menu-create-directory').click();
    });
    const input = findByTestId(container, 'file-tree-editor-input') as HTMLInputElement;
    await typeValue(input, 'archive');
    await act(async () => {
      findByTestId(container, 'file-tree-editor-submit').click();
    });

    expect(callbacks.onCreateDirectory).toHaveBeenCalledWith('daily', 'archive');
    root.unmount();
  });

  it('新規フォルダー: 閉じたフォルダのメニューから作成すると自動展開される（Q8:1）', async () => {
    const onToggleDirectory = vi.fn();
    const { container, root, callbacks } = await renderTree({
      expandedPaths: new Set(['']),
      onToggleDirectory,
    });

    await openContextMenu(container, 'daily');
    await act(async () => {
      findByTestId(container, 'file-menu-create-directory').click();
    });

    expect(onToggleDirectory).toHaveBeenCalledWith('daily');
    expect(callbacks.onCreateDirectory).not.toHaveBeenCalled();
    root.unmount();
  });

  it('複製: コンテキストメニューから onDuplicate が呼ばれる（フォルダ・ノート共通項目）', async () => {
    const { container, root, callbacks } = await renderTree();

    await openContextMenu(container, 'a.md');
    await act(async () => {
      findByTestId(container, 'file-menu-duplicate').click();
    });
    expect(callbacks.onDuplicate).toHaveBeenCalledWith('a.md', 'file');

    await openContextMenu(container, 'daily');
    await act(async () => {
      findByTestId(container, 'file-menu-duplicate').click();
    });
    expect(callbacks.onDuplicate).toHaveBeenCalledWith('daily', 'directory');
    root.unmount();
  });

  it('リネーム: コンテキストメニュー「名前を変更」からインライン入力を開き、onRename が呼ばれる', async () => {
    const { container, root, callbacks } = await renderTree();

    await openContextMenu(container, 'a.md');
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

    await openContextMenu(container, 'a.md');
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
    await openContextMenu(container, 'a.md');
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

    await openContextMenu(container, 'daily');
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

    await openContextMenu(container, 'logo.png');
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

  it('コンテキストメニュー: ↑↓ で項目移動、Enter で実行、Escape で閉じる（Q10:1）', async () => {
    const { container, root } = await renderTree();

    await openContextMenu(container, 'a.md');
    const menu = findByTestId(container, 'file-context-menu');

    // 最初の項目（複製を作成）にフォーカスされている
    const items = () => container.querySelectorAll('[role="menuitem"]');
    expect(items().length).toBe(4);
    expect(document.activeElement?.textContent).toBe('複製を作成');

    // ↓ で 2 番目（名前を変更）
    await act(async () => {
      menu.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement?.textContent).toBe('名前を変更');

    // Enter で実行（名前を変更 → インライン入力が開く）
    await act(async () => {
      menu.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });
    expect(container.querySelector('[data-testid="file-rename-input"]')).not.toBeNull();

    // リネーム入力を Escape で閉じて、再びメニューを開く
    await act(async () => {
      findByTestId(container, 'file-rename-input').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    await openContextMenu(container, 'a.md');
    await act(async () => {
      findByTestId(container, 'file-context-menu').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(container.querySelector('[data-testid="file-context-menu"]')).toBeNull();
    root.unmount();
  });
});
