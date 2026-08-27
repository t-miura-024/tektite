/**
 * Cmd+K / Ctrl+K（全文検索）と Cmd+O / Ctrl+O（クイックスイッチャー）の
 * ショートカット。両パネルは同時に開かない。
 */

import { useEffect } from 'react';

type PanelToggles = {
  toggleSearch: () => void;
  toggleQuickSwitch: () => void;
};

export function usePanelShortcuts({ toggleSearch, toggleQuickSwitch }: PanelToggles): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === 'k') {
        event.preventDefault();
        toggleSearch();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && key === 'o') {
        event.preventDefault();
        toggleQuickSwitch();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => window.removeEventListener('keydown', onKeyDown);
  }, [toggleSearch, toggleQuickSwitch]);
}
