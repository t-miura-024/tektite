/**
 * R2 上の Vault 実体ストレージ（M3: R2 読み取り経路と初期同期）。
 *
 * GitHub API のレート制限解消のため、Vault の実体（ツリー・ノート本文・
 * 添付バイナリ）を R2 バケット（VAULT_BUCKET）に保持し、読み取りは基本的に
 * R2 から返す。キー設計（AI 判断）:
 *
 * - `vaults/{owner}/{repo}/meta`           … 初期同期完了マーカー
 *   （JSON: { syncedAt, defaultBranch, treeSha }）。このキーの存在が
 *   「R2 が正」を有効にする前提であり、存在しない間は GitHub 直行する
 * - `vaults/{owner}/{repo}/tree`           … ファイルツリーのキャッシュ
 *   （JSON: { defaultBranch, truncated, treeSha, entries }）
 * - `vaults/{owner}/{repo}/notes/{path}`   … ノート本文 + sha（コンテンツハッシュ）
 *   （JSON: { sha, content }）。sha は GitHub の blob sha（コンテンツから
 *   決まるハッシュ）で、同期（M5）のツリー sha 比較と保存時の楽観ロックに使う
 * - `vaults/{owner}/{repo}/raw/{path}`     … 添付（画像等）のバイナリ
 *   （customMetadata.contentType に Content-Type を保持）
 * - `vaults/{owner}/{repo}/deleted/{path}` … ローカル削除の tombstone（空マーカー）
 *   同期済み Vault でファイル操作（files 一括コミットの delete / move）が削除を
 *   行ったときに記録される。R2 とツリーキャッシュの両方から消えたパスは
 *   「ローカル削除」か「GitHub 側新規追加」のどちらの可能性もあるため、
 *   同期（vault-sync.ts）はこのマーカーで区別する:
 *   - プル: tombstone があるパスは fetch しない（削除の巻き戻り防止）
 *   - プッシュ: tombstone があるパスは GitHub ツリーから削除する（削除の反映）
 *   同期の完了（衝突なし）でクリアされる
 *
 * 書き込みは初期同期（sync ルート）・遅延キャッシュ（tree/notes/raw ルート）・
 * 保存（notes blob PUT / files 一括コミット、M4 の R2 先行化）が行う。
 * 保存後の sha はコンテンツハッシュ（SHA-256、content-hash.ts）で、GitHub への
 * push は同期時（M5）のみ。定時同期は meta.treeSha と GitHub のツリー sha を
 * 比較して差分を取る。
 */

/** 初期同期完了マーカー（vaults/{owner}/{repo}/meta の内容） */
export interface VaultMeta {
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
}

/** ツリー応答のエントリ 1 件（/api/tree と同じ形式 + 同期用の blob sha） */
export interface VaultTreeEntry {
  readonly path: string;
  readonly type: 'file' | 'directory';
  /**
   * 同期時点（初期同期・同期・遅延キャッシュ）の GitHub blob sha。
   * 同期（M5）の衝突判定と push 差分検出で「GitHub 由来のファイルか・
   * ローカル追加のファイルか」の区別に使う。ローカルで追加された
   * ファイル（applyVaultTreeChanges 経由）は null。
   */
  readonly sha: string | null;
}

/** vaults/{owner}/{repo}/tree の内容 */
export interface CachedVaultTree {
  readonly defaultBranch: string;
  readonly truncated: boolean;
  readonly treeSha: string | null;
  readonly entries: readonly VaultTreeEntry[];
}

/** vaults/{owner}/{repo}/notes/{path} の内容（コンテンツハッシュ + 本文） */
export interface CachedNote {
  readonly sha: string;
  readonly content: string;
}

/** vaults/{owner}/{repo}/raw/{path} の読み取り結果 */
export interface CachedRaw {
  readonly body: ArrayBuffer;
  readonly contentType: string;
}

/** ノート一覧（/api/notes/all 用）の 1 件 */
export interface CachedNoteRef {
  readonly path: string;
  readonly note: CachedNote;
}

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

export function vaultRawKey(owner: string, repo: string, rawPath: string): string {
  return `vaults/${owner}/${repo}/raw/${rawPath}`;
}

/** ローカル削除の tombstone キー（vaults/{owner}/{repo}/deleted/{path}） */
export function vaultDeletedKey(owner: string, repo: string, path: string): string {
  return `vaults/${owner}/${repo}/deleted/${path}`;
}

/** R2 オブジェクトの JSON を安全にパースする（破損・形式不正は null） */
async function readJsonObject(
  bucket: R2Bucket,
  key: string,
): Promise<Record<string, unknown> | null> {
  const object = await bucket.get(key);
  if (object === null) {
    return null;
  }
  const parsed = await object.json().catch(() => null);
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function readVaultMeta(
  bucket: R2Bucket,
  owner: string,
  repo: string,
): Promise<VaultMeta | null> {
  const parsed = await readJsonObject(bucket, vaultMetaKey(owner, repo));
  if (parsed === null) {
    return null;
  }
  const syncedAt = readOptionalString(parsed.syncedAt);
  const defaultBranch = readOptionalString(parsed.defaultBranch);
  if (syncedAt === null || defaultBranch === null) {
    return null;
  }
  return {
    syncedAt,
    defaultBranch,
    treeSha: readOptionalString(parsed.treeSha),
    lastSyncError: readOptionalString(parsed.lastSyncError),
    lastFailedAt: readOptionalString(parsed.lastFailedAt),
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
  const parsed = await readJsonObject(bucket, vaultTreeKey(owner, repo));
  if (parsed === null || !Array.isArray(parsed.entries)) {
    return null;
  }
  const defaultBranch = readOptionalString(parsed.defaultBranch);
  if (defaultBranch === null) {
    return null;
  }
  const entries: VaultTreeEntry[] = [];
  for (const item of parsed.entries) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const entry = item as Record<string, unknown>;
    const path = readOptionalString(entry.path);
    if (path === null) {
      continue;
    }
    if (entry.type === 'file' || entry.type === 'directory') {
      entries.push({ path, type: entry.type, sha: readOptionalString(entry.sha) });
    }
  }
  return {
    defaultBranch,
    truncated: parsed.truncated === true,
    treeSha: readOptionalString(parsed.treeSha),
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
  const parsed = await readJsonObject(bucket, vaultNoteKey(owner, repo, notePath));
  if (parsed === null) {
    return null;
  }
  const sha = readOptionalString(parsed.sha);
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
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- R2 list のページング（truncated 時のみ続行）のため
    const listed = await bucket.list({
      prefix,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const object of listed.objects) {
      const notePath = object.key.slice(prefix.length);
      if (notePath.length === 0) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- ページ内のオブジェクトを 1 件ずつ読み出す（R2 一覧の走査）ため
      const stored = await readJsonObject(bucket, object.key);
      if (stored === null) {
        continue;
      }
      const sha = readOptionalString(stored.sha);
      if (sha === null || typeof stored.content !== 'string') {
        continue;
      }
      notes.push({ path: notePath, note: { sha, content: stored.content } });
    }
    // oxlint-disable-next-line no-await-in-loop -- R2 list のページング（truncated 時のみ続行）のため
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  return notes;
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
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- R2 list のページング（truncated 時のみ続行）のため
    const listed = await bucket.list({
      prefix,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const object of listed.objects) {
      const rawPath = object.key.slice(prefix.length);
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
    // oxlint-disable-next-line no-await-in-loop -- R2 list のページング（truncated 時のみ続行）のため
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  return raws;
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
  const contentType =
    typeof object.customMetadata?.contentType === 'string' &&
    object.customMetadata.contentType.length > 0
      ? object.customMetadata.contentType
      : 'application/octet-stream';
  return { body, contentType };
}

export async function writeCachedRaw(
  bucket: R2Bucket,
  owner: string,
  repo: string,
  rawPath: string,
  body: ArrayBuffer,
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
 * ローカル削除の tombstone を記録する（M4 の files 一括コミットの delete / move
 * が削除したパスに対して呼ぶ）。
 *
 * R2 のノート/添付とツリーキャッシュの両方から消えたパスは、次回同期のプルで
 * 「GitHub ツリーにあり R2 に無い」状態になり、無条件 fetch だと削除が巻き戻る。
 * tombstone はこのパスが「ローカル削除（push 待ち）」であることを記録し、
 * 同期（vault-sync.ts）のプルで fetch を抑止し、プッシュで GitHub ツリーから
 * 削除する材料になる（完了後にクリアされる）。
 */
export async function markVaultDeleted(
  bucket: R2Bucket,
  owner: string,
  repo: string,
  path: string,
): Promise<void> {
  await bucket.put(vaultDeletedKey(owner, repo, path), '');
}

/** ローカル削除の tombstone が記録されているか（同期プルの復活防止に使う） */
export async function isVaultDeleted(
  bucket: R2Bucket,
  owner: string,
  repo: string,
  path: string,
): Promise<boolean> {
  return (await bucket.get(vaultDeletedKey(owner, repo, path))) !== null;
}

/** ローカル削除の tombstone を消す（同期のプッシュ反映後に呼ぶ） */
export async function clearVaultDeleted(
  bucket: R2Bucket,
  owner: string,
  repo: string,
  path: string,
): Promise<void> {
  await bucket.delete(vaultDeletedKey(owner, repo, path));
}

/**
 * 同期済み Vault の全 tombstone パスを列挙する（同期プッシュの削除検出用）。
 * ローカルで追加・削除を繰り返したパスの tombstone も含めて返す。
 */
export async function listVaultDeleted(
  bucket: R2Bucket,
  owner: string,
  repo: string,
): Promise<readonly string[]> {
  const prefix = `vaults/${owner}/${repo}/deleted/`;
  const paths: string[] = [];
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- R2 list のページング（truncated 時のみ続行）のため
    const listed = await bucket.list({
      prefix,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const object of listed.objects) {
      const path = object.key.slice(prefix.length);
      if (path.length > 0) {
        paths.push(path);
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- R2 list のページング（truncated 時のみ続行）のため
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  return paths;
}

/** ツリーキャッシュへの変更 1 件（ファイル操作の R2 反映で使う） */
export interface VaultTreeChange {
  readonly op: 'add' | 'remove';
  readonly path: string;
}

/** パスの祖先ディレクトリパスをルート側から順に返す（a/b/c.md → ['a', 'a/b']） */
function ancestorPaths(path: string): readonly string[] {
  const segments = path.split('/');
  const ancestors: string[] = [];
  for (let depth = 1; depth < segments.length; depth += 1) {
    ancestors.push(segments.slice(0, depth).join('/'));
  }
  return ancestors;
}

/**
 * ツリーキャッシュへファイル操作の結果を反映する（M4: 一括コミットの R2 先行化）。
 *
 * - ファイルエントリは add / remove を適用する（既存のファイルは保持する。
 *   遅延キャッシュ前の GitHub 由来エントリを失わないため）
 * - ディレクトリエントリはファイルパスの祖先から再構成する（移動・削除後の
 *   空ディレクトリがツリーに残らないようにする）
 * - ツリーが未キャッシュ（初期同期前）の Vault は何もしない
 * - ローカルで追加されたファイル（sha 未指定）は sha: null で追加し、
 *   既にエントリがあるパスは既存の sha を保持する（M5 の同期が「ローカル
 *   追加 vs GitHub 由来」を区別する材料にする）
 */
export async function applyVaultTreeChanges(
  bucket: R2Bucket,
  owner: string,
  repo: string,
  changes: readonly VaultTreeChange[],
): Promise<void> {
  const tree = await readVaultTree(bucket, owner, repo);
  if (tree === null) {
    return;
  }
  const fileShas = new Map(
    tree.entries.filter((entry) => entry.type === 'file').map((entry) => [entry.path, entry.sha]),
  );
  for (const change of changes) {
    if (change.op === 'add') {
      if (!fileShas.has(change.path)) {
        // ローカルで新規追加されたファイル（GitHub 由来の blob sha は未知）
        fileShas.set(change.path, null);
      }
    } else {
      fileShas.delete(change.path);
    }
  }
  const directories = new Set<string>();
  for (const path of fileShas.keys()) {
    for (const ancestor of ancestorPaths(path)) {
      directories.add(ancestor);
    }
  }
  const entries: VaultTreeEntry[] = [
    ...[...fileShas.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([path, sha]) => ({
        path,
        type: 'file' as const,
        sha,
      })),
    ...[...directories].toSorted().map((path) => ({
      path,
      type: 'directory' as const,
      sha: null,
    })),
  ];
  await writeVaultTree(bucket, owner, repo, { ...tree, entries });
}
