import { describe, expect, it } from 'vitest';

import { decryptSecretPayload, encryptSecretPayload } from '@/infra/auth/session-crypto';

const SECRET = 'test-session-secret';

describe('encryptSecretPayload / decryptSecretPayload', () => {
  it('暗号化したトークンを同じ鍵で復号できる', async () => {
    const token = 'gho_16C7e42F292c6912E7710c838347Ae178B4a';
    const payload = await encryptSecretPayload(SECRET, token);
    expect(payload).not.toContain(token);
    expect(await decryptSecretPayload(SECRET, payload)).toEqual({ ok: true, value: token });
  });

  it('暗号化のたびに iv が変わるためペイロードも変化する', async () => {
    const first = await encryptSecretPayload(SECRET, 'same-token');
    const second = await encryptSecretPayload(SECRET, 'same-token');
    expect(first).not.toBe(second);
  });

  it('異なる鍵では復号できない', async () => {
    const payload = await encryptSecretPayload(SECRET, 'secret-token');
    expect(await decryptSecretPayload('another-secret', payload)).toEqual({
      ok: false,
      error: 'decrypt_failed',
    });
  });

  it('ペイロードが改ざんされている場合は Err を返す', async () => {
    const payload = await encryptSecretPayload(SECRET, 'secret-token');
    const parts = payload.split('.');
    const ciphertext = parts[2] ?? '';
    const tampered = [
      parts[0],
      parts[1],
      ciphertext.slice(0, -2) + (ciphertext.endsWith('AA') ? 'BB' : 'AA'),
    ].join('.');
    expect(await decryptSecretPayload(SECRET, tampered)).toEqual({
      ok: false,
      error: 'decrypt_failed',
    });
  });

  it('形式不正のペイロードは Err（invalid_format）を返す', async () => {
    const invalidFormat = { ok: false, error: 'invalid_format' };
    expect(await decryptSecretPayload(SECRET, '')).toEqual(invalidFormat);
    expect(await decryptSecretPayload(SECRET, 'v2.aaa.bbb')).toEqual(invalidFormat);
    expect(await decryptSecretPayload(SECRET, 'v1.only-two')).toEqual(invalidFormat);
    expect(await decryptSecretPayload(SECRET, 'v1.!!!.bbb')).toEqual(invalidFormat);
    expect(await decryptSecretPayload(SECRET, 'v1.aGVsbG8.bbb')).toEqual(invalidFormat);
  });
});
