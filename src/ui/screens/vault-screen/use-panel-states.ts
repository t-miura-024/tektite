/**
 * 画面内パネル（検索・クイックスイッチャー・左右サイドバー・補助ペイン）の
 * 開閉状態。両パネルは同時に開かない（オーバーレイの重なりを避ける）。
 */

import { useCallback, useState } from 'react';

export type RightPanelKind = 'outline' | 'backlinks';

export type PanelStates = {
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  /** 開閉をトグルする（Cmd+K。開く場合はクイックスイッチャーを閉じる） */
  toggleSearch: () => void;
  quickSwitchOpen: boolean;
  setQuickSwitchOpen: (open: boolean) => void;
  /** 開閉をトグルする（Cmd+O。開く場合は検索パネルを閉じる） */
  toggleQuickSwitch: () => void;
  leftSidebarOpen: boolean;
  toggleLeftSidebar: () => void;
  rightSidebarOpen: boolean;
  toggleRightSidebar: () => void;
  rightPanel: RightPanelKind;
  setRightPanel: (panel: RightPanelKind) => void;
};

export function usePanelStates(): PanelStates {
  const [searchOpen, setSearchOpenState] = useState(false);
  const [quickSwitchOpen, setQuickSwitchOpenState] = useState(false);
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [rightPanel, setRightPanel] = useState<RightPanelKind>('outline');

  const toggleLeftSidebar = useCallback((): void => {
    setLeftSidebarOpen((open) => !open);
  }, []);
  const toggleRightSidebar = useCallback((): void => {
    setRightSidebarOpen((open) => !open);
  }, []);

  const setSearchOpenOnly = useCallback((open: boolean): void => {
    setSearchOpenState(open);
    if (open) {
      setQuickSwitchOpenState(false);
    }
  }, []);
  const setQuickSwitchOpenOnly = useCallback((open: boolean): void => {
    setQuickSwitchOpenState(open);
    if (open) {
      setSearchOpenState(false);
    }
  }, []);

  const toggleSearch = useCallback((): void => {
    setSearchOpenState((open) => !open);
    setQuickSwitchOpenState(false);
  }, []);
  const toggleQuickSwitch = useCallback((): void => {
    setQuickSwitchOpenState((open) => !open);
    setSearchOpenState(false);
  }, []);

  return {
    searchOpen,
    setSearchOpen: setSearchOpenOnly,
    toggleSearch,
    quickSwitchOpen,
    setQuickSwitchOpen: setQuickSwitchOpenOnly,
    toggleQuickSwitch,
    leftSidebarOpen,
    toggleLeftSidebar,
    rightSidebarOpen,
    toggleRightSidebar,
    rightPanel,
    setRightPanel,
  };
}
