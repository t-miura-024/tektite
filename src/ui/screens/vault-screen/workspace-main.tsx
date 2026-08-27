/**
 * メインペイン（タブバー / ノートナビゲーション + 同期状態 / NotePane または
 * プレースホルダ / ステータスバー）。
 */

import type { JSX } from 'react';

import { joinDirectoryPath, parentDirectoryPath, pathBaseName } from '@/domain/tree';
import type { VaultRef } from '@/domain/vault';

import { EmptyVaultCta } from '@/ui/components/empty-vault-cta';
import { NotePane } from '@/ui/components/note-pane';
import { FILE_OPERATION_MESSAGES, formatSyncTime } from '@/ui/screens/vault-screen/screen-utils';
import type { VaultWorkspace } from '@/ui/screens/vault-screen/use-vault-workspace';

export type WorkspaceMainProps = {
  vaultRef: VaultRef;
  /** 選択中のノートパス（ツリー画面では null） */
  notePath: string | null;
  ws: VaultWorkspace;
};

export function WorkspaceMain({ vaultRef, notePath, ws }: WorkspaceMainProps): JSX.Element {
  const { state, syncStatus } = ws;
  const syncHasError = syncStatus !== null && syncStatus.lastSyncError !== null;
  const syncStatusLabel = ws.syncing
    ? '同期中…'
    : syncHasError
      ? `同期失敗（${syncStatus?.lastSyncError}）`
      : syncStatus !== null && syncStatus.syncedAt !== null
        ? `最終同期 ${formatSyncTime(syncStatus.syncedAt)}`
        : '未同期';

  return (
    <section className="vault-content">
      <div className="workspace-tabs" role="tablist" aria-label="開いているノート">
        <div className="workspace-tab is-active" role="tab" aria-selected="true">
          <span>{notePath === null ? 'Vault' : pathBaseName(notePath)}</span>
          <button type="button" aria-label="タブを閉じる" disabled={notePath === null}>
            ×
          </button>
        </div>
        <button type="button" className="workspace-tab-add" aria-label="新しいタブ">
          +
        </button>
      </div>
      <div className="workspace-navigation" aria-label="ノートナビゲーション">
        <button type="button" aria-label="戻る" onClick={() => window.history.back()}>
          ‹
        </button>
        <button type="button" aria-label="進む" onClick={() => window.history.forward()}>
          ›
        </button>
        <span />
        <button type="button" aria-label="ノートを開く">
          ◫
        </button>
        <button type="button" aria-label="その他の操作">
          …
        </button>
        <span className="workspace-navigation-spacer" />
        <span
          className={`sync-status${syncHasError ? ' has-error' : ''}`}
          data-testid="sync-status"
          title={
            syncHasError
              ? `定時同期が失敗しました（${syncStatus?.lastSyncError}）。次回同期で自動リトライされます。`
              : 'Vault と GitHub の最終同期時刻'
          }
        >
          {syncStatusLabel}
        </span>
        <button
          type="button"
          className="button-secondary sync-button"
          data-testid="sync-button"
          onClick={() => void ws.runSync()}
          disabled={ws.syncing || ws.initializing || state.kind === 'loading'}
        >
          {ws.syncing ? '同期中…' : '同期'}
        </button>
      </div>
      <MainContent vaultRef={vaultRef} notePath={notePath} ws={ws} />
      <footer className="workspace-statusbar" aria-label="ステータスバー">
        <span>{state.kind === 'ready' ? state.tree.defaultBranch : 'main'}</span>
        <span>{notePath === null ? 'ノート未選択' : 'Markdown'}</span>
        <span>⌘K 検索</span>
        <span>⌘O クイックスイッチャー</span>
      </footer>
    </section>
  );
}

/** 選択状態に応じたメインコンテンツ（NotePane / 空 Vault CTA / プレースホルダ） */
function MainContent({ vaultRef, notePath, ws }: WorkspaceMainProps): JSX.Element {
  const { state } = ws;
  if (notePath !== null) {
    return (
      <NotePane
        vaultRef={vaultRef}
        notePath={notePath}
        filePaths={ws.filePaths}
        pendingPath={ws.pendingNotePath}
        notify={ws.notify}
        onSessionExpired={ws.onSessionExpired}
        onNoteSaved={ws.handleNoteSaved}
        onNoteContentLoaded={ws.setOutlineContent}
        onFileChanged={() => void ws.load()}
        onPendingCommit={ws.commitPendingNote}
        onPendingDiscard={ws.discardPendingNote}
        onRenameNote={(path, newName) =>
          ws.runFileOperation(
            {
              kind: 'rename-note',
              from: path,
              to: joinDirectoryPath(parentDirectoryPath(path), newName),
            },
            FILE_OPERATION_MESSAGES['rename-note'],
          )
        }
        syncVersion={ws.syncVersion}
        syncConflict={ws.currentSyncConflict}
        onSyncConflictResolved={ws.handleSyncConflictResolved}
      />
    );
  }
  if (state.kind === 'ready' && state.tree.root.children.length === 0) {
    return <EmptyVaultCta onCreateNote={() => ws.startNewNote('')} />;
  }
  return (
    <p className="app-placeholder">
      {ws.initializing ? 'Vault を初期同期しています…' : 'ツリーからファイルを選択してください。'}
    </p>
  );
}
