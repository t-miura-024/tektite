/**
 * ワークスペース左レール（ファイル / 検索 / 補助ペインの切替など）。
 */

import type { JSX } from 'react';

import { WorkspaceIcon } from '@/ui/screens/vault-screen/workspace-icon';

export type WorkspaceRailProps = {
  leftOpen: boolean;
  rightOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onOpenSearch: () => void;
};

export function WorkspaceRail({
  leftOpen,
  rightOpen,
  onToggleLeft,
  onToggleRight,
  onOpenSearch,
}: WorkspaceRailProps): JSX.Element {
  return (
    <nav className="workspace-rail" aria-label="ワークスペース">
      <button
        type="button"
        className={`workspace-rail-button${leftOpen ? ' is-active' : ''}`}
        aria-label="ファイル"
        aria-pressed={leftOpen}
        onClick={onToggleLeft}
      >
        <WorkspaceIcon name="files" />
      </button>
      <button
        type="button"
        className="workspace-rail-button"
        aria-label="検索"
        onClick={onOpenSearch}
      >
        <WorkspaceIcon name="search" />
      </button>
      <button type="button" className="workspace-rail-button" aria-label="ブックマーク">
        <WorkspaceIcon name="bookmark" />
      </button>
      <button type="button" className="workspace-rail-button" aria-label="データベース">
        <WorkspaceIcon name="database" />
      </button>
      <button type="button" className="workspace-rail-button" aria-label="カレンダー">
        <WorkspaceIcon name="calendar" />
      </button>
      <button type="button" className="workspace-rail-button" aria-label="コマンド">
        <WorkspaceIcon name="command" />
      </button>
      <span className="workspace-rail-spacer" />
      <button
        type="button"
        className={`workspace-rail-button${rightOpen ? ' is-active' : ''}`}
        aria-label="右サイドバー"
        aria-pressed={rightOpen}
        onClick={onToggleRight}
      >
        <WorkspaceIcon name="sidebar" />
      </button>
    </nav>
  );
}
