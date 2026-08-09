// @vitest-environment jsdom
/**
 * HTML サニタイズ（DOMPurify）のテスト。
 * ブラウザの DOM が必要なため jsdom 環境で実行する。
 */

import { describe, expect, it } from 'vitest';

import { sanitizeHtml } from '@/infra/render/sanitize';

describe('sanitizeHtml', () => {
  it('script 要素を除去する', () => {
    const html = '<p>本文</p><script>alert(1)</script>';
    expect(sanitizeHtml(html)).not.toContain('<script');
  });

  it('イベントハンドラ属性を除去する', () => {
    const html = '<img src="x.png" onerror="alert(1)">';
    const sanitized = sanitizeHtml(html);
    expect(sanitized).not.toContain('onerror');
    expect(sanitized).toContain('src="x.png"');
  });

  it('javascript: URL を除去する', () => {
    const html = '<a href="javascript:alert(1)">危険</a>';
    expect(sanitizeHtml(html)).not.toContain('javascript:');
  });

  it('WikiLink のマークアップ（class / href / data 属性）を保持する', () => {
    const html =
      '<a class="tk-wikilink" href="/octocat/notes/blob/note.md" data-note-path="note.md" data-subpath="見出し">note</a>';
    const sanitized = sanitizeHtml(html);
    expect(sanitized).toContain('class="tk-wikilink"');
    expect(sanitized).toContain('data-note-path="note.md"');
    expect(sanitized).toContain('href="/octocat/notes/blob/note.md"');
  });

  it('埋め込みと画像のマークアップを保持する', () => {
    const html =
      '<div class="note-embed" data-embed-path="child.md"><img class="note-embed-image" src="/api/raw/o/r/a.png" alt="a.png" data-embed-image="true" loading="lazy"></div>';
    const sanitized = sanitizeHtml(html);
    expect(sanitized).toContain('class="note-embed"');
    expect(sanitized).toContain('data-embed-image="true"');
    expect(sanitized).toContain('src="/api/raw/o/r/a.png"');
  });

  it('KaTeX の出力を保持する', () => {
    const html = '<span class="katex"><span class="katex-html">x</span></span>';
    const sanitized = sanitizeHtml(html);
    expect(sanitized).toContain('class="katex"');
  });

  it('見出しの id を保持する（スラグ遷移に必要）', () => {
    expect(sanitizeHtml('<h2 id="usage">Usage</h2>')).toContain('id="usage"');
  });
});

describe('埋め込み注入後の HTML はサニタイズ後も壊れない', () => {
  // renderNoteMarkdown はノード環境でも動く（KaTeX / highlight.js は動的
  // import）。配置の異なる入力に対し、出力 HTML を DOMPurify に通しても
  // <div class="note-embed"> が <p> の内側に閉じ込められないことを検証する。

  it('段落内の埋め込みは DOMPurify 後も <p> の外に保たれる', async () => {
    const { renderNoteMarkdown } = await import('@/infra/render/render');
    const result = await renderNoteMarkdown('前 ![[child]] 後', {
      path: 'root.md',
      contents: new Map([
        ['root.md', '前 ![[child]] 後'],
        ['child.md', '子の本文'],
      ]),
      filePaths: ['root.md', 'child.md'],
      imageUrl: (p) => `/api/raw/o/r/${encodeURIComponent(p)}`,
      linkHref: (p, sub) => `/octocat/notes/blob/${p}${sub !== null ? `#${sub}` : ''}`,
    });
    const sanitized = sanitizeHtml(result.html);
    expect(sanitized).toContain('<div class="note-embed"');
    expect(sanitized).not.toContain('<p><div');
    expect(sanitized).not.toContain('</div></p>');
    // DOMPurify は DOM パース経由のため、不正なネストは自動修正される。
    // 実 DOM でも <p> 内に埋め込み div が入らないことを確認する
    const document = new DOMParser().parseFromString(sanitized, 'text/html');
    const embed = document.querySelector('.note-embed');
    expect(embed?.parentElement?.tagName).not.toBe('P');
    expect(embed?.parentElement?.tagName).not.toBe('A');
  });

  it('リスト項目内の埋め込みは DOMPurify 後もリストを壊さない', async () => {
    const { renderNoteMarkdown } = await import('@/infra/render/render');
    const result = await renderNoteMarkdown('- 前\n- ![[child]]\n- 後', {
      path: 'root.md',
      contents: new Map([
        ['root.md', '- 前\n- ![[child]]\n- 後'],
        ['child.md', '子の本文'],
      ]),
      filePaths: ['root.md', 'child.md'],
      imageUrl: (p) => `/api/raw/o/r/${encodeURIComponent(p)}`,
      linkHref: (p, sub) => `/octocat/notes/blob/${p}${sub !== null ? `#${sub}` : ''}`,
    });
    const sanitized = sanitizeHtml(result.html);
    expect(sanitized).toContain('<div class="note-embed"');
    expect(sanitized).not.toContain('<p><div');
    expect(sanitized).not.toContain('</div></p>');
  });

  it('文書先頭の埋め込みは DOMPurify 後も最初の要素に保たれる', async () => {
    const { renderNoteMarkdown } = await import('@/infra/render/render');
    const result = await renderNoteMarkdown('![[child]]\n\n後続の本文', {
      path: 'root.md',
      contents: new Map([
        ['root.md', '![[child]]\n\n後続の本文'],
        ['child.md', '子の本文'],
      ]),
      filePaths: ['root.md', 'child.md'],
      imageUrl: (p) => `/api/raw/o/r/${encodeURIComponent(p)}`,
      linkHref: (p, sub) => `/octocat/notes/blob/${p}${sub !== null ? `#${sub}` : ''}`,
    });
    const sanitized = sanitizeHtml(result.html);
    expect(sanitized.trim().startsWith('<div class="note-embed"')).toBe(true);
  });
});
