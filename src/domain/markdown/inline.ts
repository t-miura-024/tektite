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
      i = scanInlineCode(text, i, base, out);
      continue;
    }
    if (ch === '*') {
      i = scanEmphasis(text, i, base, out);
      continue;
    }
    if (ch === '[' && text[i - 1] !== '!') {
      const next = scanLink(text, i, base, out);
      if (next !== null) {
        i = next;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
}

/** インラインコード（バッククォート連続で挟まれた範囲）を解析する。戻り値は次の走査位置 */
function scanInlineCode(
  text: string,
  start: number,
  base: number,
  out: MarkdownDecoration[],
): number {
  const run = countRun(text, start, '`');
  const close = text.indexOf('`'.repeat(run), start + run);
  if (close !== -1) {
    add(out, base + start, base + close + run, 'inline-code');
    return close + run;
  }
  return start + run;
}

/** 強調（* / ** / ***）を解析する。戻り値は次の走査位置 */
function scanEmphasis(
  text: string,
  start: number,
  base: number,
  out: MarkdownDecoration[],
): number {
  const run = countRun(text, start, '*');
  if (run >= 3) {
    const close = text.indexOf('***', start + run);
    if (close !== -1) {
      add(out, base + start + 3, base + close, 'bold-italic');
      return close + 3;
    }
    return start + run;
  }
  if (run === 2) {
    const close = text.indexOf('**', start + 2);
    if (close !== -1) {
      add(out, base + start + 2, base + close, 'bold');
      return close + 2;
    }
    return start + 2;
  }
  const close = text.indexOf('*', start + 1);
  if (close !== -1) {
    add(out, base + start + 1, base + close, 'italic');
    return close + 1;
  }
  return start + 1;
}

/** `[テキスト](url)` 形式のリンクを解析する。リンクでなければ null を返す */
function scanLink(
  text: string,
  start: number,
  base: number,
  out: MarkdownDecoration[],
): number | null {
  const link = findLink(text, start);
  if (link === null) {
    return null;
  }
  add(out, base + start + 1, base + link.labelTo, 'link-text');
  add(out, base + link.urlFrom, base + link.urlTo, 'link-url');
  return link.urlTo;
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

type LinkRange = {
  /** `]` の位置（排他） */
  readonly labelTo: number;
  /** `(` の直後の位置 */
  readonly urlFrom: number;
  /** `)` の位置（排他） */
  readonly urlTo: number;
};

/**
 * `[テキスト](url)` 形式のリンクを探す。
 * 画像（`![...]`）は openBracket 側で除外済み。空 URL や空白・<> を含む
 * 複雑な URL（タイトル付き等）は装飾対象外として null を返す。
 */
function findLink(text: string, openBracket: number): LinkRange | null {
  const closeBracket = text.indexOf(']', openBracket + 1);
  if (closeBracket === -1 || text[closeBracket + 1] !== '(') {
    return null;
  }
  const urlFrom = closeBracket + 2;
  const urlTo = text.indexOf(')', urlFrom);
  if (urlTo === -1) {
    return null;
  }
  const url = text.slice(urlFrom, urlTo);
  if (url === '' || /[\s<>]/.test(url)) {
    return null;
  }
  return { labelTo: closeBracket, urlFrom, urlTo };
}
