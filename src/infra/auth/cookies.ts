/**
 * Cookie のパース/シリアライズ（純 TS・プラットフォーム非依存）。
 *
 * Pages Functions（Workers ランタイム）とユニットテストの両方で使うため、
 * フレームワークや Cookie ライブラリに依存しない最小実装を置く。
 */

import { err, ok } from '@/domain/result';
import type { Result } from '@/domain/result';

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
 * 各 Cookie の値は Result で返す: 不正なパーセントエスケープを含む値は
 * Err（invalid_percent_escape）になる（decodeURIComponent の URIError で
 * 認証エンドポイントが 500 になるのを防ぐため。欠落扱いにするかどうかは
 * 呼び出し側が Result を見て決める）。
 */
export type CookieDecodeError = 'invalid_percent_escape';

export function parseCookies(
  header: string | null | undefined,
): Record<string, Result<string, CookieDecodeError>> {
  const cookies: Record<string, Result<string, CookieDecodeError>> = {};
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
    try {
      cookies[name] = ok(decodeURIComponent(value));
    } catch {
      // 不正なパーセントエスケープ（例: "%ZZ"、途中切れの UTF-8 列）は
      // Err として記録する。無視（欠落扱い）するかどうかは呼び出し側の判断。
      cookies[name] = err('invalid_percent_escape');
    }
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
