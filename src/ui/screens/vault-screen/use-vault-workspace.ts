/**
 * Vault 内画面の状態と操作を 1 つのフックへまとめる（VaultScreen の表示を薄く保つ）。
 * ローダー / 同期 / パネル開閉 / アウトライン / サイドバー幅 / 展開状態 /
 * ファイル操作 / 派生索引（検索・タグ・バックリンク・ノート一覧）を構成する。
 */

import { useCallback, useMemo } from 'react';

import { applySavedNote } from '@/application/note-index';
import { run } from '@/composition';
import type { TreeDirectory } from '@/domain/tree';
import type { VaultRef } from '@/domain/vault';
import type { ToastAction } from '@/ui/toast';

import { collectFilePaths } from '@/ui/screens/vault-screen/screen-utils';
import { useDerivedIndexes } from '@/ui/screens/vault-screen/use-derived-indexes';
import { useExpandedDirectories } from '@/ui/screens/vault-screen/use-expanded-directories';
import { useOutline } from '@/ui/screens/vault-screen/use-outline';
import { usePanelShortcuts } from '@/ui/screens/vault-screen/use-panel-shortcuts';
import { usePanelStates } from '@/ui/screens/vault-screen/use-panel-states';
import { useSidebarWidth } from '@/ui/screens/vault-screen/use-sidebar-width';
import { useVaultFileOperations } from '@/ui/screens/vault-screen/use-vault-file-operations';
import { useVaultLoader } from '@/ui/screens/vault-screen/use-vault-loader';
import { useVaultSync } from '@/ui/screens/vault-screen/use-vault-sync';

export type VaultWorkspaceArgs = {
  vaultRef: VaultRef;
  /** 選択中のノートパス（ツリー画面では null） */
  notePath: string | null;
  notify: (message: string, action?: ToastAction) => void;
  onSessionExpired: () => void;
};

/** 各フィーチャーフックの戻り値を合成した VaultWorkspace の型 */
type WorkspaceParts = ReturnType<typeof useVaultLoader> &
  ReturnType<typeof usePanelStates> &
  ReturnType<typeof useOutline> &
  ReturnType<typeof useSidebarWidth> &
  ReturnType<typeof useExpandedDirectories> &
  ReturnType<typeof useVaultSync> &
  ReturnType<typeof useVaultFileOperations> &
  ReturnType<typeof useDerivedIndexes> & {
    /** 開いているノートに対応する同期衝突（無ければ null） */
    currentSyncConflict: import('@/application/vault').VaultSyncConflict | null;
    notify: (message: string, action?: ToastAction) => void;
    onSessionExpired: () => void;
    filePaths: readonly string[];
    handleNoteSaved: (path: string, content: string) => void;
  };

/** VaultWorkspace の型（VaultScreen 配下のコンポーネントが受け取る状態の集合） */
export type VaultWorkspace = WorkspaceParts;

export function useVaultWorkspace(args: VaultWorkspaceArgs): WorkspaceParts {
  const { vaultRef, notePath, notify, onSessionExpired } = args;
  const { owner, name } = vaultRef;
  const loader = useVaultLoader({ owner, name, notify, onSessionExpired });
  const panels = usePanelStates();
  const outlineState = useOutline(notePath);
  const sidebar = useSidebarWidth();
  const root: TreeDirectory | null = loader.state.kind === 'ready' ? loader.state.tree.root : null;
  const dirs = useExpandedDirectories({ root, notePath, vaultKey: `${owner}/${name}` });
  usePanelShortcuts(panels);

  // ツリーが取得できている間だけ全ファイルパスを算出する（リーディング表示と
  // ファイル操作のリンク張り替え入力に使う）
  const filePaths = useMemo(() => (root !== null ? collectFilePaths(root) : []), [root]);

  /**
   * ノート保存後に共有索引とバックリンク / タグ索引を更新する。保存済みの本文を
   * 渡すため、再取得は発生しない（レートリミット圧迫の回避）。
   */
  const handleNoteSaved = useCallback(
    (path: string, content: string): void => {
      void run(applySavedNote({ owner, name }, path, content)).then((index) => {
        if (index !== null) {
          loader.noteIndexUpdated(index);
        }
      });
    },
    [owner, name, loader],
  );

  const reloadWithoutInit = useCallback(() => loader.load(false), [loader]);
  const sync = useVaultSync({
    owner,
    name,
    notePath,
    notify,
    onSessionExpired,
    reload: reloadWithoutInit,
    setSyncProgress: loader.setSyncProgress,
  });
  const ops = useVaultFileOperations({
    owner,
    name,
    notePath,
    filePaths,
    notify,
    onSessionExpired,
    load: loader.load,
    expandDirectory: dirs.expandDirectory,
  });
  const derived = useDerivedIndexes(loader.state, loader.noteIndex);

  return {
    ...loader,
    ...panels,
    ...outlineState,
    ...sidebar,
    ...dirs,
    ...sync,
    currentSyncConflict: sync.currentSyncConflict,
    ...ops,
    notify,
    onSessionExpired,
    filePaths,
    ...derived,
    handleNoteSaved,
  };
}
