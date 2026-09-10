/**
 * Vault / ノートゲートウェイのブラウザ実装（Effect Layer）。Pages Functions のプロキシ
 * 経由で呼び、トークンは Workers 側保持のためブラウザは JSON 応答だけを読む。GitHub
 * 直呼びはしない。VaultGateway / NoteGateway の具体実装を Layer として提供し、
 * 応答パースと通信は別モジュール、組成は composition が担う。
 */

import { Effect, Layer } from 'effect';

import {
  fileCommitError,
  noteFetchError,
  NoteGateway,
  noteSaveError,
  type CommitChangesInput,
  type FileChange,
  type NoteSaveRequest,
} from '@/application/note';
import { vaultFetchError, VaultGateway, type VaultFetchError } from '@/application/vault';
import type { VaultRef } from '@/domain/vault';
import { encodeBase64Content, requestJson, requestSave } from '@/infra/github/proxy-request';
import {
  parseCommitResultBody,
  parseNoteBody,
  parseNoteIndexBody,
  parseNoteSaveBody,
  parseSyncBody,
  parseSyncStatusBody,
  parseTreeBody,
  parseVaultsBody,
} from '@/infra/github/response-parser';

const invalidVaultResponse = (): Effect.Effect<never, VaultFetchError> =>
  Effect.fail(vaultFetchError('server', 'サーバー応答の形式が不正です。'));

const invalidNoteResponse = (): Effect.Effect<never, ReturnType<typeof noteFetchError>> =>
  Effect.fail(noteFetchError('server', 'サーバー応答の形式が不正です。'));

const invalidNoteSaveResponse = (): Effect.Effect<never, ReturnType<typeof noteSaveError>> =>
  Effect.fail(noteSaveError('server', 'サーバー応答の形式が不正です。'));

/** 同期系 POST の共通前処理（ステータス → エラー変換のみ。404 も server 扱い） */
function syncRequest(path: string, body: unknown): Effect.Effect<Response, VaultFetchError> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      catch: (error) =>
        vaultFetchError('network', 'サーバーと通信できませんでした。', { cause: error }),
    });
    if (response.status === 401) {
      return yield* Effect.fail(
        vaultFetchError('unauthenticated', 'セッションの有効期限が切れました。'),
      );
    }
    if (response.status === 429) {
      return yield* Effect.fail(
        vaultFetchError('rate_limited', 'GitHub API のレートリミットに達しました。'),
      );
    }
    return response.ok
      ? response
      : yield* Effect.fail(
          vaultFetchError('server', `同期に失敗しました（HTTP ${response.status}）。`),
        );
  });
}

/** 同期系 POST の JSON 応答を読む（形式不正は server エラー） */
function readJson(response: Response): Effect.Effect<unknown, VaultFetchError> {
  return Effect.tryPromise({
    try: (): Promise<unknown> => response.json(),
    catch: (error) => vaultFetchError('server', 'サーバー応答の形式が不正です。', { cause: error }),
  });
}

function syncPath(ref: VaultRef): string {
  return `/api/vaults/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/sync`;
}

/** VaultGateway の本番実装（Pages Functions 経由） */
export const VaultGatewayLive = Layer.succeed(VaultGateway, {
  listVaults: () =>
    Effect.gen(function* () {
      const body = yield* requestJson('/api/vaults', vaultFetchError);
      const vaults = parseVaultsBody(body);
      if (vaults === null) {
        return yield* invalidVaultResponse();
      }
      return vaults;
    }),

  fetchTree: (ref: VaultRef) =>
    Effect.gen(function* () {
      const path = `/api/tree/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`;
      const body = yield* requestJson(path, vaultFetchError);
      const treeData = parseTreeBody(body);
      if (treeData === null) {
        return yield* invalidVaultResponse();
      }
      return treeData;
    }),

  initializeSync: (ref: VaultRef) =>
    Effect.gen(function* () {
      const path = syncPath(ref);
      const body = yield* requestJson(path, vaultFetchError, { method: 'POST' });
      const result = parseSyncBody(body);
      if (result === null) {
        return yield* invalidVaultResponse();
      }
      return result;
    }),

  syncVault: (ref: VaultRef) =>
    Effect.gen(function* () {
      // 明示同期: body の action: 'sync' で差分同期（プル + プッシュ）を実行させる
      const response = yield* syncRequest(syncPath(ref), { action: 'sync' });
      const body = yield* readJson(response);
      const result = parseSyncBody(body);
      if (result === null) {
        return yield* invalidVaultResponse();
      }
      return result;
    }),

  fetchSyncStatus: (ref: VaultRef) =>
    Effect.gen(function* () {
      const body = yield* requestJson(syncPath(ref), vaultFetchError);
      const status = parseSyncStatusBody(body);
      if (status === null) {
        return yield* invalidVaultResponse();
      }
      return status;
    }),

  resolveSyncConflict: (ref: VaultRef, notePath: string, resolution: 'overwrite' | 'adopt') =>
    Effect.gen(function* () {
      const path = `${syncPath(ref)}/resolve`;
      const response = yield* syncRequest(path, { path: notePath, resolution });
      const body = yield* readJson(response);
      const sha =
        typeof body === 'object' && body !== null && 'sha' in body && typeof body.sha === 'string'
          ? body.sha
          : null;
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
      const body = yield* requestJson(path, noteFetchError);
      const note = parseNoteBody(body);
      if (note === null) {
        return yield* invalidNoteResponse();
      }
      return note;
    }),

  fetchAllNotes: (ref: VaultRef) =>
    Effect.gen(function* () {
      const path = `/api/notes/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/all`;
      const body = yield* requestJson(path, noteFetchError);
      const indexData = parseNoteIndexBody(body);
      if (indexData === null) {
        return yield* invalidNoteResponse();
      }
      return indexData;
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
        noteSaveError,
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
      const changes: FileChange[] = input.changes.map((change): FileChange => {
        if (change.op === 'create-binary') {
          return { op: 'create', path: change.path, content: change.base64 };
        }
        return change.op === 'create' || change.op === 'update'
          ? { ...change, content: encodeBase64Content(change.content) }
          : change;
      });
      const body = yield* requestSave(path, { changes, message: input.message }, fileCommitError, {
        method: 'POST',
        conflictMessage: 'コミット前にリモートが変更されていました。',
      });
      const result = parseCommitResultBody(body);
      if (result === null) {
        return yield* Effect.fail(fileCommitError('server', 'サーバー応答の形式が不正です。'));
      }
      return result;
    }),
});
