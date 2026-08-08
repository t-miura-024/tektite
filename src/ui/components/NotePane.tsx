/**
 * ノートペイン（Vault 内画面のメインペイン。選択中ノートの表示と編集）。
 *
 * ノートを読み込んで CM6 エディタ（src/infra/editor）を表示する。
 * エラー UX 基本方針: トースト表示 + リトライ（コンテンツ側にもリトライ導線）。
 *
 * ユースケースの実行は組成ルート（src/composition）の run() 経由で行う。
 */

import { useCallback, useEffect, useState } from 'react';

import { openNote } from '@/application/note';
import type { NoteContent } from '@/application/note';
import { run } from '@/composition';
import type { VaultRef } from '@/domain/vault';

import { NoteEditor } from '@/ui/components/NoteEditor';
import { noteErrorMessage } from '@/ui/note-error';
import type { ToastAction } from '@/ui/toast';
import { isSessionExpiredError } from '@/ui/vault-error';

export interface NotePaneProps {
  vaultRef: VaultRef;
  /** 表示・編集対象のノートパス（Vault ルートからの / 区切り） */
  notePath: string;
  notify: (message: string, action?: ToastAction) => void;
  onSessionExpired: () => void;
}

type NoteState =
  | { kind: 'loading' }
  | { kind: 'ready'; note: NoteContent }
  | { kind: 'error'; message: string };

export function NotePane({ vaultRef, notePath, notify, onSessionExpired }: NotePaneProps) {
  const [state, setState] = useState<NoteState>({ kind: 'loading' });

  // オブジェクトの同一性ではなく値（owner / name）で依存を比較する
  const { owner, name } = vaultRef;

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const note = await run(openNote({ owner, name }, notePath));
      setState({ kind: 'ready', note });
    } catch (error) {
      if (isSessionExpiredError(error)) {
        notify('セッションの有効期限が切れました。ログインし直してください。');
        onSessionExpired();
        return;
      }
      const message = noteErrorMessage(error);
      setState({ kind: 'error', message });
      notify(message, { label: '再試行', onClick: () => void load() });
    }
  }, [owner, name, notePath, notify, onSessionExpired]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="note-pane">
      <header className="note-pane-header">
        <p className="note-pane-path" data-testid="note-path">
          {notePath}
        </p>
      </header>
      {state.kind === 'loading' && (
        <p className="app-placeholder" role="status">
          ノートを読み込み中…
        </p>
      )}
      {state.kind === 'error' && (
        <div className="error-panel">
          <p>{state.message}</p>
          <button type="button" className="button-secondary" onClick={() => void load()}>
            再試行
          </button>
        </div>
      )}
      {state.kind === 'ready' && (
        <NoteEditor key={notePath} notePath={notePath} initialContent={state.note.content} />
      )}
    </div>
  );
}
