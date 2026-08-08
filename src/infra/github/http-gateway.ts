/**
 * VaultGateway のブラウザ実装（Effect Layer）:
 * Pages Functions のプロキシエンドポイントを呼ぶ。
 *
 * - GET /api/vaults              … Vault 候補一覧（functions/api/vaults）
 * - GET /api/tree/:owner/:repo   … ファイルツリー（functions/api/tree）
 *
 * GitHub トークンは Workers 側のみ保持（ADR-0002）のため、ブラウザは
 * 暗号化 Cookie を意識せずプロキシの JSON 応答だけを読む。ブラウザから
 * api.github.com を直接呼ぶことはない（方針: Functions プロキシ経由に集約）。
 *
 * application 層が定義する VaultGateway（Effect Service）の具体実装を
 * Layer として提供する。組成（UI への注入）は src/composition が担う。
 */

import { Effect, Layer } from 'effect';

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

/** プロキシにリクエストし、HTTP ステータスを VaultFetchError に変換して JSON を返す */
function requestJson(path: string): Effect.Effect<unknown, VaultFetchError> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetch(path),
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
    if (response.status === 404) {
      return yield* Effect.fail(new VaultFetchError('not_found', 'Vault が見つかりませんでした。'));
    }
    if (!response.ok) {
      return yield* Effect.fail(
        new VaultFetchError('server', `データの取得に失敗しました（HTTP ${response.status}）。`),
      );
    }
    return yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (error) =>
        new VaultFetchError('server', 'サーバー応答の形式が不正です。', { cause: error }),
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

const invalidResponse = () =>
  Effect.fail(new VaultFetchError('server', 'サーバー応答の形式が不正です。'));

/** VaultGateway の本番実装（Pages Functions 経由） */
export const VaultGatewayLive = Layer.succeed(VaultGateway, {
  listVaults: () =>
    Effect.gen(function* () {
      const body = yield* requestJson('/api/vaults');
      const vaults = parseVaultsBody(body);
      if (vaults === null) {
        return yield* invalidResponse();
      }
      return vaults;
    }),

  fetchTree: (ref: VaultRef) =>
    Effect.gen(function* () {
      const path = `/api/tree/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`;
      const body = yield* requestJson(path);
      const data = parseTreeBody(body);
      if (data === null) {
        return yield* invalidResponse();
      }
      return data;
    }),
});
