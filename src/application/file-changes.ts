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

/** ディレクトリ配下か（path 自身を含む） */
function isUnderDirectory(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

/** ファイルパス集合（大文字小文字を区別しない重複チェック用の小文字セット） */
function lowerPathSet(paths: readonly string[]): Set<string> {
  return new Set(paths.map((path) => path.toLowerCase()));
}

/**
 * 移動対象（MovePair 列）を検証・展開する。失敗時は validationFailure の結果を返す。
 * ノート 1 件 or ディレクトリ配下すべて（添付含む）。
 */
function expandMove(
  operation: Extract<FileOperation, { kind: 'rename-note' | 'rename-directory' }>,
  filePaths: readonly string[],
  existing: Set<string>,
): MovePair[] | { readonly ok: false; readonly error: FileCommitError } {
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
    return [{ from: operation.from, to: operation.to }];
  }
  // ディレクトリ配下の全ファイル（添付含む）を移動対象に展開する
  const children = filePaths.filter((path) => isUnderDirectory(path, operation.from));
  if (children.length === 0) {
    return validationFailure(`「${operation.from}」は存在しません。`);
  }
  const moves = children.map((path) => ({
    from: path,
    to: `${operation.to}${path.slice(operation.from.length)}`,
  }));
  // 展開後の個別移動先が既存ファイルと衝突する場合は失敗させる。
  // 先の existing.has(to) はディレクトリ自身の検証にしかならないため、
  // 例: 既存の daily/tektite.md がある Vault で projects/ を daily/ へ移動すると
  // 一括コミットの delta 上書きで既存ファイルの内容が失われる（実削除同様に
  // git 履歴を除いて取り返しがつかない）。移動元自身が移動先になるケースは
  // from === to の検証で除外済みで、展開後の to が from 配下に一致することもない
  const colliding = moves.find((move) => existing.has(move.to.toLowerCase()));
  if (colliding !== undefined) {
    return validationFailure(`移動先「${colliding.to}」は既に存在します。`);
  }
  return moves;
}

/** リネーム/移動の変更列を組み立てる（移動 + リンク張り替え + 影響ノート更新） */
function buildRename(
  operation: Extract<FileOperation, { kind: 'rename-note' | 'rename-directory' }>,
  filePaths: readonly string[],
  contents: ReadonlyMap<string, string>,
  existing: Set<string>,
):
  | { readonly ok: true; readonly changes: FileChange[]; readonly result: FileOperationResult }
  | { readonly ok: false; readonly error: FileCommitError } {
  const expanded = expandMove(operation, filePaths, existing);
  if (!Array.isArray(expanded)) {
    return expanded;
  }
  const moves = expanded;
  const plan = planLinkRewrite({ moves, contents, filePaths });

  const changes: FileChange[] = [];
  for (const move of moves) {
    changes.push({ op: 'move', path: move.from, to: move.to });
    const rewrittenContent = plan.rewritten.get(move.from);
    if (rewrittenContent !== undefined) {
      // 移動元ノート自身のリンクが張り替わった場合は移動後に新本文で上書きする
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
  const existing = lowerPathSet(filePaths);

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
  return buildRename(operation, filePaths, contents, existing);
}
