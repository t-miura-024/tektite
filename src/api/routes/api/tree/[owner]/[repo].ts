/**
 * ファイルツリー: GET /api/tree/:owner/:repo
 *
 * 対象 Vault のデフォルトブランチのファイルツリーを返す（MVP はデフォルト
 * ブランチのみ対象）。まずリポジトリ情報でデフォルトブランチを解決し、
 * Git Trees API（recursive=1）で 1 回にまとめて取得する。
 *
 * 応答:
 * - パラメータ不正                 → 400 { error: 'invalid_vault_ref' }
 * - 未ログイン                     → 401 { error: 'unauthenticated' }
 * - Vault（リポジトリ）が見つからない → 404 { error: 'not_found' }
 * - レートリミット（403 / 429）    → 429 { error: 'rate_limited' }
 * - 正常                           → 200 { owner, name, defaultBranch, truncated, entries }
 *
 * entries は [{ path, type: 'file' | 'directory' }] のフラット列。
 * 隠れディレクトリの除外・ツリー構築はクライアントのドメイン層（src/domain/tree）
 * が担当する。サブモジュール（type: 'commit'）は対象外のため含めない。
 */

import { createRoute } from 'honox/factory';

import type { RouteContext } from '@/api/_lib/route-context';
import { isValidGitHubName } from '@/domain/vault';
import {
  ProxyConfigError,
  authenticateRequest,
  githubApiFetch,
  githubUnreachable,
  mapGithubFailure,
  resolveProxyConfig,
} from '@/api/_lib/github-proxy';
import { readVaultMeta, readVaultTree, writeVaultTree } from '@/api/_lib/r2-vault';

interface GithubRepoInfo {
  default_branch?: unknown;
}

interface GithubTreeEntry {
  path?: unknown;
  type?: unknown;
  sha?: unknown;
}

interface GithubTreeResponse {
  sha?: unknown;
  truncated?: unknown;
  tree?: GithubTreeEntry[];
}

/** パスパラメータを文字列に正規化する（配列で渡された場合は先頭を採用） */
function paramToString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

export async function handleTreeGet(context: RouteContext): Promise<Response> {
  const { env, request, params } = context;
  const owner = paramToString(params.owner);
  const repoName = paramToString(params.repo);
  if (!isValidGitHubName(owner) || !isValidGitHubName(repoName)) {
    return Response.json({ error: 'invalid_vault_ref' }, { status: 400 });
  }

  let config;
  try {
    config = resolveProxyConfig(env);
  } catch (error) {
    if (error instanceof ProxyConfigError) {
      return Response.json(
        { error: 'auth_not_configured', message: error.message },
        { status: 503 },
      );
    }
    throw error;
  }

  const auth = await authenticateRequest(request, config);
  if (!auth.ok) {
    return auth.response;
  }

  // R2 が正: 初期同期済み（メタあり）の Vault はツリーを R2 から返す
  // （Vault を開くだけでは GitHub API を消費しない）
  const bucket = env.VAULT_BUCKET;
  if (bucket) {
    const meta = await readVaultMeta(bucket, owner, repoName);
    if (meta !== null) {
      const cached = await readVaultTree(bucket, owner, repoName);
      if (cached !== null) {
        return Response.json(
          {
            owner,
            name: repoName,
            defaultBranch: cached.defaultBranch,
            truncated: cached.truncated,
            entries: cached.entries.map(({ path, type }) => ({ path, type })),
          },
          { headers: { 'Cache-Control': 'no-store' } },
        );
      }
    }
  }

  // 1) リポジトリ情報からデフォルトブランチを解決する
  let repoResponse: Response;
  try {
    repoResponse = await githubApiFetch(
      config.apiBaseUrl,
      `/repos/${owner}/${repoName}`,
      auth.token,
    );
  } catch {
    return githubUnreachable();
  }
  const repoFailure = mapGithubFailure(repoResponse);
  if (repoFailure) {
    return repoFailure;
  }
  const repoInfo = (await repoResponse.json().catch(() => null)) as GithubRepoInfo | null;
  if (
    !repoInfo ||
    typeof repoInfo.default_branch !== 'string' ||
    repoInfo.default_branch.length === 0
  ) {
    return Response.json({ error: 'github_error' }, { status: 502 });
  }
  const defaultBranch = repoInfo.default_branch;

  // 2) Git Trees API でツリー全体を 1 回で取得する（個人 Vault 前提）
  let treeResponse: Response;
  try {
    treeResponse = await githubApiFetch(
      config.apiBaseUrl,
      `/repos/${owner}/${repoName}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
      auth.token,
    );
  } catch {
    return githubUnreachable();
  }
  const treeFailure = mapGithubFailure(treeResponse);
  if (treeFailure) {
    // コミットが 1 つもない空リポジトリは Trees API が 404 を返す（GitHub 実挙動）。
    // リポジトリ自体は上で取得成功済みなので、空ツリーとして扱う
    // （「最初のノートを作成」CTA の前提。M2）
    if (treeResponse.status === 404) {
      return Response.json(
        { owner, name: repoName, defaultBranch, truncated: false, entries: [] },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return treeFailure;
  }
  const treeBody = (await treeResponse.json().catch(() => null)) as GithubTreeResponse | null;
  if (!treeBody || !Array.isArray(treeBody.tree)) {
    return Response.json({ error: 'github_error' }, { status: 502 });
  }

  const entries: { path: string; type: 'file' | 'directory'; sha: string | null }[] = [];
  for (const entry of treeBody.tree) {
    if (typeof entry.path !== 'string' || entry.path.length === 0) {
      continue;
    }
    if (entry.type === 'blob') {
      entries.push({
        path: entry.path,
        type: 'file',
        sha: typeof entry.sha === 'string' && entry.sha.length > 0 ? entry.sha : null,
      });
    } else if (entry.type === 'tree') {
      entries.push({ path: entry.path, type: 'directory', sha: null });
    }
  }

  // 遅延キャッシュ: 初期同期済み Vault でツリーが R2 に無い場合は取得して書き戻す
  // （メタなし = 未同期の Vault は書き込まない。初期同期が全量を取り込む）
  if (bucket) {
    const meta = await readVaultMeta(bucket, owner, repoName);
    if (meta !== null) {
      const treeSha =
        typeof treeBody.sha === 'string' && treeBody.sha.length > 0 ? treeBody.sha : null;
      await writeVaultTree(bucket, owner, repoName, {
        defaultBranch,
        truncated: treeBody.truncated === true,
        treeSha,
        entries,
      });
    }
  }

  return Response.json(
    {
      owner,
      name: repoName,
      defaultBranch,
      truncated: treeBody.truncated === true,
      entries: entries.map(({ path, type }) => ({ path, type })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export const GET = createRoute((c) =>
  handleTreeGet({ env: c.env as Env, request: c.req.raw, params: c.req.param() }),
);
