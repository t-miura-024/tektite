/**
 * 未確定ノート（Obsidian 式の新規作成）の作成コミットを担うフック。
 * タイトル確定時・自動保存時に、最終名 + 本文で 1 コミットだけ行う（Q15:2）。
 */

import { useCallback } from 'react';

import type { NotePaneCore } from '@/ui/components/use-note-pane-core';
import { fileErrorMessage } from '@/ui/note-error';

export function usePendingCommit(core: NotePaneCore): {
  commitPending: (content: string) => Promise<void>;
} {
  const { notify, props, savingRef, titleNameRef } = core;
  const { setSaveStatus, setDirty } = core;

  const commitPending = useCallback(
    async (content: string): Promise<void> => {
      savingRef.current = true;
      setSaveStatus('saving');
      const finalName = titleNameRef.current;
      try {
        const ok = await props.onPendingCommit?.(finalName, content);
        savingRef.current = false;
        if (ok === true) {
          // コミット成功後は VaultScreen が pending を解除して再読込する
          setDirty(false);
          return;
        }
        setSaveStatus('dirty');
      } catch (error) {
        savingRef.current = false;
        setSaveStatus('dirty');
        notify(fileErrorMessage(error));
      }
    },
    [notify, props, savingRef, titleNameRef, setSaveStatus, setDirty],
  );

  return { commitPending };
}
