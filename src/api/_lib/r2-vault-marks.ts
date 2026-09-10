/**
 * R2上のローカル変更マーカー。削除のtombstoneと未プッシュのdirtyを保持する。
 * 保存やファイル操作の書き換え時に記録し、本文を読まず空マーカーで差分を特定する。
 * プル時はtombstoneのあるパスを復活させず、プッシュ時は削除反映とdirty差分に使う。
 * 同期の完了（衝突なし）でクリアされる。キー設計の全体像はr2-vault.ts参照。
 */

import { listAllR2Keys } from '@/api/_lib/r2-list';

/** ローカル削除の tombstone キー（vaults/{owner}/{repo}/deleted/{path}） */
export function vaultDeletedKey(owner: string, repo: string, path: string): string {
  return `vaults/${owner}/${repo}/deleted/${path}`;
}

/** 削除tombstoneを記録する。同期の巻き戻り防止に使う。 */
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
  for (const key of await listAllR2Keys(bucket, prefix)) {
    const path = key.slice(prefix.length);
    if (path.length > 0) {
      paths.push(path);
    }
  }
  return paths;
}

/**
 * 未プッシュ変更（ローカル保存）の dirty キー（vaults/{owner}/{repo}/dirty/{path}）。
 *
 * 保存（notes blob PUT）やファイル操作（一括コミットの create / update / copy / move）
 * が R2 を書き換えたときに記録する空マーカー。同期のプッシュ完了（衝突なし）で
 * クリアされる。
 */
export function vaultDirtyKey(owner: string, repo: string, path: string): string {
  return `vaults/${owner}/${repo}/dirty/${path}`;
}

/** 未プッシュ変更（dirty）を記録する（保存・ファイル操作の R2 書き換え時に呼ぶ） */
export async function markVaultDirty(
  bucket: R2Bucket,
  owner: string,
  repo: string,
  path: string,
): Promise<void> {
  await bucket.put(vaultDirtyKey(owner, repo, path), '');
}

/** 未プッシュ変更（dirty）マーカーを消す（同期プッシュの反映後に呼ぶ） */
export async function clearVaultDirty(
  bucket: R2Bucket,
  owner: string,
  repo: string,
  path: string,
): Promise<void> {
  await bucket.delete(vaultDirtyKey(owner, repo, path));
}

/** 同期済み Vault の全 dirty パスを列挙する（同期プッシュの差分検出用） */
export async function listVaultDirty(
  bucket: R2Bucket,
  owner: string,
  repo: string,
): Promise<readonly string[]> {
  const prefix = `vaults/${owner}/${repo}/dirty/`;
  const paths: string[] = [];
  for (const key of await listAllR2Keys(bucket, prefix)) {
    const path = key.slice(prefix.length);
    if (path.length > 0) {
      paths.push(path);
    }
  }
  return paths;
}
