import { describe, expect, it } from 'vitest';

import { generateOAuthState, signOAuthState, verifyOAuthState } from './oauth-state';

const SECRET = 'test-session-secret';

describe('generateOAuthState', () => {
  it('呼び出しごとに異なる state を生成する', () => {
    const first = generateOAuthState();
    const second = generateOAuthState();
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(40);
  });
});

describe('signOAuthState / verifyOAuthState', () => {
  it('正しい state と署名の組は検証に成功する', async () => {
    const state = generateOAuthState();
    const signature = await signOAuthState(SECRET, state);
    expect(await verifyOAuthState(SECRET, state, signature)).toBe(true);
  });

  it('state が改ざんされていると検証に失敗する', async () => {
    const state = generateOAuthState();
    const signature = await signOAuthState(SECRET, state);
    expect(await verifyOAuthState(SECRET, `${state}x`, signature)).toBe(false);
  });

  it('署名が改ざんされていると検証に失敗する', async () => {
    const state = generateOAuthState();
    const signature = await signOAuthState(SECRET, state);
    const tampered = signature.slice(0, -2) + (signature.endsWith('AA') ? 'BB' : 'AA');
    expect(await verifyOAuthState(SECRET, state, tampered)).toBe(false);
  });

  it('異なる鍵では検証に失敗する', async () => {
    const state = generateOAuthState();
    const signature = await signOAuthState(SECRET, state);
    expect(await verifyOAuthState('another-secret', state, signature)).toBe(false);
  });

  it('空 state・不正な署名は検証に失敗する', async () => {
    const signature = await signOAuthState(SECRET, 'state');
    expect(await verifyOAuthState(SECRET, '', signature)).toBe(false);
    expect(await verifyOAuthState(SECRET, 'state', '!!!')).toBe(false);
    expect(await verifyOAuthState(SECRET, 'state', '')).toBe(false);
  });
});
