/**
 * ファイル操作 → コミット変更列の組み立て。
 *
 * UI の操作（FileOperation）を検証し、一括コミットへ渡す FileChange 列と
 * 操作結果（FileOperationResult）を組み立てる。検証エラーは ok: false で返す
 * （Effect.gen 内で typed failure として扱うため）。リンク張り替えは
 * src/domain/notation/rewrite が担う。
 */

import {
  buildCreateDirectory,
  isValidPath,
  buildCreateNote,
  buildDeleteDirectory,
  buildDeleteNote,
  buildDuplicate,
} from '@/application/file-changes-entries';
import { fileCommitError, type FileChange, type FileCommitError } from '@/application/note';
import { planLinkRewrite, type MovePair, type RewriteIssue } from '@/domain/notation/rewrite';

/** ファイル操作 1 件（path は Vault ルートからの / 区切りフルパス） */
export type FileOperation =
  | { readonly kind: 'create-note'; readonly path: string; readonly content?: string }
  | { readonly kind: 'create-directory'; readonly path: string }
  | { readonly kind: 'delete-note'; readonly path: string }
  | { readonly kind: 'delete-directory'; readonly path: string }
  | { readonly kind: 'rename-note'; readonly from: string; readonly to: string }
  | { readonly kind: 'rename-directory'; readonly from: string; readonly to: string }
  | { readonly kind: 'duplicate-note'; readonly from: string; readonly to: string }
  | { readonly kind: 'duplicate-directory'; readonly from: string; readonly to: string };

/** 操作の結果（UI がツリー再読込・ノート遷移・警告表示に使う） */
export type FileOperationResult = {
  /** 削除されたパス（リネーム/移動の元パスを含む） */
  readonly removedPaths: readonly string[];
  /** リネーム/移動の対応（from → to。ディレクトリ操作は配下ファイル分に展開済み） */
  readonly movedPaths: readonly MovePair[];
  /** 新規作成されたパス（create-directory は `.gitkeep` ではなくディレクトリパス） */
  readonly createdPaths: readonly string[];
  /** 張り替えられなかった曖昧参照（リネーム/移動時のみ） */
  readonly issues: readonly RewriteIssue[];
};

/** 検証エラーの失敗値（buildChanges の ok: false 形） */
const validationFailure = (
  message: string,
): { readonly ok: false; readonly error: FileCommitError } => ({
  ok: false,
  error: fileCommitError('server', message),
});

/**
 * 操作の検証を行い、コミットへ渡す変更列（FileChange）を組み立てる。
 * filePaths は操作前の全ファイルパス（ツリー由来）。contents は全ノート本文（旧パス基準）。
 * 検証エラーは ok: false で返す（Effect.gen 内で typed failure として扱うため）。
 */
export function buildChanges(
  operation: FileOperation,
  filePaths: readonly string[],
  contents: ReadonlyMap<string, string>,
):
  | { readonly ok: true; readonly changes: FileChange[]; readonly result: FileOperationResult }
  | { readonly ok: false; readonly error: FileCommitError } {
  const existing = new Set(filePaths.map((path) => path.toLowerCase()));

  if (operation.kind === 'create-note') {
    return buildCreateNote(operation, existing);
  }
  if (operation.kind === 'create-directory') {
    return buildCreateDirectory(operation, filePaths);
  }
  if (operation.kind === 'delete-note') {
    return buildDeleteNote(operation, existing);
  }
  if (operation.kind === 'delete-directory') {
    return buildDeleteDirectory(operation, filePaths);
  }
  if (operation.kind === 'duplicate-note' || operation.kind === 'duplicate-directory') {
    return buildDuplicate(operation, filePaths, existing);
  }
  if (operation.from === operation.to) {
    return validationFailure('移動元と移動先が同じです。');
  }
  if (!isValidPath(operation.to)) {
    return validationFailure('移動先のパスが不正です。');
  }
  if (existing.has(operation.to.toLowerCase())) {
    return validationFailure(`「${operation.to}」は既に存在します。`);
  }
  if (operation.kind === 'rename-note') {
    if (!existing.has(operation.from.toLowerCase())) {
      return validationFailure(`「${operation.from}」は存在しません。`);
    }
    const moves: MovePair[] = [{ from: operation.from, to: operation.to }];
    const plan = planLinkRewrite({ moves, contents, filePaths });
    const changes: FileChange[] = [];
    for (const move of moves) {
      changes.push({ op: 'move', path: move.from, to: move.to });
      const rewrittenContent = plan.rewritten.get(move.from);
      if (rewrittenContent !== undefined) {
        changes.push({ op: 'update', path: move.to, content: rewrittenContent });
      }
    }
    for (const [path, content] of plan.rewritten) {
      if (!moves.some((move) => move.from === path)) {
        changes.push({ op: 'update', path, content });
      }
    }
    return {
      ok: true,
      changes,
      result: {
        removedPaths: moves.map((move) => move.from),
        movedPaths: moves,
        createdPaths: [],
        issues: plan.issues,
      },
    };
  }
  const children = filePaths.filter(
    (path) => path === operation.from || path.startsWith(`${operation.from}/`),
  );
  if (children.length === 0) {
    return validationFailure(`「${operation.from}」は存在しません。`);
  }
  const moves = children.map((path) => ({
    from: path,
    to: `${operation.to}${path.slice(operation.from.length)}`,
  }));
  const colliding = moves.find((move) => existing.has(move.to.toLowerCase()));
  if (colliding !== undefined) {
    return validationFailure(`移動先「${colliding.to}」は既に存在します。`);
  }
  const plan = planLinkRewrite({ moves, contents, filePaths });
  const changes: FileChange[] = [];
  for (const move of moves) {
    changes.push({ op: 'move', path: move.from, to: move.to });
    const rewrittenContent = plan.rewritten.get(move.from);
    if (rewrittenContent !== undefined) {
      changes.push({ op: 'update', path: move.to, content: rewrittenContent });
    }
  }
  for (const [path, content] of plan.rewritten) {
    if (!moves.some((move) => move.from === path)) {
      changes.push({ op: 'update', path, content });
    }
  }
  return {
    ok: true,
    changes,
    result: {
      removedPaths: moves.map((move) => move.from),
      movedPaths: moves,
      createdPaths: [],
      issues: plan.issues,
    },
  };
}
