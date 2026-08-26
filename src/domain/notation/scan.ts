/**
 * ノート本文の記法スキャン（WikiLink / Embed / Tag の走査）。
 *
 * コードフェンスとインラインコードスパン内は走査対象外（`#タグ` や
 * `[[...]]` をコード内で誤認識しない）。エスケープ（`\[[` / `\#`）は
 * スキップする。スパンの型定義は parse.ts（記法解析の窓口）に置く。
 */

import type { EmbedSpan, NotationSpan, WikiLinkSpan } from '@/domain/notation/parse';

/** フェンスドコードの開始: ``` または ~~~（言語指定付きも可） */
const FENCE_OPEN_RE = /^(`{3,}|~{3,})(.*)$/;

/**
 * タグ本文のパターン: 英数字・日本語・`_`・`-` の連続を `/` で区切ったネスト
 * 形式（`area/project`）。`#` はタグに含めない。
 */
const TAG_BODY_RE = /^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*/u;

/** 画像として分類する拡張子（小文字比較） */
const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'avif',
  'bmp',
  'ico',
]);

/**
 * ターゲット名が画像ファイルかどうかを拡張子で判定する。
 * 対象外の拡張子（PDF や音声など）は MVP ではノート（テキスト）として扱う。
 */
export function isImageTarget(target: string): boolean {
  const lastSegment = target.split('/').at(-1) ?? '';
  const dot = lastSegment.lastIndexOf('.');
  if (dot <= 0 || dot === lastSegment.length - 1) {
    return false;
  }
  return IMAGE_EXTENSIONS.has(lastSegment.slice(dot + 1).toLowerCase());
}

/** `[[...]]` の内側テキストの分解結果 */
export type LinkTextParts = {
  readonly target: string;
  readonly alias: string | null;
  readonly subpath: string | null;
};

/**
 * `[[...]]` の内側テキストを target / alias / subpath に分解する。
 *
 * - エイリアスは最後の `|` 以降（Obsidian の parseLinktext に倣う）
 * - サブパスは最初の `#` 以降
 * - ターゲットが空（`[[]]` / `[[|x]]` / `[[#h]]`）や `#` の後に文字がない
 *   （`[[note#]]`）場合は null を返す
 */
export function parseLinkText(linktext: string): LinkTextParts | null {
  const pipeIndex = linktext.lastIndexOf('|');
  const main = pipeIndex === -1 ? linktext : linktext.slice(0, pipeIndex);
  const alias = pipeIndex === -1 ? null : linktext.slice(pipeIndex + 1);
  const hashIndex = main.indexOf('#');
  const target = hashIndex === -1 ? main : main.slice(0, hashIndex);
  const subpath = hashIndex === -1 ? null : main.slice(hashIndex + 1).trim();
  if (target === '' || subpath === '') {
    return null;
  }
  return { target, alias: alias === '' ? null : alias, subpath };
}

/** 本文を走査する。フロントマテリア領域（start より前）はスキップ済み */
export function scanBody(text: string, start: number, out: NotationSpan[]): void {
  let fence: { char: string; len: number } | null = null;
  let offset = start;
  for (const line of text.slice(start).split('\n')) {
    const from = offset;
    const to = offset + line.length;
    offset = to + 1;

    if (fence !== null) {
      if (isFenceClose(line, fence)) {
        fence = null;
      }
      continue;
    }
    const fenceOpen = FENCE_OPEN_RE.exec(line);
    if (fenceOpen && fenceOpen[1]) {
      fence = { char: fenceOpen[1][0] ?? '', len: fenceOpen[1].length };
      continue;
    }
    scanLine(line, from, out);
  }
}

/** 1 行分のインライン走査（WikiLink / Embed / Tag / コードスパン / エスケープ） */
function scanLine(line: string, base: number, out: NotationSpan[]): void {
  for (let i = 0; i < line.length;) {
    const ch = line[i] ?? '';
    if (ch === '\\') {
      // エスケープは次の文字ごと読み飛ばす（`\[[` / `\#` を記法にしない）
      i += 2;
      continue;
    }
    if (ch === '`') {
      const run = countRun(line, i, '`');
      const close = line.indexOf('`'.repeat(run), i + run);
      i = close === -1 ? i + run : close + run;
      continue;
    }
    if (ch === '!' && line[i + 1] === '[' && line[i + 2] === '[') {
      const next = parseLinkSpan(line, i, base, 'embed', out);
      if (next !== null) {
        i = next;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '[' && line[i + 1] === '[') {
      const next = parseLinkSpan(line, i, base, 'wikilink', out);
      if (next !== null) {
        i = next;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '#') {
      const next = parseTagSpan(line, i, base, out);
      if (next !== null) {
        i = next;
        continue;
      }
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

/**
 * `[[` または `![[` から閉じ `]]` までを WikiLink / Embed スパンとして追加する。
 * 閉じ `]]` が見つからないときは null（スパン追加なし・走査位置は進めない）。
 * 戻り値は「次の走査位置」（閉じ `]]` の直後、行内相対）。
 */
function parseLinkSpan(
  line: string,
  lineIndex: number,
  base: number,
  kind: 'wikilink' | 'embed',
  out: NotationSpan[],
): number | null {
  const openLength = kind === 'embed' ? 3 : 2;
  const innerStart = lineIndex + openLength;
  const close = line.indexOf(']]', innerStart);
  if (close === -1) {
    return null;
  }
  const parts = parseLinkText(line.slice(innerStart, close));
  if (parts === null) {
    // 空ターゲット等の不正な `[[...]]` は、内部をタグなどとして誤解析しないよう
    // 閉じ `]]` までまとめて読み飛ばす
    return close + 2;
  }
  const from = base + lineIndex;
  const to = base + close + 2;
  const span: NotationSpan =
    kind === 'embed' ? buildEmbedSpan(from, to, parts) : buildWikiLinkSpan(from, to, parts);
  out.push(span);
  return close + 2;
}

/** Embed スパンを生成する（画像分類を含む） */
function buildEmbedSpan(from: number, to: number, parts: LinkTextParts): EmbedSpan {
  return {
    kind: 'embed',
    from,
    to,
    target: parts.target,
    alias: parts.alias,
    subpath: parts.subpath,
    targetType: isImageTarget(parts.target) ? 'image' : 'note',
  };
}

/** WikiLink スパンを生成する */
function buildWikiLinkSpan(from: number, to: number, parts: LinkTextParts): WikiLinkSpan {
  return {
    kind: 'wikilink',
    from,
    to,
    target: parts.target,
    alias: parts.alias,
    subpath: parts.subpath,
  };
}

/**
 * `#` からタグを解析して TagSpan を追加する。
 * - 直前の文字が英数字・日本語・`_`・`-`・`/`・`#` の場合はタグにしない
 *   （`foo#bar` や `C#` を誤認識しない。Markdown リンクのアンカー
 *   `[x](#sec)` のような稀なケースはタグと誤認しうるが MVP では許容）
 * - 数字のみ（`#123`）や `#` 直後が空白（見出し）のものはタグにしない
 * 戻り値は「次の走査位置」（タグ末尾の直後）。タグでないときは null。
 */
function parseTagSpan(
  line: string,
  lineIndex: number,
  base: number,
  out: NotationSpan[],
): number | null {
  const prev = line[lineIndex - 1] ?? '';
  if (/[\p{L}\p{N}_/#-]/u.test(prev)) {
    return null;
  }
  const match = TAG_BODY_RE.exec(line.slice(lineIndex + 1));
  const tag = match?.[0] ?? '';
  if (tag === '' || !/[\p{L}]/u.test(tag)) {
    return null;
  }
  const from = base + lineIndex;
  const to = base + lineIndex + 1 + tag.length;
  out.push({ kind: 'tag', from, to, tag });
  return lineIndex + 1 + tag.length;
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
