import { describe, expect, it } from 'vitest';

import { base64UrlDecode, base64UrlEncode } from '@/infra/auth/base64url';

describe('base64UrlEncode / base64UrlDecode', () => {
  it('バイト列を base64url にエンコードしてデコードすると元に戻る', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(base64UrlDecode(encoded)).toEqual({ ok: true, value: bytes });
  });

  it('空バイト列は空文字になる', () => {
    expect(base64UrlEncode(new Uint8Array([]))).toBe('');
    expect(base64UrlDecode('')).toEqual({ ok: true, value: new Uint8Array([]) });
  });

  it('base64url 固有の文字（- _）を正しくデコードする', () => {
    // 標準 base64 で '+' や '/' を含む値が base64url では '-_' になる
    const bytes = new Uint8Array([251, 255, 191]); // standard base64: "+/+/"
    const encoded = base64UrlEncode(bytes);
    expect(encoded).toContain('-');
    expect(base64UrlDecode(encoded)).toEqual({ ok: true, value: bytes });
  });

  it('不正な文字を含む場合は Err を返す', () => {
    expect(base64UrlDecode('!!!')).toEqual({ ok: false, error: 'invalid_base64url' });
    expect(base64UrlDecode('abc=')).toEqual({ ok: false, error: 'invalid_base64url' });
  });
});
