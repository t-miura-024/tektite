/**
 * 全文検索クエリ層のユニットテスト（M4: M2 全文検索 UI）。
 * マッチ・優先度（本文 > ファイル名 > タグ）・スニペット / ハイライトを検証する。
 */

import { describe, expect, it } from 'vitest';

import { buildSnippet, createNoteSearcher, highlightParts } from '@/application/search';
import type { SearchableNote } from '@/application/search';

const notes: SearchableNote[] = [
  {
    // タグ meeting はパスに含めない（#meeting がタグ一致として分類されることを検証するため）
    path: 'archive/2026-08.md',
    content: '今週の定例ミーティングで検索機能を議論した。',
    tags: ['meeting'],
  },
  {
    path: 'search-design.md',
    content: 'クイックスイッチャーの設計メモ。',
    tags: ['design', 'navigation'],
  },
  { path: 'misc/scratch.md', content: '買い物リスト: 牛乳・卵・パン', tags: [] },
];

describe('createNoteSearcher', () => {
  it('ノート本文に一致するノートがヒットする', () => {
    const searcher = createNoteSearcher(notes);
    const hits = searcher.search('牛乳');
    expect(hits.map((hit) => hit.path)).toContain('misc/scratch.md');
    expect(hits[0]).toMatchObject({ path: 'misc/scratch.md', kind: 'content' });
  });

  it('ファイル名（パス）に一致するノートがヒットする', () => {
    const searcher = createNoteSearcher(notes);
    const hits = searcher.search('search-design');
    expect(hits.map((hit) => hit.path)).toContain('search-design.md');
    const hit = hits.find((h) => h.path === 'search-design.md');
    expect(hit?.kind).toBe('name');
  });

  it('タグに一致するノートがヒットする（# 付きクエリ）', () => {
    const searcher = createNoteSearcher(notes);
    const hits = searcher.search('#meeting');
    expect(hits.map((hit) => hit.path)).toContain('archive/2026-08.md');
    const hit = hits.find((h) => h.path === 'archive/2026-08.md');
    expect(hit?.kind).toBe('tag');
    expect(hit?.matchedTags).toEqual(['meeting']);
  });

  it('タグに一致するノートがヒットする（# なしクエリ）', () => {
    const searcher = createNoteSearcher(notes);
    const hits = searcher.search('navigation');
    expect(hits.map((hit) => hit.path)).toContain('search-design.md');
    const hit = hits.find((h) => h.path === 'search-design.md');
    expect(hit?.kind).toBe('tag');
  });

  it('大文字小文字を区別しない', () => {
    const searcher = createNoteSearcher(notes);
    expect(searcher.search('MEETING').length).toBeGreaterThan(0);
    expect(searcher.search('Search-Design').length).toBeGreaterThan(0);
  });

  it('長音を含むカタカナ語でヒットする', () => {
    const searcher = createNoteSearcher([
      { path: 'notes/alpha.md', content: '本文に キーワード を含む', tags: [] },
    ]);
    const hits = searcher.search('キーワード');
    expect(hits.map((hit) => hit.path)).toContain('notes/alpha.md');
    expect(hits[0]?.kind).toBe('content');
  });

  it('本文一致 > ファイル名一致 > タグ一致 の優先順で並ぶ', () => {
    const searcher = createNoteSearcher([
      { path: 'content.md', content: '検索 が本文にあるノート', tags: [] },
      { path: '検索-file.md', content: '本文は別の話題', tags: [] },
      { path: 'tag.md', content: '本文は別の話題', tags: ['検索'] },
    ]);
    const hits = searcher.search('検索');
    expect(hits.map((hit) => hit.path)).toEqual(['content.md', '検索-file.md', 'tag.md']);
    expect(hits.map((hit) => hit.kind)).toEqual(['content', 'name', 'tag']);
  });

  it('複数種別に一致するノートは優先度の高い種別（本文）と判定される', () => {
    const searcher = createNoteSearcher([
      {
        path: '両方.md',
        content: '本文にも 検索 という語を含む',
        tags: ['検索'],
      },
    ]);
    const hits = searcher.search('検索');
    expect(hits[0]?.kind).toBe('content');
  });

  it('複数語は AND 検索になる', () => {
    const searcher = createNoteSearcher(notes);
    const hits = searcher.search('定例 ミーティング');
    expect(hits.map((hit) => hit.path)).toContain('archive/2026-08.md');
    expect(hits.map((hit) => hit.path)).not.toContain('search-design.md');
  });

  it('空クエリ（空白のみ）は空配列を返す', () => {
    const searcher = createNoteSearcher(notes);
    expect(searcher.search('')).toEqual([]);
    expect(searcher.search('   ')).toEqual([]);
  });

  it('一致しないクエリは空配列を返す', () => {
    const searcher = createNoteSearcher(notes);
    expect(searcher.search('存在しない語')).toEqual([]);
  });

  it('結果上限（50 件）を超える場合は先頭 50 件に絞る', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      path: `notes/note-${i}.md`,
      content: `共通のキーワード ${i}`,
      tags: [] as string[],
    }));
    const searcher = createNoteSearcher(many);
    const hits = searcher.search('共通');
    expect(hits.length).toBe(50);
  });

  it('本文一致の結果は一致スニペットを持つ', () => {
    const searcher = createNoteSearcher(notes);
    const hit = searcher.search('牛乳')[0];
    expect(hit?.snippet).not.toBeNull();
    const text = hit!.snippet!.map((part) => part.text).join('');
    expect(text).toContain('牛乳');
    expect(hit!.snippet!.some((part) => part.highlight && part.text === '牛乳')).toBe(true);
  });

  it('ファイル名・タグ一致の結果はスニペットを持たない', () => {
    const searcher = createNoteSearcher(notes);
    const nameHit = searcher.search('search-design').find((h) => h.kind === 'name');
    expect(nameHit?.snippet).toBeNull();
    const tagHit = searcher.search('#meeting').find((h) => h.kind === 'tag');
    expect(tagHit?.snippet).toBeNull();
  });

  it('検索対象が空の場合は常に空配列を返す', () => {
    const searcher = createNoteSearcher([]);
    expect(searcher.search('何か')).toEqual([]);
  });
});

describe('highlightParts', () => {
  it('一致部分をハイライト断片に分割する', () => {
    const parts = highlightParts('abc検索def', ['検索']);
    expect(parts).toEqual([
      { from: 0, text: 'abc', highlight: false },
      { from: 3, text: '検索', highlight: true },
      { from: 5, text: 'def', highlight: false },
    ]);
  });

  it('一致が複数ある場合はすべて分割する', () => {
    const parts = highlightParts('検索と検索', ['検索']);
    expect(parts.filter((part) => part.highlight)).toHaveLength(2);
  });

  it('隣接・重複する一致は 1 つのハイライトにまとめる', () => {
    const parts = highlightParts('検索検索', ['検索']);
    expect(parts).toEqual([{ from: 0, text: '検索検索', highlight: true }]);
  });

  it('長音を含むカタカナ語は 1 つのハイライトにまとまる', () => {
    const parts = highlightParts('本文に キーワード を含む', ['キーワード']);
    expect(parts).toEqual([
      { from: 0, text: '本文に ', highlight: false },
      { from: 4, text: 'キーワード', highlight: true },
      { from: 9, text: ' を含む', highlight: false },
    ]);
  });

  it('クエリ語の大文字小文字を区別しない', () => {
    const parts = highlightParts('Search result', ['search']);
    expect(parts).toEqual([
      { from: 0, text: 'Search', highlight: true },
      { from: 6, text: ' result', highlight: false },
    ]);
  });

  it('一致がなければ 1 つの非ハイライト断片を返す', () => {
    expect(highlightParts('abc', ['xyz'])).toEqual([{ from: 0, text: 'abc', highlight: false }]);
  });

  it('空テキスト・空クエリは空断片を返す', () => {
    expect(highlightParts('', ['a'])).toEqual([{ from: 0, text: '', highlight: false }]);
    expect(highlightParts('abc', [])).toEqual([{ from: 0, text: 'abc', highlight: false }]);
  });
});

describe('buildSnippet', () => {
  it('本文が長い場合は最初の一致箇所を中心に切り出す（前後に省略記号を付ける）', () => {
    const content = 'あいうえお'.repeat(10) + '検索' + 'かきくけこ'.repeat(20);
    const parts = buildSnippet(content, ['検索']);
    expect(parts).not.toBeNull();
    expect(parts![0]).toEqual({ from: -1, text: '…', highlight: false });
    expect(parts!.at(-1)).toEqual({ from: -2, text: '…', highlight: false });
    expect(parts!.some((part) => part.highlight && part.text === '検索')).toBe(true);
  });

  it('本文が短い場合は省略記号を付けない', () => {
    const parts = buildSnippet('検索の本文', ['検索']);
    expect(parts).toEqual([
      { from: 0, text: '検索', highlight: true },
      { from: 2, text: 'の本文', highlight: false },
    ]);
  });

  it('一致がなければ null を返す', () => {
    expect(buildSnippet('abc', ['xyz'])).toBeNull();
  });
});
