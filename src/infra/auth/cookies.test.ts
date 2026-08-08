import { describe, expect, it } from 'vitest';

import { expireCookie, parseCookies, serializeCookie } from '@/infra/auth/cookies';

describe('parseCookies', () => {
  it('Cookie ヘッダーをキーと値の組にパースする', () => {
    expect(parseCookies('a=1; b=2')).toEqual({ a: '1', b: '2' });
  });

  it('URL エンコードされた値をデコードする', () => {
    expect(parseCookies('state=abc%20def')).toEqual({ state: 'abc def' });
  });

  it('空・null・不正な要素は無視する', () => {
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies('')).toEqual({});
    expect(parseCookies(';;=x; lone')).toEqual({});
  });

  it('重複する名前は後の値を優先する', () => {
    expect(parseCookies('a=1; a=2')).toEqual({ a: '2' });
  });

  it('不正なパーセントエスケープを含む Cookie は無視して落ちない', () => {
    // %E0%A4%A は途中切れの UTF-8 パーセントエスケープ（decodeURIComponent が URIError を投げる）
    expect(parseCookies('bad=%E0%A4%A; ok=1')).toEqual({ ok: '1' });
    expect(parseCookies('broken=%ZZ')).toEqual({});
    expect(parseCookies('a=%E6%97%A5; bad=%E0%A4%A')).toEqual({ a: '日' });
  });
});

describe('serializeCookie', () => {
  it('属性付きの Set-Cookie 文字列を生成する', () => {
    const cookie = serializeCookie('session', 'v1.payload', {
      maxAge: 600,
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    });
    expect(cookie).toBe('session=v1.payload; Path=/; Max-Age=600; SameSite=Lax; Secure; HttpOnly');
  });

  it('値は URL エンコードされる', () => {
    expect(serializeCookie('s', 'a b')).toBe('s=a%20b; Path=/');
  });
});

describe('expireCookie', () => {
  it('Max-Age=0 で削除用の Set-Cookie を生成する', () => {
    expect(expireCookie('session', { secure: true, httpOnly: true, sameSite: 'Lax' })).toBe(
      'session=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly',
    );
  });
});
