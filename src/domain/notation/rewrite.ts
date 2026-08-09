/**
 * リンク張り替えエンジン（M5: リネーム/移動時の WikiLink 自動張り替え）。
 *
 * リネーム/移動（MovePair の列）を受け取り、Vault 内の全ノート本文を走査して
 * 移動対象を参照する WikiLink / Embed（エイリアス・見出しリンクの参照先を含む）
 * を新しいパスへ張り替えた本文を生成する。純 TypeScript・副作用なし。
 *
 * 張り替え規則:
 * - 参照の解決は既存の索引（src/domain/notation/resolve の最短パス一致）に従う。
 *   解決結果のパスが移動元（from）なら、ターゲットを移動先のフルパス（to）に
 *   置き換える。エイリアス（`|` 以降）と見出し（`#` 以降）は保持する。
 *   Embed（`![[...]]`）も同じ規則で張り替える（ノート本文展開・画像の両方。
 *   ディレクトリ移動で添付ファイルも動くため、参照を壊さない）
 * - 移動先をフルパスで書くのは、張り替え後のリンクが常に最短パス一致で一意に
 *   解決できることを保証するため（短縮名にすると同名ノートが増えたときに
 *   意図しないノートを指す危険がある）
 * - 移動元ノートが「候補に入るが解決規則の勝者にならなかった」参照は曖昧とみなし、
 *   張り替えずに issues（警告）として返す（計画メモ: 同名ノートが複数ある場合）。
 *   勝者が移動元なら規則どおり張り替える（規則が確定した解釈として扱う）
 * - 張り替え対象外（移動と無関係なリンク・壊れリンク）は本文を変更しない
 */

import { parseNotation } from '@/domain/notation/parse';
import type { NotationSpan } from '@/domain/notation/parse';
import { resolveNotePath } from '@/domain/notation/resolve';

/** 移動 1 件（from: 旧パス → to: 新パス。ファイル・ディレクトリ内ファイル単位） */
export interface MovePair {
  readonly from: string;
  readonly to: string;
}

/** 張り替えられなかった参照（警告として UI へ通知する） */
export interface RewriteIssue {
  readonly kind: 'ambiguous';
  /** 参照元ノートのパス */
  readonly path: string;
  /** リンクのターゲット本文（`#` / `|` を除いたもの） */
  readonly target: string;
  /** 候補に入っていた移動元パス（解決規則の勝者ではなかったもの） */
  readonly movedCandidates: readonly string[];
}

export interface RewritePlan {
  /**
   * 旧パス → 張り替え後の本文。本文が実際に変化したノートだけを含む
   * （移動元ノート自身が自分のリンクを張り替える場合もここに入る）
   */
  readonly rewritten: ReadonlyMap<string, string>;
  /** 張り替えられなかった曖昧参照（規則で確定できないもの） */
  readonly issues: readonly RewriteIssue[];
}

export interface RewriteInput {
  /** 移動の対応（from → to）。from と to はファイルパス単位 */
  readonly moves: readonly MovePair[];
  /** Vault 内の全ノート本文（旧パス基準） */
  readonly contents: ReadonlyMap<string, string>;
  /** Vault 内の全ファイルパス（旧パス基準。画像等の非 Markdown も含む） */
  readonly filePaths: readonly string[];
}

/** 参照スパン 1 件の張り替え結果 */
interface Edit {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

/** 移動 1 件の張り替え対象パス（`[[a]]` が `dir/a.md` に解決するかの判定） */
function isMovedCandidate(target: string, from: string): boolean {
  return resolveNotePath(target, [from]) !== null;
}

/** 張り替え後のリンク本文（`[[to#subpath|alias]]` / `![[to#subpath|alias]]`） */
function buildLinkText(
  span: Extract<NotationSpan, { kind: 'wikilink' | 'embed' }>,
  to: string,
): string {
  const open = span.kind === 'embed' ? '![[' : '[[';
  const subpath = span.subpath === null ? '' : `#${span.subpath}`;
  const alias = span.alias === null ? '' : `|${span.alias}`;
  return `${open}${to}${subpath}${alias}]]`;
}

/**
 * 移動の対応に従って全ノートのリンクを張り替える。
 * 本文が変わったノートの新旧対応と、張り替えられなかった曖昧参照を返す。
 */
export function planLinkRewrite(input: RewriteInput): RewritePlan {
  const { moves, contents, filePaths } = input;
  const toByFrom = new Map(moves.map((move) => [move.from, move.to]));
  const rewritten = new Map<string, string>();
  const issues: RewriteIssue[] = [];

  for (const [path, content] of contents) {
    const result = parseNotation(content);
    const edits: Edit[] = [];
    for (const span of result.spans) {
      if (span.kind === 'tag') {
        continue;
      }
      const resolved = resolveNotePath(span.target, filePaths);
      const to = resolved === null ? undefined : toByFrom.get(resolved);
      if (resolved !== null && to !== undefined) {
        // 解決先が移動元 → 移動先フルパスへ張り替える（エイリアス・見出しは保持）
        edits.push({ from: span.from, to: span.to, text: buildLinkText(span, to) });
        continue;
      }
      // 移動元が候補に入るが勝者にならなかった参照は曖昧として警告する
      const movedCandidates = moves
        .filter((move) => isMovedCandidate(span.target, move.from))
        .map((move) => move.from);
      if (movedCandidates.length > 0) {
        issues.push({ kind: 'ambiguous', path, target: span.target, movedCandidates });
      }
    }
    if (edits.length === 0) {
      continue;
    }
    // 出現順（昇順）の編集を後ろから適用してオフセットを保つ
    let next = content;
    for (let index = edits.length - 1; index >= 0; index -= 1) {
      const edit = edits[index];
      if (edit === undefined) {
        continue;
      }
      next = `${next.slice(0, edit.from)}${edit.text}${next.slice(edit.to)}`;
    }
    rewritten.set(path, next);
  }

  return { rewritten, issues };
}
