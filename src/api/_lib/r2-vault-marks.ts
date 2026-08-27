/**
 * R2 上のローカル変更マーカー（tombstone / dirty）。
 *
 * - `vaults/{owner}/{repo}/deleted/{path}` … ローカル削除の tombstone（空マーカー）。
 *   同期済み Vault でファイル操作（files 一括コミットの delete / move）が削除を
 *   行ったときに記録される。R2 とツリーキャッシュの両方から消えたパスは
 *   「ローカル削除」か「GitHub 側新規追加」のどちらの可能性もあるため、
 *   同期（vault-sync.ts）はこのマーカーで区別する:
 *   - プル: tombstone があるパスは fetch しない（削除の巻き戻り防止）
 *   - プッシュ: tombstone があるパスは GitHub ツリーから削除する（削除の反映）
 *   同期の完了（衝突なし）でクリアされる
 * - `vaults/{owner}/{repo}/dirty/{path}` … 未プッシュ変更のマーカー。
 *   保存やファイル操作が R2 を書き換えたときに記録し、同期プッシュが
 *   「どのノートを GitHub へ反映すべきか」を全ノートの本文を読まずに
 *   特定するために使う（Workers Free のサブリクエスト / CPU 制限への対応）。
 *
 * キー設計と全体像は r2-vault.ts のドキュメントを参照。
 */

import { listAllR2Keys } from '@/api/_lib/r2-list';

/** ローカル削除の tombstone キー（vaults/{owner}/{repo}/deleted/{path}） */
export function vaultDeletedKey(owner: string, repo: string, path: string): string {
  return `vaults/${owner}/${repo}/deleted/${path}`;
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
