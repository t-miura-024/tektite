import { describe, expect, it } from 'vitest';

import {
  isImageTarget,
  parseFrontmatter,
  parseLinkText,
  parseNotation,
  type NotationSpan,
} from '@/domain/notation/parse';

function spans(text: string): readonly NotationSpan[] {
  return parseNotation(text).spans;
}

describe('parseLinkText', () => {
  it('基本形を分解する', () => {
    expect(parseLinkText('ノート')).toEqual({
      target: 'ノート',
      alias: null,
      subpath: null,
    });
  });

  it('エイリアスは最後の | 以降', () => {
    expect(parseLinkText('ノート|表示名')).toEqual({
      target: 'ノート',
      alias: '表示名',
      subpath: null,
    });
    expect(parseLinkText('A|B|C')).toEqual({ target: 'A|B', alias: 'C', subpath: null });
  });

  it('サブパスは最初の # 以降', () => {
    expect(parseLinkText('ノート#見出し')).toEqual({
      target: 'ノート',
      alias: null,
      subpath: '見出し',
    });
    expect(parseLinkText('ノート#見出し|表示名')).toEqual({
      target: 'ノート',
      alias: '表示名',
      subpath: '見出し',
    });
  });

  it('ブロック参照（#^ブロック）もサブパスとして解析する（解決時に壊れる）', () => {
    expect(parseLinkText('ノート#^abc123')).toEqual({
      target: 'ノート',
      alias: null,
      subpath: '^abc123',
    });
  });

  it('空ターゲット・空サブパスは null', () => {
    expect(parseLinkText('')).toBeNull();
    expect(parseLinkText('|x')).toBeNull();
    expect(parseLinkText('#見出し')).toBeNull();
    expect(parseLinkText('ノート#')).toBeNull();
    expect(parseLinkText('ノート|')).toEqual({ target: 'ノート', alias: null, subpath: null });
  });
});

describe('WikiLink の解析', () => {
  it('基本形 [[ノート]] をオフセット付きで返す', () => {
    expect(spans('[[ノート]]')).toEqual([
      { kind: 'wikilink', from: 0, to: 7, target: 'ノート', alias: null, subpath: null },
    ]);
  });

  it('エイリアス付き [[ノート|表示名]]', () => {
    expect(spans('[[ノート|表示名]]')).toEqual([
      { kind: 'wikilink', from: 0, to: 11, target: 'ノート', alias: '表示名', subpath: null },
    ]);
  });

  it('見出しリンク [[ノート#見出し]]', () => {
    expect(spans('[[ノート#見出し]]')).toEqual([
      { kind: 'wikilink', from: 0, to: 11, target: 'ノート', alias: null, subpath: '見出し' },
    ]);
  });

  it('複数リンクは出現順に返す', () => {
    expect(spans('本文 [[A]] と [[B]]')).toEqual([
      { kind: 'wikilink', from: 3, to: 8, target: 'A', alias: null, subpath: null },
      { kind: 'wikilink', from: 11, to: 16, target: 'B', alias: null, subpath: null },
    ]);
  });

  it('閉じのない・空のリンクは解析しない', () => {
    expect(spans('[[]]')).toEqual([]);
    expect(spans('[[ノート')).toEqual([]);
    expect(spans('[[|x]]')).toEqual([]);
    expect(spans('[[#h]]')).toEqual([]);
    expect(spans('[[ノート#]]')).toEqual([]);
  });

  it('エスケープされた [[ は解析しない', () => {
    expect(spans('\\[[ノート]]')).toEqual([]);
    expect(spans('前 \\[[ノート]] 後')).toEqual([]);
  });

  it('行をまたぐ [[ は解析しない', () => {
    expect(spans('[[ノート\nまだ]]')).toEqual([]);
  });
});

describe('Embed の解析', () => {
  it('画像 Embed ![[画像.png]] を画像として分類する', () => {
    expect(spans('![[画像.png]]')).toEqual([
      {
        kind: 'embed',
        from: 0,
        to: 11,
        target: '画像.png',
        alias: null,
        subpath: null,
        targetType: 'image',
      },
    ]);
  });

  it('ノート Embed ![[ノート]] をノートとして分類する', () => {
    expect(spans('![[ノート]]')).toEqual([
      {
        kind: 'embed',
        from: 0,
        to: 8,
        target: 'ノート',
        alias: null,
        subpath: null,
        targetType: 'note',
      },
    ]);
  });

  it('拡張子は大文字小文字を区別しない', () => {
    expect(spans('![[IMG.PNG]]')[0]).toMatchObject({ targetType: 'image' });
    expect(spans('![[photo.WebP]]')[0]).toMatchObject({ targetType: 'image' });
  });

  it('画像リスト外の拡張子はノート扱い', () => {
    expect(spans('![[doc.pdf]]')[0]).toMatchObject({ targetType: 'note' });
    expect(spans('![[audio.mp3]]')[0]).toMatchObject({ targetType: 'note' });
  });

  it('エイリアス付き Embed も解析できる', () => {
    expect(spans('![[ノート|埋め込み]]')[0]).toMatchObject({
      kind: 'embed',
      target: 'ノート',
      alias: '埋め込み',
      targetType: 'note',
    });
  });
});

describe('isImageTarget', () => {
  it('画像拡張子を true と判定する', () => {
    expect(isImageTarget('foo.png')).toBe(true);
    expect(isImageTarget('a/b/foo.jpeg')).toBe(true);
    expect(isImageTarget('foo.svg')).toBe(true);
    expect(isImageTarget('FOO.GIF')).toBe(true);
  });

  it('それ以外は false', () => {
    expect(isImageTarget('foo.md')).toBe(false);
    expect(isImageTarget('foo.pdf')).toBe(false);
    expect(isImageTarget('foo')).toBe(false);
    expect(isImageTarget('.png')).toBe(false);
  });
});

describe('Tag の解析', () => {
  it('インライン #タグ をオフセット付きで返す', () => {
    expect(spans('本文 #タグ1 あり')).toEqual([{ kind: 'tag', from: 3, to: 7, tag: 'タグ1' }]);
  });

  it('ネストタグ #area/project', () => {
    expect(spans('#area/project')).toEqual([{ kind: 'tag', from: 0, to: 13, tag: 'area/project' }]);
  });

  it('英数字・_・- を含むタグ', () => {
    expect(spans('#tag-1_tag')).toEqual([{ kind: 'tag', from: 0, to: 10, tag: 'tag-1_tag' }]);
  });

  it('見出し # 見出し はタグにしない', () => {
    expect(spans('# 見出し')).toEqual([]);
  });

  it('数字のみ #123 はタグにしない', () => {
    expect(spans('#123')).toEqual([]);
  });

  it('単語の途中 # はタグにしない（foo#bar / C#）', () => {
    expect(spans('foo#bar')).toEqual([]);
    expect(spans('C#')).toEqual([]);
  });

  it('日本語の途中 # はタグにしない', () => {
    expect(spans('日本語#タグ')).toEqual([]);
  });

  it('タグの直後に . があってもタグはそこで終わる', () => {
    expect(spans('#tag.')).toEqual([{ kind: 'tag', from: 0, to: 4, tag: 'tag' }]);
  });

  it('括弧に囲まれたタグは解析する', () => {
    expect(spans('(#tag)')).toEqual([{ kind: 'tag', from: 1, to: 5, tag: 'tag' }]);
  });

  it('エスケープされた # はタグにしない', () => {
    expect(spans('\\#tag')).toEqual([]);
  });

  it('リンクとタグが混在しても両方解析する', () => {
    expect(spans('[[note]] #tag')).toEqual([
      { kind: 'wikilink', from: 0, to: 8, target: 'note', alias: null, subpath: null },
      { kind: 'tag', from: 9, to: 13, tag: 'tag' },
    ]);
  });
});

describe('コード内の記法は解析しない', () => {
  it('インラインコードスパン内はスキップする', () => {
    expect(spans('`#tag` と `[[note]]`')).toEqual([]);
  });

  it('インラインコードの後は解析を再開する', () => {
    expect(spans('`#a` #tag')).toEqual([{ kind: 'tag', from: 5, to: 9, tag: 'tag' }]);
  });

  it('コードフェンス内はスキップする', () => {
    expect(spans('```\n#tag\n[[note]]\n```\n#tag')).toEqual([
      { kind: 'tag', from: 22, to: 26, tag: 'tag' },
    ]);
  });
});

describe('Frontmatter の解析', () => {
  it('スカラー値のフィールドを抽出する', () => {
    const result = parseNotation('---\ntitle: Hello\ncreated: 2026-08-08\n---\n本文');
    expect(result.frontmatter).toMatchObject({
      from: 0,
      to: 40,
      fields: [
        { key: 'title', value: 'Hello', values: ['Hello'] },
        { key: 'created', value: '2026-08-08', values: ['2026-08-08'] },
      ],
    });
    expect(result.frontmatterTags).toEqual([]);
  });

  it('クォートと末尾コメントを除去する', () => {
    const result = parseNotation('---\ntitle: "Hello"\nnote: 説明 # コメント\n---\n');
    expect(result.frontmatter?.fields).toEqual([
      { key: 'title', value: 'Hello', values: ['Hello'] },
      { key: 'note', value: '説明', values: ['説明'] },
    ]);
  });

  it('tags: スカラーをタグとして抽出する', () => {
    const result = parseNotation('---\ntags: a, b\n---\n');
    expect(result.frontmatterTags).toEqual(['a', 'b']);
  });

  it('tags: インライン配列を抽出する', () => {
    const result = parseNotation('---\ntags: [a, b]\n---\n');
    expect(result.frontmatterTags).toEqual(['a', 'b']);
  });

  it('tags: リスト形式を抽出する', () => {
    const result = parseNotation('---\ntags:\n  - area/project\n  - daily\n---\n');
    expect(result.frontmatterTags).toEqual(['area/project', 'daily']);
    expect(result.frontmatter?.fields).toEqual([
      { key: 'tags', value: 'area/project, daily', values: ['area/project', 'daily'] },
    ]);
  });

  it('tags キーは大文字小文字を区別しない', () => {
    const result = parseNotation('---\nTags:\n  - x\n---\n');
    expect(result.frontmatterTags).toEqual(['x']);
  });

  it('ネストした構造（インデント付き）は無視する', () => {
    const result = parseNotation('---\ndate:\n  created: 2026\n---\n');
    expect(result.frontmatter?.fields).toEqual([{ key: 'date', value: '', values: [] }]);
  });

  it('閉じデリミタがない --- はフロントマテリアにしない', () => {
    const result = parseNotation('---\ntags: a\n本文');
    expect(result.frontmatter).toBeNull();
  });

  it('フロントマテリア直後のオフセットは本文基準になる', () => {
    const result = parseNotation('---\ntags: a\n---\n\n本文 [[note]]');
    expect(result.frontmatter).toMatchObject({ from: 0, to: 15 });
    expect(result.spans).toEqual([
      { kind: 'wikilink', from: 20, to: 28, target: 'note', alias: null, subpath: null },
    ]);
  });

  it('parseFrontmatter は単体でも使える', () => {
    expect(parseFrontmatter('---\nx: 1\n---\n')).toMatchObject({ from: 0, to: 12 });
    expect(parseFrontmatter('本文だけ')).toBeNull();
  });
});
