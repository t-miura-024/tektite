/**
 * Vault 内画面の純粋ヘルパー（ツリー収集・アウトライン抽出・サイドバー幅・
 * 同期時刻表示・ファイル操作の成功トースト文言）。
 */

import type { FileOperation } from '@/application/file';
import { slugify } from '@/composition';
import type { TreeDirectory } from '@/domain/tree';

/** ツリーから全ファイルパスを収集する（リーディング表示のリンク解決用） */
export function collectFilePaths(root: TreeDirectory): string[] {
  const paths: string[] = [];
  const walk = (directory: TreeDirectory): void => {
    for (const child of directory.children) {
      if (child.type !== 'file') {
        walk(child);
        continue;
      }
      paths.push(child.path);
    }
  };
  walk(root);
  return paths;
}

/** ツリーから全ディレクトリパス（ルート '' を含む）を収集する */
export function collectDirectoryPaths(root: TreeDirectory): string[] {
  const paths: string[] = [''];
  const walk = (directory: TreeDirectory): void => {
    for (const child of directory.children) {
      if (child.type !== 'directory') {
        continue;
      }
      paths.push(child.path);
      walk(child);
    }
  };
  walk(root);
  return paths;
}

export const SIDEBAR_WIDTH_KEY = 'tektite.sidebar.width';
export const DEFAULT_SIDEBAR_WIDTH = 200;
export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 420;

export function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

export function readSidebarWidth(): number {
  if (typeof window === 'undefined') {
    return DEFAULT_SIDEBAR_WIDTH;
  }
  try {
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(stored) ? clampSidebarWidth(stored) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

/** ファイル操作の成功トースト文言（操作種別ごと。モジュール定数） */
export const FILE_OPERATION_MESSAGES: Record<FileOperation['kind'], string> = {
  'create-note': 'ノートを作成しました。',
  'create-directory': 'フォルダーを作成しました。',
  'delete-note': 'ノートを削除しました。',
  'delete-directory': 'フォルダーを削除しました。',
  'rename-note': 'リネームしました。',
  'rename-directory': 'リネームしました。',
  'duplicate-note': 'ノートを複製しました。',
  'duplicate-directory': 'フォルダーを複製しました。',
};

/** 同期時刻の表示（ローカル時刻の時:分。パース不能な場合はそのまま返す） */
export function formatSyncTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

export type OutlineHeading = {
  readonly level: number;
  readonly text: string;
  readonly slug: string;
};

/** 本文から見出し（アウトライン）を抽出する */
export function collectOutline(content: string): readonly OutlineHeading[] {
  return content.split('\n').flatMap((line) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match === null) {
      return [];
    }
    const text = match[2] ?? '';
    return [{ level: match[1]?.length ?? 1, text, slug: slugify(text) }];
  });
}
