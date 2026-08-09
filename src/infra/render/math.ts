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

/** 数式プレースホルダーの開き/閉じ文字 */
const PLACEHOLDER_OPEN = '\uE000';
const PLACEHOLDER_CLOSE = '\uE001';

export function mathPlaceholder(index: number): string {
  return `${PLACEHOLDER_OPEN}${index}${PLACEHOLDER_CLOSE}`;
}

/** 抽出された数式 1 件 */
export interface MathItem {
  readonly kind: 'inline' | 'block';
  readonly tex: string;
}

export interface ExtractMathResult {
  /** 数式をプレースホルダーに置き換えた本文 */
  readonly text: string;
  readonly items: readonly MathItem[];
}

/** 動的 import した KaTeX の必要最小限インターフェース（UMD 型の回避用） */
export interface KatexRenderer {
  readonly renderToString: (
    tex: string,
    options?: { displayMode?: boolean; throwOnError?: boolean },
  ) => string;
}

let katexPromise: Promise<KatexRenderer | null> | null = null;

/** KaTeX を動的 import する（初回のみ。失敗時は null でキャッシュ） */
export function loadKatex(): Promise<KatexRenderer | null> {
  katexPromise ??= import('katex')
    .then((mod) => {
      const renderer = (mod as unknown as { default?: KatexRenderer }).default;
      return renderer?.renderToString ? renderer : null;
    })
    .catch(() => null);
  return katexPromise;
}

/** フェンスドコードの開始（``` または ~~~） */
const FENCE_OPEN_RE = /^(`{3,}|~{3,})(.*)$/;

/** フェンス閉じ行かどうか（同じ char が open の長さ以上続き、残りは空白のみ） */
function isFenceClose(line: string, fence: { char: string; len: number }): boolean {
  let run = 0;
  while (line[run] === fence.char) {
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

/**
 * 本文から数式を抽出してプレースホルダーに置き換える。
 * - `$$...$$` はブロック（行をまたげる）。閉じがない場合は原文のまま
 * - `$...$` はインライン。開き `$` の直後が空白・`$$`・行末の場合は数式にしない
 * - フェンスドコード内の `$` は数式にしない（インラインコードは呼び出し側で
 *   マスク済みの想定。ここではフェンスのみ自前で追跡する）
 */
export function extractMath(source: string): ExtractMathResult {
  const items: MathItem[] = [];
  const lines = source.split('\n');
  const out: string[] = [];
  let fence: { char: string; len: number } | null = null;
  let i = 0;

  while (i < lines.length) {
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

    // 行内スキャン
    let j = 0;
    let lineOut = '';
    while (j < line.length) {
      const ch = line[j] ?? '';
      if (ch === '\\') {
        lineOut += ch + (line[j + 1] ?? '');
        j += 2;
        continue;
      }
      if (ch === '$') {
        // ブロック数式 $$...$$
        if (line[j + 1] === '$') {
          const rest = line.slice(j + 2);
          const closeSameLine = rest.indexOf('$$');
          if (closeSameLine !== -1) {
            items.push({ kind: 'block', tex: rest.slice(0, closeSameLine) });
            lineOut += mathPlaceholder(items.length - 1);
            j = j + 2 + closeSameLine + 2;
            continue;
          }
          // 行をまたぐブロック数式: 後続行を閉じ `$$` まで収集する
          let tex = rest;
          let remainder = '';
          let k = i + 1;
          let closed = false;
          for (; k < lines.length; k += 1) {
            const next = lines[k] ?? '';
            const closeIndex = next.indexOf('$$');
            if (closeIndex !== -1) {
              tex += `\n${next.slice(0, closeIndex)}`;
              remainder = next.slice(closeIndex + 2);
              k += 1;
              closed = true;
              break;
            }
            tex += `\n${next}`;
          }
          if (closed) {
            items.push({ kind: 'block', tex });
            lineOut += mathPlaceholder(items.length - 1);
            // 収集した行（閉じ行含む）は出力しない。閉じ行の残りは次の行として
            // 出力する（数式と同じ行に続くテキストを失わないため）。
            // ループ末尾の i += 1 と相殺するため k - 1 にする
            if (remainder !== '') {
              out.push(remainder);
            }
            i = k - 1;
            j = line.length;
            continue;
          }
          lineOut += '$$';
          j += 2;
          continue;
        }
        // インライン数式 $...$
        const next = line[j + 1] ?? '';
        if (next !== ' ' && next !== '' && !/[\p{N}]/u.test(next)) {
          const close = findInlineClose(line, j);
          if (close !== -1) {
            items.push({ kind: 'inline', tex: line.slice(j + 1, close) });
            lineOut += mathPlaceholder(items.length - 1);
            j = close + 1;
            continue;
          }
        }
        lineOut += '$';
        j += 1;
        continue;
      }
      lineOut += ch;
      j += 1;
    }
    out.push(lineOut);
    i += 1;
  }

  return { text: out.join('\n'), items };
}

/** 抽出した数式を KaTeX HTML 列に変換する（katex が使えない場合はフォールバック） */
export function renderMathItems(
  items: readonly MathItem[],
  katex: KatexRenderer | null,
): readonly string[] {
  return items.map((item) => {
    if (katex === null) {
      return `<code class="math-fallback">${escapeHtml(item.tex)}</code>`;
    }
    try {
      return katex.renderToString(item.tex, {
        displayMode: item.kind === 'block',
        throwOnError: false,
      });
    } catch {
      return `<code class="math-fallback">${escapeHtml(item.tex)}</code>`;
    }
  });
}
