/**
 * ファイルツリーの純粋ヘルパー（収集・移動禁止先の計算・コンテキストメニュー項目）。
 */

import type { TreeDirectory } from '@/domain/tree';

/** コンテキストメニュー 1 項目 */
export type MenuItem = {
  readonly key: string;
  readonly label: string;
  /** グループ（区切り線の挿入に使う） */
  readonly group: 'create' | 'operate' | 'danger';
  readonly onSelect: () => void;
};

/** コンテキストメニューの表示状態（座標は固定配置用のビューポート座標） */
export type MenuState = {
  readonly x: number;
  readonly y: number;
  readonly items: readonly MenuItem[];
};

/** コンテキストメニューを開く対象（項目 or 空き領域） */
export type MenuTarget = { readonly path: string; readonly type: 'file' | 'directory' } | 'root';

/** メニュー項目を組み立てる対象ごとの操作 */
export type MenuActions = {
  onCreateNote: (directory: string) => void;
  onOpenCreateForm: (directory: string) => void;
  onDuplicate: (path: string, type: 'file' | 'directory') => void;
  onRequestRename: (path: string, type: 'file' | 'directory') => void;
  onRequestMove: (path: string, type: 'file' | 'directory') => void;
  onRequestDelete: (path: string, type: 'file' | 'directory') => void;
};

/** ツリーから全ディレクトリパス（ルート '' を含む）を収集する */
export function collectDirectories(root: TreeDirectory): string[] {
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

/**
 * 移動ダイアログの禁止先（自分自身の配下。ファイルは現在の親ディレクトリも）。
 * ファイルを現在の親へ「移動」すると to === from になり、
 * コミット側が「移動元と移動先が同じです」のエラーを返すため、未然に防ぐ。
 */
export function blockedMoveTargets(
  target: { readonly path: string; readonly type: 'file' | 'directory' },
  directories: readonly string[],
): Set<string> {
  const blocked = new Set<string>();
  for (const directory of directories) {
    if (directory === target.path || directory.startsWith(`${target.path}/`)) {
      blocked.add(directory);
    }
  }
  if (target.type === 'file') {
    const lastSlash = target.path.lastIndexOf('/');
    blocked.add(lastSlash === -1 ? '' : target.path.slice(0, lastSlash));
  }
  return blocked;
}

/** 右クリック対象の共通メニュー項目（複製 / リネーム / 移動 / 削除） */
function operationItems(
  path: string,
  type: 'file' | 'directory',
  actions: MenuActions,
): MenuItem[] {
  return [
    {
      key: 'duplicate',
      label: '複製を作成',
      group: 'operate',
      onSelect: () => actions.onDuplicate(path, type),
    },
    {
      key: 'rename',
      label: '名前を変更',
      group: 'operate',
      onSelect: () => actions.onRequestRename(path, type),
    },
    {
      key: 'move',
      label: '移動…',
      group: 'operate',
      onSelect: () => actions.onRequestMove(path, type),
    },
    {
      key: 'delete',
      label: '削除',
      group: 'danger',
      onSelect: () => actions.onRequestDelete(path, type),
    },
  ];
}

/** コンテキストメニューの項目一覧を作る（右クリック対象で出し分ける） */
export function buildMenuItems(target: MenuTarget, actions: MenuActions): MenuItem[] {
  if (target === 'root') {
    return [
      {
        key: 'create-note',
        label: '新規ノート',
        group: 'create',
        onSelect: () => actions.onCreateNote(''),
      },
      {
        key: 'create-directory',
        label: '新規フォルダ',
        group: 'create',
        onSelect: () => actions.onOpenCreateForm(''),
      },
    ];
  }
  if (target.type === 'directory') {
    return [
      {
        key: 'create-note',
        label: '新規ノート',
        group: 'create',
        onSelect: () => actions.onCreateNote(target.path),
      },
      {
        key: 'create-directory',
        label: '新規フォルダ',
        group: 'create',
        onSelect: () => actions.onOpenCreateForm(target.path),
      },
      ...operationItems(target.path, target.type, actions),
    ];
  }
  return operationItems(target.path, target.type, actions);
}
