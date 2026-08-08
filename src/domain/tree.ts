/**
 * ファイルツリーのドメインモデル（ノード構造・除外規則）。
 *
 * ファイルツリーは Vault 内の全ファイルを表示する（Markdown 限定ではない）。
 * 除外対象は隠れディレクトリ（ドット始まりのディレクトリセグメント）のみ。
 * `.obsidian/` や `.git/` 配下は丸ごと除外されるが、`.gitignore` のような
 * 隠れ「ファイル」は表示対象に残る。
 */

import type { VaultRef } from './vault';

export type TreeEntryType = 'file' | 'directory';

/** Git Trees API などから得られるフラットなエントリ */
export interface TreeEntry {
  readonly path: string;
  readonly type: TreeEntryType;
}

export interface TreeFile {
  readonly type: 'file';
  /** 最終セグメントの表示名 */
  readonly name: string;
  /** Vault ルートからのパス（/ 区切り） */
  readonly path: string;
}

export interface TreeDirectory {
  readonly type: 'directory';
  readonly name: string;
  readonly path: string;
  /** ディレクトリ優先・名前順でソート済み */
  readonly children: readonly TreeNode[];
}

export type TreeNode = TreeFile | TreeDirectory;

/** 構築済みの Vault ファイルツリー */
export interface VaultTree {
  readonly ref: VaultRef;
  readonly defaultBranch: string;
  /** Git Trees API が truncated を返した場合 true（巨大リポジトリ） */
  readonly truncated: boolean;
  readonly root: TreeDirectory;
}

function isHiddenSegment(segment: string): boolean {
  return segment.startsWith('.');
}

/**
 * 隠れディレクトリ配下（または隠れディレクトリ自体）かどうか。
 * ファイル自身の名前がドット始まりでも、その「ファイル」は除外しない。
 */
export function isExcludedPath(path: string, type: TreeEntryType): boolean {
  const segments = path.split('/');
  const directorySegments = type === 'directory' ? segments : segments.slice(0, -1);
  return directorySegments.some(isHiddenSegment);
}

/** ファイルパスの祖先ディレクトリパスをルート側から順に返す（ツリー展開用） */
export function ancestorDirectoryPaths(filePath: string): readonly string[] {
  const segments = filePath.split('/');
  const ancestors: string[] = [];
  for (let depth = 1; depth < segments.length; depth += 1) {
    ancestors.push(segments.slice(0, depth).join('/'));
  }
  return ancestors;
}

function compareByName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

interface MutableDirectory {
  readonly name: string;
  readonly path: string;
  readonly directories: Map<string, MutableDirectory>;
  readonly files: Map<string, string>;
}

function createMutableDirectory(name: string, path: string): MutableDirectory {
  return { name, path, directories: new Map(), files: new Map() };
}

/**
 * フラットなエントリ列からツリーを構築する。
 *
 * - 隠れディレクトリ配下のエントリは除外する
 * - 親ディレクトリのエントリが欠けていても中間ディレクトリを補完する
 * - 子ノードはディレクトリ優先・名前順（大文字小文字を区別しない）
 */
export function buildVaultTree(entries: readonly TreeEntry[]): TreeDirectory {
  const root = createMutableDirectory('', '');

  const ensureDirectory = (path: string): MutableDirectory => {
    if (path === '') {
      return root;
    }
    let current = root;
    let accumulated = '';
    for (const segment of path.split('/')) {
      accumulated = accumulated === '' ? segment : `${accumulated}/${segment}`;
      let next = current.directories.get(segment);
      if (!next) {
        next = createMutableDirectory(segment, accumulated);
        current.directories.set(segment, next);
      }
      current = next;
    }
    return current;
  };

  for (const entry of entries) {
    if (entry.path === '' || isExcludedPath(entry.path, entry.type)) {
      continue;
    }
    const segments = entry.path.split('/');
    if (segments.some((segment) => segment.length === 0)) {
      continue;
    }
    if (entry.type === 'directory') {
      ensureDirectory(entry.path);
      continue;
    }
    const name = segments[segments.length - 1];
    if (name === undefined) {
      continue;
    }
    const parent = ensureDirectory(segments.slice(0, -1).join('/'));
    parent.files.set(name, entry.path);
  }

  const toDirectory = (directory: MutableDirectory): TreeDirectory => {
    const children: TreeNode[] = [];
    const sortedDirectories = [...directory.directories.values()].toSorted(compareByName);
    for (const child of sortedDirectories) {
      children.push(toDirectory(child));
    }
    const sortedFiles = [...directory.files.entries()].toSorted(([a], [b]) =>
      compareByName({ name: a }, { name: b }),
    );
    for (const [name, path] of sortedFiles) {
      children.push({ type: 'file', name, path });
    }
    return { type: 'directory', name: directory.name, path: directory.path, children };
  };

  return toDirectory(root);
}
