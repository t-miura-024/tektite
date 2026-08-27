import { readVaultTree, writeVaultMeta, writeVaultTree } from '@/api/_lib/r2-vault';
import {
  clearVaultDeleted,
  clearVaultDirty,
  listVaultDeleted,
  listVaultDirty,
} from '@/api/_lib/r2-vault-marks';
import { buildTreeEntries } from '@/api/_lib/vault-sync-push';

export const tooManyDeletesResponse = (count: number): Response =>
  Response.json(
    {
      error: 'too_many_deletes',
      message:
        `1 回の同期で削除されるファイルが多すぎます（${count} 件）。` +
        '意図しない削除の可能性があるため同期を中断しました。' +
        '意図的な整理の場合は GitHub 側で先に削除してから同期してください。',
    },
    { status: 409 },
  );

/** 同期完了後処理: ツリーキャッシュ / meta / マーカーのクリア */
export async function finalizeSync(
  bucket: R2Bucket,
  owner: string,
  repoName: string,
  defaultBranch: string,
  treeSha: string | null,
  ghMap: ReadonlyMap<string, string>,
  now: () => Date,
): Promise<void> {
  const cachedTree = await readVaultTree(bucket, owner, repoName);
  const entries = buildTreeEntries(new Map(ghMap), cachedTree);
  await writeVaultTree(bucket, owner, repoName, {
    defaultBranch,
    truncated: false,
    treeSha,
    entries,
  });
  await writeVaultMeta(bucket, owner, repoName, {
    syncedAt: now().toISOString(),
    defaultBranch,
    treeSha,
    lastSyncError: null,
    lastFailedAt: null,
  });
  for (const path of await listVaultDeleted(bucket, owner, repoName)) {
    // oxlint-disable-next-line no-await-in-loop -- tombstone の一括クリア（同期完了時の後処理）のため
    await clearVaultDeleted(bucket, owner, repoName, path);
  }
  for (const path of await listVaultDirty(bucket, owner, repoName)) {
    // oxlint-disable-next-line no-await-in-loop -- dirty の一括クリア（同期完了時の後処理）のため
    await clearVaultDirty(bucket, owner, repoName, path);
  }
}
