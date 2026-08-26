/**
 * フロントマテリア領域のライブプレビュー装飾。
 *
 * 先頭の `--- ... ---` ブロックに対してデリミタ行 / フィールド行の装飾と、
 * プロパティアイコン（ウィジェット）を提供する。組み立ては
 * markdown-decoration.ts の computeDecorationSet が呼び出す。
 */

import { Decoration, WidgetType } from '@codemirror/view';

/** フロントマテリアのプロパティアイコン表示 */
// eslint-disable-next-line no-restricted-syntax -- CodeMirror WidgetType は抽象クラス継承が必須のフレームワーク API（toDOM / eq 等のプロトコル実装が前提のため class 禁止ルールの対象外とする）
export class FrontmatterPropertyWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const icon = document.createElement('span');
    icon.className = 'tk-frontmatter-property-icon';
    icon.textContent = '☷';
    icon.setAttribute('aria-hidden', 'true');
    return icon;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** 先頭 `---` ブロック（デリミタ行 / フィールド行）への行装飾を組み立てる */
export function frontmatterRanges(text: string): Array<{
  from: number;
  to: number;
  line: true;
  value: Decoration;
}> {
  const lines = text.split('\n');
  if ((lines[0] ?? '').trim() !== '---') {
    return [];
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) {
    return [];
  }
  const ranges: Array<{ from: number; to: number; line: true; value: Decoration }> = [];
  let offset = 0;
  for (let index = 0; index <= end; index += 1) {
    const delimiter = index === 0 || index === end;
    ranges.push({
      from: offset,
      to: offset,
      line: true,
      value: Decoration.line({
        class: delimiter ? 'tk-frontmatter-delimiter' : 'tk-frontmatter-field',
      }),
    });
    offset += (lines[index] ?? '').length + 1;
  }
  return ranges;
}

/** フロントマテリアのフィールド行（`key: value`）へのマーク装飾を組み立てる */
export function frontmatterFieldMarks(text: string): Array<{
  from: number;
  to: number;
  line: false;
  value: Decoration;
}> {
  const lines = text.split('\n');
  if ((lines[0] ?? '').trim() !== '---') {
    return [];
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) {
    return [];
  }
  const ranges: Array<{ from: number; to: number; line: false; value: Decoration }> = [];
  let offset = 0;
  for (let index = 0; index <= end; index += 1) {
    collectFieldMarkRanges(lines[index] ?? '', index, end, offset, ranges);
    offset += (lines[index] ?? '').length + 1;
  }
  return ranges;
}

/** 1 行分のフィールド装飾を ranges へ追加する（デリミタ行・先頭行は対象外） */
function collectFieldMarkRanges(
  line: string,
  index: number,
  end: number,
  offset: number,
  ranges: Array<{ from: number; to: number; line: false; value: Decoration }>,
): void {
  if (index <= 0 || index >= end) {
    return;
  }
  const separator = line.indexOf(':');
  if (separator <= 0) {
    return;
  }
  ranges.push({
    from: offset,
    to: offset,
    line: false,
    value: Decoration.widget({ widget: new FrontmatterPropertyWidget() }),
  });
  ranges.push({
    from: offset,
    to: offset + separator,
    line: false,
    value: Decoration.mark({ class: 'tk-frontmatter-field-key' }),
  });
  ranges.push({
    from: offset + separator,
    to: offset + separator + 1,
    line: false,
    value: Decoration.mark({ class: 'tk-frontmatter-field-separator' }),
  });
  const valueStart = offset + separator + 1;
  const value = line.slice(separator + 1).match(/^\s*(.*)$/)?.[1] ?? '';
  if (value.length > 0) {
    const valueFrom = valueStart + line.slice(separator + 1).indexOf(value);
    ranges.push({
      from: valueFrom,
      to: valueFrom + value.length,
      line: false,
      value: Decoration.mark({ class: 'tk-frontmatter-field-value' }),
    });
  }
}
