/**
 * VaultGateway のブラウザ実装: Pages Functions のプロキシエンドポイントを呼ぶ。
 *
 * - GET /api/vaults              … Vault 候補一覧（functions/api/vaults）
 * - GET /api/tree/:owner/:repo   … ファイルツリー（functions/api/tree）
 *
 * GitHub トークンは Workers 側のみ保持（ADR-0002）のため、ブラウザは
 * 暗号化 Cookie を意識せずプロキシの JSON 応答だけを読む。ブラウザから
 * api.github.com を直接呼ぶことはない（方針: Functions プロキシ経由に集約）。
 */

import type { VaultGateway, VaultTreeData } from '@/application/vault';
import { VaultFetchError } from '@/application/vault';
import type { TreeEntry } from '@/domain/tree';
import type { Vault, VaultRef } from '@/domain/vault';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** プロキシにリクエストし、HTTP ステータスを VaultFetchError に変換して JSON を返す */
async function requestJson(path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path);
  } catch (error) {
    throw new VaultFetchError('network', 'サーバーと通信できませんでした。', { cause: error });
  }
  if (response.status === 401) {
    throw new VaultFetchError('unauthenticated', 'セッションの有効期限が切れました。');
  }
  if (response.status === 429) {
    throw new VaultFetchError('rate_limited', 'GitHub API のレートリミットに達しました。');
  }
  if (response.status === 404) {
    throw new VaultFetchError('not_found', 'Vault が見つかりませんでした。');
  }
  if (!response.ok) {
    throw new VaultFetchError('server', `データの取得に失敗しました（HTTP ${response.status}）。`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new VaultFetchError('server', 'サーバー応答の形式が不正です。', { cause: error });
  }
}

export class HttpVaultGateway implements VaultGateway {
  async listVaults(): Promise<readonly Vault[]> {
    const body = await requestJson('/api/vaults');
    if (!isRecord(body) || !Array.isArray(body.vaults)) {
      throw new VaultFetchError('server', 'サーバー応答の形式が不正です。');
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

  async fetchTree(ref: VaultRef): Promise<VaultTreeData> {
    const path = `/api/tree/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`;
    const body = await requestJson(path);
    if (!isRecord(body) || !Array.isArray(body.entries)) {
      throw new VaultFetchError('server', 'サーバー応答の形式が不正です。');
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
}
