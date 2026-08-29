/**
 * リーディング表示のレンダリングパイプライン（Markdown → HTML）。
 *
 * domain 記法解析を再利用し、WikiLink / Embed（画像・本文再帰展開）/ Tag /
 * 数式（KaTeX）/ コールアウト / タスクリスト / コードハイライト /
 * 見出しスラグ id を 1 本のパイプラインで変換する。
 *
 * 記法スパンはプレースホルダー（私用領域の文字）に置き換えてから Markdown
 * パースし、完了後に実 HTML へ置換することで、Markdown パーサーが生成した
 * 構造を崩さずに注入する（ブロック要素は <p> を外して注入）。
 * 出力はサニタイズ前の HTML のため、DOM 注入前に必ず sanitizeHtml
 * （src/infra/render/sanitize）を通すこと。
 *
 * コードの一時マスクは code-mask、Marked セットアップは marked-setup が担う。
 */

import { noteDisplayName } from '@/application/note-name';

import type { HLJSApi } from 'highlight.js';

import { expandNoteEmbeds, type EmbedExpansionNode } from '@/domain/notation/embed';
import { parseNotation } from '@/domain/notation/parse';
import { resolveNotePath } from '@/domain/notation/resolve';

import { escapeHtml } from '@/infra/render/escape';
import { loadHighlight } from '@/infra/render/highlight';
import {
  extractMath,
  loadKatex,
  mathPlaceholder,
  renderMathItems,
  type KatexRenderer,
} from '@/infra/render/math';
import { maskCode, unmaskCode } from '@/infra/render/code-mask';
import { substituteByIndex, substituteMarker } from '@/infra/render/placeholder-substitute';
import { createMarked } from '@/infra/render/marked-setup';

/** 記法プレースホルダー（\uE010..\uE011。ユーザー本文と衝突しない私用領域） */
const NOTATION_MARKER_OPEN = '\uE010';
const NOTATION_MARKER_CLOSE = '\uE011';

/** レンダリングの入力（呼び出し側 = UI 層が組み立てる） */
export type RenderNotationOptions = {
  /** レンダリング対象ノートのパス（contents のキーと一致させる） */
  readonly path: string;
  /** 埋め込みを含むノート本文一式（パス → 本文。ルート自身を含む） */
  readonly contents: ReadonlyMap<string, string>;
  /** Vault 内の全ファイルパス（画像等の非 Markdown も含む。解決に使う） */
  readonly filePaths: readonly string[];
  /** 画像 Embed の URL ビルダー（raw プロキシ URL を返す） */
  readonly imageUrl: (path: string) => string;
  /** WikiLink の href ビルダー（SPA のノート URL + #見出し） */
  readonly linkHref: (path: string, subpath: string | null) => string;
};

export type RenderNotationResult = {
  /** サニタイズ前の HTML（DOM 注入前に sanitizeHtml を通すこと） */
  readonly html: string;
  /** 循環参照で展開を停止した埋め込み（祖先チェーン [..., 繰り返し先]） */
  readonly cycles: readonly string[][];
  /** 深さ上限で展開を打ち切った埋め込み */
  readonly truncated: readonly string[];
};

/** renderDocument 内部で使い回す描画文脈 */
type RenderContext = {
  readonly options: RenderNotationOptions;
  readonly byParent: ReadonlyMap<string, readonly EmbedExpansionNode[]>;
  readonly katex: KatexRenderer | null;
  readonly hljs: HLJSApi | null;
};

/** 記法スパンの置換結果（プレースホルダー → 実 HTML） */
type SpanReplacement = {
  readonly marker: string;
  readonly html: string;
  readonly block: boolean;
};

/**
 * Markdown をリーディング表示用 HTML に変換する。
 * KaTeX / highlight.js は初回呼び出し時に動的 import される（バンドル分割）。
 */
export async function renderNoteMarkdown(
  content: string,
  options: RenderNotationOptions,
): Promise<RenderNotationResult> {
  const [katex, hljs] = await Promise.all([loadKatex(), loadHighlight()]);

  // domain の embed.ts で埋め込みツリーを構築する（循環参照・深さ上限処理済み）。
  // 各パスの「展開される子埋め込み」リストを描画側の再帰ゲートに使う:
  // ターゲットがこのリストに無い埋め込みは展開せず、折りたたみ表示にする
  // （循環参照・深さ上限で打ち切られた埋め込み。ツリーは有限なので再帰は必ず終わる）
  const tree = expandNoteEmbeds(options.contents, options.path);
  const byParent = new Map<string, readonly EmbedExpansionNode[]>();
  byParent.set(options.path, tree.embeds);
  collectChildren(byParent, tree.embeds);

  const html = renderDocument(content, { options, byParent, katex, hljs }, tree.embeds);
  return { html, cycles: tree.cycles, truncated: tree.truncated };
}

/** 埋め込みツリーの子リストを親パスへ登録する（再帰描画ゲート用） */
function collectChildren(
  byParent: Map<string, readonly EmbedExpansionNode[]>,
  nodes: readonly EmbedExpansionNode[],
): void {
  for (const node of nodes) {
    byParent.set(node.path, node.children);
    collectChildren(byParent, node.children);
  }
}

/** 本文 1 件を HTML に変換する（埋め込みはここで再帰する） */
function renderDocument(
  content: string,
  context: RenderContext,
  children: readonly EmbedExpansionNode[],
): string {
  // フロントマテリアは本文から除去（表示は UI 側）
  const frontmatter = parseNotation(content).frontmatter;
  const body = frontmatter === null ? content : content.slice(frontmatter.to);

  // 1. 記法スパン → プレースホルダー（後方から置換して前方オフセットを保つ）
  const parsed = parseNotation(body);
  let text = body;
  const replacements: Array<SpanReplacement & { from: number; to: number }> = [];
  const pending: Array<SpanReplacement & { from: number; to: number }> = [];
  for (let i = parsed.spans.length - 1; i >= 0; i -= 1) {
    const span = parsed.spans[i];
    const marker = `${NOTATION_MARKER_OPEN}${i}${NOTATION_MARKER_CLOSE}`;
    if (span === undefined) {
      pending.push({ marker, html: '', block: false, from: 0, to: 0 });
      continue;
    }
    let rendered: { readonly html: string; readonly block: boolean } | null = null;
    if (span.kind === 'wikilink') {
      const resolved = resolveNotePath(span.target, context.options.filePaths);
      const display = escapeHtml(span.alias ?? noteDisplayName(resolved ?? span.target));
      if (resolved === null || !resolved.endsWith('.md')) {
        rendered = {
          html: `<a class="tk-wikilink tk-wikilink-broken" data-broken-link="true" title="リンク先が見つかりません">${display}</a>`,
          block: false,
        };
      }
      if (resolved !== null && resolved.endsWith('.md')) {
        rendered = {
          html:
            `<a class="tk-wikilink" href="${escapeHtml(context.options.linkHref(resolved, span.subpath), true)}"` +
            ` data-note-path="${escapeHtml(resolved, true)}" data-subpath="${escapeHtml(span.subpath ?? '', true)}">${display}</a>`,
          block: false,
        };
      }
    }
    if (span.kind === 'tag') {
      rendered = { html: `<span class="tk-tag">#${escapeHtml(span.tag)}</span>`, block: false };
    }
    if (span.kind === 'embed') {
      const resolved = resolveNotePath(span.target, context.options.filePaths);
      if (resolved === null) {
        rendered = brokenEmbed(span.target);
      }
      if (resolved !== null && span.targetType === 'image') {
        rendered = {
          html:
            `<img class="note-embed-image" src="${escapeHtml(context.options.imageUrl(resolved), true)}"` +
            ` alt="${escapeHtml(span.alias ?? span.target, true)}" data-embed-image="true" loading="lazy">`,
          block: false,
        };
      }
      if (resolved !== null && span.targetType !== 'image') {
        const childContent = context.options.contents.get(resolved);
        if (childContent === undefined) {
          rendered = brokenEmbed(span.target);
        }
        if (childContent !== undefined) {
          const headerLink =
            `<a class="note-embed-link" href="${escapeHtml(context.options.linkHref(resolved, null), true)}"` +
            ` data-note-path="${escapeHtml(resolved, true)}">${escapeHtml(noteDisplayName(resolved))}</a>`;
          const isCollapsed = !children.some((node) => node.path === resolved);
          if (isCollapsed) {
            rendered = {
              html:
                `<span class="embed-collapsed" title="循環参照または深さ上限のため展開しませんでした">${headerLink}` +
                ` を展開しませんでした</span>`,
              block: false,
            };
          }
          if (!isCollapsed) {
            const childHtml = renderDocument(
              childContent,
              context,
              context.byParent.get(resolved) ?? [],
            );
            rendered = {
              html:
                `<div class="note-embed" data-embed-path="${escapeHtml(resolved, true)}">` +
                `<div class="note-embed-header">${headerLink}` +
                `</div><div class="note-embed-content">${childHtml}</div></div>`,
              block: true,
            };
          }
        }
      }
    }
    if (rendered === null) {
      rendered = { html: '', block: false };
    }
    pending.push({ ...rendered, marker, from: span.from, to: span.to });
  }
  // 後方のスパンから順に適用する（pending は後方から積まれている）
  for (const replacement of pending) {
    const marker = replacement.marker;
    const padding = replacement.block ? '\n\n' : '';
    text = `${text.slice(0, replacement.from)}${padding}${marker}${padding}${text.slice(replacement.to)}`;
    replacements.push(replacement);
  }

  // 2. 数式抽出（コード内の `$` を誤検出しないよう、一時的にコードをマスク）
  const masked = maskCode(text);
  const math = extractMath(masked.text);
  const mathText = unmaskCode(math.text, masked.items);

  // 3. Markdown → HTML（コールアウト / ハイライト / スラグ id は renderer 側）
  const marked = createMarked(context.hljs);
  let html: string = marked.parse(mathText, { async: false });

  // 4. 数式プレースホルダー → KaTeX HTML
  const mathHtml = renderMathItems(math.items, context.katex);
  html = substituteByIndex(html, mathPlaceholder, mathHtml);

  // 5. 記法プレースホルダー → 実 HTML（ブロックは <p> を外して注入）
  for (const { marker, html: replacement, block } of replacements) {
    html = substituteMarker(html, marker, replacement, block);
  }

  return html;
}

/** 壊れ埋め込みの表示（解決不能・取得失敗） */
function brokenEmbed(target: string): { readonly html: string; readonly block: boolean } {
  return {
    html: `<span class="tk-embed tk-embed-broken">![[${escapeHtml(target)}]]</span>`,
    block: false,
  };
}
