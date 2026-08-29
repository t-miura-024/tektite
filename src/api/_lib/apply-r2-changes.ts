/**
 * 一括コミットの変更列を R2 へ適用する（M4 の R2 先行パス）。
 *
 * 変更は順に適用され、同一パスの後続変更が勝つ。move / copy は元パスの
 * 種別（notes / raw）に応じて本文・Content-Type を引き継ぐ。ツリーキャッシュ
 * への反映も併せて行う。
 */

import { sha256Hex } from '@/api/_lib/content-hash';
import { decodeBase64Bytes, decodeBase64Content } from '@/api/_lib/vault-sync-github';
import { deleteCachedNote, readCachedNote, writeCachedNote } from '@/api/_lib/r2-vault';
import { applyVaultTreeChanges, type VaultTreeChange } from '@/api/_lib/r2-vault-tree-apply';
import { deleteCachedRaw, readCachedRaw, writeCachedRaw } from '@/api/_lib/r2-vault-assets';
import { markVaultDeleted, markVaultDirty } from '@/api/_lib/r2-vault-marks';
import type { ParsedChange } from '@/api/_lib/github-commit';

/** 添付の拡張子から Content-Type を推測する（画像アップロードの規約に合わせる） */
export function inferContentType(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot === path.length - 1) {
    return 'application/octet-stream';
  }
  const extension = path.slice(dot + 1).toLowerCase();
  const table: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
  };
  return table[extension] ?? 'application/octet-stream';
}

type ApplyOutcome = { readonly ok: true } | { readonly ok: false; readonly response: Response };

/**
 * 変更列を R2 へ適用する（初期同期済み Vault の R2 先行パス）。
 * 変更は順に適用され、同一パスの後続変更が勝つ。
 */
export async function applyChangesToR2(
  bucket: R2Bucket,
  owner: string,
  repoName: string,
  changes: readonly ParsedChange[],
): Promise<ApplyOutcome> {
  const treeChanges: VaultTreeChange[] = [];
  for (const change of changes) {
    // oxlint-disable-next-line no-await-in-loop -- 変更は順に適用する（同一パスの後勝ち・
    // move 後の update 反映など GitHub の delta 適用と同じ順序依存がある）ため
    let failure: Response | null = null;
    if (change.op === 'create' || change.op === 'update') {
      if (change.content === null) {
        // parseCommitBody で保証されるため到達しない（型の防御線）
        failure = invalidBodyResponse();
      }
      if (failure === null && change.content !== null) {
        const path = change.path;
        const contentBase64 = change.content;
        const isNote = path.endsWith('.md');
        if (isNote) {
          const content = decodeBase64Content(contentBase64);
          // oxlint-disable-next-line no-await-in-loop -- ハッシュ計算（順次適用の意図）のため
          const noteSha = await sha256Hex(content);
          // oxlint-disable-next-line no-await-in-loop -- R2 書き込み（順次適用の意図）のため
          await writeCachedNote(bucket, owner, repoName, path, { sha: noteSha, content });
          // oxlint-disable-next-line no-await-in-loop -- dirty 記録（順次適用の意図）のため
          await markVaultDirty(bucket, owner, repoName, path);
          treeChanges.push({ op: 'add', path });
        }
        if (!isNote) {
          const bytes = decodeBase64Bytes(contentBase64);
          // oxlint-disable-next-line no-await-in-loop -- R2 書き込み（順次適用の意図）のため
          await writeCachedRaw(bucket, owner, repoName, path, bytes, inferContentType(path));
          // 未プッシュ変更（dirty）を記録する（同期プッシュが対象ノードだけ読めるように）
          // oxlint-disable-next-line no-await-in-loop -- dirty 記録（順次適用の意図）のため
          await markVaultDirty(bucket, owner, repoName, path);
          treeChanges.push({ op: 'add', path });
        }
      }
    }
    if (change.op === 'delete') {
      await deleteCachedNote(bucket, owner, repoName, change.path);
      await deleteCachedRaw(bucket, owner, repoName, change.path);
      await markVaultDeleted(bucket, owner, repoName, change.path);
      treeChanges.push({ op: 'remove', path: change.path });
    }
    if (change.op === 'move' || change.op === 'copy') {
      if (change.to === null) {
        // parseCommitBody で保証されるため到達しない（型の防御線）
        failure = invalidBodyResponse();
      }
      if (failure === null && change.to !== null) {
        const source = change.path;
        const destination = change.to;
        const note = await readCachedNote(bucket, owner, repoName, source);
        if (note !== null) {
          // oxlint-disable-next-line no-await-in-loop -- R2 書き込み（順次適用の意図）のため
          await writeCachedNote(bucket, owner, repoName, destination, note);
          // oxlint-disable-next-line no-await-in-loop -- dirty 記録（順次適用の意図）のため
          await markVaultDirty(bucket, owner, repoName, destination);
          if (change.op === 'move') {
            // oxlint-disable-next-line no-await-in-loop -- R2 削除（順次適用の意図）のため
            await removeSource(bucket, owner, repoName, source);
          }
          treeChanges.push({ op: 'add', path: destination });
          if (change.op === 'move') {
            treeChanges.push({ op: 'remove', path: source });
          }
        }
        if (note === null) {
          const raw = await readCachedRaw(bucket, owner, repoName, source);
          if (raw === null) {
            const label = change.op === 'move' ? '移動元' : '複製元';
            failure = invalidChangeResponse(`${label}「${source}」が見つかりません。`);
          }
          if (raw !== null) {
            // oxlint-disable-next-line no-await-in-loop -- R2 書き込み（順次適用の意図）のため
            await writeCachedRaw(bucket, owner, repoName, destination, raw.body, raw.contentType);
            // oxlint-disable-next-line no-await-in-loop -- dirty 記録（順次適用の意図）のため
            await markVaultDirty(bucket, owner, repoName, destination);
            if (change.op === 'move') {
              // oxlint-disable-next-line no-await-in-loop -- R2 削除（順次適用の意図）のため
              await removeSource(bucket, owner, repoName, source);
            }
            treeChanges.push({ op: 'add', path: destination });
            if (change.op === 'move') {
              treeChanges.push({ op: 'remove', path: source });
            }
          }
        }
      }
    }
    if (failure !== null) {
      return { ok: false, response: failure };
    }
  }
  await applyVaultTreeChanges(bucket, owner, repoName, treeChanges);
  return { ok: true };
}

const invalidBodyResponse = (): Response =>
  Response.json({ error: 'invalid_body' }, { status: 400 });

const invalidChangeResponse = (message: string): Response =>
  Response.json({ error: 'invalid_change', message }, { status: 400 });

/** move 元の削除処理（R2 から消し、ローカル削除の tombstone も記録する） */
async function removeSource(
  bucket: R2Bucket,
  owner: string,
  repoName: string,
  source: string,
): Promise<void> {
  await deleteCachedNote(bucket, owner, repoName, source);
  await deleteCachedRaw(bucket, owner, repoName, source);
  await markVaultDeleted(bucket, owner, repoName, source);
}
