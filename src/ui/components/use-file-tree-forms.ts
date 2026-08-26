/**
 * ファイルツリーの操作 UI（新規フォルダー作成フォーム・リネーム・移動ダイアログ・
 * 削除確認）の状態（開閉と確定）を担うフック。
 */

import { useCallback, useEffect, useState } from 'react';

import { validateEntryName } from '@/application/file';
import { joinDirectoryPath, parentDirectoryPath, type TreeDirectory } from '@/domain/tree';

/** リネーム / 移動 / 削除の対象（パス + 種別） */
export type EntryTarget = { readonly path: string; readonly type: 'file' | 'directory' };

export type FileTreeForms = {
  /** 新規フォルダー作成フォームを表示するディレクトリ（null は非表示。'' はルート直下） */
  creating: string | null;
  openCreate: (directory: string) => void;
  cancelCreate: () => void;
  submitCreate: (directory: string, name: string) => void;
  renaming: EntryTarget | null;
  beginRename: (target: EntryTarget) => void;
  cancelRename: () => void;
  submitRename: (newName: string) => void;
  moveTarget: EntryTarget | null;
  beginMove: (target: EntryTarget) => void;
  cancelMove: () => void;
  confirmMove: (targetDirectory: string) => void;
  deleteTarget: EntryTarget | null;
  beginDelete: (target: EntryTarget) => void;
  cancelDelete: () => void;
  confirmDelete: () => void;
};

type UseFileTreeFormsArgs = {
  root: TreeDirectory;
  expandedPaths: ReadonlySet<string>;
  onToggleDirectory: (path: string) => void;
  onCreateDirectory: (directory: string, name: string) => void;
  onRename: (path: string, type: 'file' | 'directory', newName: string) => void;
  onMove: (path: string, type: 'file' | 'directory', targetDirectory: string) => void;
  onDelete: (path: string, type: 'file' | 'directory') => void;
};

export function useFileTreeForms(args: UseFileTreeFormsArgs): FileTreeForms {
  const entry = useEntryForms(args);
  const dialogs = useDialogForms(args);
  return { ...entry, ...dialogs };
}

type EntryFormArgs = Pick<
  UseFileTreeFormsArgs,
  'root' | 'expandedPaths' | 'onToggleDirectory' | 'onCreateDirectory' | 'onRename'
>;

type EntryForms = Pick<
  FileTreeForms,
  | 'creating'
  | 'openCreate'
  | 'cancelCreate'
  | 'submitCreate'
  | 'renaming'
  | 'beginRename'
  | 'cancelRename'
  | 'submitRename'
>;

/** 新規フォルダー作成フォームとリネーム入力の状態 */
function useEntryForms(args: EntryFormArgs): EntryForms {
  const { root, expandedPaths, onToggleDirectory, onCreateDirectory, onRename } = args;
  const [creating, setCreating] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<EntryTarget | null>(null);

  // ツリーが差し替わる（操作後の再読込・Vault 切替）たびに操作 UI を閉じる
  useEffect(() => {
    setCreating(null);
    setRenaming(null);
  }, [root]);

  /** 新規フォルダー作成フォームを開く（閉じたフォルダなら自動展開する） */
  const openCreate = useCallback(
    (directory: string): void => {
      if (directory !== '' && !expandedPaths.has(directory)) {
        onToggleDirectory(directory);
      }
      setCreating(directory);
    },
    [expandedPaths, onToggleDirectory],
  );

  const submitCreate = useCallback(
    (directory: string, name: string): void => {
      onCreateDirectory(directory, name);
      setCreating(null);
    },
    [onCreateDirectory],
  );

  /** リネーム入力の確定（名前を検証してコールバックへ渡す） */
  const submitRename = useCallback(
    (newName: string): void => {
      if (renaming === null) {
        return;
      }
      const name = newName.trim();
      const error = validateEntryName(name, renaming.path.endsWith('.md'));
      if (error !== null) {
        // エラーは InlineRenameInput が保持するためここには来ない（防御線）
        return;
      }
      const target = joinDirectoryPath(parentDirectoryPath(renaming.path), name);
      if (target !== renaming.path) {
        onRename(renaming.path, renaming.type, name);
      }
      setRenaming(null);
    },
    [renaming, onRename],
  );

  return {
    creating,
    openCreate,
    cancelCreate: (): void => setCreating(null),
    submitCreate,
    renaming,
    beginRename: (target: EntryTarget): void => setRenaming(target),
    cancelRename: (): void => setRenaming(null),
    submitRename,
  };
}

type DialogFormArgs = Pick<UseFileTreeFormsArgs, 'root' | 'onMove' | 'onDelete'>;

type DialogForms = Pick<
  FileTreeForms,
  | 'moveTarget'
  | 'beginMove'
  | 'cancelMove'
  | 'confirmMove'
  | 'deleteTarget'
  | 'beginDelete'
  | 'cancelDelete'
  | 'confirmDelete'
>;

/** 移動ダイアログと削除確認ダイアログの対象状態 */
function useDialogForms(args: DialogFormArgs): DialogForms {
  const { root, onMove, onDelete } = args;
  const [moveTarget, setMoveTarget] = useState<EntryTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<EntryTarget | null>(null);

  // ツリーが差し替わる（操作後の再読込・Vault 切替）たびにダイアログを閉じる
  useEffect(() => {
    setMoveTarget(null);
    setDeleteTarget(null);
  }, [root]);

  /** 移動ダイアログの確定（対象が消えた後にコミットする） */
  const confirmMove = useCallback(
    (targetDirectory: string): void => {
      if (moveTarget === null) {
        return;
      }
      const target = moveTarget;
      setMoveTarget(null);
      onMove(target.path, target.type, targetDirectory);
    },
    [moveTarget, onMove],
  );

  /** 削除確認の確定（対象が消えた後にコミットする） */
  const confirmDelete = useCallback((): void => {
    if (deleteTarget === null) {
      return;
    }
    const target = deleteTarget;
    setDeleteTarget(null);
    onDelete(target.path, target.type);
  }, [deleteTarget, onDelete]);

  return {
    moveTarget,
    beginMove: (target: EntryTarget): void => setMoveTarget(target),
    cancelMove: (): void => setMoveTarget(null),
    confirmMove,
    deleteTarget,
    beginDelete: (target: EntryTarget): void => setDeleteTarget(target),
    cancelDelete: (): void => setDeleteTarget(null),
    confirmDelete,
  };
}
