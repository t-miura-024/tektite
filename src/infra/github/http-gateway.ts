/**
 * Vault / ノートゲートウェイのブラウザ実装（Effect Layer）:
 * Pages Functions のプロキシエンドポイントを呼ぶ。
 *
 * - GET /api/vaults                          … Vault 候補一覧（functions/api/vaults）
 * - GET /api/tree/:owner/:repo               … ファイルツリー（functions/api/tree）
 * - GET /api/notes/:owner/:repo/blob/:path   … ノート本文 + sha（functions/api/notes）
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

import { NoteFetchError, NoteGateway } from '@/application/note';
import type { NoteContent } from '@/application/note';
import { VaultFetchError, VaultGateway } from '@/application/vault';
import type { VaultTreeData } from '@/application/vault';
import type { TreeEntry } from '@/domain/tree';
import type { Vault, VaultRef } from '@/domain/vault';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** プロキシ系エラーの kind（Vault / ノートで共通の文字列合併型） */
type FetchErrorKind = 'unauthenticated' | 'rate_limited' | 'not_found' | 'server' | 'network';

/** kind を持つ Error 派生クラスのコンストラクタ（VaultFetchError / NoteFetchError） */
interface FetchErrorConstructor<E extends Error> {
  new (kind: FetchErrorKind, message: string, options?: { cause?: unknown }): E;
}

/** プロキシにリクエストし、HTTP ステータスをエラー種別に変換して JSON を返す */
function requestJson<E extends Error>(
  path: string,
  ErrorCtor: FetchErrorConstructor<E>,
): Effect.Effect<unknown, E> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetch(path),
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

const invalidVaultResponse = () =>
  Effect.fail(new VaultFetchError('server', 'サーバー応答の形式が不正です。'));

const invalidNoteResponse = () =>
  Effect.fail(new NoteFetchError('server', 'サーバー応答の形式が不正です。'));

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
});
