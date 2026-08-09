/**
 * ノート表示名ヘルパー（note-name.ts）のテスト（M4 修正: difit 指摘 4）。
 *
 * 検索結果・タグ一覧・クイックスイッチャーが共通で使う表示名（拡張子除去）の
 * 規則を 1 箇所で検証する。
 */

import { describe, expect, it } from 'vitest';

import { noteDisplayName } from '@/application/note-name';

describe('noteDisplayName', () => {
  it('ルート直下の Markdown ノートは拡張子を除いた表示名になる', () => {
    expect(noteDisplayName('render.md')).toBe('render');
  });

  it('ディレクトリ内のノートは最終セグメントの表示名になる', () => {
    expect(noteDisplayName('daily/2026-08-08.md')).toBe('2026-08-08');
  });

  it('拡張子以外の末尾（ディレクトリ名）はそのまま返す', () => {
    expect(noteDisplayName('attachments')).toBe('attachments');
  });

  it('.md 以外のファイルは拡張子を除かない', () => {
    expect(noteDisplayName('assets/logo.png')).toBe('logo.png');
  });
});
