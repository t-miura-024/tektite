/**
 * 埋め込み（![[ノート]]）用の本文収集。
 *
 * リーディング表示が `![[ノート]]` を展開するには、埋め込み先ノートの本文が
 * 必要になる。ルートノートから始めて、解決できる Note 埋め込みを幅優先で
 * 辿り、まだ取得していないノートの本文だけを fetcher で取得する
 * （Vault 内の全ノートを取得するとリポジトリ規模で肥大化するため）。
 *
 * - 解決規則は domain の resolveNotePath（大文字小文字を区別しない最短パス一致）
 * - 深さ上限（既定 8）は domain の embed.ts と揃える。上限で打ち切った先は
 *   取得しない（展開もされない）
 * - 取得に失敗したノートはマップに入れない（描画側が壊れ埋め込みとして表示）
 * - fetcher は UI 層が注入する（application の openNote 経由の実取得）
 */

import { parseNotation } from '@/domain/notation/parse';
import { resolveNotePath } from '@/domain/notation/resolve';

export type EmbedContentFetcher = (path: string) => Promise<{ readonly content: string } | null>;

const DEFAULT_MAX_DEPTH = 8;

/**
 * ルートノートから辿れる埋め込みノートの本文を幅優先で収集する。
 * 戻り値のマップはルート自身を含む（描画側の expandNoteEmbeds と揃えるため）。
 * 同じ深さのノートは並列で取得する（BFS の波単位の並列化）。
 */
export async function collectEmbedContents(
  rootPath: string,
  filePaths: readonly string[],
  fetch: EmbedContentFetcher,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): Promise<ReadonlyMap<string, string>> {
  const contents = new Map<string, string>();
  const queued = new Set<string>([rootPath]);
  let frontier: ReadonlyArray<{ path: string; depth: number }> = [{ path: rootPath, depth: 0 }];

  while (frontier.length > 0) {
    // 波単位の並列取得（BFS の深さごとに Promise.all する。直列だと埋め込みが
    // 深いノートで逐次 fetch になるため）
    // eslint-disable-next-line no-await-in-loop -- BFS の波を待ってから次の波を処理する
    const results = await Promise.all(
      frontier.map(async (item) => ({ item, note: await fetch(item.path) })),
    );
    const next: Array<{ path: string; depth: number }> = [];
    for (const { item, note } of results) {
      if (note === null) {
        continue;
      }
      contents.set(item.path, note.content);
      if (item.depth >= maxDepth) {
        continue;
      }
      // このノートが埋め込む Note を解決して次の波に積む（画像は対象外）
      const parsed = parseNotation(note.content);
      for (const span of parsed.spans) {
        if (span.kind !== 'embed' || span.targetType !== 'note') {
          continue;
        }
        const resolved = resolveNotePath(span.target, filePaths);
        if (resolved !== null && !queued.has(resolved)) {
          queued.add(resolved);
          next.push({ path: resolved, depth: item.depth + 1 });
        }
      }
    }
    frontier = next;
  }

  return contents;
}
