import { describe, expect, it } from 'vitest';

import { findHeading, resolveNotePath } from '@/domain/notation/resolve';

describe('resolveNotePath（大文字小文字を区別しない最短パス一致）', () => {
  const FILES = ['note.md', 'dir/note.md', 'deep/dir/note.md', 'Note.md', '画像.md', 'img.png'];

  it('完全一致で解決する', () => {
    expect(resolveNotePath('note', FILES)).toBe('note.md');
    expect(resolveNotePath('img.png', FILES)).toBe('img.png');
  });

  it('大文字小文字を区別しない', () => {
    // 'note.md' と 'Note.md' が同居する曖昧なケースは決定論的に 'Note.md'（ASCII 先頭）を選ぶ
    expect(resolveNotePath('NOTE', FILES)).toBe('Note.md');
    expect(resolveNotePath('Note', ['dir/note.md'])).toBe('dir/note.md');
    expect(resolveNotePath('IMg.PNG', ['img.png'])).toBe('img.png');
  });

  it('複数候補は最も浅いパス（最短）を選ぶ', () => {
    expect(resolveNotePath('note', FILES)).toBe('note.md');
    expect(resolveNotePath('note', ['dir/note.md', 'deep/dir/note.md'])).toBe('dir/note.md');
  });

  it('同数の候補は辞書順で決定的に選ぶ', () => {
    expect(resolveNotePath('note', ['z/note.md', 'a/note.md'])).toBe('a/note.md');
    expect(resolveNotePath('note', ['a/note.md', 'z/note.md'])).toBe('a/note.md');
  });

  it('パス区切り付きターゲットはパス末尾一致で解決する', () => {
    expect(resolveNotePath('dir/note', FILES)).toBe('dir/note.md');
    expect(resolveNotePath('deep/dir/note', FILES)).toBe('deep/dir/note.md');
  });

  it('先頭の / は無視する', () => {
    expect(resolveNotePath('/note', FILES)).toBe('note.md');
  });

  it('拡張子付きターゲットは完全一致のみ', () => {
    expect(resolveNotePath('note.md', FILES)).toBe('note.md');
    expect(resolveNotePath('img.png', FILES)).toBe('img.png');
    expect(resolveNotePath('img.jpg', FILES)).toBeNull();
    expect(resolveNotePath('note', ['img.png'])).toBeNull();
  });

  it('解決できないターゲットは null（壊れリンク）', () => {
    expect(resolveNotePath('missing', FILES)).toBeNull();
    expect(resolveNotePath('', FILES)).toBeNull();
    expect(resolveNotePath('///', FILES)).toBeNull();
  });

  it('前後の空白は名前の一部として扱う（Obsidian と同様）', () => {
    expect(resolveNotePath(' note ', FILES)).toBeNull();
  });

  it('日本語のノート名も解決する', () => {
    expect(resolveNotePath('画像', FILES)).toBe('画像.md');
    expect(resolveNotePath('画像', ['daily/画像.md', '画像.md'])).toBe('画像.md');
  });

  it('解決結果は元の表記のパスを返す', () => {
    expect(resolveNotePath('note', ['Note.md'])).toBe('Note.md');
  });
});

describe('findHeading（見出し位置の解決）', () => {
  const CONTENT = ['# Title', '導入文', '## Sub', '### Sub Sub', '###### Deep ##', ''].join('\n');

  it('見出しのテキスト・位置・レベルを返す', () => {
    expect(findHeading(CONTENT, 'Sub')).toEqual({ text: 'Sub', from: 12, level: 2 });
    expect(findHeading(CONTENT, 'Sub Sub')).toEqual({ text: 'Sub Sub', from: 19, level: 3 });
  });

  it('大文字小文字を区別しない', () => {
    expect(findHeading(CONTENT, 'sub')).toEqual({ text: 'Sub', from: 12, level: 2 });
    expect(findHeading(CONTENT, 'TITLE')).toEqual({ text: 'Title', from: 0, level: 1 });
  });

  it('ATX クロージング（行末の #）を除いて比較する', () => {
    expect(findHeading(CONTENT, 'Deep')).toEqual({ text: 'Deep', from: 31, level: 6 });
  });

  it('レベル 6 まで解決する', () => {
    expect(findHeading(CONTENT, 'Deep')?.level).toBe(6);
  });

  it('見つからない・空の場合は null', () => {
    expect(findHeading(CONTENT, 'ない見出し')).toBeNull();
    expect(findHeading(CONTENT, '')).toBeNull();
    expect(findHeading(CONTENT, '   ')).toBeNull();
  });
});
