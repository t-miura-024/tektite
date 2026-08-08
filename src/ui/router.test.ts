import { describe, expect, it } from 'vitest';

import { noteRoutePath, parseRoute, vaultRoutePath } from '@/ui/router';

describe('parseRoute', () => {
  it('ルートは Vault 選択画面', () => {
    expect(parseRoute('/')).toEqual({ kind: 'vaults' });
    expect(parseRoute('')).toEqual({ kind: 'vaults' });
  });

  it('2 セグメントは Vault ツリー画面', () => {
    expect(parseRoute('/octocat/notes')).toEqual({
      kind: 'tree',
      ref: { owner: 'octocat', name: 'notes' },
    });
  });

  it('末尾スラッシュは無視する', () => {
    expect(parseRoute('/octocat/notes/')).toEqual({
      kind: 'tree',
      ref: { owner: 'octocat', name: 'notes' },
    });
  });

  it('blob 系パスはノート画面（複数セグメントのパスを復元）', () => {
    expect(parseRoute('/octocat/notes/blob/daily/2026-08-08.md')).toEqual({
      kind: 'note',
      ref: { owner: 'octocat', name: 'notes' },
      notePath: 'daily/2026-08-08.md',
    });
  });

  it('エンコード済みセグメントをデコードする', () => {
    expect(parseRoute('/octocat/notes/blob/daily/%E6%97%A5%E8%A8%98%20vol.1.md')).toEqual({
      kind: 'note',
      ref: { owner: 'octocat', name: 'notes' },
      notePath: 'daily/日記 vol.1.md',
    });
  });

  it('不正な owner / repo 名は not-found', () => {
    expect(parseRoute('/bad owner/notes')).toEqual({ kind: 'not-found' });
    expect(parseRoute('/octocat/bad%2Fname')).toEqual({ kind: 'not-found' });
  });

  it('blob パスが空の場合は not-found', () => {
    expect(parseRoute('/octocat/notes/blob')).toEqual({ kind: 'not-found' });
    expect(parseRoute('/octocat/notes/blob/')).toEqual({ kind: 'not-found' });
  });

  it('不正なエンコーディングは not-found', () => {
    expect(parseRoute('/octocat/notes/blob/%E0%A4%A')).toEqual({ kind: 'not-found' });
  });

  it('想定外の構造は not-found', () => {
    expect(parseRoute('/octocat')).toEqual({ kind: 'not-found' });
    expect(parseRoute('/octocat/notes/unknown/x')).toEqual({ kind: 'not-found' });
  });
});

describe('vaultRoutePath / noteRoutePath', () => {
  const ref = { owner: 'octocat', name: 'notes' };

  it('Vault ツリー画面の URL を作る', () => {
    expect(vaultRoutePath(ref)).toBe('/octocat/notes');
  });

  it('ノートパスの URL を作る（特殊文字はエンコード）', () => {
    expect(noteRoutePath(ref, 'daily/2026-08-08.md')).toBe(
      '/octocat/notes/blob/daily/2026-08-08.md',
    );
    expect(noteRoutePath(ref, 'daily/日記 vol.1.md')).toBe(
      '/octocat/notes/blob/daily/%E6%97%A5%E8%A8%98%20vol.1.md',
    );
  });

  it('noteRoutePath と parseRoute は往復する', () => {
    const notePath = 'a b/c/d.md';
    const route = parseRoute(noteRoutePath(ref, notePath));
    expect(route).toEqual({ kind: 'note', ref, notePath });
  });
});
