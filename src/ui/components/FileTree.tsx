/**
 * ファイルツリー表示 + ファイル操作（M5: 作成・リネーム・移動・削除）。
 *
 * - ドメイン層が構築したツリー（src/domain/tree）を描画する
 * - ファイル選択はノートパスの URL（/:owner/:repo/blob/:path）へ SPA 遷移
 * - ツールバー: 新規ノート / 新規フォルダー（ルート直下に作成するインライン入力）
 * - コンテキストメニュー（右クリック）: リネーム（ツリー内インライン入力）/
 *   移動（移動先ダイアログ）/ 削除（確認ダイアログ）。削除は GitHub 上の実削除
 *   のため必ず確認ダイアログを挟む（ゴミ箱なしの方針）
 * - 実際の操作（一括コミット）は VaultScreen のコールバックが担い、ここでは
 *   操作 UI の状態（入力・メニュー・ダイアログ）だけを持つ
 * - role="tree" / treeitem でスクリーンリーダーにも構造が伝わるようにする
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent } from 'react';

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
  /** 新規ノート（ルート直下）をコミットする */
  onCreateNote: (name: string) => void;
  /** 新規フォルダー（ルート直下）をコミットする */
  onCreateDirectory: (name: string) => void;
  /** リネーム（newName は 1 セグメントの新しい名前）をコミットする */
  onRename: (path: string, type: 'file' | 'directory', newName: string) => void;
  /** 移動（targetDirectory は '' でルート）をコミットする */
  onMove: (path: string, type: 'file' | 'directory', targetDirectory: string) => void;
  /** 削除（実削除。確認ダイアログはこのコンポーネントが挟む）をコミットする */
  onDelete: (path: string, type: 'file' | 'directory') => void;
}

/** コンテキストメニューの表示状態（座標は固定配置用のビューポート座標） */
interface MenuState {
  readonly path: string;
  readonly type: 'file' | 'directory';
  readonly x: number;
  readonly y: number;
}

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

export function FileTree({
  root,
  vaultRef,
  expandedPaths,
  selectedPath,
  onToggleDirectory,
  onCreateNote,
  onCreateDirectory,
  onRename,
  onMove,
  onDelete,
}: FileTreeProps) {
  /** コンテキストメニュー（null は非表示） */
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** 作成フォーム（null は非表示） */
  const [creating, setCreating] = useState<'note' | 'directory' | null>(null);
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
  /** 作成フォームの入力値とエラー */
  const [createValue, setCreateValue] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const createInputRef = useRef<HTMLInputElement | null>(null);

  // ツリーが差し替わる（操作後の再読込・Vault 切替）たびに操作 UI を閉じる
  useEffect(() => {
    setMenu(null);
    setCreating(null);
    setRenaming(null);
    setMoveTarget(null);
    setDeleteTarget(null);
  }, [root]);

  // 作成フォームが開いたら入力へフォーカスする
  useEffect(() => {
    if (creating !== null) {
      createInputRef.current?.focus();
    }
  }, [creating]);

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

  const directories = useCallback(() => collectDirectories(root), [root]);

  /** コンテキストメニューを開く（座標はビューポート内にクランプする） */
  const openMenu = useCallback((path: string, type: 'file' | 'directory', x: number, y: number) => {
    const width = 160;
    const height = 120;
    setMenu({
      path,
      type,
      x: Math.max(0, Math.min(x, window.innerWidth - width)),
      y: Math.max(0, Math.min(y, window.innerHeight - height)),
    });
  }, []);

  /** メニュー操作を実行し、メニューを閉じる */
  const handleMenuAction = useCallback(
    (action: 'rename' | 'move' | 'delete') => {
      if (menu === null) {
        return;
      }
      const target = menu;
      setMenu(null);
      if (action === 'rename') {
        setRenaming({ path: target.path, type: target.type });
      } else if (action === 'move') {
        setMoveTarget({ path: target.path, type: target.type });
      } else {
        setDeleteTarget({ path: target.path, type: target.type });
      }
    },
    [menu],
  );

  /** 作成フォームを開く */
  const openCreate = useCallback((kind: 'note' | 'directory') => {
    setCreateValue('');
    setCreateError(null);
    setCreating(kind);
  }, []);

  /** 作成フォームの確定（名前を検証してコールバックへ渡す） */
  const submitCreate = useCallback(() => {
    if (creating === null) {
      return;
    }
    const name = createValue.trim();
    const error = validateEntryName(name, creating === 'note');
    if (error !== null) {
      setCreateError(error);
      return;
    }
    if (creating === 'note') {
      onCreateNote(name);
    } else {
      onCreateDirectory(name);
    }
    setCreating(null);
  }, [creating, createValue, onCreateNote, onCreateDirectory]);

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
          onClick={() => openCreate('note')}
        >
          ＋ 新規ノート
        </button>
        <button
          type="button"
          className="button-secondary"
          data-testid="file-create-directory-button"
          onClick={() => openCreate('directory')}
        >
          ＋ 新規フォルダー
        </button>
      </div>
      {creating !== null && (
        <div className="file-tree-editor" data-testid="file-tree-editor">
          <input
            ref={createInputRef}
            type="text"
            value={createValue}
            aria-label={creating === 'note' ? '新しいノート名' : '新しいフォルダー名'}
            data-testid="file-tree-editor-input"
            placeholder={
              creating === 'note' ? 'ノート名（例: memo.md）' : 'フォルダー名（例: daily）'
            }
            onChange={(event) => {
              setCreateValue(event.target.value);
              setCreateError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submitCreate();
              } else if (event.key === 'Escape') {
                setCreating(null);
              }
            }}
          />
          <button
            type="button"
            className="button-primary"
            data-testid="file-tree-editor-submit"
            onClick={submitCreate}
          >
            作成
          </button>
          <button type="button" className="button-secondary" onClick={() => setCreating(null)}>
            キャンセル
          </button>
          {createError !== null && (
            <p className="file-tree-editor-error" role="alert">
              {createError}
            </p>
          )}
        </div>
      )}
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
              onToggleDirectory={onToggleDirectory}
              onOpenMenu={openMenu}
              onRenameSubmit={submitRename}
              onRenameCancel={() => setRenaming(null)}
            />
          ))}
        </ul>
      )}
      {menu !== null && (
        <div
          className="file-context-menu"
          role="menu"
          data-testid="file-context-menu"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            type="button"
            role="menuitem"
            data-testid="file-menu-rename"
            onClick={() => handleMenuAction('rename')}
          >
            リネーム
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="file-menu-move"
            onClick={() => handleMenuAction('move')}
          >
            移動…
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="file-menu-delete"
            onClick={() => handleMenuAction('delete')}
          >
            削除
          </button>
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
          blocked={descendants(moveTarget.path, directories())}
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
  onToggleDirectory: (path: string) => void;
  onOpenMenu: (path: string, type: 'file' | 'directory', x: number, y: number) => void;
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
  onToggleDirectory,
  onOpenMenu,
  onRenameSubmit,
  onRenameCancel,
}: FileTreeNodeProps) {
  const indent = { '--tree-depth': depth } as CSSProperties;
  const isRenaming = renamingPath === node.path;
  const openMenuAt = (event: MouseEvent): void => {
    event.preventDefault();
    onOpenMenu(node.path, node.type, event.clientX, event.clientY);
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
          {node.name}
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
          {isOpen ? '▾' : '▸'}
        </span>
        <span className="file-tree-name">{node.name}</span>
      </button>
      {isOpen && (
        <ul role="group" className="file-tree-group">
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              vaultRef={vaultRef}
              expandedPaths={expandedPaths}
              selectedPath={selectedPath}
              renamingPath={renamingPath}
              onToggleDirectory={onToggleDirectory}
              onOpenMenu={onOpenMenu}
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
