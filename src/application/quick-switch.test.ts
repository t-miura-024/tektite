/**
 * クイックスイッチャーのファジー検索ロジックのテスト（M4: M3）。
 *
 * fzf 的な部分列一致（"tkt" → "tektite"）、大文字小文字の無視、表示名一致の
 * 優先、ギャップ（一致位置の飛び）の小さい順、パスのみ一致、空クエリの
 * 全件表示を検証する。
 */

import { describe, expect, it } from 'vitest';

import { searchNoteNames } from '@/application/quick-switch';

const NOTES = [
  'README.md',
  'daily/2026-08-07.md',
  'daily/2026-08-08.md',
  'projects/tektite.md',
  'render.md',
  'decoration.md',
  'wiki.md',
  'tags.md',
];

function pathsOf(results: readonly { path: string }[]): string[] {
  return results.map((result) => result.path);
}

describe('searchNoteNames', () => {
  it('空クエリは全ノートを表示名の短い順に返す', () => {
    const results = searchNoteNames(NOTES, '');
    expect(pathsOf(results)).toEqual([
      'tags.md',
      'wiki.md',
      'README.md',
      'render.md',
      'projects/tektite.md',
      'daily/2026-08-07.md',
      'daily/2026-08-08.md',
      'decoration.md',
    ]);
  });

  it('表示名の部分列一致（飛ばし飛ばし）でノートを探せる', () => {
    // t-k-t が "tektite" に順番どおり現れる（t@0, k@2, t@3）
    const results = searchNoteNames(NOTES, 'tkt');
    expect(pathsOf(results)).toEqual(['projects/tektite.md']);
  });

  it('大文字小文字を区別しない', () => {
    expect(pathsOf(searchNoteNames(NOTES, 'TKT'))).toEqual(['projects/tektite.md']);
    expect(pathsOf(searchNoteNames(NOTES, 'RENDER'))).toEqual(['render.md']);
  });

  it('一致位置を返す（ハイライト用）', () => {
    const results = searchNoteNames(NOTES, 'tkt');
    expect(results[0]?.positions).toEqual([0, 2, 3]);
    expect(results[0]?.matchedField).toBe('name');
  });

  it('先頭に近い連続一致を上位に並べる', () => {
    // "b": "baaa" は b@0 で連続一致、"aaab" は b@3 の飛びあり
    const results = searchNoteNames(['aaab.md', 'baaa.md'], 'b');
    expect(pathsOf(results)).toEqual(['baaa.md', 'aaab.md']);
  });

  it('同じ位置・長さの一致はパスの辞書順で安定させる', () => {
    const results = searchNoteNames(NOTES, '2026');
    expect(pathsOf(results)).toEqual(['daily/2026-08-07.md', 'daily/2026-08-08.md']);
  });

  it('表示名に一致しない場合はパス全体での一致を返す', () => {
    const results = searchNoteNames(NOTES, 'daily');
    expect(pathsOf(results)).toEqual(['daily/2026-08-07.md', 'daily/2026-08-08.md']);
    expect(results[0]?.matchedField).toBe('path');
    // パス一致の位置はパス文字列内のオフセット
    expect(results[0]?.positions).toEqual([0, 1, 2, 3, 4]);
  });

  it('拡張子の .md もパス一致の対象になる', () => {
    const results = searchNoteNames(NOTES, '.md');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.matchedField).toBe('path');
  });

  it('日本語の表示名も部分列一致で探せる', () => {
    const results = searchNoteNames(['docs/会議メモ.md', 'docs/読書メモ.md'], '議メ');
    expect(pathsOf(results)).toEqual(['docs/会議メモ.md']);
    expect(results[0]?.positions).toEqual([1, 2]);
  });

  it('一致しないクエリは空を返す', () => {
    expect(searchNoteNames(NOTES, 'zzzz')).toEqual([]);
  });
});
