/**
 * Note 埋め込み（`![[ノート]]`）の再帰展開と循環参照検出。
 *
 * 埋め込み先のノートがさらに別のノートを埋め込むとき、再帰的に展開する。
 * このとき以下の 2 つの理由で打ち切る:
 * - 循環参照: A が B を、B が A を埋め込むような参照のループ。祖先チェーン
 *   （ルートから現在のノートまでのパス列）に解決先が既に含まれる場合、
 *   ループとして検出してその枝の展開を止める
 * - 深さ上限: ループではないが深すぎる入れ子（既定 8）は展開を打ち切る
 *
 * 戻り値のツリー（EmbedExpansionNode）は、描画側（M2）が埋め込み位置に
 * 埋め込み先ノートの本文をはめ込むために使う。from/to は親ノート本文中の
 * `![[...]]` の位置。
 */

import { parseNotation } from '@/domain/notation/parse';
import { resolveNotePath } from '@/domain/notation/resolve';

export interface EmbedExpansionOptions {
  /** 展開する最大深さ（ルートを 0 とした上限。既定 8） */
  readonly maxDepth?: number;
}

/** 展開された埋め込み 1 件（再帰ツリーの 1 ノード） */
export interface EmbedExpansionNode {
  /** 展開されたノートのパス */
  readonly path: string;
  /** ルートからの深さ（ルートが 0。直接の埋め込みが 1） */
  readonly depth: number;
  /** 親ノート本文中での `![[...]]` の位置（オフセットは親本文基準） */
  readonly from: number;
  readonly to: number;
  /** このノートが持つ埋め込み（出現順） */
  readonly children: readonly EmbedExpansionNode[];
}

export interface EmbedExpansionResult {
  /** ルートノートの本文中にある Note 埋め込み（出現順・解決できたもののみ） */
  readonly embeds: readonly EmbedExpansionNode[];
  /** 深さ上限に達して展開を打ち切ったパス */
  readonly truncated: readonly string[];
  /** 循環参照を検出して打ち切ったパス（祖先チェーン [..., 繰り返し先]） */
  readonly cycles: readonly string[][];
}

const DEFAULT_MAX_DEPTH = 8;

/**
 * ルートノートの Note 埋め込みを再帰的に展開する。
 * 画像 Embed と解決できない埋め込み（壊れリンク）はツリーに含めない
 * （壊れリンクの可視化は描画側の責務）。contents に存在しないルートは
 * 空の結果を返す。
 */
export function expandNoteEmbeds(
  contents: ReadonlyMap<string, string>,
  rootPath: string,
  options: EmbedExpansionOptions = {},
): EmbedExpansionResult {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const truncated: string[] = [];
  const cycles: string[][] = [];
  const filePaths = [...contents.keys()];

  const expand = (
    path: string,
    depth: number,
    ancestors: readonly string[],
  ): EmbedExpansionNode[] => {
    const content = contents.get(path);
    if (content === undefined) {
      return [];
    }
    const nodes: EmbedExpansionNode[] = [];
    for (const span of parseNotation(content).spans) {
      if (span.kind !== 'embed' || span.targetType !== 'note') {
        continue;
      }
      const resolved = resolveNotePath(span.target, filePaths);
      if (resolved === null) {
        continue; // 壊れリンクは展開対象外（描画側で壊れ表示する）
      }
      if (ancestors.includes(resolved)) {
        cycles.push([...ancestors, resolved]);
        nodes.push({
          path: resolved,
          depth: depth + 1,
          from: span.from,
          to: span.to,
          children: [],
        });
        continue;
      }
      if (depth + 1 > maxDepth) {
        truncated.push(resolved);
        nodes.push({
          path: resolved,
          depth: depth + 1,
          from: span.from,
          to: span.to,
          children: [],
        });
        continue;
      }
      nodes.push({
        path: resolved,
        depth: depth + 1,
        from: span.from,
        to: span.to,
        children: expand(resolved, depth + 1, [...ancestors, resolved]),
      });
    }
    return nodes;
  };

  return {
    embeds: expand(rootPath, 0, [rootPath]),
    truncated,
    cycles,
  };
}
