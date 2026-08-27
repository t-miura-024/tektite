/**
 * ノート本文 → HTML のレンダリング状態を担うフック。
 *
 * レンダリングパイプライン（src/infra/render）は UI から直接 import できない
 * 規約のため、組成ルート（src/composition）経由で呼ぶ。パイプラインが返す
 * HTML はサニタイズ前に DOM へ注入しない（sanitizeHtml を必ず通す）。
 *
 * - 埋め込み（![[ノート]]）: 対象ノートを application の openNote で取得し、
 *   collectEmbedContents が幅優先で収集してから一括レンダリングする
 * - 壊れリンク / 壊れ埋め込み: パイプラインが専用クラスを付与する（CSS 側）
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

/** 画像 Embed の raw プロキシ URL を作る（パスは 1 セグメントにエンコード） */
function rawImageUrl(ref: VaultRef, path: string): string {
  return `/api/raw/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/${encodeURIComponent(path)}`;
}

/** WikiLink の遷移先 URL を作る（#見出し はスラグ化して付与する） */
function noteHref(ref: VaultRef, path: string, subpath: string | null): string {
  return `${noteRoutePath(ref, path)}${subpath !== null ? `#${slugify(subpath)}` : ''}`;
}

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
        imageUrl: (path) => rawImageUrl(vaultRef, path),
        linkHref: (path, subpath) => noteHref(vaultRef, path, subpath),
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
