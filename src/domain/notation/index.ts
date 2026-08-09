/**
 * ノートのリンク索引（参照・バックリンク・タグ索引）。
 *
 * Vault 内のノート一式から、どのノートがどのノートを参照しているかの索引を
 * 構築する。使いどころ:
 * - バックリンクパネル（M3）: `backlinks` で開いているノートを参照するノート
 *   の一覧を引く
 * - タグ一覧（M3）: `tagIndex` でタグ単位のノート一覧を引く
 * - リンク張り替え（M5）: `notes[path].links` の from/to と target から、
 *   リネームされたノートを参照する全リンクを書き換える
 * - 壊れリンクの可視化: `brokenLinks` に解決不能な参照が入る
 *
 * 解決には src/domain/notation/resolve を使う。画像 Embed もファイルパスへ
 * 解決される（存在しない画像は壊れリンクとして扱える）。
 */

import { parseNotation, type Frontmatter } from '@/domain/notation/parse';
import { findHeading, resolveNotePath, type HeadingPosition } from '@/domain/notation/resolve';

/** 索引の入力ノート（本文付き） */
export interface NoteRecord {
  /** Vault ルートからのノートパス（/ 区切り） */
  readonly path: string;
  readonly content: string;
}

/** ノートが持つリンク 1 件（WikiLink / Embed 共通） */
export interface LinkRef {
  readonly kind: 'wikilink' | 'embed';
  /** Embed のターゲット種別（画像かノートか）。WikiLink は 'note' */
  readonly targetType: 'note' | 'image';
  /** リンク本文（`#` と `|` を除いたターゲット名） */
  readonly target: string;
  readonly alias: string | null;
  readonly subpath: string | null;
  /** 解決できたファイルパス（null は壊れリンク） */
  readonly path: string | null;
  /** サブパス（見出し）の解決結果。subpath がない場合は null */
  readonly heading: HeadingPosition | null;
  /** 本文中の出現位置（オフセットはフロントマテリアを含む全文基準） */
  readonly from: number;
  readonly to: number;
}

/** ノート 1 件分の記法の解析結果 */
export interface NoteNotation {
  readonly path: string;
  readonly frontmatter: Frontmatter | null;
  /** 本文中のリンク（出現順） */
  readonly links: readonly LinkRef[];
  /** このノートが持つタグ（フロントマテリア → インラインの順、重複なし） */
  readonly tags: readonly string[];
}

export interface VaultNotationIndex {
  /** ノートパス → 解析結果 */
  readonly notes: ReadonlyMap<string, NoteNotation>;
  /** 参照先パス → 参照元ノートパス一覧（WikiLink / Embed 両方、重複なし） */
  readonly backlinks: ReadonlyMap<string, readonly string[]>;
  /** タグ（小文字正規化）→ ノートパス一覧 */
  readonly tagIndex: ReadonlyMap<string, readonly string[]>;
  /** 解決不能なリンク一覧（壊れリンク表示用） */
  readonly brokenLinks: readonly LinkRef[];
}

export interface NotationIndexInput {
  /** Vault 内の全ファイルパス（tree.ts と整合。画像等の非 Markdown も含む） */
  readonly filePaths: readonly string[];
  /** ノート本文（パス → 内容） */
  readonly contents: ReadonlyMap<string, string>;
}

/**
 * Vault 内のノート一式からリンク索引を構築する。
 * 各ノートを解析し、参照（リンク）・バックリンク・タグ索引・壊れリンクを集める。
 */
export function buildNotationIndex(input: NotationIndexInput): VaultNotationIndex {
  const { filePaths, contents } = input;
  const notes = new Map<string, NoteNotation>();
  const backlinks = new Map<string, Set<string>>();
  const tagIndex = new Map<string, string[]>();
  const brokenLinks: LinkRef[] = [];

  for (const [path, content] of contents) {
    const result = parseNotation(content);
    const links: LinkRef[] = [];
    for (const span of result.spans) {
      if (span.kind === 'tag') {
        continue;
      }
      const targetType = span.kind === 'embed' ? span.targetType : 'note';
      const resolvedPath = resolveNotePath(span.target, filePaths);
      const heading =
        span.subpath !== null && resolvedPath !== null
          ? findHeading(contents.get(resolvedPath) ?? '', span.subpath)
          : null;
      const ref: LinkRef = {
        kind: span.kind,
        targetType,
        target: span.target,
        alias: span.alias,
        subpath: span.subpath,
        path: resolvedPath,
        heading,
        from: span.from,
        to: span.to,
      };
      links.push(ref);
      if (resolvedPath !== null) {
        const sources = backlinks.get(resolvedPath) ?? new Set<string>();
        sources.add(path);
        backlinks.set(resolvedPath, sources);
      } else {
        brokenLinks.push(ref);
      }
    }

    // タグ（フロントマテリア → インラインの順、大文字小文字を区別せず重複除去）
    const tags: string[] = [];
    const seenTags = new Set<string>();
    const addTag = (tag: string): void => {
      const key = tag.toLowerCase();
      if (seenTags.has(key)) {
        return;
      }
      seenTags.add(key);
      tags.push(tag);
      const paths = tagIndex.get(key) ?? [];
      paths.push(path);
      tagIndex.set(key, paths);
    };
    for (const tag of result.frontmatterTags) {
      addTag(tag);
    }
    for (const span of result.spans) {
      if (span.kind === 'tag') {
        addTag(span.tag);
      }
    }

    notes.set(path, { path, frontmatter: result.frontmatter, links, tags });
  }

  return {
    notes,
    backlinks: new Map([...backlinks].map(([key, value]) => [key, [...value]])),
    tagIndex,
    brokenLinks,
  };
}
