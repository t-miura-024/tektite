/**
 * WikiLink のターゲット解決（大文字小文字を区別しない最短パス一致）。
 *
 * 純 TypeScript の関数で、Vault 内のファイルパス一覧（src/domain/tree と
 * 整合）とノート本文を受け取り、WikiLink / Embed のターゲットを解決する。
 *
 * 解決規則（Obsidian に倣う）:
 * - 大文字小文字は区別しない（`[[Note]]` は `note.md` に解決される）
 * - ターゲットが拡張子を持つ場合（`[[foo.png]]` など）は、パス全体が
 *   大文字小文字を無視して完全一致するファイルにのみ解決される
 * - 拡張子を持たない場合は Markdown ノート（`.md`）が対象で、パス末尾が
 *   `<ターゲット>.md` と一致するファイルに解決される（`[[note]]` は
 *   `note.md` にも `dir/note.md` にも解決しうる）
 * - 複数候補がある場合は最も浅いパス（セグメント数が最小）を選び、同数の
 *   場合は辞書順で先のものを選ぶ（決定論的な順序）
 * - 解決できない場合は null（壊れリンク。呼び出し側が可視化する）
 *
 * ターゲットの前後の空白はそのまま名前の一部として扱う（`[[ note ]]` は
 * 名前が ` note ` のノートにのみ解決される。Obsidian と同様）。
 */

/** ノート本文中の見出しの位置 */
export interface HeadingPosition {
  /** 見出しテキスト（`#` マーカーと ATX クロージングを除いたもの） */
  readonly text: string;
  /** 見出し行の開始オフセット（UTF-16 コード単位） */
  readonly from: number;
  /** 見出しレベル（1-6） */
  readonly level: number;
}

/** 見出し: `#` 〜 `######` */
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * WikiLink / Embed のターゲットをファイルパスへ解決する。
 * 見つからない場合は null（壊れリンク）。
 */
export function resolveNotePath(target: string, filePaths: readonly string[]): string | null {
  const normalized = target.replace(/^\/+/, '');
  if (normalized === '') {
    return null;
  }
  const lowerTarget = normalized.toLowerCase();
  const hasExtension = (normalized.split('/').at(-1) ?? '').includes('.');

  const candidates: string[] = [];
  for (const path of filePaths) {
    const lower = path.toLowerCase();
    if (hasExtension) {
      if (lower === lowerTarget) {
        candidates.push(path);
      }
    } else if (lower === `${lowerTarget}.md` || lower.endsWith(`/${lowerTarget}.md`)) {
      candidates.push(path);
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  // 最短パス優先（セグメント数が最小）→ 大文字小文字が完全一致するものを優先
  // → 残りは ASCII 順で決定論的に選ぶ
  candidates.sort((a, b) => {
    const byDepth = segmentCount(a) - segmentCount(b);
    if (byDepth !== 0) {
      return byDepth;
    }
    const aExact = matchesExactCase(a, normalized, hasExtension) ? 0 : 1;
    const bExact = matchesExactCase(b, normalized, hasExtension) ? 0 : 1;
    if (aExact !== bExact) {
      return aExact - bExact;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return candidates[0] ?? null;
}

/** ターゲット（の `.md` 付き）と大文字小文字まで一致するか */
function matchesExactCase(path: string, target: string, hasExtension: boolean): boolean {
  return hasExtension ? path === target : path === `${target}.md`;
}

/** パスのセグメント数（最短パス判定に使う） */
function segmentCount(path: string): number {
  return path.split('/').length;
}

/**
 * ノート本文から見出し（`#` 〜 `######`）の位置を解決する。
 * テキストは前後空白・ATX クロージング（行末の `#`）を除いた上で
 * 大文字小文字を区別せずに比較する。同名の見出しが複数ある場合は
 * 最初のものを返す。見つからない場合は null。
 */
export function findHeading(content: string, headingText: string): HeadingPosition | null {
  const wanted = headingText.trim().toLowerCase();
  if (wanted === '') {
    return null;
  }
  let offset = 0;
  for (const line of content.split('\n')) {
    const match = HEADING_RE.exec(line);
    if (match && match[1] && match[2] !== undefined) {
      const level = match[1].length;
      const text = match[2].replace(/\s+#+\s*$/, '').trim();
      if (text.toLowerCase() === wanted) {
        return { text, from: offset, level };
      }
    }
    offset += line.length + 1;
  }
  return null;
}
