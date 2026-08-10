/**
 * CM6 のライブプレビュー装飾（decoration）。
 *
 * domain 層の Markdown 構文解析（src/domain/markdown/parse）の結果を
 * CM6 の DecorationSet に変換する。ドキュメントが変更されるたびに再解析し、
 * 見出し・強調・コード・リスト・引用・リンク・水平線などをインライン装飾する。
 *
 * 編集は常にソーステキストに対して行われる（WYSIWYG の DOM 変換はしない）。
 * タスクリストの `[ ]` / `[x]` は replace decoration でチェックボックス表示に
 * 差し替えるが、ソーステキスト自体は変わらない。
 *
 * 装飾クラスは tk- プレフィックスを使い、アプリの CSS 変数（--color-*）に
 * 追従させる（ダークモードでも整合する）。
 */

import { RangeSetBuilder, StateField } from '@codemirror/state';
import type { Text } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';

import {
  parseMarkdownDecorations,
  type MarkdownDecoration,
  type MarkdownDecorationType,
} from '@/domain/markdown/parse';

/** タスクリストのチェックボックス表示（ソースの `[ ]` を視覚的に置き換える） */
export class TaskCheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  override eq(other: TaskCheckboxWidget): boolean {
    return other.checked === this.checked;
  }

  override toDOM(): HTMLElement {
    const box = document.createElement('span');
    box.className = this.checked ? 'tk-task-checkbox checked' : 'tk-task-checkbox';
    box.setAttribute('aria-hidden', 'true');
    return box;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** 解析結果 1 件を対応する Decoration に変換する */
function toDecoration(d: MarkdownDecoration): Decoration {
  switch (d.type) {
    case 'heading-marker':
      return Decoration.mark({ class: 'tk-heading-marker' });
    case 'heading':
      return Decoration.mark({ class: `tk-heading tk-heading-${d.level ?? 1}` });
    case 'bold':
      return Decoration.mark({ class: 'tk-bold' });
    case 'italic':
      return Decoration.mark({ class: 'tk-italic' });
    case 'bold-italic':
      return Decoration.mark({ class: 'tk-bold-italic' });
    case 'inline-code':
      return Decoration.mark({ class: 'tk-inline-code' });
    case 'code-fence':
      return Decoration.line({ class: 'tk-code-fence' });
    case 'code-block':
      return Decoration.line({ class: 'tk-code-block' });
    case 'list-marker':
      return Decoration.mark({ class: 'tk-list-marker' });
    case 'task-marker':
      return Decoration.mark({ class: 'tk-task-marker' });
    case 'task-checkbox':
      return Decoration.replace({ widget: new TaskCheckboxWidget(d.checked ?? false) });
    case 'quote':
      return Decoration.line({ class: 'tk-quote' });
    case 'quote-marker':
      return Decoration.mark({ class: 'tk-quote-marker' });
    case 'link-text':
      return Decoration.mark({ class: 'tk-link' });
    case 'link-url':
      return Decoration.mark({ class: 'tk-link-url' });
    case 'hr':
      return Decoration.mark({ class: 'tk-hr' });
  }
}

/**
 * ドキュメント全体の装飾セットを組み立てる（純粋関数。テスト用に分離）。
 * RangeSetBuilder は from 昇順 + 同一 from では startSide 昇順（line decoration が先）
 * で追加することを要求するため、その順に整列してから追加する。
 */
export function computeDecorationSet(doc: Text): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const text = doc.toString();
  const decorations = parseMarkdownDecorations(text).toSorted(
    (a, b) => a.from - b.from || startSide(a) - startSide(b),
  );
  const ranges = [
    ...decorations.map((decoration) => ({
      from: decoration.from,
      to: decoration.to,
      line: isLineType(decoration.type),
      value: toDecoration(decoration),
    })),
    ...htmlCommentRanges(text),
  ].toSorted((a, b) => a.from - b.from || Number(a.line) * -1 - Number(b.line) * -1);
  for (const range of ranges) {
    // LineDecoration はゼロ長で追加する（CM6 の制約: 行全体への適用は from の行で決まる）
    if (range.line) {
      builder.add(range.from, range.from, range.value);
    } else {
      builder.add(range.from, range.to, range.value);
    }
  }
  return builder.finish();
}

function htmlCommentRanges(text: string): Array<{
  from: number;
  to: number;
  line: false;
  value: Decoration;
}> {
  const ranges: Array<{ from: number; to: number; line: false; value: Decoration }> = [];
  const comments = /<!--[\s\S]*?-->/g;
  for (const match of text.matchAll(comments)) {
    const from = match.index;
    if (from === undefined) {
      continue;
    }
    ranges.push({
      from,
      to: from + match[0].length,
      line: false,
      value: Decoration.mark({ class: 'tk-html-comment' }),
    });
  }
  return ranges;
}

/** 行全体に適用する装飾種別（Decoration.line を使う） */
function isLineType(type: MarkdownDecorationType): boolean {
  switch (type) {
    case 'code-fence':
    case 'code-block':
    case 'quote':
      return true;
    default:
      return false;
  }
}

/** RangeSetBuilder の startSide 順序: line decoration 相当（quote 等）を先に置く */
function startSide(d: MarkdownDecoration): number {
  return isLineType(d.type) ? -1 : 1;
}

/**
 * ドキュメント変更のたびに装飾を再計算する StateField。
 * 変更時のみ再解析する（カーソル移動・選択変更では計算しない）ため、
 * タイピング中の再解析は体感で遅延しない。
 */
export const markdownDecoration = StateField.define<DecorationSet>({
  create(state) {
    return computeDecorationSet(state.doc);
  },
  update(deco, tr) {
    if (!tr.docChanged) {
      return deco;
    }
    return computeDecorationSet(tr.state.doc);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** 装飾クラスのスタイル。アプリの CSS 変数に追従しダークモードでも整合する */
export const markdownDecorationTheme = EditorView.baseTheme({
  '.tk-html-comment': { color: '#6272a4' },
  '.tk-heading-marker': { color: 'var(--color-fg-muted)' },
  '.tk-heading': { fontWeight: '700', color: 'var(--color-fg)' },
  '.tk-heading-1': { fontSize: '1.6em', lineHeight: 1.25 },
  '.tk-heading-2': { fontSize: '1.4em', lineHeight: 1.3 },
  '.tk-heading-3': { fontSize: '1.2em', lineHeight: 1.35 },
  '.tk-heading-4': { fontSize: '1.05em' },
  '.tk-heading-5': { fontSize: '1em' },
  '.tk-heading-6': { fontSize: '0.95em', color: 'var(--color-fg-muted)' },
  '.tk-bold': { fontWeight: '800' },
  '.tk-italic': { fontStyle: 'italic' },
  '.tk-bold-italic': { fontWeight: '800', fontStyle: 'italic' },
  '.tk-inline-code': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.875em',
    backgroundColor: 'var(--color-bg-subtle)',
    borderRadius: '4px',
    padding: '0.1em 0.35em',
  },
  '.tk-code-block': {
    display: 'block',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.875em',
    backgroundColor: 'var(--color-bg-subtle)',
    padding: '0 0.75em',
  },
  '.tk-code-fence': {
    display: 'block',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.875em',
    backgroundColor: 'var(--color-bg-subtle)',
    color: 'var(--color-fg-muted)',
    padding: '0 0.75em',
  },
  '.tk-list-marker': { color: 'var(--color-fg-muted)' },
  '.tk-task-marker': { color: 'var(--color-fg-muted)' },
  '.tk-task-checkbox': {
    display: 'inline-block',
    width: '0.95em',
    height: '0.95em',
    border: '1px solid var(--color-border)',
    borderRadius: '4px',
    backgroundColor: 'var(--color-bg)',
    marginRight: '0.35em',
    verticalAlign: '-0.1em',
  },
  '.tk-task-checkbox.checked': {
    backgroundColor: 'var(--color-accent)',
    borderColor: 'var(--color-accent)',
  },
  '.tk-quote': {
    borderLeft: '3px solid var(--color-border)',
    paddingLeft: 'var(--space-md)',
    color: 'var(--color-fg-muted)',
  },
  '.tk-quote-marker': { color: 'var(--color-fg-muted)' },
  '.tk-link': { color: 'var(--color-accent)', textDecoration: 'underline' },
  '.tk-link-url': { color: 'var(--color-fg-muted)' },
  '.tk-hr': {
    display: 'block',
    height: '1px',
    backgroundColor: 'var(--color-border)',
    color: 'transparent',
  },
});
