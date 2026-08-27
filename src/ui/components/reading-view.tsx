/**
 * リーディング表示（ノートの Markdown を描画した閲覧モード）。
 *
 * レンダリングは useNoteRender フック（組成ルート経由。sanitizeHtml 済み HTML
 * のみを DOM へ注入する）、見出しアンカーへのスクロールは useHashScroll が担う。
 *
 * - WikiLink クリック: SPA 内遷移（navigate）。#見出し は見出し位置へスクロール
 * - 画像 Embed: /api/raw プロキシ経由。読み込み失敗は代替表示に置き換える
 * - フロントマテリア: ノート上部に表示（表示のみ。編集は対象外）
 */

import type { JSX, SyntheticEvent, MouseEvent } from 'react';

import { pathBaseName } from '@/domain/tree';
import type { VaultRef } from '@/domain/vault';
import { navigate } from '@/ui/router';
import { useHashScroll } from '@/ui/use-hash-scroll';

import { useNoteRender } from '@/ui/components/use-note-render';

export type ReadingViewProps = {
  vaultRef: VaultRef;
  /** 表示対象ノートのパス（埋め込み取得と遷移先に使う） */
  notePath: string;
  /** 表示するノート本文（最新の編集内容を含みうる） */
  content: string;
  /** Vault 内の全ファイルパス（WikiLink / Embed の解決に使う） */
  filePaths: readonly string[];
  notify: (message: string, action?: { label: string; onClick: () => void }) => void;
  onSessionExpired: () => void;
};

/** 修飾キー付き / 中クリックか（ブラウザの新規タブ動作に任せる） */
function isModifiedClick(event: MouseEvent): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
}

/** クリック対象に最も近いノートリンク（data-note-path 付きアンカー）を返す */
function noteAnchorFrom(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) {
    return null;
  }
  return target.closest('a[data-note-path]');
}

/** 読み込み失敗の画像を代替表示要素へ置き換える */
function replaceWithImageFallback(event: SyntheticEvent): void {
  const target = event.target;
  if (!(target instanceof HTMLImageElement)) {
    return;
  }
  const fallback = document.createElement('span');
  fallback.className = 'note-embed-image-fallback';
  fallback.textContent = `画像を読み込めませんでした: ${target.getAttribute('alt') ?? ''}`;
  target.replaceWith(fallback);
}

/** WikiLink クリック: SPA 内遷移（props に依存しないためモジュール関数） */
function handleContentClick(event: MouseEvent<HTMLDivElement>): void {
  if (isModifiedClick(event)) {
    return;
  }
  const anchor = noteAnchorFrom(event.target);
  const href = anchor?.getAttribute('href');
  if (anchor === null || !href) {
    return;
  }
  event.preventDefault();
  navigate(href);
}

/** ノート上部のフロントマテリア表示（プロパティ。表示のみ） */
function FrontmatterDetails({
  fields,
}: {
  fields: readonly { readonly key: string; readonly value: string }[];
}): JSX.Element {
  return (
    <details className="note-frontmatter" data-testid="note-frontmatter">
      <summary className="note-frontmatter-summary">プロパティ</summary>
      <dl className="note-frontmatter-fields">
        {fields.map((field) => (
          <div className="note-frontmatter-field" key={field.key}>
            <dt>{field.key}</dt>
            <dd>{field.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function ReadingView({
  vaultRef,
  notePath,
  content,
  filePaths,
  notify,
  onSessionExpired,
}: ReadingViewProps): JSX.Element {
  const { state, html, frontmatter, embedNotice, render } = useNoteRender({
    vaultRef,
    notePath,
    content,
    filePaths,
    notify,
    onSessionExpired,
  });

  // 見出しリンク（#スラグ）へのスクロール。html 適用後と URL 変更イベントの両方で試みる
  useHashScroll(html);

  return (
    <div className="reading-view" data-testid="reading-view">
      <h1 className="reading-inline-title">{pathBaseName(notePath).replace(/\.md$/i, '')}</h1>
      {frontmatter !== null && <FrontmatterDetails fields={frontmatter.fields} />}
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
            onClick={handleContentClick}
            onError={replaceWithImageFallback}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </>
      )}
    </div>
  );
}
