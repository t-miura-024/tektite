/**
 * Vault 一覧: GET /api/vaults
 *
 * ログインユーザーのリポジトリを Vault 候補として一覧する。
 * トークンは暗号化 Cookie から復号（M2 の session 実装を再利用）。
 *
 * - Vault 候補のフィルタはドメインロジック（src/domain/vault の isVaultCandidate）:
 *   write（push）権限があり、アーカイブ済みでないリポジトリのみ。
 * - 個人利用の規模を前提に、直近更新順で最大 300 件（100 件 × 3 ページ）取得する。
 *
 * 応答:
 * - 未ログイン                     → 401 { error: 'unauthenticated' }
 * - GitHub 到達不能                → 502 { error: 'github_unreachable' }
 * - レートリミット（403 / 429）    → 429 { error: 'rate_limited' }
 * - 正常                           → 200 { vaults: [...] }
 */

import { isVaultCandidate } from '@/domain/vault';
import {
  ProxyConfigError,
  authenticateRequest,
  githubApiFetch,
  githubUnreachable,
  mapGithubFailure,
  resolveProxyConfig,
} from '@functions/api/_lib/github-proxy';

interface GithubRepoPermissions {
  admin?: boolean;
  push?: boolean;
  pull?: boolean;
}

interface GithubRepo {
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
}

interface VaultResponseBody {
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  updatedAt: string;
}

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
  const body = (await response.json().catch(() => null)) as GithubRepo[] | null;
  if (!Array.isArray(body)) {
    return Response.json({ error: 'github_error' }, { status: 502 });
  }
  accumulated.push(...body);
  if (body.length < PER_PAGE) {
    return accumulated;
  }
  return fetchRepoPages(config, token, page + 1, accumulated);
}

function toVault(repo: GithubRepo): VaultResponseBody | null {
  if (typeof repo.name !== 'string' || repo.name.length === 0) {
    return null;
  }
  if (!repo.owner || typeof repo.owner.login !== 'string' || repo.owner.login.length === 0) {
    return null;
  }
  const owner = repo.owner.login;
  const name = repo.name;
  const updatedAt =
    typeof repo.pushed_at === 'string'
      ? repo.pushed_at
      : typeof repo.updated_at === 'string'
        ? repo.updated_at
        : '';
  return {
    owner,
    name,
    fullName: typeof repo.full_name === 'string' ? repo.full_name : `${owner}/${name}`,
    description: typeof repo.description === 'string' ? repo.description : null,
    isPrivate: repo.private === true,
    defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : 'main',
    updatedAt,
  };
}

export const onRequestGet: PagesFunction<Env, 'api/vaults'> = async ({ env, request }) => {
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
    const vault = toVault(repo);
    if (vault) {
      vaults.push(vault);
    }
  }

  return Response.json({ vaults }, { headers: { 'Cache-Control': 'no-store' } });
};
