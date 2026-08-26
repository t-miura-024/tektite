/**
 * 通常ノートの保存（未保存の変更がある場合のみコミット）とそのエラー処理。
 * セッション失効 / 競合（Conflict フローへ遷移）/ その他を振り分ける。
 */

import type { MutableRefObject } from 'react';

import { clearDraft } from '@/application/draft';
import { isNoteSaveError, saveNoteContent } from '@/application/note';
import { run } from '@/composition';
import type { NotePaneCore } from '@/ui/components/use-note-pane-core';
import { noteSaveErrorMessage } from '@/ui/note-error';
import { isSessionExpiredError } from '@/ui/vault-error';

type UseExistingSaveArgs = {
  core: NotePaneCore;
  /** 保存時競合の検出（Conflict 状態への遷移） */
  enterConflict: (local: string) => Promise<void>;
  /** 再試行で呼び直す最新の performSave（循環参照を ref で断つ） */
  performSaveRef: MutableRefObject<(content: string) => Promise<void>>;
};

export function useExistingSave({ core, enterConflict, performSaveRef }: UseExistingSaveArgs): {
  saveExisting: (content: string) => Promise<void>;
} {
  const {
    owner,
    name,
    notePath,
    notify,
    onSessionExpired,
    props,
    shaRef,
    dirtyRef,
    savingRef,
    generationRef,
  } = core;

  /**
   * 未保存の変更がある場合のみコミットする。保存成功時は Draft を消し、
   * 復元通知を閉じて clean 状態へ戻す。世代ガード付き（ノート切替レース対策）。
   */
  async function saveExisting(content: string): Promise<void> {
    if (!dirtyRef.current) {
      return;
    }
    savingRef.current = true;
    core.setSaveStatus('saving');
    const generation = generationRef.current;
    try {
      const result = await run(
        saveNoteContent({ owner, name }, notePath, { content, baseSha: shaRef.current }),
      );
      // サーバーの状態は変わったため、世代ガードより先に索引キャッシュへ反映する
      props.onNoteSaved?.(notePath, content);
      if (generation !== generationRef.current) {
        // 保存中にノートが切り替わった: 旧ノートの結果を新しいノートへ適用しない
        return;
      }
      shaRef.current = result.sha;
      await run(clearDraft({ owner, name }, notePath)).catch(() => {});
      // 保存成功で復元通知を閉じる（失敗時は「復元」での誤った巻き戻しを防ぐため閉じない）
      core.setDraftNotice(null);
      savingRef.current = false;
      core.setDirty(false);
    } catch (error) {
      await handleSaveError(error, content, generation);
    }
  }

  /** 保存エラーの処理（セッション失効 / 競合 / その他。世代ガード付き） */
  async function handleSaveError(
    error: unknown,
    content: string,
    generation: number,
  ): Promise<void> {
    if (generation !== generationRef.current) {
      return;
    }
    savingRef.current = false;
    if (isSessionExpiredError(error)) {
      notify('セッションの有効期限が切れました。ログインし直してください。');
      onSessionExpired();
      core.setSaveStatus('dirty');
      return;
    }
    if (isNoteSaveError(error) && error.kind === 'conflict') {
      // リモート sha が読込時から変化: Conflict 状態へ遷移（データ損失は起こさない）
      await enterConflict(content);
      return;
    }
    notify(noteSaveErrorMessage(error), {
      label: '再試行',
      onClick: () => void performSaveRef.current(core.contentRef.current),
    });
    core.setSaveStatus('dirty');
  }

  return { saveExisting };
}
