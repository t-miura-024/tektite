/**
 * 保存時競合（NoteSaveError kind: conflict）のフローを担うフック群。
 *
 * - enterConflict: リモートの最新内容を再取得して Conflict 状態へ遷移する
 * - handleOverwrite: 編集中の内容を最新 sha で上書き保存する
 * - handleAdopt: リモートの内容を取り込み、編集中の変更を破棄する
 */

import { clearDraft } from '@/application/draft';
import { isNoteSaveError, openNote, saveNoteContent } from '@/application/note';
import { run } from '@/composition';
import type { NotePaneCore } from '@/ui/components/use-note-pane-core';
import { noteErrorMessage, noteSaveErrorMessage } from '@/ui/note-error';
import { isSessionExpiredError } from '@/ui/vault-error';

export function useConflictEnter(core: NotePaneCore): {
  enterConflict: (local: string) => Promise<void>;
} {
  const { owner, name, notePath, notify, onSessionExpired, conflictRef } = core;

  /** 競合検出 → Conflict 状態へ遷移する。再取得に失敗したらトースト + リトライ */
  async function enterConflict(local: string): Promise<void> {
    try {
      const remote = await run(openNote({ owner, name }, notePath));
      conflictRef.current = true;
      core.setConflict({ local, remote });
      // 保存処理（saving）を解除する。表示は conflict により「競合」になる
      core.setSaveStatus('dirty');
    } catch (error) {
      if (isSessionExpiredError(error)) {
        notify('セッションの有効期限が切れました。ログインし直してください。');
        onSessionExpired();
        return;
      }
      notify(noteErrorMessage(error), {
        label: '再試行',
        onClick: () => void enterConflict(local),
      });
    }
  }

  return { enterConflict };
}

export function useSaveConflictResolution(
  core: NotePaneCore,
  enterConflict: (local: string) => Promise<void>,
): {
  handleOverwrite: () => Promise<void>;
  handleAdopt: () => Promise<void>;
} {
  const handleOverwrite = useConflictOverwrite(core, enterConflict);
  const handleAdopt = useConflictAdopt(core);
  return { handleOverwrite, handleAdopt };
}

function useConflictOverwrite(
  core: NotePaneCore,
  enterConflict: (local: string) => Promise<void>,
): () => Promise<void> {
  const {
    owner,
    name,
    notePath,
    notify,
    onSessionExpired,
    props,
    shaRef,
    contentRef,
    savingRef,
    generationRef,
    conflictRef,
  } = core;

  /** 競合解決: 編集中の内容を最新 sha で上書き保存する */
  async function handleOverwrite(): Promise<void> {
    const current = core.conflict;
    if (!current) {
      return;
    }
    savingRef.current = true;
    core.setSaveStatus('saving');
    const generation = generationRef.current;
    try {
      const result = await run(
        saveNoteContent({ owner, name }, notePath, {
          content: current.local,
          baseSha: current.remote.sha,
        }),
      );
      props.onNoteSaved?.(notePath, current.local);
      if (generation !== generationRef.current) {
        return;
      }
      shaRef.current = result.sha;
      await run(clearDraft({ owner, name }, notePath)).catch(() => {});
      core.setDraftNotice(null);
      contentRef.current = current.local;
      conflictRef.current = false;
      core.setConflict(null);
      core.setEditorContent(current.local);
      savingRef.current = false;
      core.setDirty(false);
    } catch (error) {
      if (generation !== generationRef.current) {
        return;
      }
      savingRef.current = false;
      if (isSessionExpiredError(error)) {
        notify('セッションの有効期限が切れました。ログインし直してください。');
        onSessionExpired();
        return;
      }
      if (isNoteSaveError(error) && error.kind === 'conflict') {
        await enterConflict(current.local);
        return;
      }
      notify(noteSaveErrorMessage(error), {
        label: '再試行',
        onClick: () => void handleOverwrite(),
      });
    }
  }

  return handleOverwrite;
}

function useConflictAdopt(core: NotePaneCore): () => Promise<void> {
  const { owner, name, notePath, props, shaRef, contentRef, generationRef, conflictRef } = core;

  return async (): Promise<void> => {
    const current = core.conflict;
    if (!current) {
      return;
    }
    const generation = generationRef.current;
    contentRef.current = current.remote.content;
    shaRef.current = current.remote.sha;
    // 取り込み後はリモート内容が現在の本文になるため索引キャッシュへ反映する
    props.onNoteSaved?.(notePath, current.remote.content);
    await run(clearDraft({ owner, name }, notePath)).catch(() => {});
    if (generation !== generationRef.current) {
      // 取り込み中にノートが切り替わった: 旧ノートの状態を新しいノートへ適用しない
      return;
    }
    conflictRef.current = false;
    core.setConflict(null);
    core.setEditorContent(current.remote.content);
    core.setDirty(false);
  };
}
