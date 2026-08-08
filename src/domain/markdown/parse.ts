/**
 * Markdown の行ベース構文解析（ライブプレビュー装飾の基礎）。
 *
 * 純 TypeScript・フレームワーク非依存の関数で、テキストを走査して
 * 装飾対象の範囲（from/to は UTF-16 コード単位のオフセット）と種別の
 * リストを返す。CodeMirror 6 の Decoration への変換は infra 層の責務
 * （src/infra/editor/markdown-decoration.ts）が担う。
 *
 * 意図的に「過剰に完全」にはしない: ネストした強調・行をまたぐインライン
 * 要素・複雑な URL（タイトル付き等）は装飾対象外。Obsidian 記法
 * （WikiLink / Embed / Tag / Frontmatter）は src/domain/notation が担う。
 * 装飾は重ならず、出力は常に from 昇順になる
 * （CM6 の RangeSetBuilder が from 昇順を要求するため）。
 */

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

export interface MarkdownDecoration {
  /** 装飾開始オフセット（UTF-16 コード単位） */
  readonly from: number;
  /** 装飾終了オフセット（排他） */
  readonly to: number;
  readonly type: MarkdownDecorationType;
  /** 見出しレベル（1-6）。type が 'heading' のときのみ */
  readonly level?: number;
  /** タスクのチェック状態。type が 'task-checkbox' のときのみ */
  readonly checked?: boolean;
}

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

    if (fence) {
      if (isFenceClose(line, fence)) {
        add(out, from, to, 'code-fence');
        fence = null;
      } else {
        add(out, from, to, 'code-block');
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
      const markerLength = heading[1].length;
      add(out, from, from + markerLength, 'heading-marker');
      const textStart = from + markerLength + 1;
      add(out, textStart, to, 'heading', { level: markerLength });
      parseInline(line.slice(markerLength + 1), textStart, out);
      continue;
    }

    const task = TASK_RE.exec(line);
    if (task) {
      const indentLen = task[1]?.length ?? 0;
      const markerLen = task[2]?.length ?? 0;
      const markerStart = from + indentLen;
      // line.indexOf は行内の相対位置で検索し、from を加えて絶対位置にする
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

/** 1 行分のインライン要素（強調・インラインコード・リンク）を左→右に走査する */
function parseInline(text: string, base: number, out: MarkdownDecoration[]): void {
  let i = 0;
  while (i < text.length) {
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
      i += run;
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
        i += run;
        continue;
      }
      if (run === 2) {
        const close = text.indexOf('**', i + 2);
        if (close !== -1) {
          add(out, base + i + 2, base + close, 'bold');
          i = close + 2;
          continue;
        }
        i += 2;
        continue;
      }
      const close = text.indexOf('*', i + 1);
      if (close !== -1) {
        add(out, base + i + 1, base + close, 'italic');
        i = close + 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '[' && text[i - 1] !== '!') {
      const link = findLink(text, i);
      if (link) {
        add(out, base + i + 1, base + link.labelTo, 'link-text');
        add(out, base + link.urlFrom, base + link.urlTo, 'link-url');
        i = link.urlTo;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
}

/** from 以降に ch が何文字連続するかを数える */
function countRun(text: string, from: number, ch: string): number {
  let n = 0;
  while (text[from + n] === ch) {
    n += 1;
  }
  return n;
}

interface LinkRange {
  /** `]` の位置（排他） */
  readonly labelTo: number;
  /** `(` の直後の位置 */
  readonly urlFrom: number;
  /** `)` の位置（排他） */
  readonly urlTo: number;
}

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

/** フェンス閉じ行かどうか（同じ char が open の長さ以上続き、残りは空白のみ） */
function isFenceClose(line: string, fence: { char: string; len: number }): boolean {
  let run = 0;
  while (line[run] === fence.char) {
    run += 1;
  }
  return run >= fence.len && line.slice(run).trim() === '';
}
