import { describe, expect, it } from 'vitest';

import type { RenderNotationOptions } from '@/infra/render/render';
import { renderNoteMarkdown } from '@/infra/render/render';
import { slugify } from '@/infra/render/slug';
import { noteRoutePath } from '@/ui/router';

const REF = { owner: 'octocat', name: 'notes' };

/** テスト用のオプション（contents のキー = ファイルパス一覧として使う） */
function optionsFor(contents: Record<string, string>, path = 'root.md'): RenderNotationOptions {
  return {
    path,
    contents: new Map(Object.entries(contents)),
    filePaths: Object.keys(contents),
    imageUrl: (p) => `/api/raw/${REF.owner}/${REF.name}/${encodeURIComponent(p)}`,
    linkHref: (p, sub) => `${noteRoutePath(REF, p)}${sub !== null ? `#${slugify(sub)}` : ''}`,
  };
}

describe('WikiLink', () => {
  it('解決できる WikiLink を <a> に変換する（表示名は拡張子を除いたノート名）', async () => {
    const result = await renderNoteMarkdown(
      '[[note]]',
      optionsFor({ 'root.md': '[[note]]', 'note.md': 'hi' }),
    );
    expect(result.html).toContain(
      '<a class="tk-wikilink" href="/octocat/notes/blob/note.md" data-note-path="note.md" data-subpath="">note</a>',
    );
  });

  it('エイリアスを表示名にする', async () => {
    const result = await renderNoteMarkdown(
      '[[note|表示名]]',
      optionsFor({ 'root.md': '[[note|表示名]]', 'note.md': 'hi' }),
    );
    expect(result.html).toContain('>表示名</a>');
  });

  it('見出しリンクは #スラグ を付与する', async () => {
    const result = await renderNoteMarkdown(
      '[[note#Usage]]',
      optionsFor({ 'root.md': '[[note#Usage]]', 'note.md': '# Usage' }),
    );
    expect(result.html).toContain('href="/octocat/notes/blob/note.md#usage"');
  });

  it('大文字小文字を区別せず解決する', async () => {
    const result = await renderNoteMarkdown(
      '[[NOTE]]',
      optionsFor({ 'root.md': '[[NOTE]]', 'note.md': 'hi' }),
    );
    expect(result.html).toContain('data-note-path="note.md"');
  });

  it('解決できない WikiLink は壊れリンクとして描画する', async () => {
    const result = await renderNoteMarkdown(
      '[[missing]]',
      optionsFor({ 'root.md': '[[missing]]' }),
    );
    expect(result.html).toContain('class="tk-wikilink tk-wikilink-broken"');
    expect(result.html).not.toContain('href=');
  });

  it('ノート以外のファイル（画像）への WikiLink は壊れリンク扱い', async () => {
    const result = await renderNoteMarkdown(
      '[[logo.png]]',
      optionsFor({ 'root.md': '[[logo.png]]', 'logo.png': '' }),
    );
    expect(result.html).toContain('tk-wikilink-broken');
  });

  it('見出しリンクのスラグは対象ノートの見出し id と一致する', async () => {
    const result = await renderNoteMarkdown(
      '本文 ![[child]]\n\n[[child#使い方]]',
      optionsFor({
        'root.md': '本文 ![[child]]\n\n[[child#使い方]]',
        'child.md': '# 使い方\n\n中身',
      }),
    );
    expect(result.html).toContain('<h1 id="使い方">使い方</h1>');
    expect(result.html).toContain('href="/octocat/notes/blob/child.md#使い方"');
  });
});

describe('Tag', () => {
  it('インラインタグを <span class="tk-tag"> に変換する', async () => {
    const result = await renderNoteMarkdown(
      'タグ #area/project です',
      optionsFor({ 'root.md': 'タグ #area/project です' }),
    );
    expect(result.html).toContain('<span class="tk-tag">#area/project</span>');
  });
});

describe('Embed', () => {
  it('画像 Embed を <img> に変換する（raw プロキシ URL）', async () => {
    const result = await renderNoteMarkdown(
      '![[logo.png]]',
      optionsFor({ 'root.md': '![[logo.png]]', 'logo.png': '' }),
    );
    expect(result.html).toContain(
      '<img class="note-embed-image" src="/api/raw/octocat/notes/logo.png" alt="logo.png" data-embed-image="true" loading="lazy">',
    );
  });

  it('存在しない画像 Embed は壊れ埋め込みとして描画する', async () => {
    const result = await renderNoteMarkdown(
      '![[missing.png]]',
      optionsFor({ 'root.md': '![[missing.png]]' }),
    );
    expect(result.html).toContain('<span class="tk-embed tk-embed-broken">![[missing.png]]</span>');
  });

  it('ノート Embed を本文展開に変換する（前後の段落は保持される）', async () => {
    const result = await renderNoteMarkdown(
      'before\n\n![[child]]\n\nafter',
      optionsFor({ 'root.md': 'before\n\n![[child]]\n\nafter', 'child.md': '子の本文' }),
    );
    expect(result.html).toContain('<p>before</p>');
    expect(result.html).toContain('<p>after</p>');
    expect(result.html).toContain('<div class="note-embed" data-embed-path="child.md">');
    expect(result.html).toContain('子の本文');
  });

  it('ノート Embed は再帰的に展開する', async () => {
    const result = await renderNoteMarkdown(
      '![[a]]',
      optionsFor({
        'root.md': '![[a]]',
        'a.md': 'A ![[b]]',
        'b.md': 'B ![[c]]',
        'c.md': 'C',
      }),
    );
    expect(result.html).toContain('A');
    expect(result.html).toContain('B');
    expect(result.html).toContain('C');
    const embeds = result.html.match(/class="note-embed"/g) ?? [];
    expect(embeds.length).toBe(3);
  });

  it('循環参照は展開を停止し、cycles を報告する', async () => {
    const result = await renderNoteMarkdown(
      '![[b]]',
      optionsFor({ 'root.md': '![[b]]', 'b.md': 'B ![[root]]' }),
    );
    expect(result.cycles).toEqual([['root.md', 'b.md', 'root.md']]);
    expect(result.html).toContain('B');
    expect(result.html).toContain('class="embed-collapsed"');
  });

  it('本文が取得できない Embed は壊れ埋め込みとして描画する', async () => {
    const result = await renderNoteMarkdown('![[ghost]]', optionsFor({ 'root.md': '![[ghost]]' }));
    expect(result.html).toContain('<span class="tk-embed tk-embed-broken">![[ghost]]</span>');
  });

  // 配置別の注入テスト（difit 指摘: ブロック要素の注入は配置によって
  // 不正な HTML（<p> 内の <div>）になりうるため、配置ごとに検証する）

  it('文書先頭のノート Embed を本文展開に変換する', async () => {
    const result = await renderNoteMarkdown(
      '![[child]]\n\n後続の本文',
      optionsFor({ 'root.md': '![[child]]\n\n後続の本文', 'child.md': '子の本文' }),
    );
    expect(result.html.trim().startsWith('<div class="note-embed"')).toBe(true);
    expect(result.html).toContain('<p>後続の本文</p>');
    expect(result.html).not.toContain('<p><div');
    expect(result.html).not.toContain('</div></p>');
  });

  it('段落内のノート Embed は段落を分断して注入する（<p> 内に <div> が入らない）', async () => {
    const result = await renderNoteMarkdown(
      '前の段落の続き ![[child]] 後の続き',
      optionsFor({ 'root.md': '前の段落の続き ![[child]] 後の続き', 'child.md': '子の本文' }),
    );
    expect(result.html).toContain('<p>前の段落の続き </p>');
    expect(result.html).toContain('<div class="note-embed" data-embed-path="child.md">');
    expect(result.html).toContain('<p> 後の続き</p>');
    expect(result.html).not.toContain('<p><div');
    expect(result.html).not.toContain('</div></p>');
  });

  it('リスト項目内のノート Embed はリストを壊さず注入する', async () => {
    const result = await renderNoteMarkdown(
      '- 前\n- ![[child]]\n- 後',
      optionsFor({ 'root.md': '- 前\n- ![[child]]\n- 後', 'child.md': '子の本文' }),
    );
    expect(result.html).toContain('<li>前</li>');
    expect(result.html).toContain('<div class="note-embed" data-embed-path="child.md">');
    expect(result.html).toContain('<li>後</li>');
    expect(result.html).not.toContain('<p><div');
    expect(result.html).not.toContain('</div></p>');
  });

  it('埋め込みのみの本文は Embed ブロックをルート要素として返す', async () => {
    const result = await renderNoteMarkdown(
      '![[child]]',
      optionsFor({ 'root.md': '![[child]]', 'child.md': '子の本文' }),
    );
    const trimmed = result.html.trim();
    expect(trimmed.startsWith('<div class="note-embed" data-embed-path="child.md">')).toBe(true);
    expect(trimmed.endsWith('</div>')).toBe(true);
    expect(trimmed).not.toContain('<p><div');
  });

  it('連続するノート Embed をそれぞれ展開する', async () => {
    const result = await renderNoteMarkdown(
      '![[a]]\n\n![[b]]',
      optionsFor({ 'root.md': '![[a]]\n\n![[b]]', 'a.md': 'A', 'b.md': 'B' }),
    );
    const embeds = result.html.match(/class="note-embed"/g) ?? [];
    expect(embeds.length).toBe(2);
    expect(result.html).not.toContain('<p><div');
    expect(result.html).not.toContain('</div></p>');
  });
});

describe('Frontmatter', () => {
  it('フロントマテリアは本文から除去する（表示は UI 側）', async () => {
    const result = await renderNoteMarkdown(
      '---\ntags: [a, b]\ntitle: タイトル\n---\n本文',
      optionsFor({ 'root.md': '---\ntags: [a, b]\ntitle: タイトル\n---\n本文' }),
    );
    expect(result.html).not.toContain('tags:');
    expect(result.html).not.toContain('タイトル');
    expect(result.html).toContain('本文');
  });
});

describe('コールアウト / 引用 / タスクリスト', () => {
  it('> [!type] をコールアウトに変換する', async () => {
    const result = await renderNoteMarkdown(
      '> [!warning] 注意\n> 内容です',
      optionsFor({ 'root.md': '> [!warning] 注意\n> 内容です' }),
    );
    expect(result.html).toContain('<div class="callout callout-warning">');
    expect(result.html).toContain('<div class="callout-title">注意</div>');
    expect(result.html).toContain('内容です');
  });

  it('タイトルなしコールアウトは type をタイトルにする', async () => {
    const result = await renderNoteMarkdown(
      '> [!note]\n> 本文',
      optionsFor({ 'root.md': '> [!note]\n> 本文' }),
    );
    expect(result.html).toContain('<div class="callout-title">note</div>');
  });

  it('コールアウト内の Markdown も描画する', async () => {
    const result = await renderNoteMarkdown(
      '> [!tip] ヒント\n> **太字** と `コード`',
      optionsFor({ 'root.md': '> [!tip] ヒント\n> **太字** と `コード`' }),
    );
    expect(result.html).toContain('<strong>太字</strong>');
    expect(result.html).toContain('<code>コード</code>');
  });

  it('マーカーがない引用は通常の blockquote のまま', async () => {
    const result = await renderNoteMarkdown(
      '> 通常の引用',
      optionsFor({ 'root.md': '> 通常の引用' }),
    );
    expect(result.html).toContain('<blockquote>');
    expect(result.html).not.toContain('callout');
  });

  it('コールアウト内の WikiLink / 数式も変換する', async () => {
    const result = await renderNoteMarkdown(
      '> [!note] 参照\n> [[note]] と $x$',
      optionsFor({ 'root.md': '> [!note] 参照\n> [[note]] と $x$', 'note.md': 'hi' }),
    );
    expect(result.html).toContain('class="tk-wikilink"');
    expect(result.html).toContain('class="katex"');
  });

  it('ネストしたコールアウトも変換する', async () => {
    const result = await renderNoteMarkdown(
      '> [!note] 外\n> 本文\n>\n> > [!warning] 内\n> > 内側',
      optionsFor({ 'root.md': '> [!note] 外\n> 本文\n>\n> > [!warning] 内\n> > 内側' }),
    );
    expect(result.html).toContain('callout-note');
    expect(result.html).toContain('callout-warning');
    expect(result.html).toContain('内側');
  });

  it('テーブルを描画する', async () => {
    const result = await renderNoteMarkdown(
      '| A | B |\n|---|---|\n| 1 | 2 |',
      optionsFor({ 'root.md': '| A | B |\n|---|---|\n| 1 | 2 |' }),
    );
    expect(result.html).toContain('<table>');
    expect(result.html).toContain('<td>1</td>');
  });

  it('タスクリストをチェックボックス付きリストに変換する', async () => {
    const result = await renderNoteMarkdown(
      '- [ ] 未完了\n- [x] 完了',
      optionsFor({ 'root.md': '- [ ] 未完了\n- [x] 完了' }),
    );
    expect(result.html).toContain('<input class="task-list-checkbox" disabled="" type="checkbox">');
    expect(result.html).toContain(
      '<input class="task-list-checkbox" disabled="" type="checkbox" checked="">',
    );
  });
});

describe('コード', () => {
  it('言語指定付きコードをハイライトする', async () => {
    const result = await renderNoteMarkdown(
      '```js\nconst x = 1;\n```',
      optionsFor({ 'root.md': '```js\nconst x = 1;\n```' }),
    );
    expect(result.html).toContain('<pre><code class="hljs language-js">');
    expect(result.html).toContain('hljs-keyword');
  });

  it('未登録言語はプレーン表示（言語クラスのみ付く）', async () => {
    const result = await renderNoteMarkdown(
      '```hoge\nconst x = 1;\n```',
      optionsFor({ 'root.md': '```hoge\nconst x = 1;\n```' }),
    );
    expect(result.html).toContain('<pre><code class="language-hoge">const x = 1;</code></pre>');
    expect(result.html).not.toContain('hljs-');
  });

  it('言語指定なしのコードはエスケープして表示する', async () => {
    const result = await renderNoteMarkdown(
      '```\n<a>\n```',
      optionsFor({ 'root.md': '```\n<a>\n```' }),
    );
    expect(result.html).toContain('<pre><code>&lt;a&gt;</code></pre>');
  });

  it('インラインコードはエスケープして表示する', async () => {
    const result = await renderNoteMarkdown('`<a>`', optionsFor({ 'root.md': '`<a>`' }));
    expect(result.html).toContain('<code>&lt;a&gt;</code>');
  });
});

describe('見出し', () => {
  it('見出しにスラグ id を付与する', async () => {
    const result = await renderNoteMarkdown(
      '# Hello World',
      optionsFor({ 'root.md': '# Hello World' }),
    );
    expect(result.html).toContain('<h1 id="hello-world">Hello World</h1>');
  });

  it('同名見出しの重複 id は連番で区別する', async () => {
    const result = await renderNoteMarkdown(
      '# Same\n\n## Same',
      optionsFor({ 'root.md': '# Same\n\n## Same' }),
    );
    expect(result.html).toContain('<h1 id="same">');
    expect(result.html).toContain('<h2 id="same-2">');
  });
});

describe('数式', () => {
  it('インライン数式を KaTeX で描画する', async () => {
    const result = await renderNoteMarkdown(
      '面積は $a^2$ です',
      optionsFor({ 'root.md': '面積は $a^2$ です' }),
    );
    expect(result.html).toContain('class="katex"');
  });

  it('ブロック数式を KaTeX display で描画する', async () => {
    const result = await renderNoteMarkdown('$$E=mc^2$$', optionsFor({ 'root.md': '$$E=mc^2$$' }));
    expect(result.html).toContain('katex-display');
  });

  it('コード内の $ は数式にしない', async () => {
    const result = await renderNoteMarkdown(
      '```\n$a$\n```\n\n`$b$`',
      optionsFor({ 'root.md': '```\n$a$\n```\n\n`$b$`' }),
    );
    expect(result.html).not.toContain('class="katex"');
  });

  it('数式が Markdown 装飾と混在しても崩れない', async () => {
    const result = await renderNoteMarkdown(
      '**太字 $x$ 太字**',
      optionsFor({ 'root.md': '**太字 $x$ 太字**' }),
    );
    expect(result.html).toContain('<strong>太字 ');
    expect(result.html).toContain('class="katex"');
  });
});

describe('コード内の記法は変換しない', () => {
  it('コードフェンス内の WikiLink / Tag はそのまま表示する', async () => {
    const result = await renderNoteMarkdown(
      '```\n[[note]] #tag\n```',
      optionsFor({ 'root.md': '```\n[[note]] #tag\n```', 'note.md': 'hi' }),
    );
    expect(result.html).not.toContain('class="tk-wikilink"');
    expect(result.html).not.toContain('class="tk-tag"');
    expect(result.html).toContain('[[note]] #tag');
  });

  it('インラインコード内の WikiLink は変換しない', async () => {
    const result = await renderNoteMarkdown(
      '`[[note]]`',
      optionsFor({ 'root.md': '`[[note]]`', 'note.md': 'hi' }),
    );
    expect(result.html).not.toContain('class="tk-wikilink"');
    expect(result.html).toContain('<code>[[note]]</code>');
  });
});
