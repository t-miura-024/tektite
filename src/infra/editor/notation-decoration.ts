/**
 * ライブプレビュー記法装飾（WikiLink / Embed / Tag）。
 *
 * domain 層の Obsidian 記法パーサー（src/domain/notation/parse）の結果
 * （from/to オフセット）を CM6 の DecorationSet に変換する。既存の Markdown
 * 装飾（src/infra/editor/markdown-decoration）とは独立した StateField として
 * 供給され、両者が同じドキュメント上で共存する。
 *
 * - WikiLink: `[[ノート]]` / `[[ノート|表示名]]` / `[[ノート#見出し]]`
 *   リンク色で装飾し、解決できないターゲット（壊れリンク）は赤系にする。
 *   クリック遷移は src/infra/editor/editor のクリックハンドラが担う
 * - Embed: `![[...]]` を muted 色で装飾する（画像 / ノート共通。壊れは赤系）
 * - Tag: インライン `#タグ` / `#area/project` をピル型で装飾する
 *
 * 装飾クラスは tk- プレフィックスを使い、アプリの CSS 変数（--color-*）に
 * 追従させる。フロントマテリア領域とコードフェンス内はパーサーが対象外に
 * しているため、ここでも装飾されない。
 */

import { RangeSetBuilder, StateField } from '@codemirror/state';
import type { Extension, Text } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';

import { parseNotation } from '@/domain/notation/parse';
import type { NotationSpan } from '@/domain/notation/parse';
import { resolveNotePath } from '@/domain/notation/resolve';

/** 解析結果 1 件を対応する Decoration に変換する（該当なしは null） */
function toNotationDecoration(span: NotationSpan, filePaths: readonly string[]): Decoration | null {
  switch (span.kind) {
    case 'wikilink': {
      const resolved = resolveNotePath(span.target, filePaths);
      const broken = resolved === null || !resolved.endsWith('.md');
      return Decoration.mark({ class: broken ? 'tk-wikilink tk-wikilink-broken' : 'tk-wikilink' });
    }
    case 'embed': {
      const broken = resolveNotePath(span.target, filePaths) === null;
      return Decoration.mark({ class: broken ? 'tk-embed tk-embed-broken' : 'tk-embed' });
    }
    case 'tag':
      return Decoration.mark({ class: 'tk-tag' });
  }
}

/**
 * ドキュメント全体の記法装飾セットを組み立てる（純粋関数。テスト用に分離）。
 * parseNotation のスパンは本文の出現順（from 昇順）で返るため、そのまま
 * RangeSetBuilder に追加できる。
 */
export function computeNotationDecorationSet(
  doc: Text,
  filePaths: readonly string[],
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const span of parseNotation(doc.toString()).spans) {
    const decoration = toNotationDecoration(span, filePaths);
    if (decoration !== null) {
      builder.add(span.from, span.to, decoration);
    }
  }
  return builder.finish();
}

/**
 * 記法装飾の StateField。ドキュメント変更のたびに再解析する。
 * filePaths は Vault 単位で固定のため、extension 生成時に取り込む。
 */
export function notationDecoration(filePaths: readonly string[]): Extension {
  return StateField.define<DecorationSet>({
    create(state) {
      return computeNotationDecorationSet(state.doc, filePaths);
    },
    update(deco, tr) {
      if (!tr.docChanged) {
        return deco;
      }
      return computeNotationDecorationSet(tr.state.doc, filePaths);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

/**
 * クリック位置の WikiLink を解決する（純粋関数。テスト用に分離）。
 * 位置が WikiLink スパン内で、かつターゲットが Markdown ノートへ解決できる
 * 場合のみ遷移情報を返す（壊れリンク・ノート以外のファイルは null）。
 */
export function resolveWikilinkAt(
  text: string,
  pos: number,
  filePaths: readonly string[],
): { readonly path: string; readonly subpath: string | null } | null {
  for (const span of parseNotation(text).spans) {
    if (span.kind !== 'wikilink' || pos < span.from || pos >= span.to) {
      continue;
    }
    const resolved = resolveNotePath(span.target, filePaths);
    if (resolved === null || !resolved.endsWith('.md')) {
      return null;
    }
    return { path: resolved, subpath: span.subpath };
  }
  return null;
}

/** 装飾クラスのスタイル。アプリの CSS 変数に追従しダークモードでも整合する */
export const notationDecorationTheme = EditorView.baseTheme({
  '.tk-wikilink': {
    color: 'var(--color-accent)',
    cursor: 'pointer',
  },
  '.tk-wikilink:hover': { textDecoration: 'underline' },
  '.tk-wikilink-broken': {
    color: 'var(--color-danger)',
    textDecoration: 'underline dotted',
  },
  '.tk-embed': { color: 'var(--color-fg-muted)' },
  '.tk-embed-broken': {
    color: 'var(--color-danger)',
    textDecoration: 'underline dotted',
  },
  '.tk-tag': {
    color: 'var(--color-accent)',
    backgroundColor: 'var(--color-bg-subtle)',
    borderRadius: '999px',
    padding: '0 0.35em',
  },
});
