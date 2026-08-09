/**
 * HTML エスケープ（marked が v18 で escape を公開しなくなったため自前実装）。
 *
 * リーディング表示の出力はすべてユーザー入力（Markdown 本文）由来のため、
 * テキストは `< > &`、属性値はさらに `" '` をエスケープする。
 * 最終的なサニタイズは DOMPurify（src/infra/render/sanitize）が担う。
 */

export function escapeHtml(text: string, attribute = false): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (!attribute) {
    return escaped;
  }
  return escaped.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
