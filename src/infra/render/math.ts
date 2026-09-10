/**
 * 数式（KaTeX）の抽出とレンダリング。
 * `$` / `$$` を置き換える（コード内は対象外）。
 * KaTeX は動的 import し、失敗時は code 表示に落とす。
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

/** KaTeX を動的 import する（初回のみ。失敗時は null でキャッシュ） */
export function loadKatex(): Promise<KatexRenderer | null> {
  katexPromise ??= import('katex')
    .then((mod) => {
      const candidate: unknown = 'default' in mod ? mod.default : mod;
      const isKatexRendererLocal = (value: unknown): value is KatexRenderer => {
        void katexPromise;
        return (
          typeof value === 'object' &&
          value !== null &&
          'renderToString' in value &&
          typeof value.renderToString === 'function'
        );
      };
      return isKatexRendererLocal(candidate) ? candidate : null;
    })
    .catch(() => null);
  return katexPromise;
}

/** フェンスドコードの開始（``` または ~~~） */
const FENCE_OPEN_RE = /^(`{3,}|~{3,})(.*)$/;

/** 複数行ブロック数式の収集結果（tex / 閉じ行の残りテキスト / 閉じ行位置） */
type MultiLineBlock = {
  readonly closed: boolean;
  readonly tex: string;
  readonly remainder: string;
  readonly closeIndex: number;
};

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

  // Helpers are defined inside to avoid top-level single-use lint and to capture `items` for oxlint scoping
  const scanInlineMath = (
    line: string,
    openIndex: number,
  ): { placeholderIndex: number; nextCharIndex: number } | null => {
    const next = line[openIndex + 1] ?? '';
    if (next === ' ' || next === '' || /[\p{N}]/u.test(next)) {
      return null;
    }
    const close = ((): number => {
      for (let i = openIndex + 1; i < line.length; i += 1) {
        const ch = line[i] ?? '';
        if (ch !== '$') {
          continue;
        }
        const prev = line[i - 1] ?? '';
        const nxt = line[i + 1] ?? '';
        if (prev === ' ' || /[\p{N}]/u.test(nxt)) {
          continue;
        }
        return i;
      }
      return -1;
    })();
    if (close === -1) {
      return null;
    }
    items.push({ kind: 'inline', tex: line.slice(openIndex + 1, close) });
    return { placeholderIndex: items.length - 1, nextCharIndex: close + 1 };
  };

  const scanBlockMath = (
    line: string,
    lineIndex: number,
    openIndex: number,
  ): LineScanResult | null => {
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
    const collected: MultiLineBlock = ((): MultiLineBlock => {
      let tex = rest;
      for (let k = lineIndex + 1; k < lines.length; k += 1) {
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
    })();
    if (!collected.closed) {
      return null;
    }
    items.push({ kind: 'block', tex: collected.tex });
    const outputs =
      collected.remainder === ''
        ? [`${prefix}${mathPlaceholder(items.length - 1)}`, null]
        : [`${prefix}${mathPlaceholder(items.length - 1)}`, collected.remainder];
    return { outputs, nextIndex: collected.closeIndex };
  };

  const scanLineMath = (line: string, lineIndex: number): LineScanResult => {
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
        const block = scanBlockMath(line, lineIndex, j);
        if (block !== null) {
          return block;
        }
        lineOut += '$$';
        j += 2;
        continue;
      }
      const inlineResult = scanInlineMath(line, j);
      if (inlineResult !== null) {
        lineOut += mathPlaceholder(inlineResult.placeholderIndex);
        j = inlineResult.nextCharIndex;
        continue;
      }
      lineOut += '$';
      j += 1;
    }
    return { outputs: [lineOut], nextIndex: lineIndex };
  };

  for (let i = 0; i < lines.length;) {
    const line = lines[i] ?? '';
    if (fence !== null) {
      out.push(line);
      const currentFence = fence;
      const fenceClose = ((): boolean => {
        let run = 0;
        for (const current of line) {
          if (current !== currentFence.char) {
            break;
          }
          run += 1;
        }
        return run >= currentFence.len && line.slice(run).trim() === '';
      })();
      if (fenceClose) {
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
    const scanned = scanLineMath(line, i);
    for (const output of scanned.outputs) {
      if (output !== null) {
        out.push(output);
      }
    }
    i = scanned.nextIndex + 1;
  }

  return { text: out.join('\n'), items };
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
