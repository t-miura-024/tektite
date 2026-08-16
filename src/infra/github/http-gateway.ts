/**
 * Vault / ノートゲートウェイのブラウザ実装（Effect Layer）:
 * Pages Functions のプロキシエンドポイントを呼ぶ。
 *
 * - GET /api/vaults                          … Vault 候補一覧（functions/api/vaults）
 * - GET /api/tree/:owner/:repo               … ファイルツリー（functions/api/tree）
 * - GET /api/notes/:owner/:repo/blob/:path   … ノート本文 + sha（functions/api/notes）
 * - PUT /api/notes/:owner/:repo/blob/:path   … ノート保存（sha 楽観ロック）（functions/api/notes）
 *   （path は / 区切りを 1 セグメントにエンコードして渡す）
 *
 * GitHub トークンは Workers 側のみ保持（ADR-0002）のため、ブラウザは
 * 暗号化 Cookie を意識せずプロキシの JSON 応答だけを読む。ブラウザから
 * api.github.com を直接呼ぶことはない（方針: Functions プロキシ経由に集約）。
 *
 * application 層が定義する VaultGateway / NoteGateway（Effect Service）の
 * 具体実装を Layer として提供する。組成（UI への注入）は src/composition が担う。
 */

import { Effect, Layer } from 'effect';

import { FileCommitError, NoteFetchError, NoteGateway, NoteSaveError } from '@/application/note';
import type {
  CommitChangesInput,
  CommitResult,
  FileChange,
  NoteContent,
  NoteIndexData,
  NoteSaveRequest,
  NoteSaveResult,
} from '@/application/note';
import { VaultFetchError, VaultGateway } from '@/application/vault';
import type {
  VaultSyncConflict,
  VaultSyncResult,
  VaultSyncStatus,
  VaultTreeData,
} from '@/application/vault';
import type { TreeEntry } from '@/domain/tree';
import type { Vault, VaultRef } from '@/domain/vault';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** プロキシ系エラーの kind（Vault / ノート取得で共通の文字列合併型） */
type FetchErrorKind = 'unauthenticated' | 'rate_limited' | 'not_found' | 'server' | 'network';

/** 保存系エラーの kind（FetchErrorKind に conflict を加えたもの） */
type SaveErrorKind =
  | 'unauthenticated'
  | 'rate_limited'
  | 'conflict'
  | 'not_found'
  | 'server'
  | 'network';

/** UTF-8 文字列を base64（btoa 互換）にエンコードする（PUT の content 用） */
function encodeBase64Content(content: string): string {
  const bytes = new TextEncoder().encode(content);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** kind を持つ Error 派生クラスのコンストラクタ（VaultFetchError / NoteFetchError） */
interface FetchErrorConstructor<E extends Error> {
  new (kind: FetchErrorKind, message: string, options?: { cause?: unknown }): E;
}

/** kind を持つ Error 派生クラスのコンストラクタ（保存系。conflict を含む） */
interface SaveErrorConstructor<E extends Error> {
  new (kind: SaveErrorKind, message: string, options?: { cause?: unknown }): E;
}

/** プロキシにリクエストし、HTTP ステータスをエラー種別に変換して JSON を返す */
function requestJson<E extends Error>(
  path: string,
  ErrorCtor: FetchErrorConstructor<E>,
  init: { method?: 'GET' | 'POST' } = {},
): Effect.Effect<unknown, E> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(
          path,
          init.method === 'POST'
            ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
            : undefined,
        ),
      catch: (error) =>
        new ErrorCtor('network', 'サーバーと通信できませんでした。', { cause: error }),
    });
    if (response.status === 401) {
      return yield* Effect.fail(
        new ErrorCtor('unauthenticated', 'セッションの有効期限が切れました。'),
      );
    }
    if (response.status === 429) {
      return yield* Effect.fail(
        new ErrorCtor('rate_limited', 'GitHub API のレートリミットに達しました。'),
      );
    }
    if (response.status === 404) {
      return yield* Effect.fail(new ErrorCtor('not_found', 'リソースが見つかりませんでした。'));
    }
    if (!response.ok) {
      return yield* Effect.fail(
        new ErrorCtor('server', `データの取得に失敗しました（HTTP ${response.status}）。`),
      );
    }
    return yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (error) => new ErrorCtor('server', 'サーバー応答の形式が不正です。', { cause: error }),
    });
  });
}

/**
 * 保存/一括コミット（PUT / POST）専用のリクエスト。取得系（requestJson）と違って
 * JSON ボディを送り、409（sha 楽観ロック競合・ブランチ競合）を conflict として
 * 区別して返す。エラー種別（ErrorCtor）は呼び出し側が選ぶ。
 */
function requestSave<E extends Error>(
  path: string,
  body: unknown,
  ErrorCtor: SaveErrorConstructor<E>,
  options: { method?: 'PUT' | 'POST'; conflictMessage?: string } = {},
): Effect.Effect<unknown, E> {
  const method = options.method ?? 'PUT';
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(path, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      catch: (error) =>
        new ErrorCtor('network', 'サーバーと通信できませんでした。', { cause: error }),
    });
    if (response.status === 401) {
      return yield* Effect.fail(
        new ErrorCtor('unauthenticated', 'セッションの有効期限が切れました。'),
      );
    }
    if (response.status === 429) {
      return yield* Effect.fail(
        new ErrorCtor('rate_limited', 'GitHub API のレートリミットに達しました。'),
      );
    }
    if (response.status === 404) {
      return yield* Effect.fail(new ErrorCtor('not_found', 'リソースが見つかりませんでした。'));
    }
    if (response.status === 409) {
      return yield* Effect.fail(
        new ErrorCtor(
          'conflict',
          options.conflictMessage ?? '保存前にリモートの内容が変更されていました。',
        ),
      );
    }
    if (!response.ok) {
      return yield* Effect.fail(
        new ErrorCtor('server', `保存に失敗しました（HTTP ${response.status}）。`),
      );
    }
    return yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (error) => new ErrorCtor('server', 'サーバー応答の形式が不正です。', { cause: error }),
    });
  });
}

/** /api/vaults の応答を Vault 列にパースする（形式不正は null） */
function parseVaultsBody(body: unknown): readonly Vault[] | null {
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
function parseTreeBody(body: unknown): VaultTreeData | null {
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
function parseNoteBody(body: unknown): NoteContent | null {
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
function parseNoteIndexBody(body: unknown): NoteIndexData | null {
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
function parseNoteSaveBody(body: unknown): NoteSaveResult | null {
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
function parseCommitResultBody(body: unknown): CommitResult | null {
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
function parseSyncBody(body: unknown): VaultSyncResult | null {
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
  let conflicts: VaultSyncConflict[] | undefined;
  if (Array.isArray(body.conflicts)) {
    conflicts = [];
    for (const item of body.conflicts) {
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
  }
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

/** /api/vaults/:owner/:repo/sync（GET）の応答を VaultSyncStatus にパースする */
function parseSyncStatusBody(body: unknown): VaultSyncStatus | null {
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

const invalidVaultResponse = () =>
  Effect.fail(new VaultFetchError('server', 'サーバー応答の形式が不正です。'));

const invalidNoteResponse = () =>
  Effect.fail(new NoteFetchError('server', 'サーバー応答の形式が不正です。'));

const invalidNoteSaveResponse = () =>
  Effect.fail(new NoteSaveError('server', 'サーバー応答の形式が不正です。'));

/** VaultGateway の本番実装（Pages Functions 経由） */
export const VaultGatewayLive = Layer.succeed(VaultGateway, {
  listVaults: () =>
    Effect.gen(function* () {
      const body = yield* requestJson('/api/vaults', VaultFetchError);
      const vaults = parseVaultsBody(body);
      if (vaults === null) {
        return yield* invalidVaultResponse();
      }
      return vaults;
    }),

  fetchTree: (ref: VaultRef) =>
    Effect.gen(function* () {
      const path = `/api/tree/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`;
      const body = yield* requestJson(path, VaultFetchError);
      const data = parseTreeBody(body);
      if (data === null) {
        return yield* invalidVaultResponse();
      }
      return data;
    }),

  initializeSync: (ref: VaultRef) =>
    Effect.gen(function* () {
      const path = `/api/vaults/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/sync`;
      const body = yield* requestJson(path, VaultFetchError, { method: 'POST' });
      const result = parseSyncBody(body);
      if (result === null) {
        return yield* invalidVaultResponse();
      }
      return result;
    }),

  syncVault: (ref: VaultRef) =>
    Effect.gen(function* () {
      // 明示同期: body の action: 'sync' で差分同期（プル + プッシュ）を実行させる
      const path = `/api/vaults/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/sync`;
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'sync' }),
          }),
        catch: (error) =>
          new VaultFetchError('network', 'サーバーと通信できませんでした。', { cause: error }),
      });
      if (response.status === 401) {
        return yield* Effect.fail(
          new VaultFetchError('unauthenticated', 'セッションの有効期限が切れました。'),
        );
      }
      if (response.status === 429) {
        return yield* Effect.fail(
          new VaultFetchError('rate_limited', 'GitHub API のレートリミットに達しました。'),
        );
      }
      if (!response.ok) {
        return yield* Effect.fail(
          new VaultFetchError('server', `同期に失敗しました（HTTP ${response.status}）。`),
        );
      }
      const body = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (error) =>
          new VaultFetchError('server', 'サーバー応答の形式が不正です。', { cause: error }),
      });
      const result = parseSyncBody(body);
      if (result === null) {
        return yield* invalidVaultResponse();
      }
      return result;
    }),

  fetchSyncStatus: (ref: VaultRef) =>
    Effect.gen(function* () {
      const path = `/api/vaults/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/sync`;
      const body = yield* requestJson(path, VaultFetchError);
      const result = parseSyncStatusBody(body);
      if (result === null) {
        return yield* invalidVaultResponse();
      }
      return result;
    }),

  resolveSyncConflict: (ref: VaultRef, notePath: string, resolution: 'overwrite' | 'adopt') =>
    Effect.gen(function* () {
      const path = `/api/vaults/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/sync/resolve`;
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: notePath, resolution }),
          }),
        catch: (error) =>
          new VaultFetchError('network', 'サーバーと通信できませんでした。', { cause: error }),
      });
      if (response.status === 401) {
        return yield* Effect.fail(
          new VaultFetchError('unauthenticated', 'セッションの有効期限が切れました。'),
        );
      }
      if (response.status === 429) {
        return yield* Effect.fail(
          new VaultFetchError('rate_limited', 'GitHub API のレートリミットに達しました。'),
        );
      }
      if (!response.ok) {
        return yield* Effect.fail(
          new VaultFetchError(
            'server',
            `同期衝突を解決できませんでした（HTTP ${response.status}）。`,
          ),
        );
      }
      const body = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (error) =>
          new VaultFetchError('server', 'サーバー応答の形式が不正です。', { cause: error }),
      });
      const sha = isRecord(body) ? readString(body.sha) : null;
      if (sha === null) {
        return yield* invalidVaultResponse();
      }
      return sha;
    }),
});

/** NoteGateway の本番実装（Pages Functions 経由） */
export const NoteGatewayLive = Layer.succeed(NoteGateway, {
  fetchNote: (ref: VaultRef, notePath: string) =>
    Effect.gen(function* () {
      // Pages Functions はキャッチオールを持てないため、ノートパス全体（/ 区切り）を
      // 1 セグメントにパーセントエンコードして blob/:path に渡す
      const path = `/api/notes/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/blob/${encodeURIComponent(notePath)}`;
      const body = yield* requestJson(path, NoteFetchError);
      const note = parseNoteBody(body);
      if (note === null) {
        return yield* invalidNoteResponse();
      }
      return note;
    }),

  fetchAllNotes: (ref: VaultRef) =>
    Effect.gen(function* () {
      const path = `/api/notes/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/all`;
      const body = yield* requestJson(path, NoteFetchError);
      const data = parseNoteIndexBody(body);
      if (data === null) {
        return yield* invalidNoteResponse();
      }
      return data;
    }),

  saveNote: (ref: VaultRef, notePath: string, request: NoteSaveRequest) =>
    Effect.gen(function* () {
      const path = `/api/notes/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/blob/${encodeURIComponent(notePath)}`;
      // sha が null の新規作成は JSON からキーごと落とす（プロキシが Create として扱う）。
      // content はプロキシ（functions/api/notes）の規約に合わせて base64 で渡す
      const body = yield* requestSave(
        path,
        {
          content: encodeBase64Content(request.content),
          message: request.message,
          ...(request.sha === null ? {} : { sha: request.sha }),
        },
        NoteSaveError,
      );
      const saved = parseNoteSaveBody(body);
      if (saved === null) {
        return yield* invalidNoteSaveResponse();
      }
      return saved;
    }),

  commitChanges: (ref: VaultRef, input: CommitChangesInput) =>
    Effect.gen(function* () {
      const path = `/api/files/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/commit`;
      // content は base64（/api/notes 保存と同じ規約）。create-binary は既に base64 の
      // ためそのまま渡し、サーバーの 'create' として送る（UTF-8 経由にすると二重
      // エンコードで画像が壊れる）。move / delete は content なし
      const changes: FileChange[] = input.changes.map((change) => {
        if (change.op === 'create-binary') {
          return { op: 'create', path: change.path, content: change.base64 } as const;
        }
        return change.op === 'create' || change.op === 'update'
          ? { ...change, content: encodeBase64Content(change.content) }
          : change;
      });
      const body = yield* requestSave(path, { changes, message: input.message }, FileCommitError, {
        method: 'POST',
        conflictMessage: 'コミット前にリモートが変更されていました。',
      });
      const result = parseCommitResultBody(body);
      if (result === null) {
        return yield* Effect.fail(new FileCommitError('server', 'サーバー応答の形式が不正です。'));
      }
      return result;
    }),
});
