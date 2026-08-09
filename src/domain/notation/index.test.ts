import { describe, expect, it } from 'vitest';

import { buildNotationIndex } from '@/domain/notation/index';

const CONTENTS = new Map<string, string>([
  ['a.md', '# A\n\n[[b]] と [[b#Sec]] と [[missing]] #x'],
  ['b.md', '# B\n## Sec\n\n![[c.md]]'],
  ['c.md', '# C\n![[a.md]]'],
  ['d.md', '---\ntags:\n  - area/project\n---\n#tag と #x\n'],
  ['e.md', '![[img.png]]'],
]);
const FILE_PATHS = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'img.png'];

function build(): ReturnType<typeof buildNotationIndex> {
  return buildNotationIndex({ filePaths: FILE_PATHS, contents: CONTENTS });
}

describe('buildNotationIndex', () => {
  it('全ノートを解析して索引に載せる', () => {
    const index = build();
    expect(index.notes.size).toBe(5);
    expect(index.notes.get('a.md')?.links.length).toBe(3);
    expect(index.notes.get('a.md')?.frontmatter).toBeNull();
    expect(index.notes.get('d.md')?.frontmatter?.fields[0]).toEqual({
      key: 'tags',
      value: 'area/project',
      values: ['area/project'],
    });
  });

  it('WikiLink を解決して path を載せる（壊れリンクは null）', () => {
    const index = build();
    const links = index.notes.get('a.md')?.links ?? [];
    expect(links[0]).toMatchObject({
      kind: 'wikilink',
      targetType: 'note',
      target: 'b',
      alias: null,
      subpath: null,
      path: 'b.md',
    });
    expect(links[2]).toMatchObject({ target: 'missing', path: null });
  });

  it('見出しリンクはターゲットノートの見出し位置まで解決する', () => {
    const index = build();
    const link = index.notes.get('a.md')?.links[1];
    expect(link).toMatchObject({
      target: 'b',
      subpath: 'Sec',
      path: 'b.md',
      heading: { text: 'Sec', from: 4, level: 2 },
    });
  });

  it('Embed（ノート・画像）も解決して path を載せる', () => {
    const index = build();
    expect(index.notes.get('b.md')?.links[0]).toMatchObject({
      kind: 'embed',
      targetType: 'note',
      target: 'c.md',
      path: 'c.md',
    });
    expect(index.notes.get('e.md')?.links[0]).toMatchObject({
      kind: 'embed',
      targetType: 'image',
      target: 'img.png',
      path: 'img.png',
    });
  });

  it('バックリンク（被参照）を参照先パスで逆引きできる', () => {
    const index = build();
    expect(index.backlinks.get('b.md')).toEqual(['a.md']);
    expect(index.backlinks.get('c.md')).toEqual(['b.md']);
    expect(index.backlinks.get('a.md')).toEqual(['c.md']);
    expect(index.backlinks.get('img.png')).toEqual(['e.md']);
    expect(index.backlinks.get('missing')).toBeUndefined();
  });

  it('タグ索引を小文字正規化して構築する（フロントマテリア + インライン）', () => {
    const index = build();
    expect(index.tagIndex.get('x')).toEqual(['a.md', 'd.md']);
    expect(index.tagIndex.get('area/project')).toEqual(['d.md']);
    expect(index.tagIndex.get('tag')).toEqual(['d.md']);
  });

  it('同一ノートが同じタグを重複して持ってもタグ一覧は 1 回', () => {
    const contents = new Map<string, string>([['note.md', '#x と #x と #X']]);
    const index = buildNotationIndex({ filePaths: ['note.md'], contents });
    expect(index.notes.get('note.md')?.tags).toEqual(['x']);
    expect(index.tagIndex.get('x')).toEqual(['note.md']);
  });

  it('壊れリンクは brokenLinks に集約する', () => {
    const index = build();
    expect(index.brokenLinks).toHaveLength(1);
    expect(index.brokenLinks[0]).toMatchObject({
      kind: 'wikilink',
      target: 'missing',
      path: null,
    });
  });

  it('ノートが何もない空の索引を構築できる', () => {
    const index = buildNotationIndex({ filePaths: [], contents: new Map() });
    expect(index.notes.size).toBe(0);
    expect(index.brokenLinks).toEqual([]);
    expect(index.backlinks.size).toBe(0);
    expect(index.tagIndex.size).toBe(0);
  });
});
