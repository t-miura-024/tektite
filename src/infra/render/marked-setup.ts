/**
 * リーディング表示用の Marked セットアップ。
 *
 * - heading: スラグ id を付与（重複は -2, -3… で区別）
 * - code: highlight.js によるハイライト（未登録言語はプレーン表示）
 * - checkbox: タスクリストのチェックボックス（クラス付与）
 * - callout: コールアウト拡張（`> [!note] title` → 専用ブロック）。
 *   tokenizer で作ったデータは renderer へ WeakMap 経由で渡す
 *   （marked の token 型は任意フィールドを any としてしか読めないため）
 */

import {
  Marked,
  type RendererObject,
  type TokenizerAndRendererExtension,
  type Tokens,
} from 'marked';
import type { HLJSApi } from 'highlight.js';

import { escapeHtml } from '@/infra/render/escape';
import { highlightCode } from '@/infra/render/highlight';
import { slugify } from '@/infra/render/slug';

/** コールアウトのマーカー行: `> [!type] タイトル` */
const CALL_OUT_MARKER_RE = /^\[!(\w+)\](?:\s+(.*))?$/;

/** コールアウト 1 件の描画データ（tokenizer → renderer の受け渡し用） */
type CalloutData = {
  readonly type: string;
  readonly title: string;
  readonly body: string;
};

/**
 * tokenizer が作った token と描画データの対応。
 * marked は同じ token インスタンスを renderer へ渡すため、参照で引ける。
 */
const calloutDataByToken = new WeakMap<object, CalloutData>();

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
      for (;;) {
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
      const type = (marker[1] ?? '').toLowerCase();
      const title = (marker[2] ?? '').trim();
      const resolvedType = type === '' ? 'note' : type;
      const callout: CalloutData = {
        type: resolvedType,
        title: title === '' ? resolvedType : title,
        body: quoted.slice(1).join('\n'),
      };
      const token: Tokens.Generic = {
        type: 'callout',
        raw,
        tokens: [],
      };
      calloutDataByToken.set(token, callout);
      return token;
    },
    renderer(token: Tokens.Generic): string {
      const fallback: CalloutData = { type: 'note', title: 'note', body: '' };
      const callout = calloutDataByToken.get(token) ?? fallback;
      return (
        `<div class="callout callout-${escapeHtml(callout.type)}">` +
        `<div class="callout-title">${escapeHtml(callout.title)}</div>` +
        `<div class="callout-body">${marked.parse(callout.body)}</div></div>`
      );
    },
  };
}

/**
 * リーディング表示用の Marked インスタンスを組み立てる。
 */
export function createMarked(hljs: HLJSApi | null): Marked {
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
