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
 * 追従させる（ダークモードでも整合する）。スタイルは markdown-decoration-theme、
 * フロントマテリア領域は frontmatter-decoration が担う。
 */

import { RangeSetBuilder, StateField, type Text } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

import {
  parseMarkdownDecorations,
  type MarkdownDecoration,
  type MarkdownDecorationType,
} from '@/domain/markdown/parse';
import {
  frontmatterFieldMarks,
  frontmatterRanges,
  FrontmatterPropertyWidget,
} from '@/infra/editor/frontmatter-decoration';

export { FrontmatterPropertyWidget };

/** タスクリストのチェックボックス表示（ソースの `[ ]` を視覚的に置き換える） */
// eslint-disable-next-line no-restricted-syntax -- CodeMirror WidgetType は抽象クラス継承が必須のフレームワーク API（class 禁止ルールの対象外）
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

// eslint-disable-next-line no-restricted-syntax -- CodeMirror WidgetType は抽象クラス継承が必須のフレームワーク API（class 禁止ルールの対象外）
export class HtmlBreakWidget extends WidgetType {
  override toDOM(): HTMLElement {
    return document.createElement('br');
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** 行全体に適用する装飾種別（Decoration.line を使うもの） */
const LINE_TYPES: ReadonlySet<MarkdownDecorationType> = new Set([
  'code-fence',
  'code-block',
  'quote',
]);

/** 行全体に適用する装飾種別（Decoration.line を使うもの） */

/** スパン装飾のクラス名（テーブル駆動。heading / task-checkbox / 行装飾は個別処理） */
const DECORATION_CLASSES: Readonly<Partial<Record<MarkdownDecorationType, string>>> = {
  'heading-marker': 'tk-heading-marker',
  bold: 'tk-bold',
  italic: 'tk-italic',
  'bold-italic': 'tk-bold-italic',
  'inline-code': 'tk-inline-code',
  'list-marker': 'tk-list-marker',
  'task-marker': 'tk-task-marker',
  'quote-marker': 'tk-quote-marker',
  'link-text': 'tk-link',
  'link-url': 'tk-link-url',
  hr: 'tk-hr',
};

function toDecoration(d: MarkdownDecoration): Decoration {
  if (d.type === 'heading') {
    return Decoration.mark({ class: `tk-heading tk-heading-${d.level ?? 1}` });
  }
  if (d.type === 'task-checkbox') {
    return Decoration.replace({ widget: new TaskCheckboxWidget(d.checked ?? false) });
  }
  if (LINE_TYPES.has(d.type)) {
    const lineClass =
      d.type === 'quote' ? 'tk-quote' : d.type === 'code-block' ? 'tk-code-block' : 'tk-code-fence';
    return Decoration.line({ class: lineClass });
  }
  return Decoration.mark({ class: DECORATION_CLASSES[d.type] ?? '' });
}

/** RangeSetBuilder の startSide 順序: line decoration 相当（quote 等）を先に置く */
function startSide(d: MarkdownDecoration): number {
  return LINE_TYPES.has(d.type) ? -1 : 1;
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
      line: LINE_TYPES.has(decoration.type),
      value: toDecoration(decoration),
    })),
    ...htmlCommentRanges(text),
    ...frontmatterRanges(text),
    ...frontmatterFieldMarks(text),
    ...cardHeadingRanges(text),
    ...htmlBreakRanges(text),
  ].toSorted((a, b) => a.from - b.from || Number(a.line) * -1 - Number(b.line) * -1);
  for (const range of ranges) {
    if (range.line) {
      // LineDecoration はゼロ長で追加する（CM6 の制約: 行全体への適用は from の行で決まる）
      builder.add(range.from, range.from, range.value);
      continue;
    }
    builder.add(range.from, range.to, range.value);
  }
  return builder.finish();
}

type ZeroWidthRange = {
  from: number;
  to: number;
  line: false;
  value: Decoration;
};

function htmlBreakRanges(text: string): ZeroWidthRange[] {
  const ranges: ZeroWidthRange[] = [];
  for (const match of text.matchAll(/<br\s*\/?>/gi)) {
    const from = match.index;
    if (from === undefined) {
      continue;
    }
    ranges.push({
      from,
      to: from + match[0].length,
      line: false,
      value: Decoration.replace({ widget: new HtmlBreakWidget() }),
    });
  }
  return ranges;
}

function cardHeadingRanges(text: string): Array<{
  from: number;
  to: number;
  line: true;
  value: Decoration;
}> {
  const ranges: Array<{ from: number; to: number; line: true; value: Decoration }> = [];
  let offset = 0;
  let first = true;
  for (const line of text.split('\n')) {
    if (/^#{1,6}\s+.*#card\s*$/.test(line)) {
      ranges.push({
        from: offset,
        to: offset,
        line: true,
        value: Decoration.line({
          class: first ? 'tk-card-heading-first' : 'tk-card-heading',
        }),
      });
      first = false;
    }
    offset += line.length + 1;
  }
  return ranges;
}

function htmlCommentRanges(text: string): ZeroWidthRange[] {
  const ranges: ZeroWidthRange[] = [];
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
