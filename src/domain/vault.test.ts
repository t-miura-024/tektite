import { describe, expect, it } from 'vitest';

import { isVaultCandidate, isValidGitHubName, vaultRefFullName } from './vault';

describe('vaultRefFullName', () => {
  it('owner/name 形式の表示名を作る', () => {
    expect(vaultRefFullName({ owner: 'octocat', name: 'notes' })).toBe('octocat/notes');
  });
});

describe('isValidGitHubName', () => {
  it('英数字と . _ - を許容する', () => {
    expect(isValidGitHubName('octocat')).toBe(true);
    expect(isValidGitHubName('my-notes.v2_draft')).toBe(true);
  });

  it('空文字・スラッシュ・空白・日本語は拒否する', () => {
    expect(isValidGitHubName('')).toBe(false);
    expect(isValidGitHubName('owner/repo')).toBe(false);
    expect(isValidGitHubName('has space')).toBe(false);
    expect(isValidGitHubName('ノート')).toBe(false);
  });

  it('100 文字超は拒否する', () => {
    expect(isValidGitHubName('a'.repeat(100))).toBe(true);
    expect(isValidGitHubName('a'.repeat(101))).toBe(false);
  });
});

describe('isVaultCandidate', () => {
  it('write 権限がありアーカイブ済みでなければ候補になる', () => {
    expect(isVaultCandidate({ hasWritePermission: true, isArchived: false })).toBe(true);
  });

  it('読み取り専用は候補から除外する', () => {
    expect(isVaultCandidate({ hasWritePermission: false, isArchived: false })).toBe(false);
  });

  it('アーカイブ済みは候補から除外する', () => {
    expect(isVaultCandidate({ hasWritePermission: true, isArchived: true })).toBe(false);
  });
});
