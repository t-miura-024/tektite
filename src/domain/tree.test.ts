import { describe, expect, it } from 'vitest';

import type { TreeEntry } from '@/domain/tree';
import { ancestorDirectoryPaths, buildVaultTree, isExcludedPath } from '@/domain/tree';

describe('isExcludedPath', () => {
  it('隠れディレクトリ自体を除外する', () => {
    expect(isExcludedPath('.obsidian', 'directory')).toBe(true);
    expect(isExcludedPath('.git', 'directory')).toBe(true);
  });

  it('隠れディレクトリ配下のファイルを除外する', () => {
    expect(isExcludedPath('.obsidian/app.json', 'file')).toBe(true);
    expect(isExcludedPath('nested/.hidden/note.md', 'file')).toBe(true);
  });

  it('隠れ「ファイル」は除外しない（除外対象はディレクトリのみ）', () => {
    expect(isExcludedPath('.gitignore', 'file')).toBe(false);
    expect(isExcludedPath('docs/.env.sample', 'file')).toBe(false);
  });

  it('通常パスは除外しない', () => {
    expect(isExcludedPath('daily/2026-08-08.md', 'file')).toBe(false);
    expect(isExcludedPath('daily', 'directory')).toBe(false);
  });
});

describe('ancestorDirectoryPaths', () => {
  it('祖先ディレクトリをルート側から返す', () => {
    expect(ancestorDirectoryPaths('a/b/c.md')).toEqual(['a', 'a/b']);
  });

  it('ルート直下のファイルは空配列', () => {
    expect(ancestorDirectoryPaths('README.md')).toEqual([]);
  });
});

describe('buildVaultTree', () => {
  it('フラットエントリからネスト構造を構築する', () => {
    const entries: TreeEntry[] = [
      { path: 'daily', type: 'directory' },
      { path: 'daily/2026-08-08.md', type: 'file' },
      { path: 'README.md', type: 'file' },
    ];
    const root = buildVaultTree(entries);
    expect(root.type).toBe('directory');
    expect(root.path).toBe('');
    expect(root.children.map((child) => child.name)).toEqual(['daily', 'README.md']);
    const daily = root.children[0];
    expect(daily?.type).toBe('directory');
    if (daily?.type === 'directory') {
      expect(daily.children.map((child) => child.path)).toEqual(['daily/2026-08-08.md']);
    }
  });

  it('ディレクトリ優先・名前順（大文字小文字を区別しない）でソートする', () => {
    const entries: TreeEntry[] = [
      { path: 'zebra.md', type: 'file' },
      { path: 'Alpha', type: 'directory' },
      { path: 'beta.md', type: 'file' },
      { path: 'gamma', type: 'directory' },
    ];
    const root = buildVaultTree(entries);
    expect(root.children.map((child) => child.name)).toEqual([
      'Alpha',
      'gamma',
      'beta.md',
      'zebra.md',
    ]);
  });

  it('.obsidian などの隠れディレクトリは丸ごと除外する', () => {
    const entries: TreeEntry[] = [
      { path: '.obsidian', type: 'directory' },
      { path: '.obsidian/app.json', type: 'file' },
      { path: '.git', type: 'directory' },
      { path: 'README.md', type: 'file' },
    ];
    const root = buildVaultTree(entries);
    expect(root.children.map((child) => child.name)).toEqual(['README.md']);
  });

  it('隠れファイルは表示に残す', () => {
    const entries: TreeEntry[] = [
      { path: '.gitignore', type: 'file' },
      { path: 'README.md', type: 'file' },
    ];
    const root = buildVaultTree(entries);
    expect(root.children.map((child) => child.name)).toEqual(['.gitignore', 'README.md']);
  });

  it('親エントリが欠けていても中間ディレクトリを補完する', () => {
    const entries: TreeEntry[] = [{ path: 'a/b/c.md', type: 'file' }];
    const root = buildVaultTree(entries);
    const a = root.children[0];
    expect(a?.name).toBe('a');
    if (a?.type === 'directory') {
      const b = a.children[0];
      expect(b?.name).toBe('b');
      if (b?.type === 'directory') {
        expect(b.children.map((child) => child.path)).toEqual(['a/b/c.md']);
      }
    }
  });

  it('空パス・不正セグメントは無視する', () => {
    const entries: TreeEntry[] = [
      { path: '', type: 'file' },
      { path: 'a//b.md', type: 'file' },
      { path: 'ok.md', type: 'file' },
    ];
    const root = buildVaultTree(entries);
    expect(root.children.map((child) => child.name)).toEqual(['ok.md']);
  });

  it('空のエントリ列からは空のルートディレクトリを返す', () => {
    const root = buildVaultTree([]);
    expect(root.children).toEqual([]);
  });
});
