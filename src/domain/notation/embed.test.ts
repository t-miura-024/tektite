import { describe, expect, it } from 'vitest';

import { expandNoteEmbeds } from '@/domain/notation/embed';

describe('expandNoteEmbeds', () => {
  it('ネストした埋め込みを再帰的に展開する', () => {
    const contents = new Map<string, string>([
      ['a.md', '![[b]]'],
      ['b.md', '![[c]]'],
      ['c.md', '# C'],
    ]);
    const result = expandNoteEmbeds(contents, 'a.md');
    expect(result).toEqual({
      embeds: [
        {
          path: 'b.md',
          depth: 1,
          from: 0,
          to: 6,
          children: [{ path: 'c.md', depth: 2, from: 0, to: 6, children: [] }],
        },
      ],
      truncated: [],
      cycles: [],
    });
  });

  it('循環参照（a → b → c → a）を検出して打ち切る', () => {
    const contents = new Map<string, string>([
      ['a.md', '![[b]]'],
      ['b.md', '![[c]]'],
      ['c.md', '![[a.md]]'],
    ]);
    const result = expandNoteEmbeds(contents, 'a.md');
    expect(result.cycles).toEqual([['a.md', 'b.md', 'c.md', 'a.md']]);
    // 打ち切った位置には子なしのノードが残る
    const cNode = result.embeds[0]?.children[0]?.children[0];
    expect(cNode).toMatchObject({ path: 'a.md', depth: 3, children: [] });
    expect(result.truncated).toEqual([]);
  });

  it('自分自身を埋め込む自己循環を検出する', () => {
    const contents = new Map<string, string>([['a.md', '![[a.md]]']]);
    const result = expandNoteEmbeds(contents, 'a.md');
    expect(result.cycles).toEqual([['a.md', 'a.md']]);
    expect(result.embeds[0]).toMatchObject({ path: 'a.md', depth: 1, children: [] });
  });

  it('深さ上限（maxDepth）で展開を打ち切る', () => {
    const contents = new Map<string, string>([
      ['a.md', '![[b.md]]'],
      ['b.md', '![[c.md]]'],
      ['c.md', '![[d.md]]'],
      ['d.md', '# D'],
    ]);
    const result = expandNoteEmbeds(contents, 'a.md', { maxDepth: 2 });
    expect(result.truncated).toEqual(['d.md']);
    const dNode = result.embeds[0]?.children[0]?.children[0];
    expect(dNode).toMatchObject({ path: 'd.md', depth: 3, children: [] });
    // 上限内のノードは通常どおり展開される
    expect(result.embeds[0]?.children[0]).toMatchObject({ path: 'c.md', depth: 2 });
  });

  it('既定の深さ上限は 8', () => {
    const contents = new Map<string, string>();
    for (let i = 0; i < 10; i += 1) {
      contents.set(`n${i}.md`, i === 9 ? '# end' : `![[n${i + 1}.md]]`);
    }
    const result = expandNoteEmbeds(contents, 'n0.md');
    expect(result.truncated).toEqual(['n9.md']);
    let node = result.embeds[0];
    for (let depth = 1; depth <= 8; depth += 1) {
      expect(node?.path).toBe(`n${depth}.md`);
      node = node?.children[0];
    }
    expect(node).toMatchObject({ path: 'n9.md', depth: 9, children: [] });
  });

  it('画像 Embed は展開対象外（ツリーに含めない）', () => {
    const contents = new Map<string, string>([
      ['a.md', '![[img.png]] と ![[b.md]]'],
      ['b.md', '# B'],
    ]);
    const result = expandNoteEmbeds(contents, 'a.md');
    expect(result.embeds).toHaveLength(1);
    expect(result.embeds[0]).toMatchObject({ path: 'b.md' });
  });

  it('解決できない埋め込み（壊れリンク）はツリーに含めない', () => {
    const contents = new Map<string, string>([['a.md', '![[missing.md]]']]);
    const result = expandNoteEmbeds(contents, 'a.md');
    expect(result.embeds).toEqual([]);
    expect(result.truncated).toEqual([]);
    expect(result.cycles).toEqual([]);
  });

  it('複数のトップレベル埋め込みは出現順に返す', () => {
    const contents = new Map<string, string>([
      ['a.md', '![[b.md]] と ![[c.md]]'],
      ['b.md', '# B'],
      ['c.md', '# C'],
    ]);
    const result = expandNoteEmbeds(contents, 'a.md');
    expect(result.embeds.map((node) => node.path)).toEqual(['b.md', 'c.md']);
  });

  it('contents にないルートは空の結果を返す', () => {
    const result = expandNoteEmbeds(new Map([['b.md', '# B']]), 'missing.md');
    expect(result.embeds).toEqual([]);
    expect(result.truncated).toEqual([]);
    expect(result.cycles).toEqual([]);
  });
});
