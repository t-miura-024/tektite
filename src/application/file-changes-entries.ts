/**
 * ファイル操作のうち作成・削除・複製の検証と変更列組み立て。
 * rename / move の展開とリンク張り替えは file-changes.ts が担う。
 */

import { fileCommitError, type FileChange, type FileCommitError } from '@/application/note';
import type { FileOperation, FileOperationResult } from '@/application/file-changes';

/** 検証エラーの失敗値（ok: false 形） */
function validationFailure(message: string): {
  readonly ok: false;
  readonly error: FileCommitError;
} {
  return { ok: false, error: fileCommitError('server', message) };
}

/** パスのセグメント検証（空セグメント・. / .. ・前後スラッシュを拒否） */
export function isValidPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.endsWith('/')) {
    return false;
  }
  return path
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/** ディレクトリ配下か（path 自身を含む） */
function isUnderDirectory(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

/** ノート作成 1 件の検証と変更列の組み立て */
export function buildCreateNote(
  operation: Extract<FileOperation, { kind: 'create-note' }>,
  existing: Set<string>,
):
  | { readonly ok: true; readonly changes: FileChange[]; readonly result: FileOperationResult }
  | { readonly ok: false; readonly error: FileCommitError } {
  if (!isValidPath(operation.path) || !operation.path.endsWith('.md')) {
    return validationFailure('ノートのパスが不正です。');
  }
  if (existing.has(operation.path.toLowerCase())) {
    return validationFailure(`「${operation.path}」は既に存在します。`);
  }
  return {
    ok: true,
    // Obsidian 式の新規作成（Q11/Q15）: タイトル確定時に本文を含めて 1 コミットする
    changes: [{ op: 'create', path: operation.path, content: operation.content ?? '' }],
    result: { removedPaths: [], movedPaths: [], createdPaths: [operation.path], issues: [] },
  };
}

/** ディレクトリ作成の検証と変更列の組み立て（GitHub は空ディレクトリを持てないため .gitkeep を置く） */
export function buildCreateDirectory(
  operation: Extract<FileOperation, { kind: 'create-directory' }>,
  filePaths: readonly string[],
):
  | { readonly ok: true; readonly changes: FileChange[]; readonly result: FileOperationResult }
  | { readonly ok: false; readonly error: FileCommitError } {
  if (!isValidPath(operation.path)) {
    return validationFailure('ディレクトリのパスが不正です。');
  }
  if (filePaths.some((path) => isUnderDirectory(path, operation.path))) {
    return validationFailure(`「${operation.path}」は既に存在します。`);
  }
  const keepPath = `${operation.path}/.gitkeep`;
  return {
    ok: true,
    changes: [{ op: 'create', path: keepPath, content: '' }],
    result: { removedPaths: [], movedPaths: [], createdPaths: [operation.path], issues: [] },
  };
}

/** ノート削除の検証と変更列の組み立て */
export function buildDeleteNote(
  operation: Extract<FileOperation, { kind: 'delete-note' }>,
  existing: Set<string>,
):
  | { readonly ok: true; readonly changes: FileChange[]; readonly result: FileOperationResult }
  | { readonly ok: false; readonly error: FileCommitError } {
  if (!existing.has(operation.path.toLowerCase())) {
    return validationFailure(`「${operation.path}」は存在しません。`);
  }
  return {
    ok: true,
    changes: [{ op: 'delete', path: operation.path }],
    result: { removedPaths: [operation.path], movedPaths: [], createdPaths: [], issues: [] },
  };
}

/** ディレクトリ削除の検証と変更列の組み立て（配下全ファイルを実削除する） */
export function buildDeleteDirectory(
  operation: Extract<FileOperation, { kind: 'delete-directory' }>,
  filePaths: readonly string[],
):
  | { readonly ok: true; readonly changes: FileChange[]; readonly result: FileOperationResult }
  | { readonly ok: false; readonly error: FileCommitError } {
  const targets = filePaths.filter((path) => isUnderDirectory(path, operation.path));
  if (targets.length === 0) {
    return validationFailure(`「${operation.path}」は存在しません。`);
  }
  return {
    ok: true,
    changes: targets.map((path) => ({ op: 'delete' as const, path })),
    result: {
      removedPaths: targets,
      movedPaths: [],
      createdPaths: [],
      issues: [],
    },
  };
}

/**
 * 複製の検証と変更列の組み立て（Obsidian 式命名は UI 側が決め、to を渡す）。
 * 内容はそのままコピーし WikiLink は張り替えない。copy はサーバー側で blob sha を再利用する
 */
export function buildDuplicate(
  operation: Extract<FileOperation, { kind: 'duplicate-note' | 'duplicate-directory' }>,
  filePaths: readonly string[],
  existing: Set<string>,
):
  | { readonly ok: true; readonly changes: FileChange[]; readonly result: FileOperationResult }
  | { readonly ok: false; readonly error: FileCommitError } {
  if (operation.kind === 'duplicate-note') {
    if (!isValidPath(operation.to) || !operation.to.endsWith('.md')) {
      return validationFailure('複製先のノートパスが不正です。');
    }
    if (!existing.has(operation.from.toLowerCase())) {
      return validationFailure(`「${operation.from}」は存在しません。`);
    }
    if (existing.has(operation.to.toLowerCase())) {
      return validationFailure(`「${operation.to}」は既に存在します。`);
    }
    return {
      ok: true,
      changes: [{ op: 'copy', path: operation.from, to: operation.to }],
      result: { removedPaths: [], movedPaths: [], createdPaths: [operation.to], issues: [] },
    };
  }
  if (!isValidPath(operation.to)) {
    return validationFailure('複製先のディレクトリパスが不正です。');
  }
  const children = filePaths.filter((path) => isUnderDirectory(path, operation.from));
  if (children.length === 0) {
    return validationFailure(`「${operation.from}」は存在しません。`);
  }
  const copies = children.map((path) => ({
    from: path,
    to: `${operation.to}${path.slice(operation.from.length)}`,
  }));
  const colliding = copies.find((copy) => existing.has(copy.to.toLowerCase()));
  if (colliding !== undefined) {
    return validationFailure(`複製先「${colliding.to}」は既に存在します。`);
  }
  return {
    ok: true,
    changes: copies.map((copy) => ({ op: 'copy', path: copy.from, to: copy.to })),
    result: { removedPaths: [], movedPaths: [], createdPaths: [operation.to], issues: [] },
  };
}
