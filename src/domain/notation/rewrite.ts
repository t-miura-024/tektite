/**
 * リンク張り替え（M5: リネーム時のWikiLink自動更新）。
 * MovePair列を受けて全ノートを走査する純関数。解決先が移動元なら移動先フルパスへ張り替え、エイリアスと見出しは保持する。
 * Embedも同様に扱い、フルパスで書くことで一意に解決できる。曖昧な参照はissuesで返し、無関係・壊れリンクは変えない。
 */

import { parseNotation } from '@/domain/notation/parse';
import { resolveNotePath } from '@/domain/notation/resolve';

/** 移動 1 件（from: 旧パス → to: 新パス。ファイル・ディレクトリ内ファイル単位） */
export type MovePair = {
  readonly from: string;
  readonly to: string;
};

/** 張り替えられなかった参照（警告として UI へ通知する） */
export type RewriteIssue = {
  readonly kind: 'ambiguous';
  /** 参照元ノートのパス */
  readonly path: string;
  /** リンクのターゲット本文（`#` / `|` を除いたもの） */
  readonly target: string;
  /** 候補に入っていた移動元パス（解決規則の勝者ではなかったもの） */
  readonly movedCandidates: readonly string[];
};

export type RewritePlan = {
  /**
   * 旧パス → 張り替え後の本文。本文が実際に変化したノートだけを含む
   * （移動元ノート自身が自分のリンクを張り替える場合もここに入る）
   */
  readonly rewritten: ReadonlyMap<string, string>;
  /** 張り替えられなかった曖昧参照（規則で確定できないもの） */
  readonly issues: readonly RewriteIssue[];
};

export type RewriteInput = {
  /** 移動の対応（from → to）。from と to はファイルパス単位 */
  readonly moves: readonly MovePair[];
  /** Vault 内の全ノート本文（旧パス基準） */
  readonly contents: ReadonlyMap<string, string>;
  /** Vault 内の全ファイルパス（旧パス基準。画像等の非 Markdown も含む） */
  readonly filePaths: readonly string[];
};

/** 参照スパン 1 件の張り替え結果 */
type Edit = {
  readonly from: number;
  readonly to: number;
  readonly text: string;
};

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
        const open = span.kind === 'embed' ? '![[' : '[[';
        const subpath = span.subpath === null ? '' : `#${span.subpath}`;
        const alias = span.alias === null ? '' : `|${span.alias}`;
        edits.push({ from: span.from, to: span.to, text: `${open}${to}${subpath}${alias}]]` });
        continue;
      }
      // 移動元が候補に入るが勝者にならなかった参照は曖昧として警告する
      const movedCandidates = moves
        .filter((move) => resolveNotePath(span.target, [move.from]) !== null)
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
