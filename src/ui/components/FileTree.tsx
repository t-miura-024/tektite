/**
 * ファイルツリー表示 + ファイル操作（作成・リネーム・移動・複製・削除）。
 *
 * - ドメイン層が構築したツリー（src/domain/tree）を描画する
 * - ファイル選択はノートパスの URL（/:owner/:repo/blob/:path）へ SPA 遷移
 * - ツールバー: 新規ノート（Obsidian 式: デフォルト名で即作成しエディタで開く）/
 *   新規フォルダー（ツリー内インライン入力）
 * - コンテキストメニュー（右クリック）: 右クリック対象で出し分ける
 *   - フォルダ: 新規ノート / 新規フォルダ ─ 複製を作成 / 名前を変更 / 移動… ─ 削除
 *   - ノート: 複製を作成 / 名前を変更 / 移動… ─ 削除
 *   - 空き領域: 新規ノート / 新規フォルダ（ルート直下）
 *   - キーボード: ↑↓ で項目移動 / Enter で実行 / Escape で閉じる
 * - 実際の操作（一括コミット）は VaultScreen のコールバックが担い、ここでは
 *   操作 UI の状態（入力・メニュー・ダイアログ）だけを持つ
 * - role="tree" / treeitem でスクリーンリーダーにも構造が伝わるようにする
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react';

import { validateEntryName } from '@/application/file';
import type { TreeDirectory, TreeNode } from '@/domain/tree';
import { joinDirectoryPath, pathBaseName, parentDirectoryPath } from '@/domain/tree';
import type { VaultRef } from '@/domain/vault';

import { ConfirmDialog } from '@/ui/components/ConfirmDialog';
import { Link } from '@/ui/components/Link';
import { MoveDialog } from '@/ui/components/MoveDialog';
import { noteRoutePath } from '@/ui/router';

export interface FileTreeProps {
  root: TreeDirectory;
  vaultRef: VaultRef;
  /** 展開中のディレクトリパス集合（ルートは ''） */
  expandedPaths: ReadonlySet<string>;
  /** 選択中のノートパス（未選択は null） */
  selectedPath: string | null;
  onToggleDirectory: (path: string) => void;
  /** 新規ノート（Obsidian 式: directory 直下にデフォルト名で作成し、エディタで開く） */
  onCreateNote: (directory: string) => void;
  /** 新規フォルダー（directory 直下に name で作成する） */
  onCreateDirectory: (directory: string, name: string) => void;
  /** 複製を作成する（対象パスと種別） */
  onDuplicate: (path: string, type: 'file' | 'directory') => void;
  onOpenSearch?: () => void;
  onOpenQuickSwitcher?: () => void;
  onRevealCurrent?: () => void;
  onToggleAll?: () => void;
  allExpanded?: boolean;
  /** リネーム（newName は 1 セグメントの新しい名前）をコミットする */
  onRename: (path: string, type: 'file' | 'directory', newName: string) => void;
  /** 移動（targetDirectory は '' でルート）をコミットする */
  onMove: (path: string, type: 'file' | 'directory', targetDirectory: string) => void;
  /** 削除（実削除。確認ダイアログはこのコンポーネントが挟む）をコミットする */
  onDelete: (path: string, type: 'file' | 'directory') => void;
}

/** コンテキストメニュー 1 項目 */
interface MenuItem {
  readonly key: string;
  readonly label: string;
  /** グループ（区切り線の挿入に使う） */
  readonly group: 'create' | 'operate' | 'danger';
  readonly onSelect: () => void;
}

/** コンテキストメニューの表示状態（座標は固定配置用のビューポート座標） */
interface MenuState {
  readonly x: number;
  readonly y: number;
  readonly items: readonly MenuItem[];
}

/** コンテキストメニューを開く対象（項目 or 空き領域） */
type MenuTarget = { readonly path: string; readonly type: 'file' | 'directory' } | 'root';

/** ツリーから全ディレクトリパス（ルート '' を含む）を収集する */
function collectDirectories(root: TreeDirectory): string[] {
  const paths: string[] = [''];
  const walk = (directory: TreeDirectory): void => {
    for (const child of directory.children) {
      if (child.type === 'directory') {
        paths.push(child.path);
        walk(child);
      }
    }
  };
  walk(root);
  return paths;
}

/** ディレクトリ自身とその配下（自身を自身の中へ移動できないようにする） */
function descendants(path: string, directories: readonly string[]): Set<string> {
  const blocked = new Set<string>();
  for (const directory of directories) {
    if (directory === path || directory.startsWith(`${path}/`)) {
      blocked.add(directory);
    }
  }
  return blocked;
}

/**
 * 移動ダイアログの禁止先（自分自身の配下。ファイルは現在の親ディレクトリも）。
 * ファイルを現在の親へ「移動」すると to === from になり、
 * コミット側が「移動元と移動先が同じです」のエラーを返すため、未然に防ぐ。
 */
function blockedMoveTargets(
  target: { readonly path: string; readonly type: 'file' | 'directory' },
  directories: readonly string[],
): Set<string> {
  const blocked = descendants(target.path, directories);
  if (target.type === 'file') {
    const lastSlash = target.path.lastIndexOf('/');
    blocked.add(lastSlash === -1 ? '' : target.path.slice(0, lastSlash));
  }
  return blocked;
}

type ActionIconName =
  | 'file-plus'
  | 'folder-plus'
  | 'search'
  | 'switcher'
  | 'locate'
  | 'expand'
  | 'collapse';

function ActionIcon({ name }: { name: ActionIconName }) {
  const paths: Record<ActionIconName, string> = {
    'file-plus': 'M4 2.5h7l3 3v10H4z M11 2.5v3h3 M8.5 9v4 M6.5 11h4',
    'folder-plus': 'M2.5 5.5h5l1.5 1.5h8v8.5h-14.5z M9.5 9v4 M7.5 11h4',
    search: 'm14 14 3.5 3.5 M15 9.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Z',
    switcher: 'M4 5h12 M4 9h8 M4 13h10 M14 11l2 2-2 2',
    locate: 'M9.5 3v3 M9.5 13v3 M3 9.5h3 M13 9.5h3 M12.5 9.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
    expand: 'M4 7V4h3 M13 4h3v3 M16 13v3h-3 M7 16H4v-3',
    collapse: 'M7 4H4v3 M13 4h3v3 M4 13v3h3 M16 13v3h-3',
  };
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d={paths[name]} />
    </svg>
  );
}

/** 新規フォルダーのインライン入力（Enter で確定・Escape で解除。検証は入力内で行う） */
function CreateDirectoryEditor({
  onSubmit,
  onCancel,
}: {
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (): void => {
    const name = value.trim();
    const message = validateEntryName(name, false);
    if (message !== null) {
      setError(message);
      return;
    }
    onSubmit(name);
  };

  return (
    <div className="file-tree-editor" data-testid="file-tree-editor">
      <input
        ref={inputRef}
        type="text"
        value={value}
        aria-label="新しいフォルダー名"
        data-testid="file-tree-editor-input"
        placeholder="フォルダー名（例: daily）"
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <button
        type="button"
        className="button-primary"
        data-testid="file-tree-editor-submit"
        onClick={submit}
      >
        作成
      </button>
      <button type="button" className="button-secondary" onClick={onCancel}>
        キャンセル
      </button>
      {error !== null && (
        <p className="file-tree-editor-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function FileTree({
  root,
  vaultRef,
  expandedPaths,
  selectedPath,
  onToggleDirectory,
  onCreateNote,
  onCreateDirectory,
  onDuplicate,
  onOpenSearch,
  onOpenQuickSwitcher,
  onRevealCurrent,
  onToggleAll,
  allExpanded = false,
  onRename,
  onMove,
  onDelete,
}: FileTreeProps) {
  /** コンテキストメニュー（null は非表示） */
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** キーボード操作中のメニュー項目位置 */
  const [menuActive, setMenuActive] = useState(0);
  const menuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /** 新規フォルダー作成フォーム（'' はルート直下） */
  const [creating, setCreating] = useState<string | null>(null);
  /** リネーム対象（null は非表示） */
  const [renaming, setRenaming] = useState<{ path: string; type: 'file' | 'directory' } | null>(
    null,
  );
  /** 移動ダイアログの対象（null は非表示） */
  const [moveTarget, setMoveTarget] = useState<{ path: string; type: 'file' | 'directory' } | null>(
    null,
  );
  /** 削除確認ダイアログの対象（null は非表示） */
  const [deleteTarget, setDeleteTarget] = useState<{
    path: string;
    type: 'file' | 'directory';
  } | null>(null);

  // ツリーが差し替わる（操作後の再読込・Vault 切替）たびに操作 UI を閉じる
  useEffect(() => {
    setMenu(null);
    setCreating(null);
    setRenaming(null);
    setMoveTarget(null);
    setDeleteTarget(null);
  }, [root]);

  // メニュー表示中は外部クリックで閉じる（メニュー内クリックは閉じない）
  useEffect(() => {
    if (menu === null) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (
        !(event.target instanceof HTMLElement) ||
        event.target.closest('[data-testid="file-context-menu"]') === null
      ) {
        setMenu(null);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menu]);

  // メニューが開いたら最初の項目へフォーカスする（キーボード操作の起点）
  useEffect(() => {
    if (menu === null) {
      return;
    }
    setMenuActive(0);
    menuItemRefs.current[0]?.focus();
  }, [menu]);

  const directories = useCallback(() => collectDirectories(root), [root]);

  /** 新規フォルダー作成フォームを開く（閉じたフォルダなら自動展開する） */
  const openCreate = useCallback(
    (directory: string) => {
      if (directory !== '' && !expandedPaths.has(directory)) {
        onToggleDirectory(directory);
      }
      setCreating(directory);
    },
    [expandedPaths, onToggleDirectory],
  );

  /** コンテキストメニューを開く（座標はビューポート内にクランプする） */
  const openMenu = useCallback(
    (target: MenuTarget, x: number, y: number) => {
      const width = 180;
      const height = 230;
      const items: MenuItem[] = [];
      if (target === 'root') {
        items.push({
          key: 'create-note',
          label: '新規ノート',
          group: 'create',
          onSelect: () => onCreateNote(''),
        });
        items.push({
          key: 'create-directory',
          label: '新規フォルダ',
          group: 'create',
          onSelect: () => openCreate(''),
        });
      } else {
        if (target.type === 'directory') {
          items.push({
            key: 'create-note',
            label: '新規ノート',
            group: 'create',
            onSelect: () => onCreateNote(target.path),
          });
          items.push({
            key: 'create-directory',
            label: '新規フォルダ',
            group: 'create',
            onSelect: () => openCreate(target.path),
          });
        }
        items.push({
          key: 'duplicate',
          label: '複製を作成',
          group: 'operate',
          onSelect: () => onDuplicate(target.path, target.type),
        });
        items.push({
          key: 'rename',
          label: '名前を変更',
          group: 'operate',
          onSelect: () => setRenaming({ path: target.path, type: target.type }),
        });
        items.push({
          key: 'move',
          label: '移動…',
          group: 'operate',
          onSelect: () => setMoveTarget({ path: target.path, type: target.type }),
        });
        items.push({
          key: 'delete',
          label: '削除',
          group: 'danger',
          onSelect: () => setDeleteTarget({ path: target.path, type: target.type }),
        });
      }
      setMenu({
        x: Math.max(0, Math.min(x, window.innerWidth - width)),
        y: Math.max(0, Math.min(y, window.innerHeight - height)),
        items,
      });
    },
    [onCreateNote, onDuplicate, openCreate],
  );

  /** メニューのキーボード操作（↑↓ で移動 / Enter で実行 / Escape で閉じる） */
  const handleMenuKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (menu === null) {
        return;
      }
      const count = menu.items.length;
      const focusAt = (index: number): void => {
        setMenuActive(index);
        menuItemRefs.current[index]?.focus();
      };
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusAt((menuActive + 1) % count);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusAt((menuActive - 1 + count) % count);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const item = menu.items[menuActive];
        if (item !== undefined) {
          setMenu(null);
          item.onSelect();
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setMenu(null);
      }
    },
    [menu, menuActive],
  );

  /** リネーム入力の確定（名前を検証してコールバックへ渡す） */
  const submitRename = useCallback(
    (newName: string) => {
      if (renaming === null) {
        return;
      }
      const name = newName.trim();
      const error = validateEntryName(name, renaming.path.endsWith('.md'));
      if (error !== null) {
        // エラーは InlineRenameInput が保持するためここには来ない（防御線）
        return;
      }
      const target = joinDirectoryPath(parentDirectoryPath(renaming.path), name);
      if (target !== renaming.path) {
        onRename(renaming.path, renaming.type, name);
      }
      setRenaming(null);
    },
    [renaming, onRename],
  );

  return (
    <>
      <div className="file-tree-toolbar">
        <button
          type="button"
          className="button-secondary"
          data-testid="file-create-note-button"
          aria-label="新規ノート"
          title="新規ノート"
          onClick={() => onCreateNote('')}
        >
          <ActionIcon name="file-plus" />
        </button>
        <button
          type="button"
          className="button-secondary"
          data-testid="file-create-directory-button"
          aria-label="新規フォルダー"
          title="新規フォルダー"
          onClick={() => openCreate('')}
        >
          <ActionIcon name="folder-plus" />
        </button>
        <button
          type="button"
          className="button-secondary file-tree-action-button"
          aria-label="検索"
          title="検索 ⌘K"
          onClick={() => onOpenSearch?.()}
        >
          <ActionIcon name="search" />
        </button>
        <button
          type="button"
          className="button-secondary file-tree-action-button"
          aria-label="移動"
          title="移動 ⌘O"
          onClick={() => onOpenQuickSwitcher?.()}
        >
          <ActionIcon name="switcher" />
        </button>
        <button
          type="button"
          className="button-secondary file-tree-action-button"
          aria-label="現在のNoteを表示"
          title="現在のNoteを表示"
          disabled={selectedPath === null}
          onClick={() => onRevealCurrent?.()}
        >
          <ActionIcon name="locate" />
        </button>
        <button
          type="button"
          className="button-secondary file-tree-action-button"
          aria-label={allExpanded ? 'すべて折りたたむ' : 'すべて展開'}
          title={allExpanded ? 'すべて折りたたむ' : 'すべて展開'}
          aria-pressed={allExpanded}
          onClick={() => onToggleAll?.()}
        >
          <ActionIcon name={allExpanded ? 'collapse' : 'expand'} />
        </button>
      </div>
      {creating === '' && (
        <CreateDirectoryEditor
          onSubmit={(name) => {
            onCreateDirectory('', name);
            setCreating(null);
          }}
          onCancel={() => setCreating(null)}
        />
      )}
      <div
        className="file-tree-region"
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu('root', event.clientX, event.clientY);
        }}
      >
        {root.children.length === 0 ? (
          <p className="app-placeholder">表示できるファイルがありません。</p>
        ) : (
          <ul role="tree" className="file-tree">
            {root.children.map((child) => (
              <FileTreeNode
                key={child.path}
                node={child}
                depth={0}
                vaultRef={vaultRef}
                expandedPaths={expandedPaths}
                selectedPath={selectedPath}
                renamingPath={renaming?.path ?? null}
                creatingDirectory={creating}
                onToggleDirectory={onToggleDirectory}
                onOpenMenu={openMenu}
                onCreateDirectory={(directory, name) => {
                  onCreateDirectory(directory, name);
                  setCreating(null);
                }}
                onCancelCreate={() => setCreating(null)}
                onRenameSubmit={submitRename}
                onRenameCancel={() => setRenaming(null)}
              />
            ))}
          </ul>
        )}
      </div>
      {menu !== null && (
        <div
          className="file-context-menu"
          role="menu"
          data-testid="file-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={handleMenuKeyDown}
        >
          {menu.items.map((item, index) => (
            <Fragment key={item.key}>
              {index > 0 && item.group !== menu.items[index - 1]?.group && (
                <div className="file-context-menu-separator" role="separator" />
              )}
              <button
                type="button"
                role="menuitem"
                data-testid={`file-menu-${item.key}`}
                ref={(element) => {
                  menuItemRefs.current[index] = element;
                }}
                onClick={() => {
                  setMenu(null);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            </Fragment>
          ))}
        </div>
      )}
      {moveTarget !== null && (
        <MoveDialog
          targetLabel={
            moveTarget.type === 'directory'
              ? `${pathBaseName(moveTarget.path)}/`
              : pathBaseName(moveTarget.path)
          }
          directories={directories()}
          blocked={blockedMoveTargets(moveTarget, directories())}
          onCancel={() => setMoveTarget(null)}
          onConfirm={(targetDirectory) => {
            const target = moveTarget;
            setMoveTarget(null);
            onMove(target.path, target.type, targetDirectory);
          }}
        />
      )}
      {deleteTarget !== null && (
        <ConfirmDialog
          title={deleteTarget.type === 'directory' ? 'フォルダーを削除' : 'ノートを削除'}
          message={
            deleteTarget.type === 'directory'
              ? `「${pathBaseName(deleteTarget.path)}/」を削除します。配下の全ファイルが GitHub から削除され、取り消しはできません。`
              : `「${pathBaseName(deleteTarget.path)}」を GitHub から削除します。取り消しはできません。`
          }
          confirmLabel="削除"
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const target = deleteTarget;
            setDeleteTarget(null);
            onDelete(target.path, target.type);
          }}
        />
      )}
    </>
  );
}

interface FileTreeNodeProps {
  node: TreeNode;
  depth: number;
  vaultRef: VaultRef;
  expandedPaths: ReadonlySet<string>;
  selectedPath: string | null;
  /** リネーム入力で置き換える対象パス（null は非表示） */
  renamingPath: string | null;
  /** 新規フォルダー作成フォームを表示するディレクトリパス（null は非表示） */
  creatingDirectory: string | null;
  onToggleDirectory: (path: string) => void;
  onOpenMenu: (target: MenuTarget, x: number, y: number) => void;
  onCreateDirectory: (directory: string, name: string) => void;
  onCancelCreate: () => void;
  onRenameSubmit: (newName: string) => void;
  onRenameCancel: () => void;
}

function FileTreeNode({
  node,
  depth,
  vaultRef,
  expandedPaths,
  selectedPath,
  renamingPath,
  creatingDirectory,
  onToggleDirectory,
  onOpenMenu,
  onCreateDirectory,
  onCancelCreate,
  onRenameSubmit,
  onRenameCancel,
}: FileTreeNodeProps) {
  const indent = { '--tree-depth': depth } as CSSProperties;
  const isRenaming = renamingPath === node.path;
  const openMenuAt = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    onOpenMenu({ path: node.path, type: node.type }, event.clientX, event.clientY);
  };

  if (node.type === 'file') {
    if (isRenaming) {
      return (
        <li role="treeitem" className="file-tree-item">
          <InlineRenameInput
            defaultValue={node.name}
            indent={depth}
            onSubmit={onRenameSubmit}
            onCancel={onRenameCancel}
          />
        </li>
      );
    }
    const selected = node.path === selectedPath;
    return (
      <li role="treeitem" aria-selected={selected} className="file-tree-item">
        <Link
          to={noteRoutePath(vaultRef, node.path)}
          className={selected ? 'file-tree-link is-selected' : 'file-tree-link'}
          aria-current={selected ? 'location' : undefined}
          style={indent}
          onContextMenu={openMenuAt}
        >
          <span className="file-tree-name">{node.name}</span>
        </Link>
      </li>
    );
  }

  const isOpen = expandedPaths.has(node.path);
  if (isRenaming) {
    return (
      <li role="treeitem" aria-expanded={isOpen} className="file-tree-item">
        <InlineRenameInput
          defaultValue={node.name}
          indent={depth}
          onSubmit={onRenameSubmit}
          onCancel={onRenameCancel}
        />
      </li>
    );
  }
  return (
    <li role="treeitem" aria-expanded={isOpen} className="file-tree-item">
      <button
        type="button"
        className="file-tree-toggle"
        onClick={() => onToggleDirectory(node.path)}
        style={indent}
        onContextMenu={openMenuAt}
      >
        <span className="file-tree-caret" aria-hidden="true">
          {isOpen ? '⌄' : '›'}
        </span>
        <span className="file-tree-name">{node.name}</span>
      </button>
      {isOpen && (
        <ul role="group" className="file-tree-group">
          {creatingDirectory === node.path && (
            <li role="treeitem" className="file-tree-item">
              <CreateDirectoryEditor
                onSubmit={(name) => onCreateDirectory(node.path, name)}
                onCancel={onCancelCreate}
              />
            </li>
          )}
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              vaultRef={vaultRef}
              expandedPaths={expandedPaths}
              selectedPath={selectedPath}
              renamingPath={renamingPath}
              creatingDirectory={creatingDirectory}
              onToggleDirectory={onToggleDirectory}
              onOpenMenu={onOpenMenu}
              onCreateDirectory={onCreateDirectory}
              onCancelCreate={onCancelCreate}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** リネームのインライン入力（Enter で確定・Escape で解除。検証は入力内で行う） */
function InlineRenameInput({
  defaultValue,
  indent,
  onSubmit,
  onCancel,
}: {
  defaultValue: string;
  indent: number;
  onSubmit: (newName: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = (): void => {
    const name = value.trim();
    const message = validateEntryName(name, defaultValue.endsWith('.md'));
    if (message !== null) {
      setError(message);
      return;
    }
    if (name === defaultValue) {
      onCancel();
      return;
    }
    onSubmit(name);
  };

  return (
    <div className="file-tree-rename" style={{ '--tree-depth': indent } as CSSProperties}>
      <input
        ref={inputRef}
        type="text"
        className="file-tree-rename-input"
        aria-label="新しい名前"
        data-testid="file-rename-input"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      {error !== null && (
        <p className="file-tree-editor-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
