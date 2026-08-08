/**
 * HTML サニタイズ（DOMPurify）。
 *
 * リーディング表示の HTML はユーザーが書いた Markdown（raw HTML を含みうる）
 * 由来のため、DOM に注入する前に必ず通す。スクリプト・イベントハンドラ・
 * javascript: URL などを除去する。ブラウザ専用（DOM が必要なため、node の
 * テストからは呼ばない。テストは jsdom 環境の sanitize.test.ts で行う）。
 */

import DOMPurify from 'dompurify';

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html);
}
