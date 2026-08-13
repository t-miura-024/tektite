/**
 * return-to（ディープリンク復帰）のユニットテスト。
 *
 * isSafeReturnTo はオープンリダイレクト / ヘッダーインジェクションの防衛線、
 * create/verifyReturnToCookie は署名による改ざん検知を検証する。
 * E2E（features/auth.feature）は正常系をカバーし、ここでは拒否分岐を固める。
 */

import { describe, expect, it } from 'vitest';

import {
  RETURN_TO_COOKIE_NAME,
  createReturnToCookie,
  isSafeReturnTo,
  verifyReturnToCookie,
} from '@/api/_lib/session';

const SECRET = 'test-session-secret-0123456789abcdef';

/** Set-Cookie 文字列から Cookie ヘダー用の "name=value" 部分を作る */
function toCookieHeader(setCookieValue: string): string {
  const nameValue = setCookieValue.split(';')[0] ?? '';
  return nameValue;
}

function requestWithCookies(cookieHeader: string): Request {
  return new Request('http://localhost/api/auth/callback', {
    headers: cookieHeader === '' ? {} : { Cookie: cookieHeader },
  });
}

describe('isSafeReturnTo', () => {
  it('同一オリジンの絶対パスを許可する', () => {
    expect(isSafeReturnTo('/')).toBe(true);
    expect(isSafeReturnTo('/octocat/notes/blob/daily/2026-08-08.md')).toBe(true);
    expect(isSafeReturnTo('/a?b=1')).toBe(true);
  });

  it('外部へリダイレクトしうるパスを拒否する', () => {
    expect(isSafeReturnTo('//evil.example')).toBe(false);
    expect(isSafeReturnTo('https://evil.example')).toBe(false);
    expect(isSafeReturnTo('/\\evil.example')).toBe(false);
    expect(isSafeReturnTo('')).toBe(false);
  });

  it('ヘッダーインジェクションと長すぎるパスを拒否する', () => {
    expect(isSafeReturnTo('/a\r\nSet-Cookie: x=1')).toBe(false);
    expect(isSafeReturnTo('/a\n')).toBe(false);
    expect(isSafeReturnTo(`/${'a'.repeat(3000)}`)).toBe(false);
  });
});

describe('return-to Cookie の発行と検証', () => {
  it('署名付き Cookie を往復させ、元のパスを復元する', async () => {
    const setCookie = await createReturnToCookie(SECRET, '/octocat/notes/blob/daily/vol.1.md');
    const request = requestWithCookies(toCookieHeader(setCookie));
    await expect(verifyReturnToCookie(request, SECRET)).resolves.toBe(
      '/octocat/notes/blob/daily/vol.1.md',
    );
  });

  it('Cookie 欠落・値の欠損は "/" に落ち着く', async () => {
    await expect(verifyReturnToCookie(requestWithCookies(''), SECRET)).resolves.toBe('/');
    await expect(
      verifyReturnToCookie(requestWithCookies(`${RETURN_TO_COOKIE_NAME}=`), SECRET),
    ).resolves.toBe('/');
    await expect(
      verifyReturnToCookie(requestWithCookies(`${RETURN_TO_COOKIE_NAME}=noseparator`), SECRET),
    ).resolves.toBe('/');
  });

  it('署名の改ざん・別シークレット・安全でないパスは "/" に落ち着く', async () => {
    const setCookie = await createReturnToCookie(SECRET, '/octocat/notes');
    const value = toCookieHeader(setCookie);

    // 署名の一部を破壊する
    const tampered = `${value.slice(0, value.length - 2)}xx`;
    await expect(verifyReturnToCookie(requestWithCookies(tampered), SECRET)).resolves.toBe('/');

    // 別のシークレットでは検証できない
    await expect(verifyReturnToCookie(requestWithCookies(value), 'another-secret')).resolves.toBe(
      '/',
    );

    // 署名が正しくても安全でないパスは拒否する（防衛線は二重）
    const unsafeCookie = await createReturnToCookie(SECRET, '//evil.example');
    await expect(
      verifyReturnToCookie(requestWithCookies(toCookieHeader(unsafeCookie)), SECRET),
    ).resolves.toBe('/');
  });
});
