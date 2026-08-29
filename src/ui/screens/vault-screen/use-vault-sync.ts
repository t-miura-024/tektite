/**
 * 明示同期（M5。完了条件 5 / 6 / 9）と同期状態表示を担うフック。
 *
 * - ヘッダーの同期ボタンから即時同期を実行し、結果（プル/プッシュ件数・
 *   同期衝突）をトーストと状態表示へ反映する
 * - 完了後はツリーと索引を再読込し、開いているノートへ syncVersion で最新化を通知
 * - Vault オープン時に最終同期時刻・定時同期の失敗マークを取得する（完了条件 10）
 */

import { useCallback, useEffect, useState } from 'react';

import {
  fetchVaultSyncStatus,
  syncVault,
  type SyncProgress,
  type VaultSyncConflict,
  type VaultSyncStatus,
} from '@/application/vault';
import { run } from '@/composition';
import type { ToastAction } from '@/ui/toast';
import { isSessionExpiredError, vaultErrorMessage } from '@/ui/vault-error';

export type VaultSync = {
  syncing: boolean;
  syncStatus: VaultSyncStatus | null;
  syncConflicts: readonly VaultSyncConflict[];
  /** 同期完了ごとに増えるバージョン（NotePane への最新化通知） */
  syncVersion: number;
  /** 開いているノートに対応する同期衝突（無ければ null） */
  currentSyncConflict: VaultSyncConflict | null;
  runSync: () => Promise<void>;
  /** 同期衝突の解決完了時に一覧から除去する（NotePane からの通知） */
  handleSyncConflictResolved: (path: string) => void;
};

type UseVaultSyncArgs = {
  owner: string;
  name: string;
  notePath: string | null;
  notify: (message: string, action?: ToastAction) => void;
  onSessionExpired: () => void;
  /** ツリー・索引の再読込（初期同期を再実行しない） */
  reload: () => Promise<void>;
  /** 同期進捗の更新（ローダーがオーバーレイ表示に使う state へ委譲） */
  setSyncProgress: (progress: SyncProgress | null) => void;
};

export function useVaultSync(args: UseVaultSyncArgs): VaultSync {
  const { owner, name, notePath, notify, onSessionExpired, reload, setSyncProgress } = args;
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<VaultSyncStatus | null>(null);
  const [syncConflicts, setSyncConflicts] = useState<readonly VaultSyncConflict[]>([]);
  const [syncVersion, setSyncVersion] = useState(0);

  // Vault オープン時に同期状態（最終同期時刻・失敗マーク）を取得する。
  // 取得失敗は表示を諦めるだけ（同期ボタン自体は使える）
  useEffect(() => {
    let cancelled = false;
    void run(fetchVaultSyncStatus({ owner, name }))
      .then((status) => {
        if (!cancelled) {
          setSyncStatus(status);
        }
      })
      .catch(() => {});
    return (): void => {
      cancelled = true;
    };
  }, [owner, name]);

  const runSync = useCallback(async (): Promise<void> => {
    if (syncing) {
      return;
    }
    setSyncing(true);
    setSyncProgress(null);
    try {
      const result = await run(syncVault({ owner, name }, setSyncProgress));
      const newConflicts = result.conflicts ?? [];
      setSyncConflicts(newConflicts);
      setSyncVersion((version) => version + 1);
      if (newConflicts.length > 0) {
        const openConflict =
          notePath !== null && newConflicts.some((conflict) => conflict.path === notePath);
        notify(
          openConflict
            ? '同期中に編集内容と GitHub の内容が衝突しました。差分を確認して解決してください。'
            : `${newConflicts.length} 件の同期衝突があります。該当ノートを開いて解決してください。`,
        );
      }
      if (newConflicts.length === 0) {
        const pushed = result.pushed ?? 0;
        const pulled = result.pulled ?? 0;
        notify(
          pushed > 0 || pulled > 0
            ? `同期しました（プル ${pulled} 件 / プッシュ ${pushed} 件）。`
            : '同期しました（変更はありませんでした）。',
        );
      }
      // 先にオーバーレイを解除し、ツリー・索引の更新はバックグラウンドで行う
      setSyncing(false);
      setSyncProgress(null);
      await reload();
      const status = await run(fetchVaultSyncStatus({ owner, name })).catch(() => null);
      if (status !== null) {
        setSyncStatus(status);
      }
    } catch (error) {
      if (isSessionExpiredError(error)) {
        notify('セッションの有効期限が切れました。ログインし直してください。');
        onSessionExpired();
        return;
      }
      notify(vaultErrorMessage(error));
    } finally {
      setSyncing(false);
      setSyncProgress(null);
    }
  }, [syncing, owner, name, notePath, notify, onSessionExpired, reload, setSyncProgress]);

  const handleSyncConflictResolved = useCallback((path: string): void => {
    setSyncConflicts((previous) => previous.filter((conflict) => conflict.path !== path));
  }, []);

  const currentSyncConflict =
    notePath === null
      ? null
      : (syncConflicts.find((conflict) => conflict.path === notePath) ?? null);

  return {
    syncing,
    syncStatus,
    syncConflicts,
    syncVersion,
    currentSyncConflict,
    runSync,
    handleSyncConflictResolved,
  };
}
