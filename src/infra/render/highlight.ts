/**
 * コードハイライト（highlight.js）。
 *
 * 初回レンダリング時に動的 import し、以後はキャッシュする。読み込みに失敗
 * した場合（オフライン等）はハイライトなしのプレーン表示に落ちる。
 * highlight.js/lib/common は core + 主要言語一式で、バンドル分割により
 * リーディング表示を開いたときにだけ読み込まれる（バンドルサイズ配慮）。
 */

import type { HLJSApi } from 'highlight.js';

let highlightPromise: Promise<HLJSApi | null> | null = null;

/** highlight.js を動的 import する（初回のみ。失敗時は null でキャッシュ） */
export function loadHighlight(): Promise<HLJSApi | null> {
  highlightPromise ??= import('highlight.js/lib/common')
    .then((mod) => mod.default)
    .catch(() => null);
  return highlightPromise;
}

/**
 * 言語指定付きコードをハイライトする。
 * 言語が未登録・ハイライト不能の場合は null（呼び出し側がプレーン表示に落とす）。
 */
export function highlightCode(hljs: HLJSApi, code: string, language: string): string | null {
  if (!hljs.getLanguage(language)) {
    return null;
  }
  try {
    return hljs.highlight(code, { language }).value;
  } catch {
    return null;
  }
}
