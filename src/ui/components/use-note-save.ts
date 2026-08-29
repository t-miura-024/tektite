/**
 * 保存パイプライン（明示保存・自動保存・競合解決）の入り口を担うフック。
 *
 * - performSave: 明示保存（Cmd+S / 保存ボタン）と自動保存（エディタ blur）の共通経路
 * - 競合: NoteSaveError kind: conflict で「差分表示 + 上書き / 取り込み」へ遷移
 *
 * 各ステップは useNoteDraft / useConflictEnter / usePendingCommit /
 * useExistingSave / useSaveConflictResolution に委譲する。
 */

import { useEffect, useRef } from 'react';

import type { NotePaneCore } from '@/ui/components/use-note-pane-core';
import { useExistingSave } from '@/ui/components/use-existing-save';
import { useNoteDraft } from '@/ui/components/use-note-draft';
import { useConflictEnter, useSaveConflictResolution } from '@/ui/components/use-save-conflict';
import { usePendingCommit } from '@/ui/components/use-pending-commit';

export type NoteSaveActions = {
  flushDraft: (content: string) => void;
  performSave: (content: string) => Promise<void>;
  handleEditorBlur: () => void;
  handleOverwrite: () => Promise<void>;
  handleAdopt: () => Promise<void>;
  restoreDraft: () => void;
  discardDraft: () => Promise<void>;
};

export function useNoteSave(core: NotePaneCore): NoteSaveActions {
  const { isPending, contentRef, savingRef, conflictRef, readyRef, suppressBlurRef, dirtyRef } =
    core;
  const { flushDraft, restoreDraft, discardDraft } = useNoteDraft(core);
  const { enterConflict } = useConflictEnter(core);
  const { commitPending } = usePendingCommit(core);

  // 再試行ボタンから最新の performSave を呼び直すための ref（循環参照を断つ）
  const performSaveRef = useRef<(content: string) => Promise<void>>(async () => {});
  const { saveExisting } = useExistingSave({ core, enterConflict, performSaveRef });

  /**
   * 保存を実行する（明示保存・自動保存の共通経路）。
   * 未確定ノートは create を 1 回だけ行う。通常ノートは未保存の変更がある場合のみ。
   */
  async function performSave(content: string): Promise<void> {
    if (savingRef.current || conflictRef.current || !readyRef.current) {
      return;
    }
    if (isPending) {
      await commitPending(content);
      return;
    }
    await saveExisting(content);
  }

  performSaveRef.current = performSave;

  // Cmd+S / Ctrl+S ショートカット（エディタ内外を問わず有効）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void performSaveRef.current(contentRef.current);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => window.removeEventListener('keydown', onKeyDown);
  }, [contentRef]);

  const { handleOverwrite, handleAdopt } = useSaveConflictResolution(core, enterConflict);

  return {
    flushDraft,
    performSave,
    handleEditorBlur: (): void => {
      if (core.draftNotice !== null) {
        // Draft 復元通知表示中の blur（ボタンへのフォーカス移動を含む）では自動保存しない
        return;
      }
      if (suppressBlurRef.current) {
        // タイトル編集へのクリック移動中（pointerdown で立てたフラグ）は自動保存しない
        suppressBlurRef.current = false;
        return;
      }
      if (isPending) {
        // 未確定ノート: タイトル未編集なら Untitled.md として自動コミットする（Q18:1）
        if (!savingRef.current && readyRef.current) {
          void performSave(contentRef.current);
        }
        return;
      }
      if (!dirtyRef.current || savingRef.current || conflictRef.current || !readyRef.current) {
        return;
      }
      void performSave(contentRef.current);
    },
    handleOverwrite,
    handleAdopt,
    restoreDraft,
    discardDraft,
  };
}
