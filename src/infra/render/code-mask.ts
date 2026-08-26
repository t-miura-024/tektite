/**
 * コードの一時マスク（数式抽出の前処理）。
 *
 * フェンスドコードとインラインコードスパンをプレースホルダーへ置き換える。
 * 数式抽出（math.ts）がコード内の `$` を数式と誤検出しないための前処理で、
 * 抽出後に unmaskCode で元へ戻す。
 */

/** コードマスク用プレースホルダー（\uE020..\uE021。ユーザー本文と衝突しない私用領域） */
const CODE_MASK_OPEN = '\uE020';
const CODE_MASK_CLOSE = '\uE021';

function codeMaskPlaceholder(index: number): string {
  return `${CODE_MASK_OPEN}${index}${CODE_MASK_CLOSE}`;
}

/** マスク済みコード 1 件 */
export type CodeMaskItem = {
  readonly marker: string;
  readonly code: string;
};

/** フェンスドコードの開始（``` または ~~~） */
const FENCE_OPEN_RE = /^(`{3,}|~{3,})(.*)$/;

/** from 以降に ch が何文字連続するか */
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

/** フェンス閉じ行かどうか（同じ char が open の長さ以上続き、残りは空白のみ） */
function isFenceClose(line: string, fence: { char: string; len: number }): boolean {
  let run = 0;
  for (const current of line) {
    if (current !== fence.char) {
      break;
    }
    run += 1;
  }
  return run >= fence.len && line.slice(run).trim() === '';
}

/**
 * フェンスドコードとインラインコードをプレースホルダーで一時マスクする。
 * 数式抽出の前に使う（コード内の `$` を数式と誤検出しないため）。
 */
export function maskCode(source: string): { text: string; items: readonly CodeMaskItem[] } {
  const items: CodeMaskItem[] = [];
  const out: string[] = [];
  let fence: { char: string; len: number } | null = null;
  let fenceLines: string[] | null = null;

  const addMask = (code: string): string => {
    const marker = codeMaskPlaceholder(items.length);
    items.push({ marker, code });
    return marker;
  };

  for (const line of source.split('\n')) {
    if (fence !== null) {
      if (isFenceClose(line, fence)) {
        out.push(addMask([...(fenceLines ?? []), line].join('\n')));
        fence = null;
        fenceLines = null;
        continue;
      }
      fenceLines?.push(line);
      continue;
    }
    const fenceOpen = FENCE_OPEN_RE.exec(line);
    if (fenceOpen && fenceOpen[1]) {
      fence = { char: fenceOpen[1][0] ?? '', len: fenceOpen[1].length };
      fenceLines = [line];
      continue;
    }
    out.push(maskInlineCode(line, addMask));
  }
  // フェンスが閉じないまま終了（不正な本文）: マスクせず原文のまま
  if (fenceLines !== null) {
    out.push(...fenceLines);
  }
  return { text: out.join('\n'), items };
}

/** 行内のインラインコードスパンをマスクする */
function maskInlineCode(line: string, addMask: (code: string) => string): string {
  let out = '';
  for (let i = 0; i < line.length;) {
    const ch = line[i] ?? '';
    if (ch === '\\') {
      out += ch + (line[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (ch === '`') {
      const run = countRun(line, i, '`');
      const close = line.indexOf('`'.repeat(run), i + run);
      if (close === -1) {
        out += line.slice(i);
        break;
      }
      out += addMask(line.slice(i, close + run));
      i = close + run;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** コードマスクを元のコードへ戻す */
export function unmaskCode(text: string, items: readonly CodeMaskItem[]): string {
  let out = text;
  for (const item of items) {
    out = out.split(item.marker).join(item.code);
  }
  return out;
}
