/**
 * 同期のための GitHub API 読み取りヘルパー（ツリー / blob）。
 *
 * 同期（vault-sync.ts）のプル・衝突解決から使う。GitHub 到達不能・
 * レートリミットは SyncFailureReason 付きのエラー応答に変換する。
 */

import { githubApiFetch, githubUnreachable, mapGithubFailure } from '@/api/_lib/github-proxy';
import { readJsonBody, readStringField } from '@/api/_lib/github-json';

/** 同期の失敗理由（定時同期の Vault 単位の記録に使う） */
export type SyncFailureReason =
  | 'rate_limited'
  | 'github_unreachable'
  | 'github_error'
  | 'sync_conflict'
  | 'invalid_vault'
  | 'kv_missing'
  | 'no_token'
  | 'refresh_failed'
  | 'too_many_deletes';

/** GitHub API の読み取り失敗（完成済みエラー応答を伴う） */
export type GithubReadFailure = {
  readonly ok: false;
  readonly reason: SyncFailureReason;
  readonly response: Response;
};

/** GitHub Blobs API の base64 本文を UTF-8 文字列に復号する */
export function decodeBase64Content(encoded: string): string {
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** UTF-8 テキストを標準 base64（btoa 出力相当）にエンコードする（GitHub Blobs API 用） */
export function encodeBase64Content(content: string): string {
  const bytes = new TextEncoder().encode(content);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** base64 文字列をバイト列に復号する（添付バイナリ用） */
export function decodeBase64Bytes(encoded: string): Uint8Array {
  return Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
}

/** バイト列を標準 base64 にエンコードする（添付の GitHub Blobs API 用） */
export function encodeBase64Bytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * GitHub ツリー取得（recursive）。コミット 0 件の空リポジトリはツリーが無い
 * ため、treeSha: null + 空マップとして成功扱いする。
 */
export async function fetchGithubTree(
  baseUrl: string,
  token: string,
  owner: string,
  repoName: string,
  branch: string,
): Promise<
  | { readonly ok: true; readonly treeSha: string | null; readonly ghMap: Map<string, string> }
  | GithubReadFailure
> {
  let response: Response;
  try {
    response = await githubApiFetch(
      baseUrl,
      `/repos/${owner}/${repoName}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      token,
    );
  } catch {
    return { ok: false, reason: 'github_unreachable', response: githubUnreachable() };
  }
  if (response.status === 404) {
    // コミット 0 件の空リポジトリはツリーが無い（空ツリーとして扱う）
    return { ok: true, treeSha: null, ghMap: new Map() };
  }
  if (!response.ok) {
    const failure = mapGithubFailure(response);
    const reason: SyncFailureReason =
      failure !== null && failure.status === 429 ? 'rate_limited' : 'github_error';
    return {
      ok: false,
      reason,
      response: failure ?? Response.json({ error: 'github_error' }, { status: 502 }),
    };
  }
  const body: unknown = await readJsonBody(response);
  const entries = readStringEntries(body);
  if (entries === null) {
    return {
      ok: false,
      reason: 'github_error',
      response: Response.json({ error: 'github_error' }, { status: 502 }),
    };
  }
  const ghMap = new Map<string, string>();
  for (const entry of entries) {
    collectBlobSha(entry, ghMap);
  }
  const treeSha = readStringField(body, 'sha');
  return { ok: true, treeSha: treeSha === null || treeSha.length === 0 ? null : treeSha, ghMap };
}

type UnknownRecord = Record<string, unknown>;

function isRecordObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

/** ツリー応答から blob エントリ列を読む（形式不正は null） */
function readStringEntries(body: unknown): UnknownRecord[] | null {
  if (!isRecordObject(body)) {
    return null;
  }
  const tree = body.tree;
  if (!Array.isArray(tree)) {
    return null;
  }
  const entries: UnknownRecord[] = [];
  for (const item of tree) {
    if (isRecordObject(item)) {
      entries.push(item);
    }
  }
  return entries;
}

/** blob エントリ（path / sha が文字列）をパス → sha マップへ登録する */
function collectBlobSha(entry: UnknownRecord, ghMap: Map<string, string>): void {
  const path = entry.path;
  const sha = entry.sha;
  if (
    entry.type !== 'blob' ||
    typeof path !== 'string' ||
    typeof sha !== 'string' ||
    sha.length === 0
  ) {
    return;
  }
  ghMap.set(path, sha);
}

/** Blob 1 件を取得して本文を返す（失敗は null。1 ノートの失敗が同期全体を落とさない） */
export async function fetchBlobContent(
  baseUrl: string,
  token: string,
  owner: string,
  repoName: string,
  sha: string,
): Promise<string | null> {
  let response: Response;
  try {
    response = await githubApiFetch(
      baseUrl,
      `/repos/${owner}/${repoName}/git/blobs/${encodeURIComponent(sha)}`,
      token,
    );
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  const body: unknown = await readJsonBody(response);
  if (!isRecordObject(body) || body.encoding !== 'base64' || typeof body.content !== 'string') {
    return null;
  }
  return decodeBase64Content(body.content);
}
