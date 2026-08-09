/**
 * 全文検索クエリ層（M4: M2 全文検索 UI）。
 *
 * 共有ノート索引（note-index.ts の NoteIndex.notes）と記法索引
 * （notation/index.ts のタグ）を MiniSearch で索引化し、ノート本文・
 * ファイル名（パス）・タグを対象に検索する。同一クエリの結果は
 * 本文一致 > ファイル名一致 > タグ一致 の優先順で並べる（計画の方針）。
 *
 * 検索は同期実行で、個人 Vault 規模（数百〜数千ノート）ではタイピングの
 * たびに実行しても実用的な速度を保つ（ADR-0004 の前提。数万ファイルへの
 * 最適化は行わない）。
 *
 * トークナイザは「英数字の連続 + 日本語 1 文字」で、ひらがな・カタカナ・
 * 漢字の部分一致（例: クエリ「検索」は「検」「索」の両方を含むノートに
 * マッチする）を可能にする。タグは tags フィールドに `#タグ` 形式で保持し、
 * `#meeting` のようなクエリでもタグ一致として拾える。
 */

import MiniSearch from 'minisearch';

/** 検索対象の 1 ノート（NoteIndex と記法索引のタグを統合した形） */
export interface SearchableNote {
  readonly path: string;
  readonly content: string;
  readonly tags: readonly string[];
}

/** 一致種別（本文 > ファイル名 > タグ の優先順。ソートに使う） */
export type SearchHitKind = 'content' | 'name' | 'tag';

/** ハイライト断片（text の一部または全部を <mark> で強調する） */
export interface SnippetPart {
  /** スニペット内の開始オフセット（React の key に使う。省略記号は負値） */
  readonly from: number;
  readonly text: string;
  readonly highlight: boolean;
}

/** 検索結果 1 件 */
export interface SearchHit {
  readonly path: string;
  readonly kind: SearchHitKind;
  /** MiniSearch の BM25 スコア（同種別内の並び順に使う） */
  readonly score: number;
  /** 本文一致のみ: 一致箇所を含むスニペット（<mark> 用断片）。null はスニペットなし */
  readonly snippet: readonly SnippetPart[] | null;
  /** タグ一致のみ: クエリに一致したタグ（原表記） */
  readonly matchedTags: readonly string[];
}

/** 検索 API（タイピングごとに search を呼ぶ。同期で十分高速） */
export interface NoteSearcher {
  readonly search: (query: string) => readonly SearchHit[];
}

/** 一度に表示する結果の上限（個人 Vault では十分） */
const MAX_RESULTS = 50;

/**
 * 英数字の連続を 1 トークン、日本語（ひらがな・カタカナ・漢字）を 1 文字ずつ
 * トークン化する。大文字小文字は区別しない（小文字に正規化）。
 * 長音「ー」と中黒「・」は Unicode Script が Common のため明示的に含める。
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(
    /[\w-]+|[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\u30fc\u30fb]/gu,
  )) {
    tokens.push(match[0].toLowerCase());
  }
  return tokens;
}

function kindOrder(kind: SearchHitKind): number {
  switch (kind) {
    case 'content':
      return 0;
    case 'name':
      return 1;
    case 'tag':
      return 2;
  }
}

/** クエリ語（トークン）がすべて含まれるか */
function containsAll(haystack: string, queryTerms: readonly string[]): boolean {
  return queryTerms.every((term) => haystack.includes(term));
}

/**
 * 一致種別: 本文に全クエリ語を含むなら content、本文にないがパスに含むなら
 * name、どちらにもないがタグに含むなら tag。複数種別に一致する場合は
 * 優先度の高い種別（content）と判定する。
 */
function classifyHit(note: SearchableNote, queryTerms: readonly string[]): SearchHitKind {
  if (containsAll(note.content.toLowerCase(), queryTerms)) {
    return 'content';
  }
  if (containsAll(note.path.toLowerCase(), queryTerms)) {
    return 'name';
  }
  if (note.tags.some((tag) => containsAll(tag.toLowerCase(), queryTerms))) {
    return 'tag';
  }
  return 'content';
}

/** クエリに一致するタグ（原表記）を返す */
function matchedTagsOf(tags: readonly string[], queryTerms: readonly string[]): readonly string[] {
  return tags.filter((tag) => containsAll(tag.toLowerCase(), queryTerms));
}

/**
 * テキスト中のクエリ語の出現箇所をすべてハイライト断片に分割する。
 * 重なり合う出現は 1 つのハイライトにまとめる。
 */
export function highlightParts(text: string, queryTerms: readonly string[]): SnippetPart[] {
  const terms = queryTerms.filter((term) => term.length > 0);
  if (text.length === 0 || terms.length === 0) {
    return [{ from: 0, text, highlight: false }];
  }
  const lower = text.toLowerCase();
  const marks: Array<{ from: number; to: number }> = [];
  for (const term of terms) {
    let from = 0;
    while (from < lower.length) {
      const found = lower.indexOf(term, from);
      if (found === -1) {
        break;
      }
      marks.push({ from: found, to: found + term.length });
      from = found + term.length;
    }
  }
  marks.sort((a, b) => a.from - b.from || b.to - a.to);
  const merged: Array<{ from: number; to: number }> = [];
  for (const mark of marks) {
    const last = merged.at(-1);
    if (last !== undefined && mark.from <= last.to) {
      last.to = Math.max(last.to, mark.to);
    } else {
      merged.push({ ...mark });
    }
  }
  const parts: SnippetPart[] = [];
  let cursor = 0;
  for (const mark of merged) {
    if (mark.from > cursor) {
      parts.push({ from: cursor, text: text.slice(cursor, mark.from), highlight: false });
    }
    parts.push({ from: mark.from, text: text.slice(mark.from, mark.to), highlight: true });
    cursor = mark.to;
  }
  if (cursor < text.length) {
    parts.push({ from: cursor, text: text.slice(cursor), highlight: false });
  }
  return parts;
}

/**
 * 本文から最初の一致箇所を中心にスニペットを切り出す（mark 用断片）。
 * 一致がなければ null。前後が省略された場合は「…」を付ける。
 */
export function buildSnippet(content: string, queryTerms: readonly string[]): SnippetPart[] | null {
  const lower = content.toLowerCase();
  let start = -1;
  let end = 0;
  for (const term of queryTerms) {
    if (term.length === 0) {
      continue;
    }
    const found = lower.indexOf(term);
    if (found !== -1 && (start === -1 || found < start)) {
      start = found;
      end = found + term.length;
    }
  }
  if (start === -1) {
    return null;
  }
  const from = Math.max(0, start - 40);
  const to = Math.min(content.length, end + 60);
  const parts = highlightParts(content.slice(from, to), queryTerms);
  // 省略記号はスニペット本文の外なので負のオフセットを割り当てる（key 衝突を避ける）
  if (from > 0) {
    parts.unshift({ from: -1, text: '…', highlight: false });
  }
  if (to < content.length) {
    parts.push({ from: -2, text: '…', highlight: false });
  }
  return parts;
}

/**
 * ノート一式から検索器を構築する。索引の構築はノート数に比例するため、
 * 呼び出し側（VaultScreen）でノート索引の変更時のみ再構築する。
 */
export function createNoteSearcher(notes: readonly SearchableNote[]): NoteSearcher {
  const byPath = new Map<string, SearchableNote>();
  for (const note of notes) {
    byPath.set(note.path, note);
  }
  const miniSearch = new MiniSearch({
    idField: 'path',
    fields: ['content', 'name', 'tags'],
    tokenize,
    searchOptions: {
      prefix: true,
      // 全クエリ語の一致を要求する（日本語 1 文字トークンの部分マッチのノイズを抑える）
      combineWith: 'AND',
      // 本文一致を優先する boost（分類でも本文 > ファイル名 > タグを保証する）
      boost: { content: 1, name: 0.8, tags: 0.6 },
    },
  });
  miniSearch.addAll(
    notes.map((note) => ({
      path: note.path,
      content: note.content,
      name: note.path,
      tags: note.tags.map((tag) => `#${tag}`).join(' '),
    })),
  );
  return {
    search: (query) => {
      const trimmed = query.trim();
      if (trimmed.length === 0) {
        return [];
      }
      const results = miniSearch.search(trimmed);
      const hits: SearchHit[] = [];
      for (const result of results) {
        const note = byPath.get(result.id as string);
        if (note === undefined) {
          continue;
        }
        const kind = classifyHit(note, result.queryTerms);
        hits.push({
          path: note.path,
          kind,
          score: result.score,
          snippet: kind === 'content' ? buildSnippet(note.content, result.queryTerms) : null,
          matchedTags: kind === 'tag' ? matchedTagsOf(note.tags, result.queryTerms) : [],
        });
      }
      hits.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || b.score - a.score);
      return hits.slice(0, MAX_RESULTS);
    },
  };
}
