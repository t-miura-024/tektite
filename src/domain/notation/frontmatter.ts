/**
 * Frontmatter（`---\n...\n---` ブロック）の解析。
 *
 * ノート先頭ブロックを YAML のサブセットとして解析する
 * （スカラー / インライン配列 / インデント付きリスト）。
 */

export type FrontmatterField = {
  readonly key: string;
  /** 表示用の値（リストは ", " 結合。クォート除去・末尾コメント除去済み） */
  readonly value: string;
  /** リスト形式の値（スカラーの場合は [value]。タグ索引で使う） */
  readonly values: readonly string[];
};

export type Frontmatter = {
  /** 先頭 `---` の開始位置（常に 0） */
  readonly from: number;
  /** 閉じ `---` の直後（排他） */
  readonly to: number;
  /** デリミタを除いた YAML 本文 */
  readonly raw: string;
  readonly fields: readonly FrontmatterField[];
};

/** フロントマテリアのフィールド行: `key: value`（キーは英数字・日本語・`_`・`-`） */
const FIELD_RE = /^([\p{L}\p{N}_-]+):(?:\s*(.*))?$/u;

/** インデント付きリスト項目: `- 値` */
const LIST_ITEM_RE = /^(\s*)-(\s+)(.+)$/;

/** フロントマテリアのデリミタ行: `---`（前後の空白は許容） */
const FRONTMATTER_DELIMITER_RE = /^---\s*$/;

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
export function extractTags(fields: readonly FrontmatterField[]): string[] {
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
