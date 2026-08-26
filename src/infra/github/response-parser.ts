/**
 * プロキシ応答（JSON）のパース。
 *
 * Pages Functions プロキシ（/api/vaults、/api/tree、/api/notes、/api/files、
 * /api/vaults/:owner/:repo/sync）の JSON 応答を application 層のデータ型へ
 * 変換する。形式不正は null を返し、呼び出し側がエラー種別を選ぶ。
 */

import type { CommitResult, NoteContent, NoteIndexData, NoteSaveResult } from '@/application/note';
import type {
  VaultSyncConflict,
  VaultSyncResult,
  VaultSyncStatus,
  VaultTreeData,
} from '@/application/vault';
import type { TreeEntry } from '@/domain/tree';
import type { Vault } from '@/domain/vault';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** /api/vaults の応答を Vault 列にパースする（形式不正は null） */
export function parseVaultsBody(body: unknown): readonly Vault[] | null {
  if (!isRecord(body) || !Array.isArray(body.vaults)) {
    return null;
  }
  const vaults: Vault[] = [];
  for (const item of body.vaults) {
    if (!isRecord(item)) {
      continue;
    }
    const owner = readString(item.owner);
    const name = readString(item.name);
    if (!owner || !name) {
      continue;
    }
    vaults.push({
      owner,
      name,
      fullName: readString(item.fullName) ?? `${owner}/${name}`,
      description: readString(item.description),
      isPrivate: item.isPrivate === true,
      defaultBranch: readString(item.defaultBranch) ?? 'main',
      updatedAt: readString(item.updatedAt) ?? '',
    });
  }
  return vaults;
}

/** /api/tree の応答を VaultTreeData にパースする（形式不正は null） */
export function parseTreeBody(body: unknown): VaultTreeData | null {
  if (!isRecord(body) || !Array.isArray(body.entries)) {
    return null;
  }
  const entries: TreeEntry[] = [];
  for (const item of body.entries) {
    if (!isRecord(item)) {
      continue;
    }
    const entryPath = readString(item.path);
    if (!entryPath) {
      continue;
    }
    if (item.type === 'file' || item.type === 'directory') {
      entries.push({ path: entryPath, type: item.type });
    }
  }
  return {
    defaultBranch: readString(body.defaultBranch) ?? 'main',
    truncated: body.truncated === true,
    entries,
  };
}

/** /api/notes の応答を NoteContent にパースする（形式不正は null） */
export function parseNoteBody(body: unknown): NoteContent | null {
  if (!isRecord(body)) {
    return null;
  }
  const notePath = readString(body.path);
  const sha = readString(body.sha);
  const content = readString(body.content);
  if (!notePath || !sha || content === null) {
    return null;
  }
  return { path: notePath, sha, content };
}

/** /api/notes/:owner/:repo/all の応答を NoteIndexData にパースする（形式不正は null） */
export function parseNoteIndexBody(body: unknown): NoteIndexData | null {
  if (!isRecord(body) || !Array.isArray(body.notes)) {
    return null;
  }
  const notes: NoteContent[] = [];
  for (const item of body.notes) {
    if (!isRecord(item)) {
      continue;
    }
    const notePath = readString(item.path);
    const sha = readString(item.sha);
    const content = readString(item.content);
    if (!notePath || !sha || content === null) {
      continue;
    }
    notes.push({ path: notePath, sha, content });
  }
  return {
    defaultBranch: readString(body.defaultBranch) ?? 'main',
    truncated: body.truncated === true,
    notes,
  };
}

/** /api/notes 保存応答を NoteSaveResult にパースする（形式不正は null） */
export function parseNoteSaveBody(body: unknown): NoteSaveResult | null {
  if (!isRecord(body)) {
    return null;
  }
  const notePath = readString(body.path);
  const sha = readString(body.sha);
  if (!notePath || !sha) {
    return null;
  }
  return { path: notePath, sha };
}

/** /api/files 一括コミット応答を CommitResult にパースする（形式不正は null） */
export function parseCommitResultBody(body: unknown): CommitResult | null {
  if (!isRecord(body)) {
    return null;
  }
  const owner = readString(body.owner);
  const name = readString(body.name);
  const branch = readString(body.branch);
  const commitSha = readString(body.commitSha);
  if (!owner || !name || !branch || !commitSha) {
    return null;
  }
  return { owner, name, branch, commitSha };
}

/** /api/vaults/:owner/:repo/sync の応答を VaultSyncResult にパースする（形式不正は null） */
export function parseSyncBody(body: unknown): VaultSyncResult | null {
  if (!isRecord(body)) {
    return null;
  }
  const owner = readString(body.owner);
  const name = readString(body.name);
  if (
    !owner ||
    !name ||
    (body.status !== 'initialized' &&
      body.status !== 'already_synced' &&
      body.status !== 'synced' &&
      body.status !== 'syncing')
  ) {
    return null;
  }
  const conflicts = parseConflicts(body.conflicts);
  return {
    owner,
    name,
    status: body.status,
    defaultBranch: readString(body.defaultBranch) ?? 'main',
    notes: typeof body.notes === 'number' ? body.notes : 0,
    ...(typeof body.syncedAt === 'string' ? { syncedAt: body.syncedAt } : {}),
    ...(typeof body.pulled === 'number' ? { pulled: body.pulled } : {}),
    ...(typeof body.pushed === 'number' ? { pushed: body.pushed } : {}),
    ...(conflicts !== undefined ? { conflicts } : {}),
    ...(typeof body.remaining === 'number' ? { remaining: body.remaining } : {}),
  };
}

/** 同期衝突列を読む（配列でなければ undefined） */
function parseConflicts(value: unknown): VaultSyncConflict[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const conflicts: VaultSyncConflict[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const path = readString(item.path);
    if (!path || typeof item.local !== 'string' || typeof item.remote !== 'string') {
      continue;
    }
    const remoteSha = readString(item.remoteSha);
    conflicts.push({ path, local: item.local, remote: item.remote, remoteSha });
  }
  return conflicts;
}

/** /api/vaults/:owner/:repo/sync（GET）の応答を VaultSyncStatus にパースする */
export function parseSyncStatusBody(body: unknown): VaultSyncStatus | null {
  if (!isRecord(body)) {
    return null;
  }
  const owner = readString(body.owner);
  const name = readString(body.name);
  if (!owner || !name) {
    return null;
  }
  return {
    owner,
    name,
    syncedAt: readString(body.syncedAt),
    lastSyncError: readString(body.lastSyncError),
    lastFailedAt: readString(body.lastFailedAt),
  };
}
