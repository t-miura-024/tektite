/**
 * ディレクトリの展開状態（ルート自動展開・ディープリンク復元・一括開閉）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { ancestorDirectoryPaths, type TreeDirectory } from '@/domain/tree';

import { collectDirectoryPaths } from '@/ui/screens/vault-screen/screen-utils';

export type ExpandedDirectories = {
  expandedPaths: ReadonlySet<string>;
  toggleDirectory: (path: string) => void;
  /** 開いているノートの祖先ディレクトリを展開する */
  revealCurrentNote: () => void;
  toggleAllDirectories: () => void;
  allExpanded: boolean;
  /** 指定ディレクトリを展開済みにする（複製先の表示など） */
  expandDirectory: (path: string) => void;
};

type UseExpandedDirectoriesArgs = {
  /** 展開計算の対象ツリーのルート（未取得は null） */
  root: TreeDirectory | null;
  notePath: string | null;
  /** Vault 切替で展開状態をリセットするためのキー（`${owner}/${name}`） */
  vaultKey: string;
};

export function useExpandedDirectories(args: UseExpandedDirectoriesArgs): ExpandedDirectories {
  const { root, notePath, vaultKey } = args;
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set(['']));

  // Vault が変わったらルートのみ展開した状態へ戻す
  useEffect(() => {
    setExpandedPaths(new Set(['']));
  }, [vaultKey]);

  // ツリー取得後: ルートを展開し、ノートパス指定があれば祖先ディレクトリも展開する
  // （ディープリンクのリロードで選択状態を復元するため）
  useEffect(() => {
    if (root === null) {
      return;
    }
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      next.add('');
      if (notePath !== null) {
        for (const ancestor of ancestorDirectoryPaths(notePath)) {
          next.add(ancestor);
        }
      }
      return next;
    });
  }, [root, notePath]);

  const toggleDirectory = useCallback((path: string): void => {
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
        return next;
      }
      next.add(path);
      return next;
    });
  }, []);

  const revealCurrentNote = useCallback((): void => {
    if (notePath === null) {
      return;
    }
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      for (const ancestor of ancestorDirectoryPaths(notePath)) {
        next.add(ancestor);
      }
      return next;
    });
  }, [notePath]);

  const expandDirectory = useCallback((path: string): void => {
    setExpandedPaths((previous) => new Set(previous).add(path));
  }, []);

  const allDirectoryPaths = useMemo(
    () => (root === null ? [] : collectDirectoryPaths(root)),
    [root],
  );
  const allExpanded =
    allDirectoryPaths.length > 0 && allDirectoryPaths.every((path) => expandedPaths.has(path));
  const toggleAllDirectories = useCallback((): void => {
    setExpandedPaths(allExpanded ? new Set(['']) : new Set(allDirectoryPaths));
  }, [allDirectoryPaths, allExpanded]);

  return {
    expandedPaths,
    toggleDirectory,
    revealCurrentNote,
    toggleAllDirectories,
    allExpanded,
    expandDirectory,
  };
}
