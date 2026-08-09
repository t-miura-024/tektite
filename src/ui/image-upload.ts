/**
 * 画像アップロードのブラウザ側ユーティリティ（M2）。
 * File → 標準 base64 変換と、クリップボード由来の画像ファイル名の正規化を担う。
 * アップロード本体（コミット・パス生成）は application 層の uploadImage が行う。
 */

/** File のバイナリを標準 base64（btoa 互換。コミット API の content と同じ規約）に変換する */
export async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/** ファイル名の拡張子を小文字で返す（ドット始まり・拡張子なしは null） */
export function fileExtension(fileName: string): string | null {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) {
    return null;
  }
  return fileName.slice(dot + 1).toLowerCase();
}

/**
 * アップロードに使うファイル名を正規化する。スクリーンショットのペーストなど
 * 名前を持たない画像は MIME タイプから拡張子を補う（image/png → image.png）。
 */
export function imageFileName(file: File): string {
  if (fileExtension(file.name) !== null) {
    return file.name;
  }
  const fromMime = file.type.match(/^image\/([A-Za-z0-9.+-]+)$/)?.[1];
  if (fromMime !== undefined && fromMime !== '') {
    return `image.${fromMime}`;
  }
  return 'image.png';
}
