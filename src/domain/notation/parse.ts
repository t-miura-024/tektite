/**
 * Obsidian 記法のパーサー（WikiLink / Embed / Tag / Frontmatter）。
 *
 * 純 TypeScript・フレームワーク非依存の関数で、テキストを走査して記法の
 * 出現範囲（from/to は UTF-16 コード単位のオフセット）とメタデータのリストを
 * 返す。ライブプレビュー装飾（CM6）とリーディング表示（Markdown → HTML）の
 * 両方がこの解析結果を共用する。
 *
 * - WikiLink: `[[ノート]]` / `[[ノート|表示名]]` / `[[ノート#見出し]]` /
 *   `[[ノート#見出し|表示名]]`。ブロック参照（`[[ノート#^ブロック]]`）は
 *   MVP 対象外だが、構造上は `^...` もサブパスとして解析され、解決時に
 *   見出しとして見つからないため壊れリンクになる
 * - Embed: `![[画像.png]]`（画像）と `![[ノート]]`（本文のインライン展開）。
 *   拡張子で画像かノートかを分類する
 * - Tag: インライン `#タグ`（`#` + 英数字/日本語/`_`/`-`、`/` 区切りの
 *   ネスト `#area/project` も可）。数字のみ・`#` 直後が空白のものはタグに
 *   しない（見出し `# 見出し` と衝突しないため）
 * - Frontmatter: ノート先頭の `---\n...\n---` ブロックを YAML のサブセット
 *   として抽出する（スカラー / インライン配列 / インデント付きリスト）。
 *   `tags:` キーはタグとして抽出し、それ以外は表示用に保持する
 *
 * コードフェンスとインラインコードスパン内は走査対象外（`#タグ` や
 * `[[...]]` をコード内で誤認識しない）。エスケープ（`\[[` / `\#`）は
 * スキップする。既存の装飾用パーサー（src/domain/markdown/parse）は壊さず、
 * こちらは Obsidian 記法専用の新設モジュールとして分離する。
 */

export type NotationKind = 'wikilink' | 'embed' | 'tag';

export interface WikiLinkSpan {
  readonly kind: 'wikilink';
  /** `[[` の開始位置 */
  readonly from: number;
  /** `]]` の直後（排他） */
  readonly to: number;
  /** リンク先ノート名・パス（`#` と `|` を除いた本文） */
  readonly target: string;
  /** 表示名（`[[ノート|表示名]]` の `|` 以降。省略時は null） */
  readonly alias: string | null;
  /** サブパス（`[[ノート#見出し]]` の `#` 以降。省略時は null） */
  readonly subpath: string | null;
}

export interface EmbedSpan {
  readonly kind: 'embed';
  /** `![[` の開始位置 */
  readonly from: number;
  /** `]]` の直後（排他） */
  readonly to: number;
  readonly target: string;
  readonly alias: string | null;
  readonly subpath: string | null;
  /** 拡張子による分類（画像なら 'image'、それ以外は 'note'） */
  readonly targetType: 'image' | 'note';
}

export interface TagSpan {
  readonly kind: 'tag';
  /** `#` の位置 */
  readonly from: number;
  /** タグ末尾の直後（排他） */
  readonly to: number;
  /** `#` を除いたタグ本文（`area/project` 形式。表記は原文のまま） */
  readonly tag: string;
}

export type NotationSpan = WikiLinkSpan | EmbedSpan | TagSpan;

export interface FrontmatterField {
  readonly key: string;
  /** 表示用の値（リストは ", " 結合。クォート除去・末尾コメント除去済み） */
  readonly value: string;
  /** リスト形式の値（スカラーの場合は [value]。タグ索引で使う） */
  readonly values: readonly string[];
}

export interface Frontmatter {
  /** 先頭 `---` の開始位置（常に 0） */
  readonly from: number;
  /** 閉じ `---` の直後（排他） */
  readonly to: number;
  /** デリミタを除いた YAML 本文 */
  readonly raw: string;
  readonly fields: readonly FrontmatterField[];
}

export interface NotationParseResult {
  /** 先頭にフロントマテリアがあればその解析結果（なければ null） */
  readonly frontmatter: Frontmatter | null;
  /** フロントマテリア `tags:` から抽出したタグ（本文タグとは分けて扱う） */
  readonly frontmatterTags: readonly string[];
  /**
   * 本文中の記法スパン（WikiLink / Embed / インライン Tag）。
   * フロントマテリア領域は含まない。オフセットはテキスト全体基準。
   */
  readonly spans: readonly NotationSpan[];
}

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

/** フロントマテリアのフィールド行: `key: value`（キーは英数字・日本語・`_`・`-`） */
const FIELD_RE = /^([\p{L}\p{N}_-]+):(?:\s*(.*))?$/u;

/** インデント付きリスト項目: `- 値` */
const LIST_ITEM_RE = /^(\s*)-(\s+)(.+)$/;

/** フロントマテリアのデリミタ行: `---`（前後の空白は許容） */
const FRONTMATTER_DELIMITER_RE = /^---\s*$/;

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
export interface LinkTextParts {
  readonly target: string;
  readonly alias: string | null;
  readonly subpath: string | null;
}

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

/** テキスト全体を解析し、フロントマテリアと記法スパンを返す */
export function parseNotation(text: string): NotationParseResult {
  const frontmatter = parseFrontmatter(text);
  const spans: NotationSpan[] = [];
  scanBody(text, frontmatter?.to ?? 0, spans);
  return {
    frontmatter,
    frontmatterTags: frontmatter === null ? [] : extractTags(frontmatter.fields),
    spans,
  };
}

/**
 * 先頭の `---\n...\n---` ブロックを YAML のサブセットとして解析する。
 * 閉じデリミタが見つからない場合はフロントマテリアではなく水平線なので null。
 */
export function parseFrontmatter(text: string): Frontmatter | null {
  const lines: { text: string; start: number }[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    lines.push({ text: line, start: offset });
    offset += line.length + 1;
  }

  const first = lines[0];
  if (!first || !FRONTMATTER_DELIMITER_RE.test(first.text)) {
    return null;
  }
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (FRONTMATTER_DELIMITER_RE.test(lines[i]?.text ?? '')) {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) {
    return null;
  }
  const closeLine = lines[closeIndex];
  const from = 0;
  const to = (closeLine?.start ?? 0) + 3;
  const raw = text.slice(first.text.length + 1, closeLine?.start ?? 0);
  return { from, to, raw, fields: parseFrontmatterFields(raw) };
}

/** YAML のスカラー値を正規化する（クォート除去・末尾コメント除去） */
function parseScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return '';
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  // クォートされていない値の末尾コメント（` #...`）を除去する
  const spaceHash = trimmed.indexOf(' #');
  return (spaceHash === -1 ? trimmed : trimmed.slice(0, spaceHash)).trim();
}

/** フロントマテリア本文（raw）からトップレベルフィールドを抽出する */
function parseFrontmatterFields(raw: string): FrontmatterField[] {
  const fields: { key: string; values: string[] }[] = [];
  let last: { key: string; values: string[] } | null = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    if (trimmed.startsWith('-')) {
      const item = LIST_ITEM_RE.exec(line);
      if (item && item[3] !== undefined) {
        const value = parseScalar(item[3]);
        if (last) {
          last.values.push(value);
        }
      }
      continue;
    }
    if (/^\s/.test(line)) {
      // インデントされた行はトップレベルではない（ネストした構造の一部として無視）
      continue;
    }
    const field = FIELD_RE.exec(line);
    if (!field || field[1] === undefined) {
      continue;
    }
    const values = parseListValue(field[2] ?? '');
    const value = values.length > 0 ? values.join(', ') : parseScalar(field[2] ?? '');
    const next: { key: string; values: string[] } = {
      key: field[1],
      values: values.length > 0 ? values : (field[2] ?? '').trim() === '' ? [] : [value],
    };
    fields.push(next);
    last = next;
  }

  return fields.map((field) => ({
    key: field.key,
    value: field.values.join(', '),
    values: field.values,
  }));
}

/** インライン配列 `[a, b]` を分解する。配列でなければ空配列 */
function parseListValue(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return [];
  }
  return trimmed
    .slice(1, -1)
    .split(',')
    .map((item) => parseScalar(item))
    .filter((item) => item !== '');
}

/** frontmatter フィールドから `tags:` キー（大文字小文字を区別しない）のタグを抽出する */
function extractTags(fields: readonly FrontmatterField[]): string[] {
  const tags: string[] = [];
  for (const field of fields) {
    if (field.key.toLowerCase() !== 'tags') {
      continue;
    }
    for (const value of field.values) {
      for (const tag of value.split(',').map((part) => part.trim())) {
        if (tag !== '') {
          tags.push(tag);
        }
      }
    }
  }
  return tags;
}

/** 本文を走査する。フロントマテリア領域（start より前）はスキップ済み */
function scanBody(text: string, start: number, out: NotationSpan[]): void {
  let fence: { char: string; len: number } | null = null;
  let offset = start;
  for (const line of text.slice(start).split('\n')) {
    const from = offset;
    const to = offset + line.length;
    offset = to + 1;

    if (fence) {
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
  let i = 0;
  while (i < line.length) {
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
  } else {
    out.push({
      kind: 'wikilink',
      from,
      to,
      target: parts.target,
      alias: parts.alias,
      subpath: parts.subpath,
    });
  }
  return close + 2;
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
  while (line[run] === fence.char) {
    run += 1;
  }
  return run >= fence.len && line.slice(run).trim() === '';
}
