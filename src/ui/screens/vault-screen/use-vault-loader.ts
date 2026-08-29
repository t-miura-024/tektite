/**
 * Vault のツリー / ノート索引の読み込み（初期同期を含む）を担うフック。
 *
 * - 初期同期: Vault を開くたびに初期同期 API を呼び、R2 に同期済みメタがある場合は
 *   サーバーが即座に完了を返す（初回のみ GitHub API を消費）。失敗してもツリー取得へ進む
 * - ツリー取得: R2 から開く（同期済みなら GitHub を消費しない）
 * - ノート索引: ツリー取得成功後に共有レジストリ（note-index.ts）へ展開する。
 *   失敗はツリー表示を妨げず、indexError として検索 / スイッチャーに伝わる
 */

import { useCallback, useEffect, useState } from 'react';

import { loadNoteIndex, type NoteIndex } from '@/application/note-index';
import { initializeVault, openVault, type SyncProgress } from '@/application/vault';
import { run } from '@/composition';
import type { VaultTree } from '@/domain/tree';
import type { ToastAction } from '@/ui/toast';
import { isSessionExpiredError, vaultErrorMessage } from '@/ui/vault-error';

export type TreeState =
  | { kind: 'loading' }
  | { kind: 'ready'; tree: VaultTree }
  | { kind: 'error'; message: string };

export type VaultLoader = {
  state: TreeState;
  /** 初期同期の実行中フラグ */
  initializing: boolean;
  /** 同期の進捗（オーバーレイ表示用。null は進捗不明か同期中でない） */
  syncProgress: SyncProgress | null;
  noteIndex: NoteIndex | null;
  indexError: string | null;
  /** ツリー + 索引を読み込む。initialize=false で初期同期を省略する */
  load: (initialize?: boolean) => Promise<void>;
  /** 共有索引の state を保存済み内容で差し替える（NotePane の onNoteSaved 経由） */
  noteIndexUpdated: (index: NoteIndex) => void;
  setSyncProgress: (progress: SyncProgress | null) => void;
};

type UseVaultLoaderArgs = {
  owner: string;
  name: string;
  notify: (message: string, action?: ToastAction) => void;
  onSessionExpired: () => void;
};

export function useVaultLoader(args: UseVaultLoaderArgs): VaultLoader {
  const { owner, name, notify, onSessionExpired } = args;
  const [state, setState] = useState<TreeState>({ kind: 'loading' });
  const [initializing, setInitializing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [noteIndex, setNoteIndex] = useState<NoteIndex | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);

  // Vault が変わったら索引をリセットする（前の Vault のタグ・バックリンク等を
  // 新しい Vault のロード中に表示しないため）
  useEffect(() => {
    setNoteIndex(null);
    setIndexError(null);
  }, [owner, name]);

  const load = useCallback(
    async (initialize = true): Promise<void> => {
      setState({ kind: 'loading' });
      if (initialize) {
        // 初期同期: 初回のみ GitHub から R2 へ全量を取り込む。失敗しても
        // ツリー取得へ進む（R2 未設定環境のフォールバック。実エラーはトースト通知）
        setInitializing(true);
        setSyncProgress(null);
        let expired = false;
        try {
          await run(initializeVault({ owner, name }, setSyncProgress));
        } catch (error) {
          if (isSessionExpiredError(error)) {
            notify('セッションの有効期限が切れました。ログインし直してください。');
            onSessionExpired();
            expired = true;
          }
          if (!isSessionExpiredError(error)) {
            notify(vaultErrorMessage(error));
          }
        }
        setInitializing(false);
        setSyncProgress(null);
        if (expired) {
          return;
        }
      }
      try {
        const tree = await run(openVault({ owner, name }));
        setState({ kind: 'ready', tree });
      } catch (error) {
        if (isSessionExpiredError(error)) {
          notify('セッションの有効期限が切れました。ログインし直してください。');
          onSessionExpired();
          return;
        }
        const message = vaultErrorMessage(error);
        setState({ kind: 'error', message });
        // ツリー取得失敗時も検索パネル・クイックスイッチャーを「読み込み中…」のままに
        // しない（エラー表示 + 再試行導線へ切り替える）
        setIndexError(message);
        notify(message, { label: '再試行', onClick: () => void load() });
        return;
      }
      try {
        const index = await run(loadNoteIndex({ owner, name }));
        setNoteIndex(index);
        setIndexError(null);
      } catch (error) {
        setIndexError(vaultErrorMessage(error));
        notify('ノート索引を取得できませんでした。タグ・バックリンクは表示されません。');
      }
    },
    [owner, name, notify, onSessionExpired],
  );

  const noteIndexUpdated = useCallback((index: NoteIndex): void => setNoteIndex(index), []);
  const setSyncProgressState = useCallback(
    (progress: SyncProgress | null): void => setSyncProgress(progress),
    [],
  );

  return {
    state,
    initializing,
    syncProgress,
    noteIndex,
    indexError,
    load,
    noteIndexUpdated,
    setSyncProgress: setSyncProgressState,
  };
}
