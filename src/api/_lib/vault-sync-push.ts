/**
 * 同期プッシュ（R2 → GitHub）。
 *
 * R2 の未反映変更（dirty マーカー付きノート・添付と、削除 tombstone）を
 * commitChangesToGitHub で 1 コミットに束ねて反映する。削除件数の安全弁
 * （SyncDeleteGuardError）を持つ。失敗は SyncPushError で伝える。
 */

import { commitChangesToGitHub, type ParsedChange } from '@/api/_lib/github-commit';
import { makeNamedError } from '@/api/_lib/error-object';
import { readCachedNote, readVaultTree, type CachedVaultTree } from '@/api/_lib/r2-vault';
import { readCachedRaw } from '@/api/_lib/r2-vault-assets';
import { listVaultDeleted, listVaultDirty } from '@/api/_lib/r2-vault-marks';
import { encodeBase64Bytes, encodeBase64Content } from '@/api/_lib/vault-sync-github';
import { gitBlobShaHex } from '@/api/_lib/vault-sync-pull';

/** push（GitHub へのコミット）に失敗したことを表す例外（応答は呼び出し側が返す） */
export type SyncPushError = Error & {
  readonly response: Response;
};

export function syncPushError(response: Response): SyncPushError {
  return Object.assign(makeNamedError('SyncPushError', 'sync push failed'), { response });
}

/** error が SyncPushError かどうか */
export function isSyncPushError(error: unknown): error is SyncPushError {
  return isErrorNamed(error, 'SyncPushError');
}

/**
 * 1 回の push で削除されるファイル数が上限を超えたことを表す例外。
 * 意図しない大量削除の安全弁（削除ガード）。
 */
export type SyncDeleteGuardError = Error & {
  readonly count: number;
};

export function syncDeleteGuardError(count: number): SyncDeleteGuardError {
  return Object.assign(
    makeNamedError('SyncDeleteGuardError', 'too many deletions in a single sync'),
    { count },
  );
}

/** error が SyncDeleteGuardError かどうか */
export function isSyncDeleteGuardError(error: unknown): error is SyncDeleteGuardError {
  return isErrorNamed(error, 'SyncDeleteGuardError');
}

/** 1 回の同期 push で許容する削除件数の上限（削除ガードの安全弁） */
const MAX_SYNC_DELETIONS = 100;

function isErrorNamed(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

/** ツリーキャッシュのエントリ列を構築する（GitHub ツリーが正。前回のディレクトリは再構成） */
export function buildTreeEntries(
  ghMap: Map<string, string>,
  cachedTree: CachedVaultTree | null,
): { path: string; type: 'file' | 'directory'; sha: string | null }[] {
  const fileShas = new Map<string, string | null>();
  for (const [path, ghSha] of ghMap) {
    fileShas.set(path, ghSha);
  }
  // GitHub ツリーに無いファイルは、キャッシュに「ローカル追加（sha: null）」として
  // 残っているものだけ保持する（GitHub 側削除は反映済みのはず）
  if (cachedTree !== null) {
    for (const entry of cachedTree.entries) {
      if (entry.type === 'file' && !fileShas.has(entry.path) && entry.sha === null) {
        fileShas.set(entry.path, null);
      }
    }
  }
  const directories = new Set<string>();
  for (const path of fileShas.keys()) {
    const segments = path.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      directories.add(segments.slice(0, depth).join('/'));
    }
  }
  return [
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
}

/**
 * R2 の未反映変更を commitChangesToGitHub で 1 コミットに束ねて GitHub へ反映する。
 * 反映したファイル数を返す（変更なしは 0）。conflictPaths はプッシュ対象から除外する。
 * 失敗時は SyncPushError / SyncDeleteGuardError を投げる（呼び出し側が catch する）。
 */
export async function pushPendingChanges(
  baseUrl: string,
  token: string,
  bucket: R2Bucket,
  owner: string,
  repoName: string,
  ghMap: ReadonlyMap<string, string>,
  conflictPaths: ReadonlySet<string>,
): Promise<number> {
  const cachedTree = await readVaultTree(bucket, owner, repoName);
  const cachedShas = new Map<string, string | null>();
  if (cachedTree !== null) {
    for (const entry of cachedTree.entries) {
      if (entry.type === 'file') {
        cachedShas.set(entry.path, entry.sha);
      }
    }
  }

  const changes: ParsedChange[] = [];

  // 未プッシュ変更（dirty）だけを読み込んで差分を計算する。保存・ファイル操作が
  // R2 を書き換えるたびに dirty マーカーを記録するため、全ノート/全添付の本文を
  // 読み込まずに「どのファイルを GitHub へ反映すべきか」を特定できる
  // （Workers Free のサブリクエスト / CPU 制限への対応。2026-08-17 の 500 エラー）
  const dirtyPaths = await listVaultDirty(bucket, owner, repoName);
  const r2Paths = new Set<string>();
  for (const path of dirtyPaths) {
    if (conflictPaths.has(path)) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- dirty ファイルを順に読み込むため
    const ghSha = ghMap.get(path);
    // ノート（Markdown）として読む。null なら添付（raw）として扱う
    const note = await readCachedNote(bucket, owner, repoName, path);
    if (note !== null) {
      r2Paths.add(path);
      if (ghSha === undefined) {
        // R2 にあり GitHub に無い → ローカル新規のみ作成（前回同期時点に存在した
        // = GitHub 側で削除された → 復活させない）
        if (cachedShas.get(path) === null) {
          changes.push({
            op: 'create',
            path,
            to: null,
            content: encodeBase64Content(note.content),
          });
        }
      }
      if (ghSha !== undefined && note.sha !== ghSha) {
        changes.push({ op: 'update', path, to: null, content: encodeBase64Content(note.content) });
      }
    }
    if (note === null) {
      const raw = await readCachedRaw(bucket, owner, repoName, path);
      if (raw !== null) {
        r2Paths.add(path);
        const base64 = encodeBase64Bytes(new Uint8Array(raw.body));
        if (ghSha === undefined) {
          if (cachedShas.get(path) === null) {
            changes.push({ op: 'create', path, to: null, content: base64 });
          }
        }
        if (ghSha !== undefined) {
          const blobSha = await gitBlobShaHex(new Uint8Array(raw.body));
          if (blobSha !== ghSha) {
            changes.push({ op: 'update', path, to: null, content: base64 });
          }
        }
      }
    }
  }

  // R2 で削除されたファイル → GitHub からも削除する。
  // 削除判定は tombstone（明示的なローカル削除マーカー）のみを根拠にする。
  // 状態からの推論（「R2 に無い = 削除」）は 2026-08-16 の大量削除事故を招いたため廃止
  const deletePaths = new Set<string>();
  for (const path of await listVaultDeleted(bucket, owner, repoName)) {
    if (conflictPaths.has(path) || r2Paths.has(path)) {
      continue;
    }
    if (ghMap.has(path)) {
      deletePaths.add(path);
    }
  }
  // 削除ガード: 上限を超える削除は意図しない大量削除（バグ・誤操作）の可能性が
  // 高いため push を中断する（意図的な大量整理は GitHub 側で削除してから同期する）
  if (deletePaths.size > MAX_SYNC_DELETIONS) {
    throw syncDeleteGuardError(deletePaths.size);
  }
  for (const path of deletePaths) {
    changes.push({ op: 'delete', path, to: null, content: null });
  }

  if (changes.length === 0) {
    return 0;
  }
  const message = `Sync vault updates (${new Date().toISOString()})`;
  const result = await commitChangesToGitHub(baseUrl, token, owner, repoName, changes, message);
  if (!result.ok) {
    // push の失敗は同期全体の失敗として伝える（呼び出し側が失敗を記録する）
    throw syncPushError(result.response);
  }
  return changes.length;
}
