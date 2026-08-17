/**
 * Vault 同期（M5: 定時 + 明示同期の共通ロジック）。
 *
 * プル (GitHub → R2) とプッシュ (R2 → GitHub) の両方向を 1 回の処理で行う。
 * 定時同期（Worker の scheduled ハンドラ）と明示同期（POST /sync）の両方から
 * 呼ばれる（完了条件 4）。
 *
 * プル（ツリー sha 比較による差分取得）:
 * - GitHub のツリー（recursive）を取得し、meta.treeSha と比較する
 * - ツリーが同じなら変更なし（GitHub API はツリー 1 回だけ）
 * - 変わっていれば、R2 のノートを 1 件ずつ「同一判定」で比較する
 *   （同一判定は sha 文字列比較ではなく本文の git blob sha との照合。M4 の
 *    unresolvedIssues: R2 の sha は GitHub blob sha と保存由来の SHA-256 が
 *    混在するため）
 * - GitHub 側で追加・変更された .md だけ blob を取得して R2 へ反映し、
 *   GitHub 側で削除された .md は R2 から削除する（添付は遅延キャッシュ任せ）
 * - ローカル削除（tombstone: `deleted/{path}`）のあるパスは fetch しない
 *   （R2 とツリーキャッシュの両方から消えたパスは「ローカル削除」か
 *   「GitHub 側新規追加」のどちらの可能性もあるため、tombstone で区別する）
 * - 衝突（GitHub 側の変更と R2 側のローカル保存が同一 Note で重なる）は
 *   保留し、conflicts として返す（明示同期は差分表示 + 上書き/取り込みで
 *   解決。定時同期はユーザー不在のため Vault 単位で失敗として中断する）
 *
 * プッシュ（未反映の変更を 1 コミットに束ねる）:
 * - R2 のノート・添付と GitHub ツリーを比較し、差分を Git Blobs → Trees →
 *   Commits → refs（github-commit.ts の commitChangesToGitHub）で 1 コミットに
 *   束ねて反映する
 * - 衝突保留中のノートはプッシュ対象から除外する（解決後に同期される）
 * - 「GitHub ツリーに無いが前回同期時点に存在した」（= GitHub 側で削除された）
 *   ファイルは復活させない（スキップ）
 * - 削除の反映は tombstone（ファイル操作の delete / move が記録する明示的な
 *   ローカル削除マーカー）のみを根拠にする。状態からの推論（「R2 に無い =
 *   削除」）は 2026-08-16 の大量削除事故を招いたため廃止した
 * - 1 回の push の削除件数は上限（MAX_SYNC_DELETIONS）でガードし、超過時は
 *   意図しない大量削除の可能性があるため同期を中断する
 *
 * 結果:
 * - 成功: ツリーキャッシュと meta（syncedAt / treeSha）を更新し、
 *   lastSyncError をクリアする。ローカル削除の tombstone もクリアする
 *   （反映済み・GitHub 側でも存在しないため、以降の同期で復活しない）
 * - 衝突あり（明示）: 非衝突分は反映・プッシュし、conflicts を返す。
 *   meta / ツリーキャッシュは更新しない（解決後の同期で整合が取れるまで
 *   前回同期時点の状態を保つ。tombstone も保持し、解決後の同期で反映する）
 * - 衝突あり（定時）: 何も変更せず sync_conflict で中断する（呼び出し側が
 *   meta.lastSyncError に記録し、次回同期で自動リトライされる）
 */

import { githubApiFetch, githubUnreachable, mapGithubFailure } from '@/api/_lib/github-proxy';
import { commitChangesToGitHub } from '@/api/_lib/github-commit';
import type { ParsedChange } from '@/api/_lib/github-commit';
import { sha256Hex } from '@/api/_lib/content-hash';
import {
  applyVaultTreeChanges,
  clearVaultDeleted,
  clearVaultDirty,
  deleteCachedNote,
  listCachedNotePaths,
  listVaultDeleted,
  listVaultDirty,
  readCachedNote,
  readCachedRaw,
  readVaultMeta,
  readVaultTree,
  writeCachedNote,
  writeVaultMeta,
  writeVaultTree,
} from '@/api/_lib/r2-vault';
import type { CachedVaultTree, VaultMeta } from '@/api/_lib/r2-vault';

/** ノート（Markdown）かどうか。同期のプルはノートのみを対象にする（添付は遅延キャッシュ） */
function isNotePath(path: string): boolean {
  return path.endsWith('.md');
}

/**
 * 本文の Git blob sha（SHA-1 of "blob {len}\0{content}"）を 16 進で返す。
 * GitHub の Trees/Blobs API が返す sha と同じ値になる。同期の「同一判定」は
 * この値と GitHub ツリーの sha を照合することで、R2 に保存由来の SHA-256 が
 * 混在しても本文ベースで比較できる（M4 の unresolvedIssues への対処）。
 */
export async function gitBlobShaHex(content: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${content.byteLength}\0`);
  const combined = new Uint8Array(header.byteLength + content.byteLength);
  combined.set(header, 0);
  combined.set(content, header.byteLength);
  const digest = await crypto.subtle.digest('SHA-1', combined);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** テキスト本文の git blob sha */
function gitBlobShaText(content: string): Promise<string> {
  return gitBlobShaHex(new TextEncoder().encode(content));
}

/** ノートが「ローカル保存由来（SHA-256）」かどうか（保存 → 衝突判定の材料） */
async function isLocalSavedSha(content: string, sha: string): Promise<boolean> {
  return (await sha256Hex(content)) === sha;
}

/** 同期モード（明示同期は conflicts を返して解決を UI に委ねる / 定時同期は中断する） */
export type SyncMode = 'explicit' | 'scheduled';

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

/** 同期衝突 1 件（プル時に GitHub 側の変更と R2 側の未 push 変更が重なった Note） */
export interface SyncConflict {
  readonly path: string;
  /** R2 側（ローカル保存）の内容 */
  readonly local: string;
  /** GitHub 側の現在内容（GitHub 側で削除された場合は空文字） */
  readonly remote: string;
  /** GitHub 側の blob sha（GitHub 側で削除された場合は null） */
  readonly remoteSha: string | null;
}

/** 同期の成功結果 */
export interface SyncResult {
  /** synced: 差分同期が完了 / syncing: 未処理の差分が残っている（チャンク継続） */
  readonly status: 'synced' | 'syncing';
  readonly syncedAt: string;
  /** プルで R2 に反映したノート数（追加・更新・削除の合計） */
  readonly pulled: number;
  /** プッシュで GitHub へ反映したファイル数（1 コミットに束ねる） */
  readonly pushed: number;
  /** 検出した同期衝突（明示同期のみ返す。定時同期は中断する） */
  readonly conflicts: readonly SyncConflict[];
  /** status: 'syncing' のとき、残っている未処理のプル対象数 */
  readonly remaining?: number;
}

export type SyncOutcome =
  | { readonly ok: true; readonly result: SyncResult }
  | { readonly ok: false; readonly reason: SyncFailureReason; readonly response: Response };

interface GithubTreeEntry {
  path?: unknown;
  type?: unknown;
  sha?: unknown;
}

interface GithubTreeResponse {
  sha?: unknown;
  truncated?: unknown;
  tree?: GithubTreeEntry[];
}

interface GithubBlobResponse {
  content?: unknown;
  encoding?: unknown;
}

/** GitHub Blobs API の base64 本文を UTF-8 文字列に復号する */
function decodeBase64Content(encoded: string): string {
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** UTF-8 テキストを標準 base64（btoa 出力相当）にエンコードする（GitHub Blobs API 用） */
function encodeBase64Content(content: string): string {
  const bytes = new TextEncoder().encode(content);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** バイト列を標準 base64 にエンコードする（添付の GitHub Blobs API 用） */
function encodeBase64Bytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Blob 並列取得の同時実行上限（GitHub のレートリミット消費を抑える） */
const BLOB_FETCH_CONCURRENCY = 8;

/** 1 回の同期 push で許容する削除件数の上限（削除ガードの安全弁） */
const MAX_SYNC_DELETIONS = 100;

/**
 * 1 リクエストで取得する blob 数の上限（同期プルのチャンク化。2026-08-16 の事故後）。
 *
 * Cloudflare Workers Free プランの外部 fetch サブリクエスト制限（50 件/リクエスト）
 * を超過しないための安全値。1 リクエストは「ツリー取得 + blob 取得 + 衝突 remote 取得」
 * を行うため、blob 側を 40 件に抑えて合計 50 件未満に収める。大量の差分がある
 * Vault は 1 リクエストでは処理しきらず、`status: 'syncing'` を返して呼び出し側が
 * 再実行する（冪等なため再実行で自然に続きが消化される）。
 */
const SYNC_FETCH_LIMIT = 40;

/** GitHub ツリー取得（GitHub 到達不能・レートリミットはエラー応答を返す） */
async function fetchGithubTree(
  baseUrl: string,
  token: string,
  owner: string,
  repoName: string,
  branch: string,
): Promise<
  | { readonly ok: true; readonly treeSha: string | null; readonly ghMap: Map<string, string> }
  | { readonly ok: false; readonly reason: SyncFailureReason; readonly response: Response }
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
  const failure = mapGithubFailure(response);
  if (failure) {
    const reason: SyncFailureReason = failure.status === 429 ? 'rate_limited' : 'github_error';
    return { ok: false, reason, response: failure };
  }
  const body = (await response.json().catch(() => null)) as GithubTreeResponse | null;
  if (!body || !Array.isArray(body.tree)) {
    return {
      ok: false,
      reason: 'github_error',
      response: Response.json({ error: 'github_error' }, { status: 502 }),
    };
  }
  const ghMap = new Map<string, string>();
  for (const entry of body.tree) {
    if (
      entry.type === 'blob' &&
      typeof entry.path === 'string' &&
      typeof entry.sha === 'string' &&
      entry.sha.length > 0
    ) {
      ghMap.set(entry.path, entry.sha);
    }
  }
  const treeSha = typeof body.sha === 'string' && body.sha.length > 0 ? body.sha : null;
  return { ok: true, treeSha, ghMap };
}

/** Blob 1 件を取得して本文を返す（失敗は null。1 ノートの失敗が同期全体を落とさない） */
async function fetchBlobContent(
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
  const body = (await response.json().catch(() => null)) as GithubBlobResponse | null;
  if (!body || body.encoding !== 'base64' || typeof body.content !== 'string') {
    return null;
  }
  return decodeBase64Content(body.content);
}

/** ツリーキャッシュのエントリ（path → sha）を Map にする */
function cachedTreeFileShas(tree: CachedVaultTree | null): Map<string, string | null> {
  const map = new Map<string, string | null>();
  if (tree !== null) {
    for (const entry of tree.entries) {
      if (entry.type === 'file') {
        map.set(entry.path, entry.sha);
      }
    }
  }
  return map;
}

/**
 * 同期を 1 回実行する（プル + プッシュ）。
 * 呼び出し側は認証済みの token と meta（同期済み）の存在を保証すること。
 */
export async function syncVault(
  baseUrl: string,
  token: string,
  bucket: R2Bucket,
  owner: string,
  repoName: string,
  mode: SyncMode,
  now: () => Date = () => new Date(),
): Promise<SyncOutcome> {
  const meta = await readVaultMeta(bucket, owner, repoName);
  if (meta === null) {
    return {
      ok: false,
      reason: 'invalid_vault',
      response: Response.json({ error: 'not_synced' }, { status: 409 }),
    };
  }

  // 1) ツリーを取得する（ツリー sha 比較の基準。レート消費は 1 回）
  const treeResult = await fetchGithubTree(baseUrl, token, owner, repoName, meta.defaultBranch);
  if (!treeResult.ok) {
    return treeResult;
  }
  const { treeSha, ghMap } = treeResult;

  const conflicts: SyncConflict[] = [];
  let pulled = 0;
  let treeChanged = treeSha !== meta.treeSha;

  if (treeChanged) {
    // 2) プル: GitHub 側の追加・変更を R2 へ反映し、衝突を検出する。
    //    差分判定（R2 アクセスのみ）と blob 取得（外部 fetch）を分離し、
    //    外部 fetch を 1 リクエスト SYNC_FETCH_LIMIT 件までに抑える（チャンク化。
    //    Workers Free のサブリクエスト 50 件制限を守るため）。冪等なため、
    //    リクエストを再実行するだけで未処理分が続きから消化される
    const existingPaths = await listCachedNotePaths(bucket, owner, repoName);
    // ローカル削除 tombstone を一度に列挙する（isVaultDeleted をノートごとに
    // 呼ぶと R2 アクセスが O(ノート数) になり、Workers Free の内部サービス
    // 1,000 件制限を超過するため）
    const deletedPaths = new Set(await listVaultDeleted(bucket, owner, repoName));
    // ツリーキャッシュの sha を先に取得する。前回同期から変更のないノートは
    // ツリーキャッシュの sha と GitHub の sha が一致するため、readCachedNote を
    // 呼ばずに同一と判定できる（R2 アクセスの削減）
    const cachedTreeForPull = await readVaultTree(bucket, owner, repoName);
    const treeFileSha = new Map<string, string | null>(
      (cachedTreeForPull?.entries ?? []).map((entry) => [entry.path, entry.sha]),
    );
    const noteBlobs = [...ghMap.entries()].filter(
      ([path, ghSha]) => isNotePath(path) && ghSha.length > 0,
    );

    // 2a) 差分を分類する（外部 fetch なし）
    const fetchTargets: { path: string; ghSha: string }[] = [];
    const localConflicts: { path: string; local: string; ghSha: string }[] = [];
    for (const [path, ghSha] of noteBlobs) {
      if (!existingPaths.has(path)) {
        // R2 に無いノート。ローカル削除（tombstone）のあるパスは取得しない
        // （削除の巻き戻り防止。tombstone が無ければ GitHub 側の新規追加）
        if (deletedPaths.has(path)) {
          continue;
        }
        fetchTargets.push({ path, ghSha });
        continue;
      }
      // ツリーキャッシュの sha が GitHub と一致していれば前回同期から変更なし
      // （readCachedNote を省略して R2 アクセスを減らす）
      const cachedTreeSha = treeFileSha.get(path);
      if (cachedTreeSha !== null && cachedTreeSha === ghSha) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- 変更のあった既存ノートのみ順に読むため
      const cached = await readCachedNote(bucket, owner, repoName, path);
      if (cached === null) {
        // existingPaths に存在するが破損等で読めない → 取得し直す（防衛線）
        fetchTargets.push({ path, ghSha });
        continue;
      }
      // 同一判定は sha 文字列比較ではなく本文の git blob sha との照合で行う
      // oxlint-disable-next-line no-await-in-loop -- 既存ノートを順に同一判定するため
      if (cached.sha === ghSha || (await gitBlobShaText(cached.content)) === ghSha) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- 既存ノートを順にローカル保存判定するため
      if (await isLocalSavedSha(cached.content, cached.sha)) {
        // R2 側にローカル保存（未 push）の変更がある → 同期衝突
        localConflicts.push({ path, local: cached.content, ghSha });
        continue;
      }
      // R2 は古い GitHub 内容（未編集）→ GitHub 側の変更を取り込む
      fetchTargets.push({ path, ghSha });
    }

    // 2b) blob 取得（外部 fetch）。衝突の remote 内容取得分を差し引いた
    //     バジェットで取得し、残りは次回の再実行で消化する
    const fetchBudget = Math.max(0, SYNC_FETCH_LIMIT - localConflicts.length);
    const fetchChunk = fetchTargets.slice(0, fetchBudget);
    for (let offset = 0; offset < fetchChunk.length; offset += BLOB_FETCH_CONCURRENCY) {
      const chunk = fetchChunk.slice(offset, offset + BLOB_FETCH_CONCURRENCY);
      // oxlint-disable-next-line no-await-in-loop -- 同時実行数を 8 に制限する意図的なチャンク処理
      const chunkResults = await Promise.all(
        chunk.map(async ({ path, ghSha }) => {
          const content = await fetchBlobContent(baseUrl, token, owner, repoName, ghSha);
          return content === null ? null : { path, ghSha, content };
        }),
      );
      for (const result of chunkResults) {
        if (result === null) {
          continue; // 取得失敗は次回の再実行で再試行される（冪等）
        }
        // oxlint-disable-next-line no-await-in-loop -- 取得済みノートの R2 書き込み（順次実行）のため
        await writeCachedNote(bucket, owner, repoName, result.path, {
          sha: result.ghSha,
          content: result.content,
        });
        pulled += 1;
      }
    }

    // 2c) 未処理の fetch 対象が残っている場合は中断する（syncing）。プル削除・
    //     プッシュ・meta 更新は全フェッチ完了後に行う（部分状態で進めると
    //     整合性が崩れるため）。冪等なので、呼び出し側が再実行すれば続く
    const remaining = fetchTargets.length - fetchChunk.length;
    if (remaining > 0) {
      return {
        ok: true,
        result: {
          status: 'syncing',
          syncedAt: now().toISOString(),
          pulled,
          pushed: 0,
          conflicts: [],
          remaining,
        },
      };
    }

    // 2d) 衝突の remote 内容を取得して conflicts に格納する（fetch バジェットの
    //     残り。件数は通常ごく少数で、大量衝突は異常時として許容する）
    for (const conflict of localConflicts) {
      // oxlint-disable-next-line no-await-in-loop -- 衝突 remote の順次取得のため
      const remote = await fetchBlobContent(baseUrl, token, owner, repoName, conflict.ghSha);
      conflicts.push({
        path: conflict.path,
        local: conflict.local,
        remote: remote ?? '',
        remoteSha: conflict.ghSha,
      });
    }

    // 3) プル: GitHub 側で削除されたノートを R2 から削除する。
    //    ローカル保存（未 push）のノートは削除せず衝突として残す
    const cachedTree = await readVaultTree(bucket, owner, repoName);
    if (cachedTree !== null) {
      for (const entry of cachedTree.entries) {
        if (entry.type !== 'file' || !isNotePath(entry.path) || ghMap.has(entry.path)) {
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop -- ノートの存在確認（順次適用の意図）のため
        const cached = await readCachedNote(bucket, owner, repoName, entry.path);
        if (cached === null) {
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop -- ローカル保存判定（順次適用の意図）のため
        if (await isLocalSavedSha(cached.content, cached.sha)) {
          conflicts.push({ path: entry.path, local: cached.content, remote: '', remoteSha: null });
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop -- R2 削除（順次適用の意図）のため
        await deleteCachedNote(bucket, owner, repoName, entry.path);
        pulled += 1;
      }
    }
  }

  // 定時同期はユーザー不在のため、衝突がある Vault は中断する（データ保護。
  // 呼び出し側が失敗を記録し、次回同期で自動リトライされる）
  if (mode === 'scheduled' && conflicts.length > 0) {
    return {
      ok: false,
      reason: 'sync_conflict',
      response: Response.json({ error: 'sync_conflict' }, { status: 409 }),
    };
  }

  // 4) プッシュ: R2 の未反映変更を 1 コミットに束ねる
  const conflictPaths = new Set(conflicts.map((conflict) => conflict.path));
  let pushed = 0;
  try {
    pushed = await pushPendingChanges(
      baseUrl,
      token,
      bucket,
      owner,
      repoName,
      ghMap,
      conflictPaths,
    );
  } catch (error) {
    if (error instanceof SyncPushError) {
      return { ok: false, reason: 'github_error', response: error.response };
    }
    if (error instanceof SyncDeleteGuardError) {
      return {
        ok: false,
        reason: 'too_many_deletes',
        response: Response.json(
          {
            error: 'too_many_deletes',
            message:
              `1 回の同期で削除されるファイルが多すぎます（${error.count} 件）。` +
              '意図しない削除の可能性があるため同期を中断しました。' +
              '意図的な整理の場合は GitHub 側で先に削除してから同期してください。',
          },
          { status: 409 },
        ),
      };
    }
    throw error;
  }

  // 5) 完了: ツリーキャッシュと meta を更新する。衝突がある間は「前回同期時点」を
  //    保つため更新しない（解決後の同期で整合する。衝突が再検出されるのは意図通り）
  if (conflicts.length === 0) {
    const cachedTree = await readVaultTree(bucket, owner, repoName);
    const entries = buildTreeEntries(ghMap, cachedTree);
    await writeVaultTree(bucket, owner, repoName, {
      defaultBranch: meta.defaultBranch,
      truncated: false,
      treeSha,
      entries,
    });
    await writeVaultMeta(bucket, owner, repoName, {
      syncedAt: now().toISOString(),
      defaultBranch: meta.defaultBranch,
      treeSha,
      lastSyncError: null,
      lastFailedAt: null,
    });
    // ローカル削除の tombstone をクリアする。この時点で削除は GitHub ツリーへ
    // 反映済み（push 済み、または GitHub 側でも存在しない）のため、以降の
    // 同期でパスが復活することはない（新規追加は tombstone なしで区別される）
    for (const path of await listVaultDeleted(bucket, owner, repoName)) {
      // oxlint-disable-next-line no-await-in-loop -- tombstone の一括クリア（同期完了時の後処理）のため
      await clearVaultDeleted(bucket, owner, repoName, path);
    }
    // 未プッシュ変更（dirty）もクリアする。この時点で変更は GitHub へ反映済み
    // （push 済み）のため、以降の同期で再プッシュされない
    for (const path of await listVaultDirty(bucket, owner, repoName)) {
      // oxlint-disable-next-line no-await-in-loop -- dirty の一括クリア（同期完了時の後処理）のため
      await clearVaultDirty(bucket, owner, repoName, path);
    }
  }

  return {
    ok: true,
    result: {
      status: 'synced',
      syncedAt: now().toISOString(),
      pulled,
      pushed,
      conflicts,
    },
  };
}

/** ツリーキャッシュのエントリ列を構築する（GitHub ツリーが正。前回のディレクトリは再構成） */
function buildTreeEntries(
  ghMap: Map<string, string>,
  cachedTree: CachedVaultTree | null,
): { path: string; type: 'file' | 'directory'; sha: string | null }[] {
  const fileShas = new Map<string, string | null>();
  for (const [path, ghSha] of ghMap) {
    fileShas.set(path, ghSha);
  }
  // GitHub ツリーに無いファイルは、キャッシュに「ローカル追加（sha: null）」として
  // 残っているものだけ保持する（GitHub 側削除は反映済みのはず）
  if (cachedTree !== null) {
    for (const entry of cachedTree.entries) {
      if (entry.type === 'file' && !fileShas.has(entry.path) && entry.sha === null) {
        fileShas.set(entry.path, null);
      }
    }
  }
  const directories = new Set<string>();
  for (const path of fileShas.keys()) {
    const segments = path.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      directories.add(segments.slice(0, depth).join('/'));
    }
  }
  return [
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
}

/**
 * R2 の未反映変更を commitChangesToGitHub で 1 コミットに束ねて GitHub へ反映する。
 * 反映したファイル数を返す（変更なしは 0）。conflictPaths はプッシュ対象から除外する。
 */
async function pushPendingChanges(
  baseUrl: string,
  token: string,
  bucket: R2Bucket,
  owner: string,
  repoName: string,
  ghMap: Map<string, string>,
  conflictPaths: ReadonlySet<string>,
): Promise<number> {
  const cachedTree = await readVaultTree(bucket, owner, repoName);
  const cachedShas = cachedTreeFileShas(cachedTree);

  const changes: ParsedChange[] = [];

  // 未プッシュ変更（dirty）だけを読み込んで差分を計算する。保存・ファイル操作が
  // R2 を書き換えるたびに dirty マーカーを記録するため、全ノート/全添付の本文を
  // 読み込まずに「どのファイルを GitHub へ反映すべきか」を特定できる（Workers Free
  // のサブリクエスト / CPU 制限への対応。2026-08-17 の 500 エラー）
  const dirtyPaths = await listVaultDirty(bucket, owner, repoName);
  const r2Paths = new Set<string>();
  for (const path of dirtyPaths) {
    if (conflictPaths.has(path)) {
      continue;
    }
    const ghSha = ghMap.get(path);
    // ノート（Markdown）として読む。null なら添付（raw）として扱う
    // oxlint-disable-next-line no-await-in-loop -- dirty ノートを順に読み込むため
    const note = await readCachedNote(bucket, owner, repoName, path);
    if (note !== null) {
      r2Paths.add(path);
      if (ghSha === undefined) {
        // R2 にあり GitHub に無い → ローカル新規のみ作成（前回同期時点に存在した
        // = GitHub 側で削除された → 復活させない）
        if (cachedShas.get(path) === null) {
          changes.push({
            op: 'create',
            path,
            to: null,
            content: encodeBase64Content(note.content),
          });
        }
        continue;
      }
      if (note.sha === ghSha) {
        continue;
      }
      changes.push({ op: 'update', path, to: null, content: encodeBase64Content(note.content) });
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- dirty 添付を順に読み込むため
    const raw = await readCachedRaw(bucket, owner, repoName, path);
    if (raw !== null) {
      r2Paths.add(path);
      const base64 = encodeBase64Bytes(new Uint8Array(raw.body));
      if (ghSha === undefined) {
        if (cachedShas.get(path) === null) {
          changes.push({ op: 'create', path, to: null, content: base64 });
        }
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- 添付の同一判定のため
      if ((await gitBlobShaHex(new Uint8Array(raw.body))) === ghSha) {
        continue;
      }
      changes.push({ op: 'update', path, to: null, content: base64 });
    }
  }

  // R2 で削除されたファイル → GitHub からも削除する。
  // 削除判定は tombstone（ファイル操作の delete / move が記録する明示的な
  // ローカル削除マーカー）のみを根拠にする。かつては「ツリーキャッシュにあり
  // GitHub にもあるが R2 に無い = ローカル削除」という推論も併用していたが、
  // 初期同期が Markdown 以外を取り込まないこと・取得失敗でノートが欠落することと
  // 組み合わさり、GitHub 側のファイルを大量削除する事故を起こした
  // （2026-08-16: note リポジトリで 300 ファイル削除）。
  // 破壊的操作は状態からの推論ではなく、明示的な操作記録のみを信頼する
  const deletePaths = new Set<string>();
  for (const path of await listVaultDeleted(bucket, owner, repoName)) {
    if (conflictPaths.has(path) || r2Paths.has(path)) {
      continue;
    }
    if (ghMap.has(path)) {
      deletePaths.add(path);
    }
  }
  // 削除ガード: 1 回の push で削除される件数の上限。これを超える削除は
  // 意図しない大量削除（バグ・誤操作）の可能性が高いため push を中断する
  // （安全弁。意図的な大量整理は GitHub 側で削除してから同期する）
  if (deletePaths.size > MAX_SYNC_DELETIONS) {
    throw new SyncDeleteGuardError(deletePaths.size);
  }
  for (const path of deletePaths) {
    changes.push({ op: 'delete', path, to: null, content: null });
  }

  if (changes.length === 0) {
    return 0;
  }
  const message = `Sync vault updates (${new Date().toISOString()})`;
  const result = await commitChangesToGitHub(baseUrl, token, owner, repoName, changes, message);
  if (!result.ok) {
    // push の失敗は同期全体の失敗として伝える（呼び出し側が失敗を記録する）
    throw new SyncPushError(result.response);
  }
  return changes.length;
}

/** push（GitHub へのコミット）に失敗したことを表す例外（応答は呼び出し側が返す） */
export class SyncPushError extends Error {
  readonly response: Response;

  constructor(response: Response) {
    super('sync push failed');
    this.name = 'SyncPushError';
    this.response = response;
  }
}

/**
 * 1 回の push で削除されるファイル数が上限（MAX_SYNC_DELETIONS）を超えたことを
 * 表す例外。意図しない大量削除の安全弁（削除ガード）で、呼び出し側が
 * SyncFailureReason 'too_many_deletes' として処理する。
 */
export class SyncDeleteGuardError extends Error {
  readonly count: number;

  constructor(count: number) {
    super('too many deletions in a single sync');
    this.name = 'SyncDeleteGuardError';
    this.count = count;
  }
}

/** 定時同期のための Vault 列挙結果 */
export interface VaultRefMeta {
  readonly owner: string;
  readonly repo: string;
  readonly meta: VaultMeta;
}

/**
 * 保持中の全 Vault（R2 に同期済みメタがある Vault）を列挙する。
 * 定時同期（scheduled ハンドラ）の対象一覧に使う。
 */
export async function listSyncedVaults(bucket: R2Bucket): Promise<readonly VaultRefMeta[]> {
  const prefix = 'vaults/';
  const suffix = '/meta';
  const vaults: VaultRefMeta[] = [];
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- R2 list のページング（truncated 時のみ続行）のため
    const listed = await bucket.list({
      prefix,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const object of listed.objects) {
      if (!object.key.endsWith(suffix)) {
        continue;
      }
      const parts = object.key.slice(prefix.length, -suffix.length).split('/');
      if (parts.length !== 2) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- Vault メタの読み出し（列挙中の順次処理）のため
      const meta = await readVaultMeta(bucket, parts[0] ?? '', parts[1] ?? '');
      if (meta === null) {
        continue;
      }
      vaults.push({ owner: parts[0] ?? '', repo: parts[1] ?? '', meta });
    }
    // oxlint-disable-next-line no-await-in-loop -- R2 list のページング（truncated 時のみ続行）のため
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  return vaults;
}

/** 同期失敗を meta に記録する（定時同期の Vault 単位の失敗記録。完了条件 10） */
export async function recordSyncFailure(
  bucket: R2Bucket,
  owner: string,
  repoName: string,
  reason: SyncFailureReason,
  now: () => Date = () => new Date(),
): Promise<void> {
  const meta = await readVaultMeta(bucket, owner, repoName);
  if (meta === null) {
    return;
  }
  await writeVaultMeta(bucket, owner, repoName, {
    syncedAt: meta.syncedAt,
    defaultBranch: meta.defaultBranch,
    treeSha: meta.treeSha,
    lastSyncError: reason,
    lastFailedAt: now().toISOString(),
  });
}

/** 同期衝突の解決方法（UI の選択肢。既存 Conflict UI の上書き/取り込みに対応する） */
export type ConflictResolution = 'overwrite' | 'adopt';

export type ResolveConflictOutcome =
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly response: Response };

/**
 * 同期衝突を解決する（完了条件 6。明示同期の Conflict UI 拡張から呼ばれる）。
 *
 * - overwrite（GitHub 側を採用）: R2 のノートを GitHub の現在内容で更新する。
 *   GitHub 側で削除されたノートは R2 から削除する
 * - adopt（ローカル側を採用）: R2 のローカル内容を GitHub へ 1 コミットで反映し、
 *   R2 の sha を GitHub blob sha に更新する（次回同期で同一判定になる）
 *
 * 解決後は meta の失敗記録（sync_conflict）をクリアする。
 */
export async function resolveSyncConflict(
  baseUrl: string,
  token: string,
  bucket: R2Bucket,
  owner: string,
  repoName: string,
  path: string,
  resolution: ConflictResolution,
): Promise<ResolveConflictOutcome> {
  const meta = await readVaultMeta(bucket, owner, repoName);
  if (meta === null) {
    return { ok: false, response: Response.json({ error: 'not_synced' }, { status: 409 }) };
  }
  const cached = await readCachedNote(bucket, owner, repoName, path);
  if (cached === null) {
    return {
      ok: false,
      response: Response.json(
        { error: 'not_found', message: 'ノートが見つかりません。' },
        { status: 404 },
      ),
    };
  }

  const treeResult = await fetchGithubTree(baseUrl, token, owner, repoName, meta.defaultBranch);
  if (!treeResult.ok) {
    return { ok: false, response: treeResult.response };
  }
  const ghSha = treeResult.ghMap.get(path) ?? null;
  let resolvedSha = '';

  if (resolution === 'adopt') {
    // ローカル内容を GitHub へ反映する（削除・作成・更新のどれでも update/create になる）
    const result = await commitChangesToGitHub(
      baseUrl,
      token,
      owner,
      repoName,
      [
        {
          op: ghSha === null ? 'create' : 'update',
          path,
          to: null,
          content: encodeBase64Content(cached.content),
        },
      ],
      `Resolve sync conflict: ${path}`,
    );
    if (!result.ok) {
      return { ok: false, response: result.response };
    }
    // GitHub の blob sha（= ローカル内容の git blob sha）に揃えると、次回の同期
    // で「同一」と判定され、衝突が再検出されない
    const blobSha = await gitBlobShaText(cached.content);
    await writeCachedNote(bucket, owner, repoName, path, { sha: blobSha, content: cached.content });
    resolvedSha = blobSha;
  } else if (ghSha === null) {
    // GitHub 側で削除されたノート → R2 からも削除する
    await deleteCachedNote(bucket, owner, repoName, path);
    await applyVaultTreeChanges(bucket, owner, repoName, [{ op: 'remove', path }]);
    resolvedSha = '';
  } else {
    // GitHub 側の内容を R2 へ反映する
    const remote = await fetchBlobContent(baseUrl, token, owner, repoName, ghSha);
    if (remote === null) {
      return { ok: false, response: Response.json({ error: 'github_error' }, { status: 502 }) };
    }
    await writeCachedNote(bucket, owner, repoName, path, { sha: ghSha, content: remote });
    resolvedSha = ghSha;
  }

  // 失敗記録（sync_conflict）をクリアする（次の同期で整合が取れる状態になったため）
  if (meta.lastSyncError !== null) {
    await writeVaultMeta(bucket, owner, repoName, {
      syncedAt: meta.syncedAt,
      defaultBranch: meta.defaultBranch,
      treeSha: meta.treeSha,
      lastSyncError: null,
      lastFailedAt: null,
    });
  }
  return { ok: true, sha: resolvedSha };
}
