/**
 * ファイルツリーのコンテキストメニュー（右クリック）の表示状態。
 * 外部クリックで閉じ、項目の選択はメニュー本体（FileContextMenu）が担う。
 */

import { useCallback, useEffect, useState } from 'react';

import {
  buildMenuItems,
  type MenuActions,
  type MenuState,
  type MenuTarget,
} from '@/ui/components/file-tree-utils';

export type ContextMenuState = {
  menu: MenuState | null;
  openMenu: (target: MenuTarget, x: number, y: number) => void;
  closeMenu: () => void;
};

export function useContextMenu(actions: MenuActions): ContextMenuState {
  const [menu, setMenu] = useState<MenuState | null>(null);

  // メニュー表示中は外部クリックで閉じる（メニュー内クリックは閉じない）
  useEffect(() => {
    if (menu === null) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (
        !(event.target instanceof HTMLElement) ||
        event.target.closest('[data-testid="file-context-menu"]') === null
      ) {
        setMenu(null);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return (): void => document.removeEventListener('pointerdown', onPointerDown);
  }, [menu]);

  const closeMenu = useCallback((): void => setMenu(null), []);

  /** コンテキストメニューを開く（座標はビューポート内にクランプする） */
  const openMenu = useCallback(
    (target: MenuTarget, x: number, y: number): void => {
      const width = 180;
      const height = 230;
      setMenu({
        x: Math.max(0, Math.min(x, window.innerWidth - width)),
        y: Math.max(0, Math.min(y, window.innerHeight - height)),
        items: buildMenuItems(target, actions),
      });
    },
    [actions],
  );

  return { menu, openMenu, closeMenu };
}
