/**
 * プレースホルダー（私用領域の文字）を実 HTML へ置換するヘルパー。
 */

/** プレースホルダーを実 HTML に置換する（marker は正規表現に使わない） */
export function substituteMarker(
  html: string,
  marker: string,
  replacement: string,
  block: boolean,
): string {
  if (block) {
    // ブロック要素は Markdown パーサーが <p> で包むため、<p> ごと置き換える
    const wrapped = `<p>${marker}</p>`;
    if (html.includes(wrapped)) {
      return html.replace(wrapped, replacement);
    }
  }
  return html.split(marker).join(replacement);
}

/** 番号付きプレースホルダー（mathPlaceholder(i) など）を replacements で置換する */
export function substituteByIndex(
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
