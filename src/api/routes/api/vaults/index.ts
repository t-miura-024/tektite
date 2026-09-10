/**
 * Vault一覧。ログインユーザーのリポジトリを直近更新順に最大300件まで返す。
 * write権限がありアーカイブ済みでない候補だけを残し、ページングは逐次取得する。
 * 並列取得でレートリミットを圧迫しないよう、100件未満のページで早期終了する。
 * トークンは暗号化CookieかPATから解決し、失敗はUI向けenvelopeに変換する。
 */

import { createRoute } from 'honox/factory';

import { toRouteContext, type RouteContext } from '@/api/_lib/route-context';
import { isVaultCandidate } from '@/domain/vault';
import {
  isProxyConfigError,
  authenticateRequest,
  githubApiFetch,
  githubUnreachable,
  mapGithubFailure,
  resolveProxyConfig,
} from '@/api/_lib/github-proxy';

type GithubRepoPermissions = {
  admin?: boolean;
  push?: boolean;
  pull?: boolean;
};

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

type GithubRepo = {
  name?: unknown;
  full_name?: unknown;
  owner?: { login?: unknown };
  description?: unknown;
  private?: unknown;
  archived?: unknown;
  default_branch?: unknown;
  pushed_at?: unknown;
  updated_at?: unknown;
  permissions?: GithubRepoPermissions;
};

type VaultResponseBody = {
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  updatedAt: string;
};

const PER_PAGE = 100;
const MAX_PAGES = 3;

/**
 * リポジトリ一覧をページ単位で「逐次」取得する（100 件未満のページで早期終了）。
 * Promise.all で並列取得すると個人 Vault（< 100 件）でも常に 3 回の API 呼び出しを
 * 消費してレートリミットを圧迫するため、再帰で逐次ページングを表現する。
 * 戻り値が Response の場合はエラー応答（そのままクライアントに返す）。
 */
async function fetchRepoPages(
  config: { apiBaseUrl: string },
  token: string,
  page: number,
  accumulated: GithubRepo[],
): Promise<GithubRepo[] | Response> {
  if (page > MAX_PAGES) {
    return accumulated;
  }
  let response: Response;
  try {
    response = await githubApiFetch(
      config.apiBaseUrl,
      `/user/repos?affiliation=owner,collaborator&sort=pushed&direction=desc&per_page=${PER_PAGE}&page=${page}`,
      token,
    );
  } catch {
    return githubUnreachable();
  }
  const failure = mapGithubFailure(response);
  if (failure) {
    return failure;
  }
  const body: unknown = await response.json().catch(() => null);
  if (!Array.isArray(body)) {
    return Response.json({ error: 'github_error' }, { status: 502 });
  }
  const repos = body.filter((value: unknown): value is GithubRepo => {
    if (!isRecordObject(value)) {
      return false;
    }
    if (typeof value.name !== 'string') {
      return false;
    }
    if (!isRecordObject(value.owner)) {
      return false;
    }
    if (typeof value.owner.login !== 'string') {
      return false;
    }
    return true;
  });
  accumulated.push(...repos);
  if (repos.length < PER_PAGE) {
    return accumulated;
  }
  return fetchRepoPages(config, token, page + 1, accumulated);
}

export async function handleVaultsGet(context: RouteContext): Promise<Response> {
  const { env, request } = context;
  let config;
  try {
    config = resolveProxyConfig(env);
  } catch (error) {
    if (isProxyConfigError(error)) {
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

  // 自分が owner または collaborator のリポジトリを直近更新順に取得する
  const result = await fetchRepoPages(config, auth.token, 1, []);
  if (result instanceof Response) {
    return result;
  }
  const repos = result;

  const vaults: VaultResponseBody[] = [];
  for (const repo of repos) {
    if (
      !isVaultCandidate({
        hasWritePermission: repo.permissions?.push === true,
        isArchived: repo.archived === true,
      })
    ) {
      continue;
    }
    if (typeof repo.name !== 'string' || repo.name.length === 0) {
      continue;
    }
    if (!repo.owner || typeof repo.owner.login !== 'string' || repo.owner.login.length === 0) {
      continue;
    }
    const _owner = repo.owner.login;
    const _name = repo.name;
    const _updatedAt =
      typeof repo.pushed_at === 'string'
        ? repo.pushed_at
        : typeof repo.updated_at === 'string'
          ? repo.updated_at
          : '';
    const vault: VaultResponseBody = {
      owner: _owner,
      name: _name,
      fullName: typeof repo.full_name === 'string' ? repo.full_name : `${_owner}/${_name}`,
      description: typeof repo.description === 'string' ? repo.description : null,
      isPrivate: repo.private === true,
      defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : 'main',
      updatedAt: _updatedAt,
    };
    vaults.push(vault);
  }

  return Response.json({ vaults }, { headers: { 'Cache-Control': 'no-store' } });
}

export const GET = createRoute((c) =>
  handleVaultsGet(toRouteContext(c.env, c.req.raw, c.req.param())),
);
