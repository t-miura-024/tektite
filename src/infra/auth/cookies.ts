/**
 * Cookie のパース/シリアライズ（純 TS・プラットフォーム非依存）。
 *
 * Pages Functions（Workers ランタイム）とユニットテストの両方で使うため、
 * フレームワークや Cookie ライブラリに依存しない最小実装を置く。
 */

export type SameSite = 'Strict' | 'Lax' | 'None';

export interface CookieOptions {
  /** Max-Age（秒）。省略時はセッション Cookie */
  maxAge?: number;
  /** Path。省略時は '/' */
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: SameSite;
}

/**
 * Cookie ヘッダー文字列をパースする。重複時は後の値を優先する。
 */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }
  for (const part of header.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const name = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (name.length === 0) {
      continue;
    }
    cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

/**
 * Set-Cookie 用の文字列を生成する。
 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  segments.push(`Path=${options.path ?? '/'}`);
  if (options.maxAge !== undefined) {
    segments.push(`Max-Age=${Math.trunc(options.maxAge)}`);
  }
  if (options.sameSite) {
    segments.push(`SameSite=${options.sameSite}`);
  }
  if (options.secure) {
    segments.push('Secure');
  }
  if (options.httpOnly) {
    segments.push('HttpOnly');
  }
  return segments.join('; ');
}

/**
 * 指定名の Cookie を削除する Set-Cookie 文字列を生成する（Max-Age=0）。
 */
export function expireCookie(name: string, options: Omit<CookieOptions, 'maxAge'> = {}): string {
  return serializeCookie(name, '', { ...options, maxAge: 0 });
}
