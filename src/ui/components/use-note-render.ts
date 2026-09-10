/**
 * ノート本文から HTML を作るフック。生成は組成ルート経由で呼ぶ。
 * HTML はサニタイズしてから DOM に入れる。埋め込みは幅優先で収集する。
 */

import { useCallback, useState } from 'react';
import { openNote } from '@/application/note';
import {
  collectEmbedContents,
  renderNoteMarkdown,
  run,
  sanitizeHtml,
  slugify,
} from '@/composition';
import { parseNotation, type Frontmatter } from '@/domain/notation/parse';
import type { VaultRef } from '@/domain/vault';
import { noteRoutePath } from '@/ui/router';
import type { ToastAction } from '@/ui/toast';
import { isSessionExpiredError } from '@/ui/vault-error';

export type RenderState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

export type NoteRender = {
  state: RenderState;
  html: string;
  frontmatter: Frontmatter | null;
  embedNotice: string | null;
  /** 再度レンダリングする（エラー時の再試行） */
  render: () => Promise<void>;
};

type UseNoteRenderArgs = {
  vaultRef: VaultRef;
  notePath: string;
  content: string;
  filePaths: readonly string[];
  notify: (message: string, action?: ToastAction) => void;
  onSessionExpired: () => void;
};

export function useNoteRender({
  vaultRef,
  notePath,
  content,
  filePaths,
  notify,
  onSessionExpired,
}: UseNoteRenderArgs): NoteRender {
  const [state, setState] = useState<RenderState>({ kind: 'loading' });
  const [html, setHtml] = useState('');
  const [frontmatter, setFrontmatter] = useState<Frontmatter | null>(null);
  const [embedNotice, setEmbedNotice] = useState<string | null>(null);

  const render = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      // 埋め込み先ノートの本文を幅優先で収集する（存在しないノートは壊れ表示）
      const contents = await collectEmbedContents(notePath, filePaths, async (path) => {
        try {
          const note = await run(openNote(vaultRef, path));
          return { content: note.content };
        } catch (error) {
          if (isSessionExpiredError(error)) {
            notify('セッションの有効期限が切れました。ログインし直してください。');
            onSessionExpired();
          }
          return null;
        }
      });
      const result = await renderNoteMarkdown(content, {
        path: notePath,
        contents,
        filePaths,
        imageUrl: (path) =>
          `/api/raw/${encodeURIComponent(vaultRef.owner)}/${encodeURIComponent(vaultRef.name)}/${encodeURIComponent(path)}`,
        linkHref: (path, subpath) =>
          `${noteRoutePath(vaultRef, path)}${subpath !== null ? `#${slugify(subpath)}` : ''}`,
      });
      setFrontmatter(parseNotation(content).frontmatter);
      setEmbedNotice(
        result.cycles.length > 0 || result.truncated.length > 0
          ? '循環参照・深さ上限のため一部の埋め込みを展開しませんでした。'
          : null,
      );
      setHtml(sanitizeHtml(result.html));
      setState({ kind: 'ready' });
    } catch {
      setState({ kind: 'error', message: 'ノートの表示に失敗しました。' });
      notify('ノートの表示に失敗しました。', { label: '再試行', onClick: () => void render() });
    }
  }, [vaultRef, notePath, content, filePaths, notify, onSessionExpired]);

  return { state, html, frontmatter, embedNotice, render };
}
