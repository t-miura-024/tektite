/**
 * ツリーキャッシュへのファイル操作反映（M4: 一括コミットの R2 先行化）。
 *
 * 一括コミット（files ルート）が R2 のノート/添付を書き換えた結果を、
 * ツリーキャッシュ（vaults/{owner}/{repo}/tree）へ反映する。
 */

import { readVaultTree, writeVaultTree, type VaultTreeEntry } from '@/api/_lib/r2-vault';

/** ツリーキャッシュへの変更 1 件（ファイル操作の R2 反映で使う） */
export type VaultTreeChange = {
  readonly op: 'add' | 'remove';
  readonly path: string;
};

/** ファイル操作結果をツリーキャッシュへ反映する。未取得は何もしない。 */
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
      continue;
    }
    fileShas.delete(change.path);
  }
  const directories = new Set<string>();
  for (const path of fileShas.keys()) {
    const segments = path.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      directories.add(segments.slice(0, depth).join('/'));
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
