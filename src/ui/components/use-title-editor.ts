/**
 * インラインタイトル編集（クリックで編集モードへ。Enter / blur で確定、Escape で
 * キャンセル）を担うフック。
 *
 * - 確定時の検証（validateEntryName）を通し、未確定ノートなら作成コミットへ、
 *   通常ノートならリネームへ渡す
 */

import { useCallback } from 'react';

import { validateEntryName } from '@/application/file';
import type { NotePaneCore } from '@/ui/components/use-note-pane-core';
export type TitleEditorActions = {
  /** インラインタイトルの編集を開始する（クリックで編集モードへ） */
  startTitleEdit: () => void;
  /** タイトル編集の確定（Enter / blur。検証して作成 or リネームへ渡す） */
  confirmTitleEdit: () => void;
  /** タイトル編集のキャンセル（Escape） */
  cancelTitleEdit: () => void;
};

export function useTitleEditor(
  core: NotePaneCore,
  performSave: (content: string) => Promise<void>,
): TitleEditorActions {
  const { notePath, isPending, props, contentRef, titleNameRef, titleEditingRef } = core;

  const startTitleEdit = useCallback((): void => {
    core.setTitleDraft(titleNameRef.current);
    core.setTitleError(null);
    titleEditingRef.current = true;
    core.setTitleEditing(true);
  }, [core, titleEditingRef, titleNameRef]);

  const confirmTitleEdit = useCallback((): void => {
    const rawName = core.titleDraft.trim();
    const withExtension = rawName.toLowerCase().endsWith('.md') ? rawName : `${rawName}.md`;
    const error = validateEntryName(withExtension, true);
    if (error !== null) {
      core.setTitleError(error);
      return;
    }
    titleEditingRef.current = false;
    core.setTitleEditing(false);
    core.setTitleError(null);
    if (withExtension === `${titleNameRef.current}.md`) {
      return;
    }
    if (isPending) {
      // タイトル確定 = 最終名で 1 コミット（Q15:2）。本文は現在のエディタ内容を渡す
      const finalTitle = withExtension.replace(/\.md$/i, '');
      titleNameRef.current = finalTitle;
      core.setTitleName(finalTitle);
      void performSave(contentRef.current);
      return;
    }
    void props.onRenameNote?.(notePath, withExtension);
  }, [core, isPending, notePath, props, performSave, contentRef, titleNameRef, titleEditingRef]);

  const cancelTitleEdit = useCallback((): void => {
    titleEditingRef.current = false;
    core.setTitleEditing(false);
    core.setTitleError(null);
  }, [core, titleEditingRef]);

  return { startTitleEdit, confirmTitleEdit, cancelTitleEdit };
}
