/**
 * リーディング表示（ノートの Markdown を描画した閲覧モード）。
 *
 * レンダリングパイプライン（src/infra/render）は UI から直接 import できない
 * 規約のため、組成ルート（src/composition）経由で呼ぶ。パイプラインが返す
 * HTML はサニタイズ前に DOM へ注入しない（sanitizeHtml を必ず通す）。
 *
 * - 埋め込み（![[ノート]]）: 対象ノートを application の openNote で取得し、
 *   collectEmbedContents が幅優先で収集してから一括レンダリングする
 * - WikiLink クリック: SPA 内遷移（navigate）。#見出し は見出し位置へスクロール
 * - 壊れリンク / 壊れ埋め込み: パイプラインが専用クラスを付与する（CSS 側）
 * - 画像 Embed: /api/raw プロキシ経由。読み込み失敗は代替表示に置き換える
 * - フロントマテリア: ノート上部に表示（表示のみ。編集は対象外）
 */

import { useCallback, useEffect, useState } from 'react';

import { openNote } from '@/application/note';
import { run } from '@/composition';
import { collectEmbedContents, renderNoteMarkdown, sanitizeHtml, slugify } from '@/composition';
import type { Frontmatter } from '@/domain/notation/parse';
import { parseNotation } from '@/domain/notation/parse';
import { pathBaseName } from '@/domain/tree';
import type { VaultRef } from '@/domain/vault';
import { navigate, noteRoutePath, NAVIGATE_EVENT_NAME } from '@/ui/router';
import { isSessionExpiredError } from '@/ui/vault-error';
import type { ToastAction } from '@/ui/toast';

export interface ReadingViewProps {
  vaultRef: VaultRef;
  /** 表示対象ノートのパス（埋め込み取得と遷移先に使う） */
  notePath: string;
  /** 表示するノート本文（最新の編集内容を含みうる） */
  content: string;
  /** Vault 内の全ファイルパス（WikiLink / Embed の解決に使う） */
  filePaths: readonly string[];
  notify: (message: string, action?: ToastAction) => void;
  onSessionExpired: () => void;
}

/** 画像 Embed の raw プロキシ URL を作る（パスは 1 セグメントにエンコード） */
function rawImageUrl(ref: VaultRef, path: string): string {
  return `/api/raw/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/${encodeURIComponent(path)}`;
}

/** WikiLink の遷移先 URL を作る（#見出し はスラグ化して付与する） */
function noteHref(ref: VaultRef, path: string, subpath: string | null): string {
  return `${noteRoutePath(ref, path)}${subpath !== null ? `#${slugify(subpath)}` : ''}`;
}

type RenderState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

export function ReadingView({
  vaultRef,
  notePath,
  content,
  filePaths,
  notify,
  onSessionExpired,
}: ReadingViewProps) {
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
      const sanitized = sanitizeHtml(result.html);
      setFrontmatter(parseNotation(content).frontmatter);
      setEmbedNotice(
        result.cycles.length > 0 || result.truncated.length > 0
          ? '循環参照・深さ上限のため一部の埋め込みを展開しませんでした。'
          : null,
      );
      setHtml(sanitized);
      setState({ kind: 'ready' });
    } catch {
      setState({
        kind: 'error',
        message: 'ノートの表示に失敗しました。',
      });
      notify('ノートの表示に失敗しました。', { label: '再試行', onClick: () => void render() });
    }
  }, [vaultRef, notePath, content, filePaths, notify, onSessionExpired]);

  useEffect(() => {
    void render();
  }, [render]);

  // 見出しリンク（#スラグ）へのスクロール。リロード・SPA 遷移・同一ノート内
  // 遷移のすべてで動くよう、html 適用後と URL 変更イベントの両方で試みる
  useEffect(() => {
    const scrollToHash = (): void => {
      const hash = window.location.hash;
      if (hash.length <= 1) {
        return;
      }
      const id = decodeURIComponent(hash.slice(1));
      document.getElementById(id)?.scrollIntoView({ block: 'start' });
    };
    scrollToHash();
    window.addEventListener('hashchange', scrollToHash);
    window.addEventListener(NAVIGATE_EVENT_NAME, scrollToHash);
    return () => {
      window.removeEventListener('hashchange', scrollToHash);
      window.removeEventListener(NAVIGATE_EVENT_NAME, scrollToHash);
    };
  }, [html, notePath]);

  /** WikiLink クリック: SPA 内遷移（修飾キー付きはブラウザの新規タブ動作に任せる） */
  const handleClick = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const anchor = target.closest('a[data-note-path]');
    const href = anchor?.getAttribute('href');
    if (!anchor || !href) {
      return;
    }
    event.preventDefault();
    navigate(href);
  }, []);

  /** 画像 Embed の読み込み失敗: 代替表示に置き換える（onError はキャプチャで拾う） */
  const handleImageError = useCallback((event: React.SyntheticEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLImageElement)) {
      return;
    }
    const fallback = document.createElement('span');
    fallback.className = 'note-embed-image-fallback';
    fallback.textContent = `画像を読み込めませんでした: ${target.getAttribute('alt') ?? ''}`;
    target.replaceWith(fallback);
  }, []);

  return (
    <div className="reading-view" data-testid="reading-view">
      <h1 className="reading-inline-title">{pathBaseName(notePath).replace(/\.md$/i, '')}</h1>
      {frontmatter !== null && (
        <details className="note-frontmatter" data-testid="note-frontmatter">
          <summary className="note-frontmatter-summary">プロパティ</summary>
          <dl className="note-frontmatter-fields">
            {frontmatter.fields.map((field) => (
              <div className="note-frontmatter-field" key={field.key}>
                <dt>{field.key}</dt>
                <dd>{field.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {state.kind === 'loading' && (
        <p className="app-placeholder" role="status">
          ノートを表示中…
        </p>
      )}
      {state.kind === 'error' && (
        <div className="error-panel">
          <p>{state.message}</p>
          <button type="button" className="button-secondary" onClick={() => void render()}>
            再試行
          </button>
        </div>
      )}
      {state.kind === 'ready' && (
        <>
          {embedNotice !== null && (
            <p className="embed-notice" role="status">
              {embedNotice}
            </p>
          )}
          <div
            className="reading-content"
            data-testid="reading-content"
            onClick={handleClick}
            onError={handleImageError}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </>
      )}
    </div>
  );
}
