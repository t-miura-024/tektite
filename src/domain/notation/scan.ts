/**
 * ノート本文の記法スキャン（WikiLink / Embed / Tag の走査）。
 *
 * コードフェンスとインラインコードスパン内は走査対象外（`#タグ` や
 * `[[...]]` をコード内で誤認識しない）。エスケープ（`\[[` / `\#`）は
 * スキップする。スパンの型定義は parse.ts（記法解析の窓口）に置く。
 */

import type { NotationSpan } from '@/domain/notation/parse';

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
      let run = 0;
      for (const current of line) {
        if (current !== fence.char) {
          break;
        }
        run += 1;
      }
      const closed = run >= fence.len && line.slice(run).trim() === '';
      if (closed) {
        fence = null;
      }
      continue;
    }
    const fenceOpen = FENCE_OPEN_RE.exec(line);
    if (fenceOpen && fenceOpen[1]) {
      fence = { char: fenceOpen[1][0] ?? '', len: fenceOpen[1].length };
      continue;
    }
    for (let i = 0; i < line.length;) {
      const ch = line[i] ?? '';
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`') {
        const run = line.slice(i).match(/^`+/)?.[0].length ?? 0;
        const close = line.indexOf('`'.repeat(run), i + run);
        if (close === -1) {
          i = i + run;
          continue;
        }
        i = close + run;
        continue;
      }
      if (ch === '!' && line[i + 1] === '[' && line[i + 2] === '[') {
        const next = parseLinkSpan(line, i, from, 'embed', out);
        if (next !== null) {
          i = next;
          continue;
        }
        i += 1;
        continue;
      }
      if (ch === '[' && line[i + 1] === '[') {
        const next = parseLinkSpan(line, i, from, 'wikilink', out);
        if (next !== null) {
          i = next;
          continue;
        }
        i += 1;
        continue;
      }
      if (ch === '#') {
        const prev = line[i - 1] ?? '';
        if (/[\p{L}\p{N}_/#-]/u.test(prev)) {
          i += 1;
          continue;
        }
        const match = TAG_BODY_RE.exec(line.slice(i + 1));
        const tag = match?.[0] ?? '';
        if (tag === '' || !/[\p{L}]/u.test(tag)) {
          i += 1;
          continue;
        }
        const tagFrom = from + i;
        const tagTo = from + i + 1 + tag.length;
        out.push({ kind: 'tag', from: tagFrom, to: tagTo, tag });
        i = i + 1 + tag.length;
        continue;
      }
      i += 1;
    }
  }
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
    return close + 2;
  }
  const from = base + lineIndex;
  const to = base + close + 2;
  if (kind === 'embed') {
    out.push({
      kind: 'embed',
      from,
      to,
      target: parts.target,
      alias: parts.alias,
      subpath: parts.subpath,
      targetType: isImageTarget(parts.target) ? 'image' : 'note',
    });
    return close + 2;
  }
  out.push({
    kind: 'wikilink',
    from,
    to,
    target: parts.target,
    alias: parts.alias,
    subpath: parts.subpath,
  });
  return close + 2;
}
