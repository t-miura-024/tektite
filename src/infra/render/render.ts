/**
 * リーディング表示のレンダリングパイプライン（Markdown → HTML）。
 *
 * M1 の domain 記法解析（parseNotation / resolveNotePath / expandNoteEmbeds）を
 * 再利用し、以下の変換を 1 本のパイプラインで行う:
 *
 * - WikiLink → <a>（エイリアス表示・見出しリンク。壊れリンクは専用スタイル）
 * - Embed   → 画像 <img>（raw プロキシ URL は呼び出し側が注入）/
 *   ノート本文の再帰展開（循環参照・深さ上限は domain の embed.ts が処理済み）
 * - Tag     → <span class="tag">
 * - 数式    → KaTeX（$...$ / $$...$$。動的 import。失敗時はフォールバック表示）
 * - コールアウト（> [!note] など）→ 専用ブロック
 * - タスクリスト → チェックボックス付きリスト
 * - コードハイライト（highlight.js。動的 import）
 * - 見出しにスラグ id を付与（WikiLink の #見出し 遷移先と一致させる）
 *
 * フロントマテリアは本文から除去する（表示は UI 側の責務）。
 * 記法スパンはプレースホルダー（私用領域の文字）に置き換えてから Markdown
 * パースし、完了後に実 HTML へ置換する。これにより Markdown パーサーが
 * 生成した HTML の構造を崩さずに注入できる（ブロック要素は <p> を外して
 * 注入する）。出力はサニタイズ前の HTML のため、DOM 注入前に必ず
 * sanitizeHtml（src/infra/render/sanitize）を通すこと。
 */

import { Marked } from 'marked';
import type { RendererObject, Token, TokenizerAndRendererExtension, Tokens } from 'marked';

import { expandNoteEmbeds } from '@/domain/notation/embed';
import type { EmbedExpansionNode } from '@/domain/notation/embed';
import { parseNotation } from '@/domain/notation/parse';
import type { TagSpan, WikiLinkSpan } from '@/domain/notation/parse';
import { resolveNotePath } from '@/domain/notation/resolve';

import { highlightCode, loadHighlight } from '@/infra/render/highlight';
import { escapeHtml } from '@/infra/render/escape';
import type { HLJSApi } from 'highlight.js';
import { extractMath, loadKatex, mathPlaceholder, renderMathItems } from '@/infra/render/math';
import type { KatexRenderer } from '@/infra/render/math';
import { slugify } from '@/infra/render/slug';

/** 記法プレースホルダー（\uE010..\uE011）とコードマスク（\uE020..\uE021） */
const NOTATION_MARKER_OPEN = '\uE010';
const NOTATION_MARKER_CLOSE = '\uE011';
const CODE_MASK_OPEN = '\uE020';
const CODE_MASK_CLOSE = '\uE021';

function notationPlaceholder(index: number): string {
  return `${NOTATION_MARKER_OPEN}${index}${NOTATION_MARKER_CLOSE}`;
}

function codeMaskPlaceholder(index: number): string {
  return `${CODE_MASK_OPEN}${index}${CODE_MASK_CLOSE}`;
}

/** レンダリングの入力（呼び出し側 = UI 層が組み立てる） */
export interface RenderNotationOptions {
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
}

export interface RenderNotationResult {
  /** サニタイズ前の HTML（DOM 注入前に sanitizeHtml を通すこと） */
  readonly html: string;
  /** 循環参照で展開を停止した埋め込み（祖先チェーン [..., 繰り返し先]） */
  readonly cycles: readonly string[][];
  /** 深さ上限で展開を打ち切った埋め込み */
  readonly truncated: readonly string[];
}

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
  const collectChildren = (nodes: readonly EmbedExpansionNode[]): void => {
    for (const node of nodes) {
      byParent.set(node.path, node.children);
      collectChildren(node.children);
    }
  };
  collectChildren(tree.embeds);

  const html = renderDocument(content, options, byParent, katex, hljs, tree.embeds);
  return { html, cycles: tree.cycles, truncated: tree.truncated };
}

/** 本文 1 件を HTML に変換する（埋め込みはここで再帰する） */
function renderDocument(
  content: string,
  options: RenderNotationOptions,
  byParent: ReadonlyMap<string, readonly EmbedExpansionNode[]>,
  katex: KatexRenderer | null,
  hljs: HLJSApi | null,
  children: readonly EmbedExpansionNode[],
): string {
  // フロントマテリアは本文から除去（表示は UI 側）
  const frontmatter = parseNotation(content).frontmatter;
  const body = frontmatter === null ? content : content.slice(frontmatter.to);

  // 1. 記法スパン → プレースホルダー（後方から置換して前方オフセットを保つ）
  const parsed = parseNotation(body);
  let text = body;
  const replacements: Array<{ marker: string; html: string; block: boolean }> = [];
  for (let i = parsed.spans.length - 1; i >= 0; i -= 1) {
    const span = parsed.spans[i];
    if (!span) {
      continue;
    }
    const marker = notationPlaceholder(i);
    let replacement: string;
    let block = false;
    if (span.kind === 'wikilink') {
      replacement = renderWikilink(span, options);
    } else if (span.kind === 'tag') {
      replacement = renderTag(span);
    } else {
      const resolved = resolveNotePath(span.target, options.filePaths);
      if (span.targetType === 'image') {
        replacement =
          resolved === null
            ? brokenEmbed(span.target)
            : `<img class="note-embed-image" src="${escapeHtml(options.imageUrl(resolved), true)}" alt="${escapeHtml(span.alias ?? span.target, true)}" data-embed-image="true" loading="lazy">`;
      } else if (resolved === null) {
        replacement = brokenEmbed(span.target);
      } else {
        const childContent = options.contents.get(resolved);
        if (childContent === undefined) {
          replacement = brokenEmbed(span.target);
        } else if (children.some((node) => node.path === resolved)) {
          // ツリーが展開を許した埋め込み: 子ノート本文を再帰的に描画する
          block = true;
          const childHtml = renderDocument(
            childContent,
            options,
            byParent,
            katex,
            hljs,
            byParent.get(resolved) ?? [],
          );
          replacement =
            `<div class="note-embed" data-embed-path="${escapeHtml(resolved, true)}">` +
            `<div class="note-embed-header">` +
            `<a class="note-embed-link" href="${escapeHtml(options.linkHref(resolved, null), true)}" data-note-path="${escapeHtml(resolved, true)}">${escapeHtml(noteDisplayName(resolved))}</a>` +
            `</div><div class="note-embed-content">${childHtml}</div></div>`;
        } else {
          // 循環参照・深さ上限で打ち切られた埋め込み: リンクのみ表示する
          replacement =
            `<span class="embed-collapsed" title="循環参照または深さ上限のため展開しませんでした">` +
            `<a class="embed-collapsed-link" href="${escapeHtml(options.linkHref(resolved, null), true)}" data-note-path="${escapeHtml(resolved, true)}">${escapeHtml(noteDisplayName(resolved))}</a>` +
            ` を展開しませんでした</span>`;
        }
      }
    }
    // ブロック要素（ノート埋め込み）は前後に空行を挟んで段落を分断する
    // （<p> 内に <div> が入らないようにするため。後段で <p> を外して注入する）
    const padding = block ? '\n\n' : '';
    text = `${text.slice(0, span.from)}${padding}${marker}${padding}${text.slice(span.to)}`;
    replacements.push({ marker, html: replacement, block });
  }

  // 2. 数式抽出（コード内の `$` を誤検出しないよう、一時的にコードをマスク）
  const masked = maskCode(text);
  const math = extractMath(masked.text);
  const mathText = unmaskCode(math.text, masked.items);

  // 3. Markdown → HTML（コールアウト / ハイライト / スラグ id は renderer 側）
  const marked = createMarked(hljs);
  let html = marked.parse(mathText) as string;

  // 4. 数式プレースホルダー → KaTeX HTML
  const mathHtml = renderMathItems(math.items, katex);
  html = substituteByIndex(html, mathPlaceholder, mathHtml);

  // 5. 記法プレースホルダー → 実 HTML（ブロックは <p> を外して注入）
  for (const { marker, html: replacement, block } of replacements) {
    html = substituteMarker(html, marker, replacement, block);
  }

  return html;
}

/** 壊れ埋め込みの表示（解決不能・取得失敗） */
function brokenEmbed(target: string): string {
  return `<span class="embed-broken">![[${escapeHtml(target)}]]</span>`;
}

/** WikiLink を <a> に変換する（壊れリンク / ノート以外のファイルは専用スタイル） */
function renderWikilink(span: WikiLinkSpan, options: RenderNotationOptions): string {
  const resolved = resolveNotePath(span.target, options.filePaths);
  const display = escapeHtml(span.alias ?? noteDisplayName(resolved ?? span.target));
  if (resolved === null || !resolved.endsWith('.md')) {
    return `<a class="wikilink wikilink-broken" data-broken-link="true" title="リンク先が見つかりません">${display}</a>`;
  }
  return (
    `<a class="wikilink" href="${escapeHtml(options.linkHref(resolved, span.subpath), true)}"` +
    ` data-note-path="${escapeHtml(resolved, true)}" data-subpath="${escapeHtml(span.subpath ?? '', true)}">${display}</a>`
  );
}

/** タグを <span class="tag"> に変換する（クリック動作は MVP 対象外） */
function renderTag(span: TagSpan): string {
  return `<span class="tag">#${escapeHtml(span.tag)}</span>`;
}

/** パスから表示名（拡張子を除いた最終セグメント）を得る */
function noteDisplayName(path: string): string {
  const base = path.split('/').at(-1) ?? path;
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

/** プレースホルダーを実 HTML に置換する（marker は正規表現に使わない） */
function substituteMarker(
  html: string,
  marker: string,
  replacement: string,
  block: boolean,
): string {
  if (block) {
    const wrapped = `<p>${marker}</p>`;
    if (html.includes(wrapped)) {
      return html.replace(wrapped, replacement);
    }
  }
  return html.split(marker).join(replacement);
}

/** 番号付きプレースホルダー（mathPlaceholder(i)）を html 列で置換する */
function substituteByIndex(
  html: string,
  placeholderFor: (index: number) => string,
  replacements: readonly string[],
): string {
  let out = html;
  for (let i = 0; i < replacements.length; i += 1) {
    const replacement = replacements[i];
    if (replacement !== undefined) {
      out = out.split(placeholderFor(i)).join(replacement);
    }
  }
  return out;
}

/** マスク済みコード 1 件 */
interface CodeMaskItem {
  readonly marker: string;
  readonly code: string;
}

/** フェンスドコードの開始（``` または ~~~） */
const FENCE_OPEN_RE = /^(`{3,}|~{3,})(.*)$/;

/** from 以降に ch が何文字連続するか */
function countRun(text: string, from: number, ch: string): number {
  let n = 0;
  while (text[from + n] === ch) {
    n += 1;
  }
  return n;
}

/** フェンス閉じ行かどうか（同じ char が open の長さ以上続き、残りは空白のみ） */
function isFenceClose(line: string, fence: { char: string; len: number }): boolean {
  let run = 0;
  while (line[run] === fence.char) {
    run += 1;
  }
  return run >= fence.len && line.slice(run).trim() === '';
}

/**
 * フェンスドコードとインラインコードをプレースホルダーで一時マスクする。
 * 数式抽出の前に使う（コード内の `$` を数式と誤検出しないため）。
 */
function maskCode(source: string): { text: string; items: readonly CodeMaskItem[] } {
  const items: CodeMaskItem[] = [];
  const out: string[] = [];
  let fence: { char: string; len: number } | null = null;
  let fenceLines: string[] | null = null;

  const addMask = (code: string): string => {
    const marker = codeMaskPlaceholder(items.length);
    items.push({ marker, code });
    return marker;
  };

  for (const line of source.split('\n')) {
    if (fence !== null) {
      if (isFenceClose(line, fence)) {
        out.push(addMask([...(fenceLines ?? []), line].join('\n')));
        fence = null;
        fenceLines = null;
      } else {
        fenceLines?.push(line);
      }
      continue;
    }
    const fenceOpen = FENCE_OPEN_RE.exec(line);
    if (fenceOpen && fenceOpen[1]) {
      fence = { char: fenceOpen[1][0] ?? '', len: fenceOpen[1].length };
      fenceLines = [line];
      continue;
    }
    out.push(maskInlineCode(line, addMask));
  }
  // フェンスが閉じないまま終了（不正な本文）: マスクせず原文のまま
  if (fenceLines !== null) {
    out.push(...fenceLines);
  }
  return { text: out.join('\n'), items };
}

/** 行内のインラインコードスパンをマスクする */
function maskInlineCode(line: string, addMask: (code: string) => string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i] ?? '';
    if (ch === '\\') {
      out += ch + (line[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (ch === '`') {
      const run = countRun(line, i, '`');
      const close = line.indexOf('`'.repeat(run), i + run);
      if (close === -1) {
        out += line.slice(i);
        break;
      }
      out += addMask(line.slice(i, close + run));
      i = close + run;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** コードマスクを元のコードへ戻す */
function unmaskCode(text: string, items: readonly CodeMaskItem[]): string {
  let out = text;
  for (const item of items) {
    out = out.split(item.marker).join(item.code);
  }
  return out;
}

/** コールアウトのマーカー行: `> [!type] タイトル` */
const CALL_OUT_MARKER_RE = /^\[!(\w+)\](?:\s+(.*))?$/;

/**
 * コールアウト（> [!note] など）のブロック拡張。
 * `> [!type] title` で始まる引用ブロックを専用トークンにし、コールアウト
 * UI に変換する。マーカーがない通常の引用は built-in の blockquote が担う。
 */
function createCalloutExtension(marked: Marked): TokenizerAndRendererExtension {
  return {
    name: 'callout',
    level: 'block',
    start(src: string): number | void {
      return src.startsWith('>') ? 0 : undefined;
    },
    tokenizer(src: string): Tokens.Generic | undefined {
      const lines = src.split('\n');
      const quoted: string[] = [];
      let index = 0;
      while (index < lines.length) {
        const match = /^ {0,3}> ?(.*)$/.exec(lines[index] ?? '');
        if (!match) {
          break;
        }
        quoted.push(match[1] ?? '');
        index += 1;
      }
      if (quoted.length === 0) {
        return undefined;
      }
      const marker = CALL_OUT_MARKER_RE.exec(quoted[0] ?? '');
      if (!marker) {
        return undefined;
      }
      let raw = lines.slice(0, index).join('\n');
      if (index < lines.length || src.endsWith('\n')) {
        raw += '\n';
      }
      return {
        type: 'callout',
        raw,
        calloutType: (marker[1] ?? '').toLowerCase(),
        title: (marker[2] ?? '').trim(),
        body: quoted.slice(1).join('\n'),
        tokens: [],
      };
    },
    renderer(token: Tokens.Generic): string {
      const callout = token as Token & { calloutType?: unknown; title?: unknown; body?: unknown };
      const type =
        typeof callout.calloutType === 'string' && callout.calloutType !== ''
          ? callout.calloutType
          : 'note';
      const title =
        typeof callout.title === 'string' && callout.title !== '' ? callout.title : type;
      const body = typeof callout.body === 'string' ? callout.body : '';
      return (
        `<div class="callout callout-${escapeHtml(type)}">` +
        `<div class="callout-title">${escapeHtml(title)}</div>` +
        `<div class="callout-body">${marked.parse(body)}</div></div>`
      );
    },
  };
}

/**
 * リーディング表示用の Marked インスタンス。
 * - heading: スラグ id を付与（重複は -2, -3… で区別）
 * - code: highlight.js によるハイライト（未登録言語はプレーン表示）
 * - checkbox: タスクリストのチェックボックス（クラス付与）
 * - callout: コールアウト拡張（インスタンス生成後に use() で追加する。
 *   拡張の renderer がインスタンス自身を参照するため）
 */
function createMarked(hljs: HLJSApi | null): Marked {
  const seenSlugs = new Map<string, number>();
  const renderer: RendererObject = {
    heading(token: Tokens.Heading): string {
      const base = slugify(token.text);
      const count = seenSlugs.get(base) ?? 0;
      seenSlugs.set(base, count + 1);
      const id = count === 0 ? base : `${base}-${count + 1}`;
      return `<h${token.depth} id="${escapeHtml(id)}">${this.parser.parseInline(token.tokens)}</h${token.depth}>`;
    },
    code(token: Tokens.Code): string {
      const language = (token.lang ?? '').trim().split(/\s+/)[0] ?? '';
      if (language !== '' && hljs !== null) {
        const highlighted = highlightCode(hljs, token.text, language);
        if (highlighted !== null) {
          return `<pre><code class="hljs language-${escapeHtml(language)}">${highlighted}</code></pre>`;
        }
      }
      const langAttr = language === '' ? '' : ` class="language-${escapeHtml(language)}"`;
      return `<pre><code${langAttr}>${token.escaped ? token.text : escapeHtml(token.text)}</code></pre>`;
    },
    checkbox(token: Tokens.Checkbox): string {
      return `<input class="task-list-checkbox" disabled="" type="checkbox"${token.checked ? ' checked=""' : ''}>`;
    },
  };

  const marked = new Marked({ gfm: true, renderer });
  marked.use({ extensions: [createCalloutExtension(marked)] });
  return marked;
}
