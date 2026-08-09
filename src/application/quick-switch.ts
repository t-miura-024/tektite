/**
 * クイックスイッチャー用のファイル名ファジー検索（M4: M3 クイックスイッチャー）。
 *
 * ノートのファイル名（拡張子を除いた表示名）を対象に、fzf 的な部分列一致で
 * 検索する。クエリの文字が順番どおりに現れていれば飛ばし飛ばしでも一致と
 * みなす（例: "tkt" → "tektite" は t・k・t が順に現れるため一致）。
 * 大文字小文字は区別しない。
 *
 * 全文検索（search.ts の MiniSearch）との棲み分け: 検索は本文込みの全文検索、
 * クイックスイッチャーはファイル名のみの高速移動（計画の方針 3）。対象は
 * 共有ノート索引（note-index.ts）のパス一覧で、Vault 単位に全ノートの
 * ファイル名が検索できる。巨大 Vault への最適化は行わない（ADR-0004）。
 */

import { noteDisplayName } from '@/application/note-name';

/** 一度に表示する結果の上限（全文検索と同じ。個人 Vault では十分） */
const MAX_RESULTS = 50;

/** 検索結果 1 件 */
export interface QuickSwitchHit {
  readonly path: string;
  /** 拡張子を除いた表示名（ノート名） */
  readonly name: string;
  /** 一致文字の位置（matchedField の文字列内のオフセット。空クエリは空配列） */
  readonly positions: readonly number[];
  /** 一致対象: 表示名が優先。パスにしか現れない場合は 'path' */
  readonly matchedField: 'name' | 'path';
}

/**
 * クエリが対象文字列の部分列として現れる最初の位置を返す（貪欲な左端一致）。
 * 一致しなければ null。空クエリは空配列を返す。
 */
function matchPositions(query: string, target: string): readonly number[] | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) {
    return [];
  }
  const positions: number[] = [];
  let queryIndex = 0;
  for (let targetIndex = 0; targetIndex < t.length && queryIndex < q.length; targetIndex++) {
    if (t[targetIndex] === q[queryIndex]) {
      positions.push(targetIndex);
      queryIndex++;
    }
  }
  return queryIndex === q.length ? positions : null;
}

/**
 * 一致位置のギャップ合計（先頭位置 + 一致文字間の飛び）。小さいほど
 * 「連続した先頭寄りの一致」で、fzf の順位付けと同じ基準。
 */
function gapPenalty(positions: readonly number[]): number {
  let penalty = 0;
  let previous = -1;
  for (const position of positions) {
    penalty += position - previous - 1;
    previous = position;
  }
  return penalty;
}

/**
 * ノートパス一覧からクエリに部分列一致するものを並べ替えて返す。
 * 順位: 表示名一致 > パスのみ一致 → ギャップ合計が小さい順 → 表示名が短い順
 * → パスの辞書順（安定した最終タイブレーク）。
 */
export function searchNoteNames(
  paths: readonly string[],
  query: string,
): readonly QuickSwitchHit[] {
  const trimmed = query.trim();
  const hits: QuickSwitchHit[] = [];
  for (const path of paths) {
    const name = noteDisplayName(path);
    // 空クエリは全ノートを返す（モバイルで一覧から直接選ぶ導線にもなる）
    if (trimmed.length === 0) {
      hits.push({ path, name, positions: [], matchedField: 'name' });
      continue;
    }
    const namePositions = matchPositions(trimmed, name);
    if (namePositions !== null) {
      hits.push({ path, name, positions: namePositions, matchedField: 'name' });
      continue;
    }
    const pathPositions = matchPositions(trimmed, path);
    if (pathPositions !== null) {
      hits.push({ path, name, positions: pathPositions, matchedField: 'path' });
    }
  }
  hits.sort(
    (a, b) =>
      (a.matchedField === b.matchedField ? 0 : a.matchedField === 'name' ? -1 : 1) ||
      gapPenalty(a.positions) - gapPenalty(b.positions) ||
      a.name.length - b.name.length ||
      // コードユニット順の比較（ロケールに依存しない決定的な最終タイブレーク）
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return hits.slice(0, MAX_RESULTS);
}
