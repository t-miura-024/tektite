import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import {
  computeDecorationSet,
  HtmlBreakWidget,
  TaskCheckboxWidget,
} from '@/infra/editor/markdown-decoration';

interface Found {
  readonly from: number;
  readonly to: number;
  readonly className?: string;
  readonly widget?: TaskCheckboxWidget | HtmlBreakWidget;
}

/** ドキュメントの装飾セットをクラス名と位置のリストに変換する */
function collect(docText: string): Found[] {
  const doc = EditorState.create({ doc: docText }).doc;
  const decos = computeDecorationSet(doc);
  const found: Found[] = [];
  decos.between(0, doc.length, (from, to, value) => {
    const spec = value.spec as {
      class?: string;
      widget?: TaskCheckboxWidget | HtmlBreakWidget;
    };
    found.push({ from, to, className: spec.class, widget: spec.widget });
  });
  return found;
}

describe('CM6 ライブプレビュー装飾（decoration 変換）', () => {
  it('見出しのマーカーとテキストをクラス付き decoration に変換する', () => {
    expect(collect('# 見出し')).toEqual([
      { from: 0, to: 1, className: 'tk-heading-marker' },
      { from: 2, to: 5, className: 'tk-heading tk-heading-1' },
    ]);
  });

  it('強調・インラインコード・リンクを mark decoration に変換する', () => {
    expect(collect('**太字** と `コード` と [リンク](url)')).toEqual([
      { from: 2, to: 4, className: 'tk-bold' },
      { from: 9, to: 14, className: 'tk-inline-code' },
      { from: 18, to: 21, className: 'tk-link' },
      { from: 23, to: 26, className: 'tk-link-url' },
    ]);
  });

  it('フェンスドコードの行を line decoration に変換する（ゼロ長範囲）', () => {
    expect(collect('```\ncode\n```')).toEqual([
      { from: 0, to: 0, className: 'tk-code-fence' },
      { from: 4, to: 4, className: 'tk-code-block' },
      { from: 9, to: 9, className: 'tk-code-fence' },
    ]);
  });

  it('引用を line decoration とマーカーに変換する', () => {
    expect(collect('> 引用')).toEqual([
      { from: 0, to: 0, className: 'tk-quote' },
      { from: 0, to: 1, className: 'tk-quote-marker' },
    ]);
  });

  it('タスクリストのチェックボックスを checked 付き widget に変換する', () => {
    const found = collect('- [x] 完了');
    const checkbox = found.find((f) => f.widget instanceof TaskCheckboxWidget);
    expect(checkbox).toEqual({ from: 2, to: 5, widget: new TaskCheckboxWidget(true) });
    expect(found).toContainEqual({ from: 0, to: 2, className: 'tk-task-marker' });
  });

  it('未完了タスクは checked: false の widget になる', () => {
    const found = collect('- [ ] 未完了');
    const checkbox = found.find((f) => f.widget instanceof TaskCheckboxWidget);
    expect(checkbox?.widget instanceof TaskCheckboxWidget && checkbox.widget.checked).toBe(false);
  });

  it('水平線を mark decoration に変換する', () => {
    expect(collect('---')).toEqual([{ from: 0, to: 3, className: 'tk-hr' }]);
  });

  it('空のドキュメントは空の decoration セットになる', () => {
    expect(collect('')).toEqual([]);
  });

  it('HTML コメントをライブプレビュー用のコメント装飾に変換する', () => {
    expect(collect('<!-- meta -->')).toEqual([{ from: 0, to: 13, className: 'tk-html-comment' }]);
  });

  it('先頭Frontmatterをプロパティ装飾へ変換する', () => {
    const found = collect('---\nkey: value\n---\n本文');
    expect(found).toContainEqual({ from: 0, to: 0, className: 'tk-frontmatter-delimiter' });
    expect(found).toContainEqual({ from: 4, to: 4, className: 'tk-frontmatter-field' });
    expect(found).toContainEqual({ from: 15, to: 15, className: 'tk-frontmatter-delimiter' });
  });

  it('HTMLのbr要素を改行Widgetへ置換する', () => {
    const found = collect('前<br>後');
    expect(found).toContainEqual({
      from: 1,
      to: 5,
      widget: new HtmlBreakWidget(),
    });
  });
});
