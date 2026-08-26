/**
 * ファイルツリーの操作ダイアログ（移動先選択 / 削除確認）。
 * 対象が未指定の間は何も描画しない。
 */

import { useMemo, type JSX } from 'react';

import { pathBaseName, type TreeDirectory } from '@/domain/tree';

import { ConfirmDialog } from '@/ui/components/confirm-dialog';
import { MoveDialog } from '@/ui/components/move-dialog';
import type { FileTreeForms } from '@/ui/components/use-file-tree-forms';
import { blockedMoveTargets, collectDirectories } from '@/ui/components/file-tree-utils';

export type FileTreeDialogsProps = {
  root: TreeDirectory;
  forms: FileTreeForms;
};

type MoveCandidates = {
  directories: string[];
  blocked: Set<string>;
};

/** 移動先候補（ソート済みディレクトリ一覧）と禁止先をまとめて計算する */
function useMoveCandidates(root: TreeDirectory, forms: FileTreeForms): MoveCandidates {
  return useMemo(() => {
    const directories = collectDirectories(root);
    if (forms.moveTarget === null) {
      return { directories, blocked: new Set<string>() };
    }
    return { directories, blocked: blockedMoveTargets(forms.moveTarget, directories) };
  }, [root, forms.moveTarget]);
}

export function FileTreeDialogs({ root, forms }: FileTreeDialogsProps): JSX.Element {
  const candidates = useMoveCandidates(root, forms);
  const moveTarget = forms.moveTarget;
  const deleteTarget = forms.deleteTarget;
  return (
    <>
      {moveTarget !== null && (
        <MoveDialog
          targetLabel={
            moveTarget.type === 'directory'
              ? `${pathBaseName(moveTarget.path)}/`
              : pathBaseName(moveTarget.path)
          }
          directories={candidates.directories}
          blocked={candidates.blocked}
          onCancel={forms.cancelMove}
          onConfirm={forms.confirmMove}
        />
      )}
      {deleteTarget !== null && (
        <ConfirmDialog
          title={deleteTarget.type === 'directory' ? 'フォルダーを削除' : 'ノートを削除'}
          message={
            deleteTarget.type === 'directory'
              ? `「${pathBaseName(deleteTarget.path)}/」を削除します。配下の全ファイルが GitHub から削除され、取り消しはできません。`
              : `「${pathBaseName(deleteTarget.path)}」を GitHub から削除します。取り消しはできません。`
          }
          confirmLabel="削除"
          danger
          onCancel={forms.cancelDelete}
          onConfirm={forms.confirmDelete}
        />
      )}
    </>
  );
}
