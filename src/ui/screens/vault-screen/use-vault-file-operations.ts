/**
 * ファイル操作（作成/リネーム/移動/削除/複製）の一括コミット実行と、
 * Obsidian 式の未確定ノート（新規作成 → タイトル確定で 1 コミット）の管理。
 */

import { useCallback, useEffect, useState } from 'react';

import { applyFileOperation, type FileOperation } from '@/application/file';
import { run } from '@/composition';
import { joinDirectoryPath, parentDirectoryPath, pathBaseName } from '@/domain/tree';
import { fileErrorMessage } from '@/ui/note-error';
import { navigate, noteRoutePath, vaultRoutePath } from '@/ui/router';
import { FILE_OPERATION_MESSAGES } from '@/ui/screens/vault-screen/screen-utils';
import type { ToastAction } from '@/ui/toast';
import { isSessionExpiredError } from '@/ui/vault-error';

/** 未確定ノート破棄時の遷移先（Vault ルート）へ戻す */
function backToVaultRoot(owner: string, name: string): void {
  navigate(vaultRoutePath({ owner, name }));
}

export type VaultFileOperations = {
  /** 未確定（未コミット）の新規ノートパス（null はなし） */
  pendingNotePath: string | null;
  runFileOperation: (operation: FileOperation, successMessage: string) => Promise<boolean>;
  handleDuplicate: (path: string, type: 'file' | 'directory') => Promise<void>;
  /** 新規ノートを開始する（デフォルト名でエディタを開き、コミットは保留） */
  startNewNote: (directory: string) => void;
  /** 未確定ノートを最終名 + 本文で 1 コミットで作成する（成功で true） */
  commitPendingNote: (finalName: string, content: string) => Promise<boolean>;
  /** 未確定ノートを破棄する（Escape。何もコミットしない） */
  discardPendingNote: () => void;
};

export type UseVaultFileOperationsArgs = {
  owner: string;
  name: string;
  notePath: string | null;
  /** Vault 内の全ファイルパス（衝突しない名前の生成とリンク張替えに使う） */
  filePaths: readonly string[];
  notify: (message: string, action?: ToastAction) => void;
  onSessionExpired: () => void;
  /** 操作成功後のツリー + 索引の再読込 */
  load: (initialize?: boolean) => Promise<void>;
  /** 複製したフォルダを展開済みにする */
  expandDirectory: (path: string) => void;
};

type RunFileOperations = Pick<VaultFileOperations, 'runFileOperation'>;

/** 一括コミットの実行と成否判定・遷移（M5） */
function useRunFileOperations(args: UseVaultFileOperationsArgs): RunFileOperations {
  const { owner, name, notePath, filePaths, notify, onSessionExpired, load } = args;

  const runFileOperation = useCallback(
    async (operation: FileOperation, successMessage: string): Promise<boolean> => {
      try {
        const result = await run(applyFileOperation({ owner, name }, operation, filePaths));
        let message = successMessage;
        if (result.issues.length > 0) {
          message += `（${result.issues.length} 件のリンクは曖昧なため張り替えませんでした）`;
        }
        notify(message);
        // ツリー + 共有索引を再読込する（索引はユースケースが更新済みのため再取得されない）
        await load();
        navigateFor(operation, notePath, result.movedPaths, result.removedPaths, owner, name);
        return true;
      } catch (error) {
        if (isSessionExpiredError(error)) {
          notify('セッションの有効期限が切れました。ログインし直してください。');
          onSessionExpired();
          return false;
        }
        notify(fileErrorMessage(error));
        return false;
      }
    },
    [owner, name, filePaths, notePath, notify, onSessionExpired, load],
  );

  return { runFileOperation };
}

type PendingNoteOperations = Pick<
  VaultFileOperations,
  | 'pendingNotePath'
  | 'handleDuplicate'
  | 'startNewNote'
  | 'commitPendingNote'
  | 'discardPendingNote'
>;

/** 未確定ノート（新規作成フロー）と複製の状態・操作 */
function usePendingNoteOperations(args: UseVaultFileOperationsArgs): PendingNoteOperations {
  const { owner, name, notePath, filePaths, expandDirectory } = args;
  const { runFileOperation } = useRunFileOperations(args);
  const [pendingNotePath, setPendingNotePath] = useState<string | null>(null);

  // Vault が変わったら未確定ノートを破棄する
  useEffect(() => {
    setPendingNotePath(null);
  }, [owner, name]);
  const nextDuplicatePath = useCallback(
    (path: string, type: 'file' | 'directory'): string =>
      nextAvailableCopyName(path, type, filePaths),
    [filePaths],
  );
  const handleDuplicate = useCallback(
    async (path: string, type: 'file' | 'directory'): Promise<void> => {
      const to = nextDuplicatePath(path, type);
      const kind = type === 'file' ? 'duplicate-note' : 'duplicate-directory';
      const ok = await runFileOperation({ kind, from: path, to }, FILE_OPERATION_MESSAGES[kind]);
      if (!ok) {
        return;
      }
      if (type === 'file') {
        navigate(noteRoutePath({ owner, name }, to));
        return;
      }
      // フォルダは複製先を展開して結果を見えるようにする
      expandDirectory(to);
    },
    [nextDuplicatePath, runFileOperation, owner, name, expandDirectory],
  );

  /** 新規ノートを開始する（Obsidian 式: デフォルト名でエディタを開き、コミットは保留） */
  const startNewNote = useCallback(
    (directory: string): void => {
      const path = nextUntitledName(directory, filePaths);
      setPendingNotePath(path);
      navigate(noteRoutePath({ owner, name }, path));
    },
    [filePaths, owner, name],
  );

  /** 未確定ノートを最終名 + 本文で 1 コミットで作成する（成功で true） */
  const commitPendingNote = useCallback(
    async (finalName: string, content: string): Promise<boolean> => {
      if (pendingNotePath === null) {
        return false;
      }
      const finalPath = joinDirectoryPath(parentDirectoryPath(pendingNotePath), finalName);
      const ok = await runFileOperation(
        { kind: 'create-note', path: finalPath, content },
        FILE_OPERATION_MESSAGES['create-note'],
      );
      if (ok) {
        setPendingNotePath(null);
        // リネームされた場合のみ最終パスへ遷移する（ユーザーが既に別ノートへ
        // 移動していた場合は、その移動を上書きしない）
        if (finalPath !== pendingNotePath && notePath === pendingNotePath) {
          navigate(noteRoutePath({ owner, name }, finalPath));
        }
      }
      return ok;
    },
    [pendingNotePath, runFileOperation, owner, name, notePath],
  );

  const discardPendingNote = useCallback((): void => {
    setPendingNotePath(null);
    backToVaultRoot(owner, name);
  }, [owner, name]);

  return {
    pendingNotePath,
    handleDuplicate,
    startNewNote,
    commitPendingNote,
    discardPendingNote,
  };
}

export function useVaultFileOperations(args: UseVaultFileOperationsArgs): VaultFileOperations {
  return {
    ...useRunFileOperations(args),
    ...usePendingNoteOperations(args),
  };
}

/** 操作後の遷移: 移動・リネーム → 新パス / 削除 → Vault ルート（create-note は除く） */
function navigateFor(
  operation: FileOperation,
  notePath: string | null,
  movedPaths: readonly { readonly from: string; readonly to: string }[],
  removedPaths: readonly string[],
  owner: string,
  name: string,
): void {
  if (notePath === null || operation.kind === 'create-note') {
    return;
  }
  const moved = movedPaths.find((move) => move.from === notePath);
  if (moved !== undefined) {
    navigate(noteRoutePath({ owner, name }, moved.to));
    return;
  }
  if (removedPaths.includes(notePath)) {
    navigate(vaultRoutePath({ owner, name }));
  }
}

/** 新規ノートのデフォルト名（Untitled.md / Untitled 1.md …）を衝突しない形で決める */
function nextUntitledName(directory: string, filePaths: readonly string[]): string {
  const existing = new Set(filePaths.map((p) => p.toLowerCase()));
  let candidate = 'Untitled.md';
  for (
    let index = 1;
    existing.has(joinDirectoryPath(directory, candidate).toLowerCase());
    index += 1
  ) {
    candidate = `Untitled ${index}.md`;
  }
  return joinDirectoryPath(directory, candidate);
}

/** Obsidian 式の複製名（`a copy.md` → `a copy 1.md` → …）を衝突しない形で計算する */
function nextAvailableCopyName(
  path: string,
  type: 'file' | 'directory',
  filePaths: readonly string[],
): string {
  const directory = parentDirectoryPath(path);
  const base = pathBaseName(path);
  const dot = base.lastIndexOf('.');
  const stem = type === 'file' && dot > 0 ? base.slice(0, dot) : base;
  const ext = type === 'file' && dot > 0 ? base.slice(dot) : '';
  const existing = new Set(filePaths.map((p) => p.toLowerCase()));
  let candidate = `${stem} copy${ext}`;
  for (
    let index = 1;
    existing.has(joinDirectoryPath(directory, candidate).toLowerCase());
    index += 1
  ) {
    candidate = `${stem} copy ${index}${ext}`;
  }
  return joinDirectoryPath(directory, candidate);
}
