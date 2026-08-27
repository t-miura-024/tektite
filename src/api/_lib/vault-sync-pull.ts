/**
 * 同期プル（GitHub → R2）。
 *
 * GitHub のツリー sha を meta.treeSha（前回同期時点）と比較し、差分がある場合に
 * GitHub 側の追加・変更ノートを R2 へ反映する。同一判定は本文の git blob sha 照合、
 * 衝突判定はローカル保存由来の SHA-256 照合で行う。
 * 外部 fetch は 1 リクエスト SYNC_FETCH_LIMIT 件までに抑える（チャンク化。
 * Workers Free のサブリクエスト 50 件制限を守るため）。冪等なため、未処理分は
 * 呼び出し側が再実行すれば続きから消化される。
 */

import { sha256Hex } from '@/api/_lib/content-hash';
import {
  deleteCachedNote,
  listCachedNotePaths,
  readCachedNote,
  readVaultTree,
  writeCachedNote,
} from '@/api/_lib/r2-vault';
import { listVaultDeleted } from '@/api/_lib/r2-vault-marks';
import { fetchBlobContent } from '@/api/_lib/vault-sync-github';

/** ノート（Markdown）かどうか。同期のプルはノートのみを対象にする（添付は遅延キャッシュ） */
export function isNotePath(path: string): boolean {
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

/** Blob 並列取得の同時実行上限（GitHub のレートリミット消費を抑える） */
const BLOB_FETCH_CONCURRENCY = 8;

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

/** 同期衝突（プル時に GitHub 側の変更と R2 側の未 push 変更が重なった Note） */
export type SyncConflict = {
  readonly path: string;
  /** R2 側（ローカル保存）の内容 */
  readonly local: string;
  /** GitHub 側の現在内容（GitHub 側で削除された場合は空文字） */
  readonly remote: string;
  /** GitHub 側の blob sha（GitHub 側で削除された場合は null） */
  readonly remoteSha: string | null;
};

/** プルの入力（baseUrl / token / bucket / owner / repoName + ツリー比較の材料） */
export type PullInput = {
  readonly baseUrl: string;
  readonly token: string;
  readonly bucket: R2Bucket;
  readonly owner: string;
  readonly repoName: string;
  /** 前回同期時点のツリー sha（meta.treeSha） */
  readonly prevTreeSha: string | null;
  /** 現在の GitHub ツリー sha */
  readonly ghTreeSha: string | null;
  /** 現在の GitHub ツリー（path → blob sha） */
  readonly ghMap: ReadonlyMap<string, string>;
};

/** プル結果。remaining > 0 は未処理あり（呼び出し側は syncing として打ち切る） */
export type PullResult = {
  readonly pulled: number;
  readonly remaining: number;
  readonly conflicts: readonly SyncConflict[];
};

/**
 * プルを実行する（ツリー sha が一致していれば何もしない）。
 * 未処理の取得対象が残る場合は remaining > 0 を返す。プル削除・プッシュ・meta 更新は
 * 全フェッチ完了後に行う（部分状態で進めると整合性が崩れるため）。
 */
export async function pullGithubChanges(input: PullInput): Promise<PullResult> {
  if (input.prevTreeSha === input.ghTreeSha) {
    return { pulled: 0, remaining: 0, conflicts: [] };
  }
  const conflicts: SyncConflict[] = [];
  // 差分判定（R2 アクセスのみ）と blob 取得（外部 fetch）を分離し、外部 fetch を
  // SYNC_FETCH_LIMIT 件までに抑える
  const existingPaths = await listCachedNotePaths(input.bucket, input.owner, input.repoName);
  // ローカル削除 tombstone を一度に列挙する（isVaultDeleted をノートごとに
  // 呼ぶと R2 アクセスが O(ノート数) になり、Workers Free の内部サービス
  // 1,000 件制限を超過するため）
  const deletedPaths = new Set(await listVaultDeleted(input.bucket, input.owner, input.repoName));
  // ツリーキャッシュの sha と GitHub の sha が一致するノートは前回同期から
  // 変更なしとみなし、readCachedNote を省略する（R2 アクセスの削減）
  const cachedTreeForPull = await readVaultTree(input.bucket, input.owner, input.repoName);
  const treeFileSha = new Map<string, string | null>(
    (cachedTreeForPull?.entries ?? []).map((entry) => [entry.path, entry.sha]),
  );

  const fetchTargets: { path: string; ghSha: string }[] = [];
  const localConflicts: { path: string; local: string; ghSha: string }[] = [];
  for (const [path, ghSha] of input.ghMap.entries()) {
    if (!isNotePath(path) || ghSha.length === 0) {
      continue;
    }
    await classifyNoteDifference({
      bucket: input.bucket,
      owner: input.owner,
      repoName: input.repoName,
      path,
      ghSha,
      existingPaths,
      deletedPaths,
      treeFileSha,
      fetchTargets,
      localConflicts,
    });
  }

  // blob 取得（外部 fetch）。衝突の remote 内容取得分を差し引いたバジェットで
  // 取得し、残りは次回の再実行で消化する
  const fetchBudget = Math.max(0, SYNC_FETCH_LIMIT - localConflicts.length);
  const fetchChunk = fetchTargets.slice(0, fetchBudget);
  const pulled = await fetchAndApplyChunks(input, fetchChunk);

  // 衝突の remote 内容を取得して conflicts に格納する（fetch バジェットの残り。
  // 件数は通常ごく少数で、大量衝突は異常時として許容する）
  for (const conflict of localConflicts) {
    // oxlint-disable-next-line no-await-in-loop -- 衝突 remote の順次取得のため
    const remote = await fetchBlobContent(
      input.baseUrl,
      input.token,
      input.owner,
      input.repoName,
      conflict.ghSha,
    );
    conflicts.push({
      path: conflict.path,
      local: conflict.local,
      remote: remote ?? '',
      remoteSha: conflict.ghSha,
    });
  }

  // GitHub 側で削除されたノートを R2 から削除する。
  // ローカル保存（未 push）のノートは削除せず衝突として残す
  const removed = await deleteRemovedNotes(input, conflicts);

  return {
    pulled: pulled + removed,
    remaining: fetchTargets.length - fetchChunk.length,
    conflicts,
  };
}

/** 取得チャンクを並列 fetch し、取得できたノートを R2 へ書き込む（反映数を返す） */
async function fetchAndApplyChunks(
  input: PullInput,
  fetchChunk: readonly { readonly path: string; readonly ghSha: string }[],
): Promise<number> {
  let pulled = 0;
  for (let offset = 0; offset < fetchChunk.length; offset += BLOB_FETCH_CONCURRENCY) {
    const chunk = fetchChunk.slice(offset, offset + BLOB_FETCH_CONCURRENCY);
    // oxlint-disable-next-line no-await-in-loop -- 同時実行数を 8 に制限する意図的なチャンク処理
    const chunkResults = await Promise.all(
      chunk.map(async ({ path, ghSha }) => ({
        path,
        ghSha,
        content: await fetchBlobContent(
          input.baseUrl,
          input.token,
          input.owner,
          input.repoName,
          ghSha,
        ),
      })),
    );
    for (const result of chunkResults) {
      if (result.content === null) {
        continue; // 取得失敗は次回の再実行で再試行される（冪等）
      }
      // oxlint-disable-next-line no-await-in-loop -- 取得済みノートの R2 書き込み（順次実行）のため
      await writeCachedNote(input.bucket, input.owner, input.repoName, result.path, {
        sha: result.ghSha,
        content: result.content,
      });
      pulled += 1;
    }
  }
  return pulled;
}

type ClassifyContext = {
  readonly bucket: R2Bucket;
  readonly owner: string;
  readonly repoName: string;
  readonly path: string;
  readonly ghSha: string;
  readonly existingPaths: ReadonlySet<string>;
  readonly deletedPaths: ReadonlySet<string>;
  readonly treeFileSha: ReadonlyMap<string, string | null>;
  readonly fetchTargets: { path: string; ghSha: string }[];
  readonly localConflicts: { path: string; local: string; ghSha: string }[];
};

/** 差分を分類する（外部 fetch なし。R2 の読み取りのみ） */
async function classifyNoteDifference(context: ClassifyContext): Promise<void> {
  const { path, ghSha } = context;
  if (!context.existingPaths.has(path)) {
    // R2 に無いノート。ローカル削除（tombstone）のあるパスは取得しない
    // （削除の巻き戻り防止。tombstone が無ければ GitHub 側の新規追加）
    if (!context.deletedPaths.has(path)) {
      context.fetchTargets.push({ path, ghSha });
    }
    return;
  }
  // ツリーキャッシュの sha が GitHub と一致していれば前回同期から変更なし
  const cachedTreeSha = context.treeFileSha.get(path);
  if (cachedTreeSha !== null && cachedTreeSha === ghSha) {
    return;
  }
  // oxlint-disable-next-line no-await-in-loop -- 変更のあった既存ノートのみ順に読むため
  const cached = await readCachedNote(context.bucket, context.owner, context.repoName, path);
  if (cached === null) {
    // existingPaths に存在するが破損等で読めない → 取得し直す（防衛線）
    context.fetchTargets.push({ path, ghSha });
    return;
  }
  // 同一判定は sha 文字列比較ではなく本文の git blob sha との照合で行う
  // oxlint-disable-next-line no-await-in-loop -- 既存ノートを順に同一判定するため
  if (cached.sha === ghSha || (await gitBlobShaText(cached.content)) === ghSha) {
    return;
  }
  // oxlint-disable-next-line no-await-in-loop -- 既存ノートを順にローカル保存判定するため
  if (await isLocalSavedSha(cached.content, cached.sha)) {
    // R2 側にローカル保存（未 push）の変更がある → 同期衝突
    context.localConflicts.push({ path, local: cached.content, ghSha });
    return;
  }
  // R2 は古い GitHub 内容（未編集）→ GitHub 側の変更を取り込む
  context.fetchTargets.push({ path, ghSha });
}

/** GitHub ツリーから消えたノートの後処理（削除 or 衝突化）を行う */
async function deleteRemovedNotes(input: PullInput, conflicts: SyncConflict[]): Promise<number> {
  const cachedTree = await readVaultTree(input.bucket, input.owner, input.repoName);
  if (cachedTree === null) {
    return 0;
  }
  let removed = 0;
  for (const entry of cachedTree.entries) {
    if (entry.type !== 'file' || !isNotePath(entry.path) || input.ghMap.has(entry.path)) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- ノートの存在確認（順次適用の意図）のため
    const cached = await readCachedNote(input.bucket, input.owner, input.repoName, entry.path);
    if (cached === null) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- ローカル保存判定（順次適用の意図）のため
    if (await isLocalSavedSha(cached.content, cached.sha)) {
      conflicts.push({ path: entry.path, local: cached.content, remote: '', remoteSha: null });
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- R2 削除（順次適用の意図）のため
    await deleteCachedNote(input.bucket, input.owner, input.repoName, entry.path);
    removed += 1;
  }
  return removed;
}
