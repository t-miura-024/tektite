/**
 * サイドバー幅の保持（localStorage 永続化 + ポインタドラッグでのリサイズ）。
 */

import { useCallback, useEffect, useState } from 'react';

import {
  SIDEBAR_WIDTH_KEY,
  clampSidebarWidth,
  readSidebarWidth,
} from '@/ui/screens/vault-screen/screen-utils';

export type SidebarWidth = {
  sidebarWidth: number;
  resizingSidebar: boolean;
  /** リサイズ開始（resizer の onPointerDown から呼ぶ） */
  startResize: () => void;
};

export function useSidebarWidth(): SidebarWidth {
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [resizingSidebar, setResizingSidebar] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {
      // localStorage may be unavailable in private browsing or restricted frames.
    }
  }, [sidebarWidth]);

  useEffect(() => {
    if (!resizingSidebar) {
      return;
    }
    const handlePointerMove = (event: PointerEvent): void => {
      setSidebarWidth(clampSidebarWidth(event.clientX - 44));
    };
    const stopResizing = (): void => setResizingSidebar(false);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResizing, { once: true });
    return (): void => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResizing);
    };
  }, [resizingSidebar]);

  const startResize = useCallback((): void => setResizingSidebar(true), []);

  return { sidebarWidth, resizingSidebar, startResize };
}
