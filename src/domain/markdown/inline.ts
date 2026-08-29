/**
 * Markdown インライン要素（強調・インラインコード・リンク）の解析。
 *
 * 1 行分のテキストを左→右に走査し、装飾対象の範囲を out へ追加する。
 * 意図的に「過剰に完全」にはしない: ネストした強調・行をまたぐインライン
 * 要素・複雑な URL（タイトル付き等）は装飾対象外。
 * 型（MarkdownDecoration / MarkdownDecorationType）と範囲追加ヘルパーは
 * parse.ts（行ベース構文解析の窓口）に置く。
 */

import type { MarkdownDecoration, MarkdownDecorationType } from '@/domain/markdown/parse';

/** 装飾を出力リストへ追加する（空範囲は無視する）。parse.ts の add と同じ契約 */
function add(
  out: MarkdownDecoration[],
  from: number,
  to: number,
  type: MarkdownDecorationType,
): void {
  if (to <= from) {
    return;
  }
  out.push({ from, to, type });
}

/** 1 行分のインライン要素（強調・インラインコード・リンク）を左→右に走査する */
export function parseInline(text: string, base: number, out: MarkdownDecoration[]): void {
  for (let i = 0; i < text.length;) {
    const ch = text[i] ?? '';
    if (ch === '\\') {
      // エスケープは次の文字ごと読み飛ばす（装飾しない）
      i += 2;
      continue;
    }
    if (ch === '`') {
      const run = countRun(text, i, '`');
      const close = text.indexOf('`'.repeat(run), i + run);
      if (close !== -1) {
        add(out, base + i, base + close + run, 'inline-code');
        i = close + run;
        continue;
      }
      i = i + run;
      continue;
    }
    if (ch === '*') {
      const run = countRun(text, i, '*');
      if (run >= 3) {
        const close = text.indexOf('***', i + run);
        if (close !== -1) {
          add(out, base + i + 3, base + close, 'bold-italic');
          i = close + 3;
          continue;
        }
        i = i + run;
        continue;
      }
      if (run === 2) {
        const close = text.indexOf('**', i + 2);
        if (close !== -1) {
          add(out, base + i + 2, base + close, 'bold');
          i = close + 2;
          continue;
        }
        i = i + 2;
        continue;
      }
      const close = text.indexOf('*', i + 1);
      if (close !== -1) {
        add(out, base + i + 1, base + close, 'italic');
        i = close + 1;
        continue;
      }
      i = i + 1;
      continue;
    }
    if (ch === '[' && text[i - 1] !== '!') {
      const closeBracket = text.indexOf(']', i + 1);
      if (closeBracket === -1 || text[closeBracket + 1] !== '(') {
        i += 1;
        continue;
      }
      const urlFrom = closeBracket + 2;
      const urlTo = text.indexOf(')', urlFrom);
      if (urlTo === -1) {
        i += 1;
        continue;
      }
      const url = text.slice(urlFrom, urlTo);
      if (url === '' || /[\s<>]/.test(url)) {
        i += 1;
        continue;
      }
      add(out, base + i + 1, base + closeBracket, 'link-text');
      add(out, base + urlFrom, base + urlTo, 'link-url');
      i = urlTo;
      continue;
    }
    i += 1;
  }
}

/** from 以降に ch が何文字連続するかを数える */
function countRun(text: string, from: number, ch: string): number {
  let n = 0;
  for (const current of text.slice(from)) {
    if (current !== ch) {
      break;
    }
    n += 1;
  }
  return n;
}
