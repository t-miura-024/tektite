/**
 * 左サイドバー（ファイルエクスプローラタブ・Vault ヘッダー・ツリー・リサイズバー）。
 * 状態は VaultWorkspace（useVaultWorkspace）から受け取る。
 */

import type { JSX } from 'react';

import { joinDirectoryPath, parentDirectoryPath, pathBaseName } from '@/domain/tree';
import { vaultRefFullName, type VaultRef } from '@/domain/vault';

import { FileTree } from '@/ui/components/file-tree';
import { Link } from '@/ui/components/link';
import {
  FILE_OPERATION_MESSAGES,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
} from '@/ui/screens/vault-screen/screen-utils';
import type { VaultWorkspace } from '@/ui/screens/vault-screen/use-vault-workspace';
import { WorkspaceIcon } from '@/ui/screens/vault-screen/workspace-icon';

export type LeftSidebarProps = {
  vaultRef: VaultRef;
  /** 選択中のノートパス（未選択は null） */
  notePath: string | null;
  ws: VaultWorkspace;
  onOpenSearch: () => void;
};

export function LeftSidebar({
  vaultRef,
  notePath,
  ws,
  onOpenSearch,
}: LeftSidebarProps): JSX.Element {
  return (
    <aside className="vault-sidebar">
      <div className="sidebar-workspace-tab" aria-label="ファイルエクスプローラ">
        <button type="button" aria-label="ファイル" aria-pressed="true">
          <WorkspaceIcon name="files" />
        </button>
        <button type="button" aria-label="検索" onClick={onOpenSearch}>
          <WorkspaceIcon name="search" />
        </button>
        <button type="button" aria-label="ブックマーク">
          <WorkspaceIcon name="bookmark" />
        </button>
      </div>
      <div className="vault-sidebar-header">
        <Link to="/" className="vault-back-link">
          ← Vault 一覧
        </Link>
        <h2 className="vault-title">{vaultRefFullName(vaultRef)}</h2>
      </div>
      <SidebarContent vaultRef={vaultRef} notePath={notePath} ws={ws} onOpenSearch={onOpenSearch} />
      <div
        className="vault-sidebar-resizer"
        role="separator"
        aria-label="サイドバー幅を変更"
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={ws.sidebarWidth}
        onPointerDown={(event) => {
          event.preventDefault();
          ws.startResize();
        }}
      />
    </aside>
  );
}

/** 同期・読み込み状態と、取得済みならブランチ情報 + ファイルツリー */
function SidebarContent({ vaultRef, notePath, ws, onOpenSearch }: LeftSidebarProps): JSX.Element {
  const { state } = ws;
  return (
    <>
      {ws.initializing && (
        <p className="app-placeholder" role="status">
          Vault を初期同期しています…
        </p>
      )}
      {state.kind === 'loading' && (
        <p className="app-placeholder" role="status">
          ツリーを読み込み中…
        </p>
      )}
      {state.kind === 'error' && (
        <div className="error-panel">
          <p>{state.message}</p>
          <button type="button" className="button-secondary" onClick={() => void ws.load()}>
            再試行
          </button>
        </div>
      )}
      {state.kind === 'ready' && (
        <>
          <p className="vault-branch">ブランチ: {state.tree.defaultBranch}</p>
          {state.tree.truncated && (
            <p className="tree-truncated-notice">
              リポジトリが大きいため、一部のファイルのみ表示しています。
            </p>
          )}
          {ws.noteIndex !== null && ws.noteIndex.truncated && (
            <p className="tree-truncated-notice" role="status">
              リポジトリが大きいため、一部のノートのみ索引化しています（検索・移動・タグ・バックリンクは不完全です）。
            </p>
          )}
          <VaultFileTree
            root={state.tree.root}
            vaultRef={vaultRef}
            notePath={notePath}
            ws={ws}
            onOpenSearch={onOpenSearch}
          />
        </>
      )}
    </>
  );
}

/** リネーム種別の共通写像（FileTree の type → FileOperation の kind） */
function renameKind(type: 'file' | 'directory'): 'rename-note' | 'rename-directory' {
  return type === 'file' ? 'rename-note' : 'rename-directory';
}

/** VaultWorkspace の操作コールバックを FileTree の props へ写像する */
function VaultFileTree({
  root,
  vaultRef,
  notePath,
  ws,
  onOpenSearch,
}: {
  root: Extract<VaultWorkspace['state'], { kind: 'ready' }>['tree']['root'];
  vaultRef: VaultRef;
  notePath: string | null;
  ws: VaultWorkspace;
  onOpenSearch: () => void;
}): JSX.Element {
  return (
    <FileTree
      root={root}
      vaultRef={vaultRef}
      expandedPaths={ws.expandedPaths}
      selectedPath={notePath}
      onToggleDirectory={ws.toggleDirectory}
      onOpenSearch={onOpenSearch}
      onOpenQuickSwitcher={() => ws.setQuickSwitchOpen(true)}
      onRevealCurrent={ws.revealCurrentNote}
      onToggleAll={ws.toggleAllDirectories}
      allExpanded={ws.allExpanded}
      onCreateNote={(directory) => ws.startNewNote(directory)}
      onCreateDirectory={(directory, directoryName) =>
        void ws.runFileOperation(
          { kind: 'create-directory', path: joinDirectoryPath(directory, directoryName) },
          FILE_OPERATION_MESSAGES['create-directory'],
        )
      }
      onDuplicate={(path, type) => void ws.handleDuplicate(path, type)}
      onRename={(path, type, newName) =>
        void ws.runFileOperation(
          {
            kind: renameKind(type),
            from: path,
            to: joinDirectoryPath(parentDirectoryPath(path), newName),
          },
          FILE_OPERATION_MESSAGES[renameKind(type)],
        )
      }
      onMove={(path, type, targetDirectory) =>
        void ws.runFileOperation(
          {
            kind: renameKind(type),
            from: path,
            to: joinDirectoryPath(targetDirectory, pathBaseName(path)),
          },
          FILE_OPERATION_MESSAGES[renameKind(type)],
        )
      }
      onDelete={(path, type) =>
        void ws.runFileOperation(
          { kind: type === 'file' ? 'delete-note' : 'delete-directory', path },
          FILE_OPERATION_MESSAGES[type === 'file' ? 'delete-note' : 'delete-directory'],
        )
      }
    />
  );
}
