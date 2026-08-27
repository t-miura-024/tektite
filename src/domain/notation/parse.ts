/**
 * Obsidian 記法のパーサー（WikiLink / Embed / Tag / Frontmatter）の窓口。
 *
 * 純 TypeScript・フレームワーク非依存。テキストを走査して記法の
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
 * - Frontmatter: 解析は src/domain/notation/frontmatter、本文スキャンは
 *   src/domain/notation/scan が担う（ここでは窓口として再公開する）
 */

import {
  extractTags,
  parseFrontmatter,
  type Frontmatter,
  type FrontmatterField,
} from '@/domain/notation/frontmatter';
import { isImageTarget, parseLinkText, scanBody, type LinkTextParts } from '@/domain/notation/scan';

export type { Frontmatter, FrontmatterField };
export { isImageTarget, parseFrontmatter, parseLinkText, type LinkTextParts };

export type NotationKind = 'wikilink' | 'embed' | 'tag';

export type WikiLinkSpan = {
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
};

export type EmbedSpan = {
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
};

export type TagSpan = {
  readonly kind: 'tag';
  /** `#` の位置 */
  readonly from: number;
  /** タグ末尾の直後（排他） */
  readonly to: number;
  /** `#` を除いたタグ本文（`area/project` 形式。表記は原文のまま） */
  readonly tag: string;
};

export type NotationSpan = WikiLinkSpan | EmbedSpan | TagSpan;

export type NotationParseResult = {
  /** 先頭にフロントマテリアがあればその解析結果（なければ null） */
  readonly frontmatter: Frontmatter | null;
  /** フロントマテリア `tags:` から抽出したタグ（本文タグとは分けて扱う） */
  readonly frontmatterTags: readonly string[];
  /**
   * 本文中の記法スパン（WikiLink / Embed / インライン Tag）。
   * フロントマテリア領域は含まない。オフセットはテキスト全体基準。
   */
  readonly spans: readonly NotationSpan[];
};

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
