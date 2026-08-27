/**
 * Vault 内画面（`/:owner/:repo` と `/:owner/:repo/blob/:path` の共通シェル）。
 *
 * - サイドバー: デフォルトブランチのファイルツリー（ディレクトリ開閉・ファイル選択）
 * - メインペイン: 選択中のノート（CM6 エディタ。ノート未選択はプレースホルダ）
 *
 * ディープリンク対応: ツリーは URL のみから復元する。ノートパス付き URL で
 * 開いた場合は、そのファイルまでの祖先ディレクトリを自動展開して選択状態を
 * 復元する。レスポンシブ: 狭い画面ではツリーを上部、ノートを下部に縦積みする。
 *
 * 状態とロジックは useVaultWorkspace（同フォルダのフック群）に集約し、
 * このコンポーネントは配置だけを担う。
 */

import type { JSX } from 'react';

import type { ToastAction } from '@/ui/toast';
import type { VaultRef } from '@/domain/vault';
import { SearchPanel } from '@/ui/components/search-panel';
import { QuickSwitcher } from '@/ui/components/quick-switcher';
import { LeftSidebar } from '@/ui/screens/vault-screen/left-sidebar';
import { RightSidebar } from '@/ui/screens/vault-screen/right-sidebar';
import { SyncOverlay } from '@/ui/screens/vault-screen/sync-overlay';
import { WorkspaceMain } from '@/ui/screens/vault-screen/workspace-main';
import { WorkspaceRail } from '@/ui/screens/vault-screen/workspace-rail';
import { useVaultWorkspace } from '@/ui/screens/vault-screen/use-vault-workspace';

export type VaultScreenProps = {
  vaultRef: VaultRef;
  /** 選択中のノートパス（ツリー画面では null） */
  notePath: string | null;
  notify: (message: string, action?: ToastAction) => void;
  onSessionExpired: () => void;
};

export function VaultScreen({
  vaultRef,
  notePath,
  notify,
  onSessionExpired,
}: VaultScreenProps): JSX.Element {
  const ws = useVaultWorkspace({ vaultRef, notePath, notify, onSessionExpired });

  return (
    <div
      className={`vault-screen${ws.leftSidebarOpen ? '' : ' is-left-collapsed'}${ws.rightSidebarOpen ? '' : ' is-right-collapsed'}${ws.resizingSidebar ? ' is-resizing' : ''}`}
      style={{ '--vault-sidebar-width': `${ws.sidebarWidth}px` }}
    >
      <WorkspaceRail
        leftOpen={ws.leftSidebarOpen}
        rightOpen={ws.rightSidebarOpen}
        onToggleLeft={ws.toggleLeftSidebar}
        onToggleRight={ws.toggleRightSidebar}
        onOpenSearch={() => ws.setSearchOpen(true)}
      />
      {ws.leftSidebarOpen && (
        <LeftSidebar
          vaultRef={vaultRef}
          notePath={notePath}
          ws={ws}
          onOpenSearch={() => ws.setSearchOpen(true)}
        />
      )}
      <WorkspaceMain vaultRef={vaultRef} notePath={notePath} ws={ws} />
      {ws.rightSidebarOpen && (
        <RightSidebar
          vaultRef={vaultRef}
          notePath={notePath}
          rightPanel={ws.rightPanel}
          setRightPanel={ws.setRightPanel}
          ws={ws}
        />
      )}
      {ws.searchOpen && (
        <SearchPanel
          vaultRef={vaultRef}
          searcher={ws.searcher}
          indexFailed={ws.indexError !== null}
          onRetry={() => void ws.load()}
          onClose={() => ws.setSearchOpen(false)}
        />
      )}
      {ws.quickSwitchOpen && (
        <QuickSwitcher
          vaultRef={vaultRef}
          notePaths={ws.notePaths}
          indexFailed={ws.indexError !== null}
          onRetry={() => void ws.load()}
          onClose={() => ws.setQuickSwitchOpen(false)}
        />
      )}
      {(ws.initializing || ws.syncing) && (
        <SyncOverlay initializing={ws.initializing} progress={ws.syncProgress} />
      )}
    </div>
  );
}
