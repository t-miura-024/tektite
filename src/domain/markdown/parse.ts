/**
 * Markdownの行ベース構文解析。
 * テキストを走査し装飾範囲（UTF-16オフセット）と種別を返す純関数。見出し・コード・リスト・引用・水平線を行単位で判定し、本文はインライン解析する。
 * CM6変換はinfra層が担い、Obsidian記法はnotationが担う。出力は常に重ならずfrom昇順になる。
 */

import { parseInline } from '@/domain/markdown/inline';

export type MarkdownDecorationType =
  | 'heading-marker'
  | 'heading'
  | 'bold'
  | 'italic'
  | 'bold-italic'
  | 'inline-code'
  | 'code-fence'
  | 'code-block'
  | 'list-marker'
  | 'task-marker'
  | 'task-checkbox'
  | 'quote'
  | 'quote-marker'
  | 'link-text'
  | 'link-url'
  | 'hr';

export type MarkdownDecoration = {
  /** 装飾開始オフセット（UTF-16 コード単位） */
  readonly from: number;
  /** 装飾終了オフセット（排他） */
  readonly to: number;
  readonly type: MarkdownDecorationType;
  /** 見出しレベル（1-6）。type が 'heading' のときのみ */
  readonly level?: number;
  /** タスクのチェック状態。type が 'task-checkbox' のときのみ */
  readonly checked?: boolean;
};

/** 見出し: `#` 〜 `######` */
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
/** フェンスドコードの開始: ``` または ~~~（言語指定付きも可） */
const FENCE_OPEN_RE = /^(`{3,}|~{3,})(.*)$/;
/** 水平線: --- / *** / ___（3 文字以上） */
const HR_RE = /^(-{3,}|\*{3,}|_{3,})\s*$/;
/** タスクリスト: `- [ ] テキスト` / `- [x] テキスト` */
const TASK_RE = /^(\s*)([-+*])\s+\[([ xX])\]\s+(.*)$/;
/** リスト: `- テキスト` / `1. テキスト` / `1) テキスト` */
const LIST_RE = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/;
/** 引用: `> テキスト`（入れ子の `>>` も可） */
const QUOTE_RE = /^(\s*)(>+)\s?(.*)$/;

/** タスクのチェックボックス部分（`[ ]` / `[x]` / `[X]` の 3 文字） */
const TASK_CHECKBOX_LENGTH = 3;

/**
 * テキスト全体を解析し、装飾対象の範囲リストを返す。
 * 行ごとにブロック構文（見出し・コード・リスト・引用・水平線）を判定し、
 * 段落・見出し・リスト・引用の本文はインライン解析（強調・コード・リンク）を行う。
 */
export function parseMarkdownDecorations(text: string): MarkdownDecoration[] {
  const out: MarkdownDecoration[] = [];
  let offset = 0;
  let fence: { char: string; len: number } | null = null;

  for (const line of text.split('\n')) {
    const from = offset;
    const to = offset + line.length;
    offset = to + 1;

    if (fence !== null) {
      let run = 0;
      for (const current of line) {
        if (current !== fence.char) {
          break;
        }
        run += 1;
      }
      const closed = run >= fence.len && line.slice(run).trim() === '';
      add(out, from, to, closed ? 'code-fence' : 'code-block');
      if (closed) {
        fence = null;
      }
      continue;
    }

    const fenceOpen = FENCE_OPEN_RE.exec(line);
    if (fenceOpen && fenceOpen[1]) {
      add(out, from, to, 'code-fence');
      fence = { char: fenceOpen[1][0] ?? '', len: fenceOpen[1].length };
      continue;
    }

    if (HR_RE.test(line)) {
      add(out, from, to, 'hr');
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading && heading[1]) {
      const marker = heading[1];
      const markerLength = marker.length;
      add(out, from, from + markerLength, 'heading-marker');
      const textStart = from + markerLength + 1;
      add(out, textStart, textStart + line.length - markerLength - 1, 'heading', {
        level: markerLength,
      });
      parseInline(line.slice(markerLength + 1), textStart, out);
      continue;
    }

    const task = TASK_RE.exec(line);
    if (task) {
      const indentLen = task[1]?.length ?? 0;
      const markerLen = task[2]?.length ?? 0;
      const markerStart = from + indentLen;
      const checkboxStart = from + line.indexOf('[', indentLen + markerLen);
      add(out, markerStart, checkboxStart, 'task-marker');
      add(out, checkboxStart, checkboxStart + TASK_CHECKBOX_LENGTH, 'task-checkbox', {
        checked: task[3] === 'x' || task[3] === 'X',
      });
      const rest = task[4] ?? '';
      const restStart = from + line.indexOf(rest, indentLen + markerLen + 1);
      parseInline(line.slice(restStart - from), restStart, out);
      continue;
    }

    const list = LIST_RE.exec(line);
    if (list) {
      const indentLen = list[1]?.length ?? 0;
      const marker = list[2] ?? '';
      const markerStart = from + indentLen;
      add(out, markerStart, markerStart + marker.length + 1, 'list-marker');
      const rest = list[3] ?? '';
      const restStart = from + line.indexOf(rest, indentLen + marker.length + 1);
      parseInline(line.slice(restStart - from), restStart, out);
      continue;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote) {
      const markerStart = from + (quote[1]?.length ?? 0);
      add(out, markerStart, markerStart + (quote[2]?.length ?? 0), 'quote-marker');
      add(out, from, to, 'quote');
      const rest = quote[3] ?? '';
      if (rest !== '') {
        parseInline(rest, to - rest.length, out);
      }
      continue;
    }

    if (line.trim() !== '') {
      parseInline(line, from, out);
    }
  }

  return out;
}

/** 装飾を出力リストへ追加する（空範囲は無視する） */
function add(
  out: MarkdownDecoration[],
  from: number,
  to: number,
  type: MarkdownDecorationType,
  extra: { level?: number; checked?: boolean } = {},
): void {
  if (to <= from) {
    return;
  }
  out.push({ from, to, type, ...extra });
}
