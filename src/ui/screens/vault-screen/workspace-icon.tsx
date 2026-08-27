/**
 * ワークスペース左レールのアイコン（ファイル / 検索 / ブックマーク等）。
 */

import type { JSX } from 'react';

export type WorkspaceIconName =
  | 'files'
  | 'search'
  | 'bookmark'
  | 'database'
  | 'calendar'
  | 'command'
  | 'sidebar';

const ICON_PATHS: Record<WorkspaceIconName, string> = {
  files: 'M3 4.5h14v11H3z M6 2.5h8v2H6z M6 8h8 M6 11h5',
  search: 'm14 14 3.5 3.5 M15 9.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Z',
  bookmark: 'M5 3.5h10v13l-5-3-5 3z',
  database:
    'M4 5c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2Z M4 5v5c0 1.1 2.2 2 5 2s5-.9 5-2V5 M4 10v5c0 1.1 2.2 2 5 2s5-.9 5-2v-5',
  calendar: 'M4 4h12v12H4z M7 2.5v3 M13 2.5v3 M4 8h12',
  command: 'M5 5l5 5-5 5 M11 15h4',
  sidebar: 'M3 3.5h14v13H3z M12 3.5v13',
};

export function WorkspaceIcon({ name }: { name: WorkspaceIconName }): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
