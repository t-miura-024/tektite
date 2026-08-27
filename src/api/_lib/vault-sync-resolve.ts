/**
 * 同期衝突の解決（完了条件 6。明示同期の Conflict UI 拡張から呼ばれる）。
 *
 * - overwrite（GitHub 側を採用）: R2 のノートを GitHub の現在内容で更新する。
 *   GitHub 側で削除されたノートは R2 から削除する
 * - adopt（ローカル側を採用）: R2 のローカル内容を GitHub へ 1 コミットで反映し、
 *   R2 の sha を GitHub blob sha に更新する（次回同期で同一判定になる）
 *
 * 解決後は meta の失敗記録（sync_conflict）をクリアする。
 */

import { commitChangesToGitHub } from '@/api/_lib/github-commit';
import {
  deleteCachedNote,
  readCachedNote,
  readVaultMeta,
  writeCachedNote,
  writeVaultMeta,
} from '@/api/_lib/r2-vault';
import { applyVaultTreeChanges } from '@/api/_lib/r2-vault-tree-apply';
import {
  encodeBase64Content,
  fetchBlobContent,
  fetchGithubTree,
} from '@/api/_lib/vault-sync-github';
import { gitBlobShaHex } from '@/api/_lib/vault-sync-pull';

/** 同期衝突の解決方法（UI の選択肢。既存 Conflict UI の上書き/取り込みに対応する） */
export type ConflictResolution = 'overwrite' | 'adopt';

export type ResolveConflictOutcome =
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly response: Response };

const notFoundResponse = (): Response =>
  Response.json({ error: 'not_found', message: 'ノートが見つかりません。' }, { status: 404 });

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
    return { ok: false, response: notSyncedResponse() };
  }
  const cached = await readCachedNote(bucket, owner, repoName, path);
  if (cached === null) {
    return { ok: false, response: notFoundResponse() };
  }

  const treeResult = await fetchGithubTree(baseUrl, token, owner, repoName, meta.defaultBranch);
  if (!treeResult.ok) {
    return { ok: false, response: treeResult.response };
  }
  const ghSha = treeResult.ghMap.get(path) ?? null;

  const resolved =
    resolution === 'adopt'
      ? await adoptLocalContent({
          baseUrl,
          token,
          bucket,
          owner,
          repoName,
          path,
          content: cached.content,
          ghSha,
        })
      : await overwriteWithRemote({ baseUrl, token, bucket, owner, repoName, path, ghSha });
  if (!resolved.ok) {
    return resolved;
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
  return { ok: true, sha: resolved.sha };
}

function notSyncedResponse(): Response {
  return Response.json({ error: 'not_synced' }, { status: 409 });
}

type AdoptInput = {
  readonly baseUrl: string;
  readonly token: string;
  readonly bucket: R2Bucket;
  readonly owner: string;
  readonly repoName: string;
  readonly path: string;
  /** R2 側（ローカル保存）の本文 */
  readonly content: string;
  /** GitHub 側の blob sha（GitHub 側で削除された場合は null → create になる） */
  readonly ghSha: string | null;
};

/** adopt（ローカル側を採用）: ローカル内容を GitHub へ反映し、R2 の sha を揃える */
async function adoptLocalContent(input: AdoptInput): Promise<ResolveConflictOutcome> {
  // 削除・作成・更新のどれでも update/create になる
  const result = await commitChangesToGitHub(
    input.baseUrl,
    input.token,
    input.owner,
    input.repoName,
    [
      {
        op: input.ghSha === null ? 'create' : 'update',
        path: input.path,
        to: null,
        content: encodeBase64Content(input.content),
      },
    ],
    `Resolve sync conflict: ${input.path}`,
  );
  if (!result.ok) {
    return { ok: false, response: result.response };
  }
  // GitHub の blob sha（= ローカル内容の git blob sha）に揃えると、次回の同期
  // で「同一」と判定され、衝突が再検出されない
  const blobSha = await gitBlobShaHex(new TextEncoder().encode(input.content));
  await writeCachedNote(input.bucket, input.owner, input.repoName, input.path, {
    sha: blobSha,
    content: input.content,
  });
  return { ok: true, sha: blobSha };
}

type OverwriteInput = {
  readonly baseUrl: string;
  readonly token: string;
  readonly bucket: R2Bucket;
  readonly owner: string;
  readonly repoName: string;
  readonly path: string;
  readonly ghSha: string | null;
};

/** overwrite（GitHub 側を採用）: R2 を GitHub の現在内容で更新する（削除なら R2 から消す） */
async function overwriteWithRemote(input: OverwriteInput): Promise<ResolveConflictOutcome> {
  if (input.ghSha === null) {
    // GitHub 側で削除されたノート → R2 からも削除する
    await deleteCachedNote(input.bucket, input.owner, input.repoName, input.path);
    await applyVaultTreeChanges(input.bucket, input.owner, input.repoName, [
      { op: 'remove', path: input.path },
    ]);
    return { ok: true, sha: '' };
  }
  // GitHub 側の内容を R2 へ反映する
  const remote = await fetchBlobContent(
    input.baseUrl,
    input.token,
    input.owner,
    input.repoName,
    input.ghSha,
  );
  if (remote === null) {
    return { ok: false, response: Response.json({ error: 'github_error' }, { status: 502 }) };
  }
  await writeCachedNote(input.bucket, input.owner, input.repoName, input.path, {
    sha: input.ghSha,
    content: remote,
  });
  return { ok: true, sha: input.ghSha };
}
