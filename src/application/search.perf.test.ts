/**
 * 全文検索の性能実測（M4 修正: difit 指摘 1）。
 *
 * 完了条件 1 の「タイピング中の逐次検索が実用的な速度で応答する」を裏付ける
 * ため、個人 Vault 規模（1,000 ノート相当）の合成データで索引構築と 1 クエリ
 * あたりの検索時間を計測する。計測値は console.log で出力し、Issue #5 の
 * 🐿️ メモに追記する（2026-08-08 の「実行時に計測してメモへ追記する」の実施）。
 *
 * アサートの閾値は CI マシンの性能差でフレークしないよう余裕を持たせる
 * （実際の所要は通常これより 1〜2 桁速い）。
 */

import { describe, expect, it } from 'vitest';

import { createNoteSearcher } from '@/application/search';
import type { SearchableNote } from '@/application/search';

/** 実 Vault らしい 1,000 ノート相当の合成データ（日本語本文 + タグ）を生成する */
function buildVaultNotes(count: number): SearchableNote[] {
  const topics = ['エディタ', '検索', 'ミーティング', 'バックリンク', 'ライブプレビュー'];
  return Array.from({ length: count }, (_, i) => ({
    path: `notes/${String(i % 50).padStart(2, '0')}/note-${String(i).padStart(4, '0')}.md`,
    content: [
      `# ノート ${i}`,
      '',
      `これはノート ${i} の本文です。${topics[i % topics.length]} に関するメモを残しています。`,
      '会議の議事録と TODO リスト。次のアクションは明日起票する。',
      `重複する語 ${i % 7} と固有名詞 Sample-${i % 11} を含む。`,
    ].join('\n'),
    tags: [`area/project-${i % 20}`, i % 3 === 0 ? 'meeting' : 'reference'],
  }));
}

/** タイピング相当: 逐次入力されうるクエリ列（部分一致・タグ・日本語を含む） */
const TYPING_QUERIES = [
  'エディタ',
  'ミーティング',
  '検索',
  'note',
  'ノート 12',
  'バックリンク',
  '議事録',
  'TODO',
  '#meeting',
  'project-3',
  'ライブプレビュー',
  'Sample-5',
  '重複',
  '会議',
  '明日起票',
  'note-001',
  '日本語',
  '存在しない語',
  'a',
  'エ',
];

describe('全文検索の性能実測（完了条件 1 の裏付け）', () => {
  it('1,000 ノート相当の索引構築と逐次検索が実用的な速度である', () => {
    const notes = buildVaultNotes(1000);

    const buildStart = performance.now();
    const searcher = createNoteSearcher(notes);
    const buildMs = performance.now() - buildStart;

    // 各クエリを複数回実行して平均を取る（JIT 暖気の影響を緩和）
    const searchStart = performance.now();
    let queryCount = 0;
    for (let round = 0; round < 3; round++) {
      for (const query of TYPING_QUERIES) {
        searcher.search(query);
        queryCount++;
      }
    }
    const searchTotalMs = performance.now() - searchStart;
    const perQueryMs = searchTotalMs / queryCount;

    console.log(
      `[search-perf] notes=1000 indexBuild=${buildMs.toFixed(1)}ms ` +
        `perQuery(avg ${queryCount} runs)=${perQueryMs.toFixed(3)}ms`,
    );

    // 個人 Vault 規模の目安（余裕のある閾値。実際はこれより大幅に速い）
    expect(buildMs).toBeLessThan(2000);
    expect(perQueryMs).toBeLessThan(50);
  });
});
