import type { OAuthTokenResponse } from '@/api/_lib/token-store';

export type TokenResponseBody = {
  token_type?: string;
  error?: string;
  error_description?: string;
} & OAuthTokenResponse;

/** authorization code をトークンに交換する（失敗時は null） */
export async function exchangeCodeForToken(
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  state: string,
): Promise<Response | null> {
  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'tektite',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        state,
      }),
    });
    return response;
  } catch {
    return null;
  }
}

/** トークン応答から必要フィールドだけを型付きで取り出す */
export function extractTokenFields(tokenBody: unknown, accessToken: string): TokenResponseBody {
  if (typeof tokenBody !== 'object' || tokenBody === null) {
    return { access_token: accessToken };
  }
  return {
    access_token: accessToken,
    refresh_token:
      'refresh_token' in tokenBody && typeof tokenBody.refresh_token === 'string'
        ? tokenBody.refresh_token
        : undefined,
    expires_in:
      'expires_in' in tokenBody && typeof tokenBody.expires_in === 'number'
        ? tokenBody.expires_in
        : undefined,
    scope:
      'scope' in tokenBody && typeof tokenBody.scope === 'string' ? tokenBody.scope : undefined,
    error:
      'error' in tokenBody && typeof tokenBody.error === 'string' ? tokenBody.error : undefined,
    token_type:
      'token_type' in tokenBody && typeof tokenBody.token_type === 'string'
        ? tokenBody.token_type
        : undefined,
  };
}

export function parseTokenBody(tokenBody: unknown): {
  accessToken: string | undefined;
  errorCode: string | undefined;
} {
  const accessToken =
    typeof tokenBody === 'object' && tokenBody !== null && 'access_token' in tokenBody
      ? tokenBody.access_token
      : undefined;
  const errorCode =
    typeof tokenBody === 'object' && tokenBody !== null && 'error' in tokenBody
      ? tokenBody.error
      : undefined;
  return {
    accessToken: typeof accessToken === 'string' ? accessToken : undefined,
    errorCode: typeof errorCode === 'string' ? errorCode : undefined,
  };
}
