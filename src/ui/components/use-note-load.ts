/**
 * ノート本文の読み込み（未確定ノートの即 ready 化を含む）を担うフック。
 * ノート切替レース対策として世代（generationRef）を進め、進行中の旧ノートの
 * 保存結果が新しいノートへ適用されないようにする。
 */

import { useCallback, useLayoutEffect } from 'react';

import { loadDraft } from '@/application/draft';
import { openNote } from '@/application/note';
import { run } from '@/composition';
import { pathBaseName } from '@/domain/tree';
import type { NotePaneCore } from '@/ui/components/use-note-pane-core';
import { noteErrorMessage } from '@/ui/note-error';
import { isSessionExpiredError } from '@/ui/vault-error';
import { useSyncRefresh } from '@/ui/components/use-sync-refresh';

export function useNoteLoad(core: NotePaneCore): { load: () => Promise<void> } {
  const {
    owner,
    name,
    notePath,
    isPending,
    generationRef,
    handleRef,
    readyRef,
    savingRef,
    conflictRef,
    dirtyRef,
    shaRef,
    contentRef,
    titleNameRef,
  } = core;

  const load = useCallback(async (): Promise<void> => {
    // レース対策: 世代を進め、旧ノートの保存結果が新ノートへ適用されないようにする
    generationRef.current += 1;
    core.setLoadState({ kind: 'loading' });
    readyRef.current = false;
    savingRef.current = false;
    conflictRef.current = false;
    core.setConflict(null);
    core.setDraftNotice(null);
    core.setSaveStatus('clean');
    dirtyRef.current = false;
    handleRef.current = null;

    const title = pathBaseName(notePath).replace(/\.md$/i, '');
    // 未確定の新規ノート: fetch せず空の本文で即 ready（タイトル編集で作成コミット）
    if (isPending) {
      contentRef.current = '';
      titleNameRef.current = title;
      applyEditorContent(core, '', title);
      core.onNoteContentLoaded?.('');
      readyRef.current = true;
      core.setLoadState({ kind: 'ready', note: { path: notePath, sha: '', content: '' } });
      return;
    }
    try {
      const note = await run(openNote({ owner, name }, notePath));
      shaRef.current = note.sha;
      contentRef.current = note.content;
      titleNameRef.current = title;
      applyEditorContent(core, note.content, title);
      core.onNoteContentLoaded?.(note.content);
      readyRef.current = true;
      core.setLoadState({ kind: 'ready', note });
      await announceDraftIfAny(core);
    } catch (error) {
      handleLoadError(core, error, load);
    }
  }, [
    core,
    owner,
    name,
    notePath,
    isPending,
    generationRef,
    handleRef,
    readyRef,
    savingRef,
    conflictRef,
    dirtyRef,
    shaRef,
    contentRef,
    titleNameRef,
  ]);

  useLoadOnNoteChange(load);
  useSyncRefresh(core, load);

  return { load };
}

/** エディタ初期内容とタイトル編集 state をまとめて整える（タイトルは拡張子なし） */
function applyEditorContent(core: NotePaneCore, content: string, title: string): void {
  core.setEditorContent(content);
  core.setTitleName(title);
  core.setTitleEditing(false);
  core.setTitleDraft('');
  core.setTitleError(null);
}

/** 未保存の変更（Draft）があれば復元通知を出す */
async function announceDraftIfAny(core: NotePaneCore): Promise<void> {
  const draft = await run(loadDraft({ owner: core.owner, name: core.name }, core.notePath)).catch(
    () => null,
  );
  if (draft !== null) {
    core.setDraftNotice(draft);
  }
}

/** 読み込み失敗の共通処理（セッション失効 / エラー表示 + 再試行導線） */
function handleLoadError(core: NotePaneCore, error: unknown, retry: () => Promise<void>): void {
  if (isSessionExpiredError(error)) {
    core.notify('セッションの有効期限が切れました。ログインし直してください。');
    core.onSessionExpired();
    return;
  }
  const message = noteErrorMessage(error);
  core.setLoadState({ kind: 'error', message });
  core.notify(message, { label: '再試行', onClick: () => void retry() });
}

/** ノート切替時に paint 前へ loading を反映する（NoteEditor の二重マウント防止） */
function useLoadOnNoteChange(load: () => Promise<void>): void {
  useLayoutEffect(() => {
    void load();
  }, [load]);
}
