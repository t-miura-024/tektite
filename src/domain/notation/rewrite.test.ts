/**
 * リンク張り替えエンジン（src/domain/notation/rewrite）のユニットテスト。
 *
 * リネーム/移動時の WikiLink 自動張り替え（エイリアス・見出しリンク・Embed
 * を含む）と、曖昧参照（同名ノートが複数ある場合）の警告を検証する。
 */

import { describe, expect, it } from 'vitest';

import { planLinkRewrite } from '@/domain/notation/rewrite';
import type { MovePair } from '@/domain/notation/rewrite';

function plan(moves: readonly MovePair[], contents: Map<string, string>, filePaths: string[]) {
  return planLinkRewrite({ moves, contents, filePaths });
}

describe('planLinkRewrite', () => {
  it('参照する WikiLink を移動先フルパスへ張り替える', () => {
    const contents = new Map([
      ['a.md', '# A\n\n[[b]] を参照する\n'],
      ['b.md', '# B\n'],
    ]);
    const result = plan([{ from: 'b.md', to: 'notes/b.md' }], contents, [
      'a.md',
      'b.md',
      'notes/c.md',
    ]);
    expect(result.rewritten.get('a.md')).toBe('# A\n\n[[notes/b.md]] を参照する\n');
    expect(result.rewritten.has('b.md')).toBe(false);
    expect(result.issues).toEqual([]);
  });

  it('エイリアス・見出しリンクの参照先を保って張り替える', () => {
    const contents = new Map([
      ['a.md', '# A\n\n[[b#Sec|表示名]] と [[b|別名]] と [[b#Sec]]\n'],
      ['b.md', '# B\n## Sec\n'],
    ]);
    const result = plan([{ from: 'b.md', to: 'notes/b.md' }], contents, ['a.md', 'b.md']);
    expect(result.rewritten.get('a.md')).toBe(
      '# A\n\n[[notes/b.md#Sec|表示名]] と [[notes/b.md|別名]] と [[notes/b.md#Sec]]\n',
    );
  });

  it('ノート Embed（![[...]]）も張り替える', () => {
    const contents = new Map([
      ['a.md', '# A\n\n![[b]]\n'],
      ['b.md', '# B\n'],
    ]);
    const result = plan([{ from: 'b.md', to: 'notes/b.md' }], contents, ['a.md', 'b.md']);
    expect(result.rewritten.get('a.md')).toBe('# A\n\n![[notes/b.md]]\n');
  });

  it('画像 Embed（添付ファイルの移動）も張り替える', () => {
    const contents = new Map([['a.md', '# A\n\n![[attachments/logo.png]]\n']]);
    const result = plan([{ from: 'attachments/logo.png', to: 'assets/logo.png' }], contents, [
      'a.md',
      'attachments/logo.png',
    ]);
    expect(result.rewritten.get('a.md')).toBe('# A\n\n![[assets/logo.png]]\n');
  });

  it('移動元ノート自身が持つ自己参照も張り替える', () => {
    const contents = new Map([['a.md', '# A\n\n[[a#X]] と [[a]]\n']]);
    const result = plan([{ from: 'a.md', to: 'notes/a.md' }], contents, ['a.md']);
    expect(result.rewritten.get('a.md')).toBe('# A\n\n[[notes/a.md#X]] と [[notes/a.md]]\n');
  });

  it('ディレクトリ移動（複数ファイル）では各ノートの参照を個別に張り替える', () => {
    const contents = new Map([
      ['a.md', '# A\n\n[[tektite]] と [[roadmap]]\n'],
      ['projects/tektite.md', '# tektite\n'],
      ['projects/roadmap.md', '# roadmap\n'],
    ]);
    const result = plan(
      [
        { from: 'projects/tektite.md', to: 'archive/projects/tektite.md' },
        { from: 'projects/roadmap.md', to: 'archive/projects/roadmap.md' },
      ],
      contents,
      ['a.md', 'projects/tektite.md', 'projects/roadmap.md'],
    );
    expect(result.rewritten.get('a.md')).toBe(
      '# A\n\n[[archive/projects/tektite.md]] と [[archive/projects/roadmap.md]]\n',
    );
  });

  it('移動と無関係なリンク・壊れリンクは変更しない', () => {
    const contents = new Map([
      ['a.md', '# A\n\n[[c]] と [[missing]]\n'],
      ['b.md', '# B\n'],
      ['c.md', '# C\n'],
    ]);
    const result = plan([{ from: 'b.md', to: 'notes/b.md' }], contents, ['a.md', 'b.md', 'c.md']);
    expect(result.rewritten.size).toBe(0);
    expect(result.issues).toEqual([]);
  });

  it('同名ノートが複数ある場合、解決規則の勝者が移動元なら張り替える', () => {
    // [[a]] は最短パス一致で dir1/a.md（辞書順先）に解決される
    const contents = new Map([
      ['x.md', '# X\n\n[[a]]\n'],
      ['dir1/a.md', '# A1\n'],
      ['dir2/a.md', '# A2\n'],
    ]);
    const result = plan([{ from: 'dir1/a.md', to: 'dir1/renamed.md' }], contents, [
      'x.md',
      'dir1/a.md',
      'dir2/a.md',
    ]);
    expect(result.rewritten.get('x.md')).toBe('# X\n\n[[dir1/renamed.md]]\n');
    expect(result.issues).toEqual([]);
  });

  it('移動元が候補に入るが勝者でない参照は曖昧として警告し、張り替えない', () => {
    // [[a]] は dir1/a.md に解決されるが、移動するのは dir2/a.md のため
    // 「どちらを指していたか確定できない」曖昧参照として警告する
    const contents = new Map([
      ['x.md', '# X\n\n[[a]]\n'],
      ['dir1/a.md', '# A1\n'],
      ['dir2/a.md', '# A2\n'],
    ]);
    const result = plan([{ from: 'dir2/a.md', to: 'dir2/renamed.md' }], contents, [
      'x.md',
      'dir1/a.md',
      'dir2/a.md',
    ]);
    expect(result.rewritten.size).toBe(0);
    expect(result.issues).toEqual([
      {
        kind: 'ambiguous',
        path: 'x.md',
        target: 'a',
        movedCandidates: ['dir2/a.md'],
      },
    ]);
  });

  it('大文字小文字の違いでも解決規則に従って張り替える', () => {
    const contents = new Map([
      ['a.md', '# A\n\n[[B]] を参照\n'],
      ['b.md', '# B\n'],
    ]);
    const result = plan([{ from: 'b.md', to: 'notes/b.md' }], contents, ['a.md', 'b.md']);
    expect(result.rewritten.get('a.md')).toBe('# A\n\n[[notes/b.md]] を参照\n');
  });

  it('本文に変化がないときは rewritten が空になる', () => {
    const contents = new Map([
      ['a.md', '# A\n'],
      ['b.md', '# B\n'],
    ]);
    const result = plan([{ from: 'b.md', to: 'c.md' }], contents, ['a.md', 'b.md']);
    expect(result.rewritten.size).toBe(0);
    expect(result.issues).toEqual([]);
  });
});
