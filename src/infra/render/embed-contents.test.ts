import { describe, expect, it } from 'vitest';

import { collectEmbedContents } from '@/infra/render/embed-contents';

/** フェッチャーの呼び出しを記録しつつ contents から応答するスタブを作る */
function stubFetcher(contents: Record<string, string>) {
  const calls: string[] = [];
  const fetch = async (path: string): Promise<{ content: string } | null> => {
    calls.push(path);
    const content = contents[path];
    return content === undefined ? null : { content };
  };
  return { fetch, calls };
}

describe('collectEmbedContents', () => {
  it('ルートと埋め込み先を幅優先で収集する', async () => {
    const { fetch, calls } = stubFetcher({
      'root.md': '見出し\n![[child.md]]',
      'child.md': '![[grand.md]]',
      'grand.md': '本文',
    });
    const contents = await collectEmbedContents(
      'root.md',
      ['root.md', 'child.md', 'grand.md'],
      fetch,
    );
    expect(contents.get('root.md')).toBe('見出し\n![[child.md]]');
    expect(contents.get('child.md')).toBe('![[grand.md]]');
    expect(contents.get('grand.md')).toBe('本文');
    expect(calls).toEqual(['root.md', 'child.md', 'grand.md']);
  });

  it('同じノートを 2 回埋め込んでも 1 回しか取得しない', async () => {
    const { fetch, calls } = stubFetcher({
      'root.md': '![[a.md]] ![[a.md]]',
      'a.md': 'A',
    });
    const contents = await collectEmbedContents('root.md', ['root.md', 'a.md'], fetch);
    expect(contents.get('a.md')).toBe('A');
    expect(calls).toEqual(['root.md', 'a.md']);
  });

  it('深さ上限に達した先は取得しない（上限は domain の embed.ts と揃える）', async () => {
    const { fetch, calls } = stubFetcher({
      'a.md': '![[b.md]]',
      'b.md': '![[c.md]]',
      'c.md': '![[d.md]]',
      'd.md': 'D',
    });
    const contents = await collectEmbedContents('a.md', ['a.md', 'b.md', 'c.md', 'd.md'], fetch, 2);
    expect(contents.has('a.md')).toBe(true);
    expect(contents.has('b.md')).toBe(true);
    expect(contents.has('c.md')).toBe(true);
    expect(contents.has('d.md')).toBe(false);
    expect(calls).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('解決できない埋め込みは取得しない', async () => {
    const { fetch, calls } = stubFetcher({
      'root.md': '![[missing.md]] ![[img.png]]',
    });
    const contents = await collectEmbedContents('root.md', ['root.md', 'img.png'], fetch);
    expect(contents.size).toBe(1);
    expect(calls).toEqual(['root.md']);
  });

  it('取得に失敗したノートはマップに入れない', async () => {
    const { fetch, calls } = stubFetcher({
      'root.md': '![[a.md]]',
    });
    const contents = await collectEmbedContents('root.md', ['root.md', 'a.md'], fetch);
    expect(contents.size).toBe(1);
    expect(calls).toEqual(['root.md', 'a.md']);
  });
});
