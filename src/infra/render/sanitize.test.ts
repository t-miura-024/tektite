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
      '<a class="wikilink" href="/octocat/notes/blob/note.md" data-note-path="note.md" data-subpath="見出し">note</a>';
    const sanitized = sanitizeHtml(html);
    expect(sanitized).toContain('class="wikilink"');
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
