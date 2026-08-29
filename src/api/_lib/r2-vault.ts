/**
 * R2 上の Vault 実体ストレージ（M3: R2 読み取り経路と初期同期）。
 *
 * GitHub API のレート制限解消のため、Vault の実体（ツリー・ノート本文）を
 * R2 バケット（VAULT_BUCKET）に保持し、読み取りは基本的に R2 から返す。
 * キー設計（AI 判断）:
 *
 * - `vaults/{owner}/{repo}/meta`           … 初期同期完了マーカー
 *   （JSON: { syncedAt, defaultBranch, treeSha }）。このキーの存在が
 *   「R2 が正」を有効にする前提であり、存在しない間は GitHub 直行する
 * - `vaults/{owner}/{repo}/tree`           … ファイルツリーのキャッシュ
 *   （JSON: { defaultBranch, truncated, treeSha, entries }）
 * - `vaults/{owner}/{repo}/notes/{path}`   … ノート本文 + sha（コンテンツハッシュ）
 *   （JSON: { sha, content }）。sha は GitHub の blob sha（コンテンツから
 *   決まるハッシュ）で、同期（M5）のツリー sha 比較と保存時の楽観ロックに使う
 *
 * 添付バイナリ（raw/{path}）とローカル変更マーカー（deleted / dirty）は
 * r2-vault-assets / r2-vault-marks が担う。共通走査は r2-list。
 *
 * 書き込みは初期同期（sync ルート）・遅延キャッシュ（tree/notes/raw ルート）・
 * 保存（notes blob PUT / files 一括コミット、M4 の R2 先行化）が行う。
 * 保存後の sha はコンテンツハッシュ（SHA-256、content-hash.ts）で、GitHub への
 * push は同期時（M5）のみ。定時同期は meta.treeSha と GitHub のツリー sha を
 * 比較して差分を取る。
 */

import {
  isR2Record,
  listAllR2Keys,
  readNonEmptyString,
  readR2JsonObject,
} from '@/api/_lib/r2-list';

/** 初期同期完了マーカー（vaults/{owner}/{repo}/meta の内容） */
export type VaultMeta = {
  /** 初期同期（または同期）が完了した日時（ISO 8601） */
  readonly syncedAt: string;
  /** 同期対象のデフォルトブランチ名 */
  readonly defaultBranch: string;
  /** 同期時点の GitHub ツリー sha（M5 の差分同期で比較に使う）。空リポジトリは null */
  readonly treeSha: string | null;
  /** 直近の同期失敗理由（定時同期の Vault 単位の失敗記録。成功時は null） */
  readonly lastSyncError: string | null;
  /** 直近の同期失敗日時（ISO 8601。失敗していない場合は null） */
  readonly lastFailedAt: string | null;
};

/** ツリー応答のエントリ 1 件（/api/tree と同じ形式 + 同期用の blob sha） */
export type VaultTreeEntry = {
  readonly path: string;
  readonly type: 'file' | 'directory';
  /**
   * 同期時点（初期同期・同期・遅延キャッシュ）の GitHub blob sha。
   * 同期（M5）の衝突判定と push 差分検出で「GitHub 由来のファイルか・
   * ローカル追加のファイルか」の区別に使う。ローカルで追加された
   * ファイル（applyVaultTreeChanges 経由）は null。
   */
  readonly sha: string | null;
};

/** vaults/{owner}/{repo}/tree の内容 */
export type CachedVaultTree = {
  readonly defaultBranch: string;
  readonly truncated: boolean;
  readonly treeSha: string | null;
  readonly entries: readonly VaultTreeEntry[];
};

/** vaults/{owner}/{repo}/notes/{path} の内容（コンテンツハッシュ + 本文） */
export type CachedNote = {
  readonly sha: string;
  readonly content: string;
};

/** ノート一覧（/api/notes/all 用）の 1 件 */
export type CachedNoteRef = {
  readonly path: string;
  readonly note: CachedNote;
};

/** Vault の R2 キー（owner/repo は isValidGitHubName 済みの前提） */
export function vaultMetaKey(owner: string, repo: string): string {
  return `vaults/${owner}/${repo}/meta`;
}

export function vaultTreeKey(owner: string, repo: string): string {
  return `vaults/${owner}/${repo}/tree`;
}

export function vaultNoteKey(owner: string, repo: string, notePath: string): string {
  return `vaults/${owner}/${repo}/notes/${notePath}`;
}

export async function readVaultMeta(
  bucket: R2Bucket,
  owner: string,
  repo: string,
): Promise<VaultMeta | null> {
  const parsed = await readR2JsonObject(bucket, vaultMetaKey(owner, repo));
  if (parsed === null) {
    return null;
  }
  const syncedAt = readNonEmptyString(parsed.syncedAt);
  const defaultBranch = readNonEmptyString(parsed.defaultBranch);
  if (syncedAt === null || defaultBranch === null) {
    return null;
  }
  return {
    syncedAt,
    defaultBranch,
    treeSha: readNonEmptyString(parsed.treeSha),
    lastSyncError: readNonEmptyString(parsed.lastSyncError),
    lastFailedAt: readNonEmptyString(parsed.lastFailedAt),
  };
}

/** writeVaultMeta の入力（失敗記録は省略可。省略時は null で保存される） */
export type VaultMetaInput = Omit<VaultMeta, 'lastSyncError' | 'lastFailedAt'> & {
  readonly lastSyncError?: string | null;
  readonly lastFailedAt?: string | null;
};

export async function writeVaultMeta(
  bucket: R2Bucket,
  owner: string,
  repo: string,
  meta: VaultMetaInput,
): Promise<void> {
  await bucket.put(
    vaultMetaKey(owner, repo),
    JSON.stringify({
      syncedAt: meta.syncedAt,
      defaultBranch: meta.defaultBranch,
      treeSha: meta.treeSha,
      lastSyncError: meta.lastSyncError ?? null,
      lastFailedAt: meta.lastFailedAt ?? null,
    }),
  );
}

export async function readVaultTree(
  bucket: R2Bucket,
  owner: string,
  repo: string,
): Promise<CachedVaultTree | null> {
  const parsed = await readR2JsonObject(bucket, vaultTreeKey(owner, repo));
  if (parsed === null || !Array.isArray(parsed.entries)) {
    return null;
  }
  const defaultBranch = readNonEmptyString(parsed.defaultBranch);
  if (defaultBranch === null) {
    return null;
  }
  const entries: VaultTreeEntry[] = [];
  for (const item of parsed.entries) {
    if (!isR2Record(item)) {
      continue;
    }
    const path = readNonEmptyString(item.path);
    if (path === null) {
      continue;
    }
    if (item.type === 'file' || item.type === 'directory') {
      entries.push({ path, type: item.type, sha: readNonEmptyString(item.sha) });
    }
  }
  return {
    defaultBranch,
    truncated: parsed.truncated === true,
    treeSha: readNonEmptyString(parsed.treeSha),
    entries,
  };
}

/** writeVaultTree の入力（entries の sha は省略可。省略時は null で保存される） */
export type VaultTreeEntryInput = Omit<VaultTreeEntry, 'sha'> & {
  readonly sha?: string | null;
};

export type CachedVaultTreeInput = Omit<CachedVaultTree, 'entries'> & {
  readonly entries: readonly (VaultTreeEntry | VaultTreeEntryInput)[];
};

export async function writeVaultTree(
  bucket: R2Bucket,
  owner: string,
  repo: string,
  tree: CachedVaultTreeInput,
): Promise<void> {
  await bucket.put(
    vaultTreeKey(owner, repo),
    JSON.stringify({
      ...tree,
      entries: tree.entries.map((entry) => ({
        path: entry.path,
        type: entry.type,
        sha: entry.sha ?? null,
      })),
    }),
  );
}

export async function readCachedNote(
  bucket: R2Bucket,
  owner: string,
  repo: string,
  notePath: string,
): Promise<CachedNote | null> {
  const parsed = await readR2JsonObject(bucket, vaultNoteKey(owner, repo, notePath));
  if (parsed === null) {
    return null;
  }
  const sha = readNonEmptyString(parsed.sha);
  if (sha === null || typeof parsed.content !== 'string') {
    return null;
  }
  return { sha, content: parsed.content };
}

export async function writeCachedNote(
  bucket: R2Bucket,
  owner: string,
  repo: string,
  notePath: string,
  note: CachedNote,
): Promise<void> {
  await bucket.put(vaultNoteKey(owner, repo, notePath), JSON.stringify(note));
}

/** R2 からノートを削除する（存在しない場合は何もしない） */
export async function deleteCachedNote(
  bucket: R2Bucket,
  owner: string,
  repo: string,
  notePath: string,
): Promise<void> {
  await bucket.delete(vaultNoteKey(owner, repo, notePath));
}

/**
 * 同期済み Vault の全ノートを R2 から列挙する（/api/notes/all 用）。
 * オブジェクトの破損・形式不正は 1 件ずつスキップする（個別 GET と同じ寛容さ）。
 */
export async function listCachedNotes(
  bucket: R2Bucket,
  owner: string,
  repo: string,
): Promise<readonly CachedNoteRef[]> {
  const prefix = `vaults/${owner}/${repo}/notes/`;
  const notes: CachedNoteRef[] = [];
  for (const key of await listAllR2Keys(bucket, prefix)) {
    const notePath = key.slice(prefix.length);
    if (notePath.length === 0) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- R2 一覧の走査（オブジェクトを 1 件ずつ読み出す）ため
    const stored = await readR2JsonObject(bucket, key);
    if (stored === null) {
      continue;
    }
    const sha = readNonEmptyString(stored.sha);
    if (sha === null || typeof stored.content !== 'string') {
      continue;
    }
    notes.push({ path: notePath, note: { sha, content: stored.content } });
  }
  return notes;
}

/**
 * 同期済み Vault の既存ノート path の集合を返す（合成キーを読まず path だけ列挙）。
 *
 * 同期の差分判定で「R2 にまだ取り込まれていないノート」を効率よく見つけるために
 * 使う（本文を読みたければ個別に readCachedNote する）。「R2 に無い = 削除」という
 * 推論には使わない（削除は tombstone のみを根拠にする。2026-08-16 の事故の教訓）。
 */
export async function listCachedNotePaths(
  bucket: R2Bucket,
  owner: string,
  repo: string,
): Promise<ReadonlySet<string>> {
  const prefix = `vaults/${owner}/${repo}/notes/`;
  const paths = new Set<string>();
  for (const key of await listAllR2Keys(bucket, prefix)) {
    const notePath = key.slice(prefix.length);
    if (notePath.length > 0) {
      paths.add(notePath);
    }
  }
  return paths;
}
