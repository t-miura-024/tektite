import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import {
  computeNotationDecorationSet,
  resolveWikilinkAt,
} from '@/infra/editor/notation-decoration';

/** Vault 内のファイルパス（テスト用の固定データ） */
const FILE_PATHS = ['a.md', 'daily/b.md', 'attachments/logo.png', 'wiki.md'];

interface Found {
  readonly from: number;
  readonly to: number;
  readonly className?: string;
}

/** ドキュメントの記法装飾セットをクラス名と位置のリストに変換する */
function collect(docText: string): Found[] {
  const doc = EditorState.create({ doc: docText }).doc;
  const decos = computeNotationDecorationSet(doc, FILE_PATHS);
  const found: Found[] = [];
  decos.between(0, doc.length, (from, to, value) => {
    const spec = value.spec as { class?: string };
    found.push({ from, to, className: spec.class });
  });
  return found;
}

describe('CM6 ライブプレビュー記法装飾（WikiLink / Embed / Tag）', () => {
  it('解決できる WikiLink を tk-wikilink で装飾する', () => {
    expect(collect('[[a]]')).toEqual([{ from: 0, to: 5, className: 'tk-wikilink' }]);
  });

  it('エイリアス・見出し付き WikiLink もスパン全体を装飾する', () => {
    expect(collect('[[a#見出し|表示名]]')).toEqual([{ from: 0, to: 13, className: 'tk-wikilink' }]);
  });

  it('解決できない WikiLink は tk-wikilink-broken で装飾する', () => {
    expect(collect('[[存在しない]]')).toEqual([
      { from: 0, to: 9, className: 'tk-wikilink tk-wikilink-broken' },
    ]);
  });

  it('Embed（画像・ノート）を tk-embed で装飾する', () => {
    expect(collect('![[attachments/logo.png]] と ![[a]]')).toEqual([
      { from: 0, to: 25, className: 'tk-embed' },
      { from: 28, to: 34, className: 'tk-embed' },
    ]);
  });

  it('解決できない Embed は tk-embed-broken で装飾する', () => {
    expect(collect('![[無い画像.png]]')).toEqual([
      { from: 0, to: 13, className: 'tk-embed tk-embed-broken' },
    ]);
  });

  it('インラインタグを tk-tag で装飾する', () => {
    expect(collect('本文 #area/project 参照')).toEqual([{ from: 3, to: 16, className: 'tk-tag' }]);
  });

  it('フロントマテリア領域内は装飾しない', () => {
    const text = '---\ntags:\n  - demo\n---\n# 見出し\n\n[[a]]\n';
    const found = collect(text);
    expect(found).toEqual([{ from: 30, to: 35, className: 'tk-wikilink' }]);
  });

  it('コードフェンス内の記法は装飾しない', () => {
    const text = '```\n[[a]] #tag\n```\n[[a]]\n';
    const found = collect(text);
    expect(found).toEqual([{ from: 19, to: 24, className: 'tk-wikilink' }]);
  });

  it('空のドキュメントは空の decoration セットになる', () => {
    expect(collect('')).toEqual([]);
  });
});

describe('WikiLink クリック位置の解決', () => {
  it('クリック位置が解決可能な WikiLink 内ならパスと見出しを返す', () => {
    const resolved = resolveWikilinkAt('[[a#見出し]] の参照', 3, FILE_PATHS);
    expect(resolved).toEqual({ path: 'a.md', subpath: '見出し' });
  });

  it('壊れリンクの位置は null（遷移しない）', () => {
    expect(resolveWikilinkAt('[[存在しない]]', 3, FILE_PATHS)).toBeNull();
  });

  it('WikiLink 外の位置は null', () => {
    expect(resolveWikilinkAt('本文のみ', 2, FILE_PATHS)).toBeNull();
  });

  it('ノート以外のファイル（画像）への WikiLink は null', () => {
    expect(resolveWikilinkAt('[[attachments/logo.png]]', 3, FILE_PATHS)).toBeNull();
  });
});
