/**
 * コンテンツハッシュ（content-hash.ts）のユニットテスト。
 *
 * SHA-256 は Workers ランタイムと Node のテスト環境で同一結果になる
 * （Web Crypto API の標準実装）。既知のベクトルで正しさを確認し、
 * 保存時の楽観ロック（R2 先行）が本文依存であることを検証する。
 */

import { describe, expect, it } from 'vitest';

import { sha256Hex } from './content-hash';

describe('sha256Hex', () => {
  it('既知のベクトル（空文字）を返す', async () => {
    // SHA-256('') の標準値
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('既知のベクトル（ASCII）を返す', async () => {
    // SHA-256('abc') の標準値
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('UTF-8 本文（日本語）もバイト列ベースでハッシュする', async () => {
    const japanese = await sha256Hex('# 日本語の本文\n');
    const ascii = await sha256Hex('# Nihongo no honbun\n');
    expect(japanese).not.toBe(ascii);
    // 同一本文は常に同一ハッシュ（楽観ロックの前提）
    expect(await sha256Hex('# 日本語の本文\n')).toBe(japanese);
  });

  it('本文が異なればハッシュも異なる（競合検出が機能する）', async () => {
    const a = await sha256Hex('# v1\n');
    const b = await sha256Hex('# v2\n');
    expect(a).not.toBe(b);
  });
});
