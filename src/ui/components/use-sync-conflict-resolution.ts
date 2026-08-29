/**
 * 同期衝突（M5。完了条件 6）の解決を担うフック。
 *
 * - overwrite: GitHub 側の内容を採用する。サーバーが R2 を GitHub の現在内容で
 *   更新するため、エディタと sha を更新して整合させる。GitHub 側で削除された
 *   ノートは Vault ルートへ戻る
 * - adopt: ローカル側の内容を採用する。サーバーがローカル内容を GitHub へ反映する
 *   ため、エディタはそのままで sha だけ更新する
 */

import { useRef } from 'react';

import { clearDraft } from '@/application/draft';
import { resolveVaultSyncConflict } from '@/application/vault';
import { run } from '@/composition';
import type { NotePaneCore } from '@/ui/components/use-note-pane-core';
import { navigate, vaultRoutePath } from '@/ui/router';
import { noteErrorMessage } from '@/ui/note-error';
import { isSessionExpiredError } from '@/ui/vault-error';

export type SyncConflictResolution = {
  resolveOverwrite: () => Promise<void>;
  resolveAdopt: () => Promise<void>;
  /** 解決中フラグ（二重送信の防止。ConflictPanel の saving に使う） */
  isResolving: () => boolean;
};

export function useSyncConflictResolution(core: NotePaneCore): SyncConflictResolution {
  const resolvingRef = useRef(false);
  const {
    owner,
    name,
    notePath,
    props,
    handleRef,
    contentRef,
    shaRef,
    programmaticRef,
    generationRef,
  } = core;

  const resolveOverwrite = async (): Promise<void> => {
    const conflict = core.syncConflict;
    if (conflict === null || resolvingRef.current) {
      return;
    }
    resolvingRef.current = true;
    const generation = generationRef.current;
    try {
      const sha = await run(resolveVaultSyncConflict({ owner, name }, conflict.path, 'overwrite'));
      if (conflict.remoteSha === null) {
        // GitHub 側で削除されたノートの削除を採用 → Vault ルートへ戻る
        props.onFileChanged?.();
        navigate(vaultRoutePath({ owner, name }));
        return;
      }
      if (generation !== generationRef.current) {
        return;
      }
      programmaticRef.current = true;
      handleRef.current?.setContent(conflict.remote);
      programmaticRef.current = false;
      contentRef.current = conflict.remote;
      shaRef.current = sha;
      props.onNoteSaved?.(conflict.path, conflict.remote);
      await run(clearDraft({ owner, name }, notePath)).catch(() => {});
      core.setDirty(false);
      resolvingRef.current = false;
      props.onSyncConflictResolved?.(conflict.path);
    } catch (error) {
      resolvingRef.current = false;
      notifyResolveError(core, error, () => void resolveOverwrite());
    }
  };

  const resolveAdopt = async (): Promise<void> => {
    const conflict = core.syncConflict;
    if (conflict === null || resolvingRef.current) {
      return;
    }
    resolvingRef.current = true;
    const generation = generationRef.current;
    try {
      const sha = await run(resolveVaultSyncConflict({ owner, name }, conflict.path, 'adopt'));
      if (generation !== generationRef.current) {
        return;
      }
      shaRef.current = sha;
      props.onNoteSaved?.(conflict.path, contentRef.current);
      await run(clearDraft({ owner, name }, notePath)).catch(() => {});
      core.setDirty(false);
      resolvingRef.current = false;
      props.onSyncConflictResolved?.(conflict.path);
    } catch (error) {
      resolvingRef.current = false;
      notifyResolveError(core, error, () => void resolveAdopt());
    }
  };

  const isResolving = (): boolean => resolvingRef.current;

  return { resolveOverwrite, resolveAdopt, isResolving };
}

function notifyResolveError(core: NotePaneCore, error: unknown, retry: () => void): void {
  if (isSessionExpiredError(error)) {
    core.notify('セッションの有効期限が切れました。ログインし直してください。');
    core.onSessionExpired();
    return;
  }
  core.notify(noteErrorMessage(error), { label: '再試行', onClick: retry });
}
