/**
 * 見出しアンカー用スラグの生成。
 *
 * リーディング表示の heading id と、WikiLink の `#見出し` 遷移先の両方で同じ
 * 関数を使う（両者が一致しないと見出しリンクが機能しないため）。
 *
 * 規則: 小文字化 → 英数字・`_`・`-` 以外の連続を `-` に置換 → `-` の連続を
 * 1 つに畳む → 前後の `-` を除去。空になる場合は 'section' を返す
 * （全記号の見出しなど。アンカーが空にならないためのフォールバック）。
 */

export function slugify(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug === '' ? 'section' : slug;
}
