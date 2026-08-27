import { githubApiFetch } from '@/api/_lib/github-proxy';

/** GitHub Blobs API の base64 本文を UTF-8 文字列に復号する */
export function decodeBase64Content(encoded: string): string {
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Blob 取得の最大試行回数（一時的な失敗はリトライで吸収する） */
const BLOB_FETCH_RETRIES = 3;

/**
 * Blob 1 件を取得して本文を返す（リトライ後も失敗・404・形式不正は null）。
 *
 * 初期同期で取得に失敗したノートを「欠落」させると、その後の同期 push が
 * 「R2 に無い = 削除」と誤認する事故（2026-08-16 の大量削除）につながる。
 * 一時的な失敗（ネットワーク断・レートリミットの突発的な発生）はリトライで
 * 吸収する。
 */
export async function fetchBlobContent(
  baseUrl: string,
  token: string,
  owner: string,
  repoName: string,
  sha: string,
): Promise<string | null> {
  for (let attempt = 1; attempt <= BLOB_FETCH_RETRIES; attempt += 1) {
    let response: Response;
    try {
      // oxlint-disable-next-line no-await-in-loop -- リトライを伴う逐次取得が意図のため
      response = await githubApiFetch(
        baseUrl,
        `/repos/${owner}/${repoName}/git/blobs/${encodeURIComponent(sha)}`,
        token,
      );
    } catch {
      if (attempt < BLOB_FETCH_RETRIES) {
        // oxlint-disable-next-line no-await-in-loop -- リトライ間隔のバックオフ待機のため
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        continue;
      }
      return null;
    }
    if (!response.ok) {
      if (attempt < BLOB_FETCH_RETRIES) {
        // oxlint-disable-next-line no-await-in-loop -- リトライ間隔のバックオフ待機のため
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        continue;
      }
      return null;
    }
    // oxlint-disable-next-line no-await-in-loop -- リトライを伴う逐次取得が意図のため
    const body: unknown = await response.json().catch(() => null);
    if (
      typeof body !== 'object' ||
      body === null ||
      !('encoding' in body) ||
      !('content' in body) ||
      body.encoding !== 'base64' ||
      typeof body.content !== 'string'
    ) {
      return null;
    }
    return decodeBase64Content(body.content);
  }
  return null;
}
