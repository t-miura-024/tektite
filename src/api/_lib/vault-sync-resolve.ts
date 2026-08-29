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
    return { ok: false, response: Response.json({ error: 'not_synced' }, { status: 409 }) };
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

  let resolved: ResolveConflictOutcome | null = null;
  if (resolution === 'adopt') {
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
      resolved = { ok: false, response: result.response };
    }
    if (result.ok) {
      const blobSha = await gitBlobShaHex(new TextEncoder().encode(cached.content));
      await writeCachedNote(bucket, owner, repoName, path, {
        sha: blobSha,
        content: cached.content,
      });
      resolved = { ok: true, sha: blobSha };
    }
  }
  if (resolution !== 'adopt') {
    if (ghSha === null) {
      await deleteCachedNote(bucket, owner, repoName, path);
      await applyVaultTreeChanges(bucket, owner, repoName, [{ op: 'remove', path }]);
      resolved = { ok: true, sha: '' };
    }
    if (ghSha !== null) {
      const remote = await fetchBlobContent(baseUrl, token, owner, repoName, ghSha);
      if (remote === null) {
        resolved = {
          ok: false,
          response: Response.json({ error: 'github_error' }, { status: 502 }),
        };
      }
      if (remote !== null) {
        await writeCachedNote(bucket, owner, repoName, path, {
          sha: ghSha,
          content: remote,
        });
        resolved = { ok: true, sha: ghSha };
      }
    }
  }
  if (resolved === null) {
    return { ok: false, response: Response.json({ error: 'github_error' }, { status: 502 }) };
  }
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
