/**
 * Draft（未保存本文の退避）まわりの操作を担うフック。
 * 本文が変わるたびの退避、復元通知からの「復元 / 破棄」。
 */

import { useCallback } from 'react';

import { clearDraft, saveDraft } from '@/application/draft';
import { run } from '@/composition';
import type { NotePaneCore } from '@/ui/components/use-note-pane-core';

export type NoteDraftActions = {
  /** 未保存の本文を Draft として退避する（未確定ノートは対象外） */
  flushDraft: (content: string) => void;
  /** Draft 復元: 退避済みの本文をエディタに戻す（Draft は保存成功まで残す） */
  restoreDraft: () => void;
  /** Draft 破棄: 退避済みの本文を捨て、リモートの内容のままにする */
  discardDraft: () => Promise<void>;
};

export function useNoteDraft(core: NotePaneCore): NoteDraftActions {
  const { owner, name, notePath, isPending, handleRef, contentRef, programmaticRef, dirtyRef } =
    core;

  const flushDraft = useCallback(
    (content: string): void => {
      if (isPending) {
        return;
      }
      void run(saveDraft({ owner, name }, notePath, content)).catch(() => {});
    },
    [owner, name, notePath, isPending],
  );

  function restoreDraft(): void {
    const draft = core.draftNotice;
    if (!draft) {
      return;
    }
    programmaticSetContent(draft.content);
    contentRef.current = draft.content;
    core.setDraftNotice(null);
    core.setDirty(true);
    dirtyRef.current = true;
  }

  async function discardDraft(): Promise<void> {
    core.setDraftNotice(null);
    await run(clearDraft({ owner, name }, notePath)).catch(() => {});
    core.setDirty(false);
  }

  /** setContent（プログラム的置換）中は onChange を無視する */
  function programmaticSetContent(content: string): void {
    programmaticRef.current = true;
    handleRef.current?.setContent(content);
    programmaticRef.current = false;
  }

  return { flushDraft, restoreDraft, discardDraft };
}
