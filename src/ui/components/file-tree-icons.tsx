/**
 * ファイルツリーのツールバー / コンテキストメニュー用アイコン。
 */

import type { JSX } from 'react';

export type ActionIconName =
  | 'file-plus'
  | 'folder-plus'
  | 'search'
  | 'switcher'
  | 'locate'
  | 'expand'
  | 'collapse';

const ICON_PATHS: Record<ActionIconName, string> = {
  'file-plus': 'M4 2.5h7l3 3v10H4z M11 2.5v3h3 M8.5 9v4 M6.5 11h4',
  'folder-plus': 'M2.5 5.5h5l1.5 1.5h8v8.5h-14.5z M9.5 9v4 M7.5 11h4',
  search: 'm14 14 3.5 3.5 M15 9.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Z',
  switcher: 'M4 5h12 M4 9h8 M4 13h10 M14 11l2 2-2 2',
  locate: 'M9.5 3v3 M9.5 13v3 M3 9.5h3 M13 9.5h3 M12.5 9.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  expand: 'M4 7V4h3 M13 4h3v3 M16 13v3h-3 M7 16H4v-3',
  collapse: 'M7 4H4v3 M13 4h3v3 M4 13v3h3 M16 13v3h-3',
};

export function ActionIcon({ name }: { name: ActionIconName }): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
