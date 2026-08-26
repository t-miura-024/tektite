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
  applyFileShas(fileShas, changes);
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

/** ファイルエントリの add / remove を適用する */
function applyFileShas(
  fileShas: Map<string, string | null>,
  changes: readonly VaultTreeChange[],
): void {
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
}
