/**
 * ノートの表示名ヘルパー（M4 修正: difit 指摘 4 の集約）。
 *
 * パスから拡張子（.md）を除いた表示名（ノート名）を得る。検索結果・タグ一覧・
 * クイックスイッチャー（quick-switch.ts）が同じ規則で使うため、application 層に
 * 1 箇所集約する（SearchPanel / TagPanel はここから import する）。
 */

/** パスから拡張子を除いた表示名（ノート名）を得る */
export function noteDisplayName(path: string): string {
  const base = path.split('/').at(-1) ?? path;
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}
