/**
 * 数式（KaTeX）の抽出とレンダリング。
 *
 * `$...$`（インライン）と `$$...$$`（ブロック、複数行可）を本文から抽出し、
 * 本文をプレースホルダーに置き換える。コードフェンスとインラインコード内の
 * `$` は数式にしない（呼び出し側がコードを一時マスクした状態で渡す想定だが、
 * ここでもフェンス自体はスキップする）。
 *
 * プレースホルダーは私用領域の文字（U+E000 / U+E001）で、ユーザー本文と
 * 衝突しない。レンダリングは KaTeX を動的 import し、失敗時（オフライン等）
 * は本文をそのまま <code> で表示するフォールバックに落ちる（バンドルサイズ
 * 配慮のため初期ロードには含めない）。
 */

import { escapeHtml } from '@/infra/render/escape';

const PLACEHOLDER_OPEN = '\uE000';
const PLACEHOLDER_CLOSE = '\uE001';

export function mathPlaceholder(index: number): string {
  return `${PLACEHOLDER_OPEN}${index}${PLACEHOLDER_CLOSE}`;
}

/** 抽出された数式 1 件 */
export type MathItem = {
  readonly kind: 'inline' | 'block';
  readonly tex: string;
};

export type ExtractMathResult = {
  /** 数式をプレースホルダーに置き換えた本文 */
  readonly text: string;
  readonly items: readonly MathItem[];
};

/** 動的 import した KaTeX の必要最小限インターフェース（UMD 型の回避用） */
export type KatexRenderer = {
  readonly renderToString: (
    tex: string,
    options?: { displayMode?: boolean; throwOnError?: boolean },
  ) => string;
};

let katexPromise: Promise<KatexRenderer | null> | null = null;

/** 候補値が KaTeX レンダラーの形をしているか（UMD / ESM 両対応の実行時判定） */
function isKatexRenderer(value: unknown): value is KatexRenderer {
  return (
    typeof value === 'object' &&
    value !== null &&
    'renderToString' in value &&
    typeof value.renderToString === 'function'
  );
}

/** KaTeX を動的 import する（初回のみ。失敗時は null でキャッシュ） */
export function loadKatex(): Promise<KatexRenderer | null> {
  katexPromise ??= import('katex')
    .then((mod) => {
      const candidate: unknown = 'default' in mod ? mod.default : mod;
      return isKatexRenderer(candidate) ? candidate : null;
    })
    .catch(() => null);
  return katexPromise;
}

/** フェンスドコードの開始（``` または ~~~） */
const FENCE_OPEN_RE = /^(`{3,}|~{3,})(.*)$/;

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
 * インライン数式の閉じ `$` を探す。
 * 閉じ `$` は直前が空白でなく、直後が数字でないものとする（`$x $` や
 * `$x$5` などの誤検出を避ける。KaTeX の慣例に倣う）。見つからなければ -1。
 */
function findInlineClose(line: string, open: number): number {
  for (let i = open + 1; i < line.length; i += 1) {
    const ch = line[i] ?? '';
    if (ch !== '$') {
      continue;
    }
    const prev = line[i - 1] ?? '';
    const next = line[i + 1] ?? '';
    if (prev === ' ' || /[\p{N}]/u.test(next)) {
      continue;
    }
    return i;
  }
  return -1;
}

/** 複数行ブロック数式の収集結果（tex / 閉じ行の残りテキスト / 閉じ行位置） */
type MultiLineBlock = {
  readonly closed: boolean;
  readonly tex: string;
  readonly remainder: string;
  readonly closeIndex: number;
};

/** 開き `$$` の行 rest から、後続行を閉じ `$$` まで収集する */
function collectMultiLineBlock(
  lines: readonly string[],
  startIndex: number,
  rest: string,
): MultiLineBlock {
  let tex = rest;
  for (let k = startIndex; k < lines.length; k += 1) {
    const next = lines[k] ?? '';
    const closePosition = next.indexOf('$$');
    if (closePosition !== -1) {
      return {
        closed: true,
        tex: `${tex}\n${next.slice(0, closePosition)}`,
        remainder: next.slice(closePosition + 2),
        closeIndex: k,
      };
    }
    tex += `\n${next}`;
  }
  return { closed: false, tex, remainder: '', closeIndex: lines.length - 1 };
}

/** 行スキャンの結果（複数行ブロック数式では複数行を出力・消費する） */
type LineScanResult = {
  readonly outputs: readonly (string | null)[];
  /** 次に処理する行インデックス */
  readonly nextIndex: number;
};

/**
 * 本文から数式を抽出してプレースホルダーに置き換える。
 * `$$...$$` はブロック（行をまたげる。閉じがなければ原文のまま）、`$...$` は
 * インライン（開き `$` の直後が空白・`$$`・行末なら数式にしない）。
 * フェンスドコード内の `$` は数式にしない。
 */
export function extractMath(source: string): ExtractMathResult {
  const items: MathItem[] = [];
  const lines = source.split('\n');
  const out: string[] = [];
  let fence: { char: string; len: number } | null = null;

  for (let i = 0; i < lines.length;) {
    const line = lines[i] ?? '';
    if (fence !== null) {
      out.push(line);
      if (isFenceClose(line, fence)) {
        fence = null;
      }
      i += 1;
      continue;
    }
    const fenceOpen = FENCE_OPEN_RE.exec(line);
    if (fenceOpen && fenceOpen[1]) {
      out.push(line);
      fence = { char: fenceOpen[1][0] ?? '', len: fenceOpen[1].length };
      i += 1;
      continue;
    }
    const scanned = scanLineMath(line, lines, i, items);
    for (const output of scanned.outputs) {
      if (output !== null) {
        out.push(output);
      }
    }
    // nextIndex は「処理した最後の行」。次の行から再開する
    i = scanned.nextIndex + 1;
  }

  return { text: out.join('\n'), items };
}

/** 1 行分の数式走査。nextIndex は消費した最後の行インデックス（複数行消費に対応） */
function scanLineMath(
  line: string,
  lines: readonly string[],
  lineIndex: number,
  items: MathItem[],
): LineScanResult {
  let lineOut = '';
  for (let j = 0; j < line.length;) {
    const ch = line[j] ?? '';
    if (ch === '\\') {
      lineOut += ch + (line[j + 1] ?? '');
      j += 2;
      continue;
    }
    if (ch !== '$') {
      lineOut += ch;
      j += 1;
      continue;
    }
    if (line[j + 1] === '$') {
      const block = scanBlockMath(line, lines, lineIndex, j, items);
      if (block !== null) {
        return block;
      }
      // 閉じのない `$$` は原文のまま出す
      lineOut += '$$';
      j += 2;
      continue;
    }
    const inlineResult = scanInlineMath(line, j, items);
    if (inlineResult !== null) {
      lineOut += mathPlaceholder(inlineResult.placeholderIndex);
      j = inlineResult.nextCharIndex;
      continue;
    }
    lineOut += '$';
    j += 1;
  }
  return { outputs: [lineOut], nextIndex: lineIndex };
}

/** ブロック数式 `$$...$$` を処理する。行をまたぐ場合は後続行を消費する */
function scanBlockMath(
  line: string,
  lines: readonly string[],
  lineIndex: number,
  openIndex: number,
  items: MathItem[],
): LineScanResult | null {
  const rest = line.slice(openIndex + 2);
  const closeSameLine = rest.indexOf('$$');
  const prefix = line.slice(0, openIndex);
  if (closeSameLine !== -1) {
    items.push({ kind: 'block', tex: rest.slice(0, closeSameLine) });
    const suffix = rest.slice(closeSameLine + 2);
    return {
      outputs: [`${prefix}${mathPlaceholder(items.length - 1)}${suffix}`],
      nextIndex: lineIndex,
    };
  }
  const collected = collectMultiLineBlock(lines, lineIndex + 1, rest);
  if (!collected.closed) {
    return null;
  }
  items.push({ kind: 'block', tex: collected.tex });
  // 収集した行（閉じ行含む）は出力しない。開き行の前半 + プレースホルダーと、
  // 閉じ行の残り（次の行として出力）だけを出力する
  const outputs =
    collected.remainder === ''
      ? [`${prefix}${mathPlaceholder(items.length - 1)}`, null]
      : [`${prefix}${mathPlaceholder(items.length - 1)}`, collected.remainder];
  // 閉じ行までを消費する（呼び出し側が次の行から再開する）
  return { outputs, nextIndex: collected.closeIndex };
}

/** インライン数式 `$...$` を処理する。数式でなければ null */
function scanInlineMath(
  line: string,
  openIndex: number,
  items: MathItem[],
): { placeholderIndex: number; nextCharIndex: number } | null {
  const next = line[openIndex + 1] ?? '';
  if (next === ' ' || next === '' || /[\p{N}]/u.test(next)) {
    return null;
  }
  const close = findInlineClose(line, openIndex);
  if (close === -1) {
    return null;
  }
  items.push({ kind: 'inline', tex: line.slice(openIndex + 1, close) });
  return { placeholderIndex: items.length - 1, nextCharIndex: close + 1 };
}

/** 抽出した数式を KaTeX HTML 列に変換する（katex が使えない場合はフォールバック） */
export function renderMathItems(
  items: readonly MathItem[],
  katex: KatexRenderer | null,
): readonly string[] {
  return items.map((item) => {
    const fallback = `<code class="math-fallback">${escapeHtml(item.tex)}</code>`;
    if (katex === null) {
      return fallback;
    }
    try {
      return katex.renderToString(item.tex, {
        displayMode: item.kind === 'block',
        throwOnError: false,
      });
    } catch {
      return fallback;
    }
  });
}
