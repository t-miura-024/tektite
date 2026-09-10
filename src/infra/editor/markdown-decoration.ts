/**
 * CM6 のライブプレビュー装飾。domain の Markdown 解析結果を DecorationSet に変換し、
 * 文書変更時に再解析して見出しや強調などを付与する。編集は常にソーステキストが対象で
 * DOM 変換はしない。タスク記法は置換装飾で見た目だけ差し替え、tk- 接頭辞のクラスで
 * CSS 変数に追従する。領域分担は別モジュールが担う。
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
      value: ((): Decoration => {
        if (decoration.type === 'heading') {
          return Decoration.mark({ class: `tk-heading tk-heading-${decoration.level ?? 1}` });
        }
        if (decoration.type === 'task-checkbox') {
          return Decoration.replace({
            widget: new TaskCheckboxWidget(decoration.checked ?? false),
          });
        }
        if (LINE_TYPES.has(decoration.type)) {
          const lineClass =
            decoration.type === 'quote'
              ? 'tk-quote'
              : decoration.type === 'code-block'
                ? 'tk-code-block'
                : 'tk-code-fence';
          return Decoration.line({ class: lineClass });
        }
        return Decoration.mark({ class: DECORATION_CLASSES[decoration.type] ?? '' });
      })(),
    })),
    ...((): ZeroWidthRange[] => {
      const commentRanges: ZeroWidthRange[] = [];
      const comments = /<!--[\s\S]*?-->/g;
      for (const match of text.matchAll(comments)) {
        const from = match.index;
        if (from === undefined) {
          continue;
        }
        commentRanges.push({
          from,
          to: from + match[0].length,
          line: false,
          value: Decoration.mark({ class: 'tk-html-comment' }),
        });
      }
      return commentRanges;
    })(),
    ...frontmatterRanges(text),
    ...frontmatterFieldMarks(text),
    ...((): Array<{ from: number; to: number; line: true; value: Decoration }> => {
      const cardRanges: Array<{ from: number; to: number; line: true; value: Decoration }> = [];
      let offset = 0;
      let first = true;
      for (const line of text.split('\n')) {
        if (/^#{1,6}\s+.*#card\s*$/.test(line)) {
          cardRanges.push({
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
      return cardRanges;
    })(),
    ...((): ZeroWidthRange[] => {
      const breakRanges: ZeroWidthRange[] = [];
      for (const match of text.matchAll(/<br\s*\/?>/gi)) {
        const from = match.index;
        if (from === undefined) {
          continue;
        }
        breakRanges.push({
          from,
          to: from + match[0].length,
          line: false,
          value: Decoration.replace({ widget: new HtmlBreakWidget() }),
        });
      }
      return breakRanges;
    })(),
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
