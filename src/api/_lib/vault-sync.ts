/**
 * Vault 同期（M5: 定時 + 明示同期の共通ロジック）。
 *
 * プル (GitHub → R2) とプッシュ (R2 → GitHub) を 1 回の処理で行う。
 * 定時同期（scheduled ハンドラ）と明示同期（POST /sync）の両方から呼ばれる。
 * プルは vault-sync-pull、プッシュは vault-sync-push、GitHub 読み取りは
 * vault-sync-github、衝突解決は vault-sync-resolve が担い、このモジュールは
 * 全体の進行と完了処理を担う:
 * - 成功: ツリーキャッシュと meta を更新し、lastSyncError / tombstone /
 *   dirty マーカーをクリアする（反映済みのため復活しない）
 * - 衝突あり（明示同期）: 非衝突分を反映・プッシュし conflicts を返す。
 *   meta / ツリーキャッシュは更新しない（解決後の同期で整合させる）
 * - 衝突あり（定時同期）: sync_conflict で中断する（次回同期で自動リトライ）
 */

import { listAllR2Keys } from '@/api/_lib/r2-list';
import { readVaultMeta, writeVaultMeta, type VaultMeta } from '@/api/_lib/r2-vault';
import { fetchGithubTree, type SyncFailureReason } from '@/api/_lib/vault-sync-github';
import { pullGithubChanges, type SyncConflict } from '@/api/_lib/vault-sync-pull';
import {
  isSyncDeleteGuardError,
  isSyncPushError,
  pushPendingChanges,
} from '@/api/_lib/vault-sync-push';
import { finalizeSync, tooManyDeletesResponse } from '@/api/_lib/vault-sync-finalize';

/** 同期モード（明示同期は conflicts を返して解決を UI に委ねる / 定時同期は中断する） */
export type SyncMode = 'explicit' | 'scheduled';

export type { SyncConflict, SyncFailureReason };

/** 同期の成功結果 */
export type SyncResult = {
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
};

export type SyncOutcome =
  | { readonly ok: true; readonly result: SyncResult }
  | { readonly ok: false; readonly reason: SyncFailureReason; readonly response: Response };

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
  const treeResult = await fetchGithubTree(baseUrl, token, owner, repoName, meta.defaultBranch);
  if (!treeResult.ok) {
    return treeResult;
  }
  const syncConflicts: SyncConflict[] = [];
  let pulled = 0;
  let remaining = 0;
  if (treeResult.treeSha !== meta.treeSha) {
    const pullResult = await pullGithubChanges({
      baseUrl,
      token,
      bucket,
      owner,
      repoName,
      prevTreeSha: meta.treeSha,
      ghTreeSha: treeResult.treeSha,
      ghMap: treeResult.ghMap,
    });
    pulled += pullResult.pulled;
    remaining = pullResult.remaining;
    syncConflicts.push(...pullResult.conflicts);
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
  }
  if (mode === 'scheduled' && syncConflicts.length > 0) {
    return {
      ok: false,
      reason: 'sync_conflict',
      response: Response.json({ error: 'sync_conflict' }, { status: 409 }),
    };
  }
  return pushAndFinalize({
    baseUrl,
    token,
    bucket,
    owner,
    repoName,
    ghMap: treeResult.ghMap,
    defaultBranch: meta.defaultBranch,
    treeSha: treeResult.treeSha,
    conflicts: syncConflicts,
    pulled,
    now,
  });
}

/** プッシュと完了処理（衝突がある間はツリーキャッシュ / meta を更新しない） */
async function pushAndFinalize(context: {
  readonly baseUrl: string;
  readonly token: string;
  readonly bucket: R2Bucket;
  readonly owner: string;
  readonly repoName: string;
  readonly ghMap: ReadonlyMap<string, string>;
  readonly defaultBranch: string;
  readonly treeSha: string | null;
  readonly conflicts: readonly SyncConflict[];
  readonly pulled: number;
  readonly now: () => Date;
}): Promise<SyncOutcome> {
  const { baseUrl, token, bucket, owner, repoName } = context;
  const conflictPaths = new Set(context.conflicts.map((conflict) => conflict.path));
  let pushed = 0;
  try {
    pushed = await pushPendingChanges(
      baseUrl,
      token,
      bucket,
      owner,
      repoName,
      context.ghMap,
      conflictPaths,
    );
  } catch (error) {
    if (isSyncPushError(error)) {
      return { ok: false, reason: 'github_error', response: error.response };
    }
    if (isSyncDeleteGuardError(error)) {
      return {
        ok: false,
        reason: 'too_many_deletes',
        response: tooManyDeletesResponse(error.count),
      };
    }
    throw error;
  }
  if (context.conflicts.length === 0) {
    await finalizeSync(
      bucket,
      owner,
      repoName,
      context.defaultBranch,
      context.treeSha,
      context.ghMap,
      context.now,
    );
  }
  return {
    ok: true,
    result: {
      status: 'synced',
      syncedAt: context.now().toISOString(),
      pulled: context.pulled,
      pushed,
      conflicts: context.conflicts,
    },
  };
}

/** 定時同期のための Vault 列挙結果 */
export type VaultRefMeta = {
  readonly owner: string;
  readonly repo: string;
  readonly meta: VaultMeta;
};

/**
 * 保持中の全 Vault（R2 に同期済みメタがある Vault）を列挙する。
 * 定時同期（scheduled ハンドラ）の対象一覧に使う。
 */
export async function listSyncedVaults(bucket: R2Bucket): Promise<readonly VaultRefMeta[]> {
  const prefix = 'vaults/';
  const suffix = '/meta';
  const vaults: VaultRefMeta[] = [];
  const keys = await listAllR2Keys(bucket, prefix);
  for (const key of keys) {
    if (!key.endsWith(suffix)) {
      continue;
    }
    const parts = key.slice(prefix.length, -suffix.length).split('/');
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
