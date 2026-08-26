/**
 * R2 上の添付（raw）ストレージ。
 *
 * `vaults/{owner}/{repo}/raw/{path}` にバイナリを保存する
 * （customMetadata.contentType に Content-Type を保持）。
 * キー設計と全体像は r2-vault.ts のドキュメントを参照。
 */

import { listAllR2Keys } from '@/api/_lib/r2-list';

/** vaults/{owner}/{repo}/raw/{path} の読み取り結果 */
export type CachedRaw = {
  readonly body: ArrayBuffer;
  readonly contentType: string;
};

export function vaultRawKey(owner: string, repo: string, rawPath: string): string {
  return `vaults/${owner}/${repo}/raw/${rawPath}`;
}

export async function readCachedRaw(
  bucket: R2Bucket,
  owner: string,
  repo: string,
  rawPath: string,
): Promise<CachedRaw | null> {
  const object = await bucket.get(vaultRawKey(owner, repo, rawPath));
  if (object === null) {
    return null;
  }
  const body = await object.arrayBuffer().catch(() => null);
  if (body === null) {
    return null;
  }
  const metadataContentType = object.customMetadata?.contentType;
  const contentType =
    typeof metadataContentType === 'string' && metadataContentType.length > 0
      ? metadataContentType
      : 'application/octet-stream';
  return { body, contentType };
}

export async function writeCachedRaw(
  bucket: R2Bucket,
  owner: string,
  repo: string,
  rawPath: string,
  body: ArrayBuffer | ArrayBufferView,
  contentType: string,
): Promise<void> {
  await bucket.put(vaultRawKey(owner, repo, rawPath), body, {
    customMetadata: { contentType },
  });
}

/** R2 から添付を削除する（存在しない場合は何もしない） */
export async function deleteCachedRaw(
  bucket: R2Bucket,
  owner: string,
  repo: string,
  rawPath: string,
): Promise<void> {
  await bucket.delete(vaultRawKey(owner, repo, rawPath));
}

/**
 * 同期済み Vault の全添付を R2 から列挙する（M5 の同期 push 用）。
 * 本文は body（ArrayBuffer）で返し、破損・形式不正は 1 件ずつスキップする。
 */
export async function listCachedRaws(
  bucket: R2Bucket,
  owner: string,
  repo: string,
): Promise<readonly { path: string; raw: CachedRaw }[]> {
  const prefix = `vaults/${owner}/${repo}/raw/`;
  const raws: { path: string; raw: CachedRaw }[] = [];
  for (const key of await listAllR2Keys(bucket, prefix)) {
    const rawPath = key.slice(prefix.length);
    if (rawPath.length === 0) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- 添付の読み出し（ページ内の順次処理）のため
    const stored = await readCachedRaw(bucket, owner, repo, rawPath);
    if (stored === null) {
      continue;
    }
    raws.push({ path: rawPath, raw: stored });
  }
  return raws;
}
