/**
 * GitHub API プロキシ系 Functions（Vault 一覧 / ファイルツリー）の共通基盤。
 *
 * - 認証: M2 の暗号化 Cookie（functions/api/auth/_lib/session）を再利用し、
 *   リクエストからアクセストークンを復号する。トークンは Workers 側のみ保持。
 * - PAT モード: `TEKTITE_PAT_AUTH === 'true'` かつ `GITHUB_PERSONAL_TOKEN` が
 *   設定されたローカル専用フォールバック。有効時はセッション Cookie を一切
 *   読まず（PAT 優先）、OAuth 4 変数を必要としない。
 * - GitHub API 呼び出し: ヘッダー規約を統一した fetch ヘルパーを使う。
 * - エラー envelope: GitHub の失敗応答を UI が扱いやすい形に変換する
 *   （401 → unauthenticated / 403・429 → rate_limited / 404 → not_found / その他 → 502）。
 *
 * 環境変数のテストシーム（GITHUB_API_BASE_URL）は M2 と同じ仕組みで、
 * E2E ではローカルのモック GitHub サーバーに差し替えられる。
 */

import { clearSessionCookie, readAccessToken } from '@/api/_lib/session';

const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';

export class ProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyConfigError';
  }
}

/**
 * PAT モードが有効かどうか。
 * `TEKTITE_PAT_AUTH === 'true'` かつ `GITHUB_PERSONAL_TOKEN` が空でない時のみ true。
 * それ以外の値のバリエーションは判定しない（完全一致のみ）。
 */
export function isPatModeEnabled(env: Env): boolean {
  return env.TEKTITE_PAT_AUTH === 'true' && !!env.GITHUB_PERSONAL_TOKEN;
}

export interface ProxyConfig {
  /** セッション Cookie 復号用の鍵。PAT モードでは null（不要） */
  sessionSecret: string | null;
  /** PAT モード時のトークン。OAuth モードでは null */
  patToken: string | null;
  /** サーバー側 GitHub API ベース URL（E2E でモック差し替え可能） */
  apiBaseUrl: string;
}

/** プロキシ系エンドポイントに必要な設定だけを検証する（OAuth 資格情報は不要） */
export function resolveProxyConfig(env: Env): ProxyConfig {
  if (isPatModeEnabled(env)) {
    // PAT モードでは SESSION_SECRET を必要としない
    return {
      sessionSecret: null,
      patToken: env.GITHUB_PERSONAL_TOKEN ?? null,
      apiBaseUrl: env.GITHUB_API_BASE_URL ?? DEFAULT_GITHUB_API_BASE_URL,
    };
  }
  if (!env.SESSION_SECRET) {
    throw new ProxyConfigError('環境変数 SESSION_SECRET が設定されていません');
  }
  return {
    sessionSecret: env.SESSION_SECRET,
    patToken: null,
    apiBaseUrl: env.GITHUB_API_BASE_URL ?? DEFAULT_GITHUB_API_BASE_URL,
  };
}

export type ProxyAuthResult = { ok: true; token: string } | { ok: false; response: Response };

/**
 * 認証を解決する。PAT モードでは Cookie を一切読まず常に PAT を使う（PAT 優先）。
 * OAuth モードではセッション Cookie を復号し、未ログインなら 401 応答を返す。
 */
export async function authenticateRequest(
  request: Request,
  config: ProxyConfig,
): Promise<ProxyAuthResult> {
  if (config.patToken) {
    return { ok: true, token: config.patToken };
  }
  const token = await readAccessToken(request, config.sessionSecret ?? '');
  if (!token) {
    return { ok: false, response: Response.json({ error: 'unauthenticated' }, { status: 401 }) };
  }
  return { ok: true, token };
}

/** GitHub API への fetch（ヘッダー規約を統一する。raw 配信は headers で上書き可能） */
export async function githubApiFetch(
  baseUrl: string,
  path: string,
  token: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'tektite',
    'X-GitHub-Api-Version': '2022-11-28',
    ...init.headers,
  };
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body,
  });
}

/** GitHub API の失敗応答をプロキシのエラー envelope に変換する（成功時は null） */
export function mapGithubFailure(response: Response): Response | null {
  if (response.ok) {
    return null;
  }
  if (response.status === 401) {
    // トークンが無効化されているためセッションも破棄する（/api/auth/me と同じ挙動）
    const headers = new Headers();
    headers.append('Set-Cookie', clearSessionCookie());
    return Response.json({ error: 'unauthenticated' }, { status: 401, headers });
  }
  if (response.status === 403 || response.status === 429) {
    return Response.json({ error: 'rate_limited' }, { status: 429 });
  }
  if (response.status === 404) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  return Response.json({ error: 'github_error' }, { status: 502 });
}

/** GitHub へのネットワーク到達失敗（502） */
export function githubUnreachable(): Response {
  return Response.json({ error: 'github_unreachable' }, { status: 502 });
}
