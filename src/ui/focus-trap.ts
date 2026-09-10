/**
 * オーバーレイパネルのフォーカストラップ。Tab で panel 内を循環させる。
 */

import { useEffect, type RefObject } from 'react';
/** フォーカス可能な要素のセレクタ（disabled / aria-hidden は除外する） */
const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * コンテナ内で Tab キーのフォーカスを循環させる。
 *
 * @param containerRef トラップ対象のコンテナ（パネルのルート要素）
 * @param active パネルが開いているとき true（閉じたらリスナーを解除する）
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) {
      return;
    }
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') {
        return;
      }
      const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (element) =>
          !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true',
      );
      if (focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) {
        return;
      }
      const activeElement = document.activeElement;
      const index = activeElement instanceof HTMLElement ? focusable.indexOf(activeElement) : -1;
      // ブラウザのデフォルトの Tab 移動に依存せず、常にパネル内の次/前の要素へ
      // 明示的にフォーカスを移す（jsdom でも同一動作になる）
      event.preventDefault();
      if (event.shiftKey) {
        const previous = index <= 0 ? last : focusable[index - 1];
        previous?.focus();
        return;
      }
      const next = index === -1 || index === focusable.length - 1 ? first : focusable[index + 1];
      next?.focus();
    };
    container.addEventListener('keydown', onKeyDown);
    return (): void => container.removeEventListener('keydown', onKeyDown);
  }, [containerRef, active]);
}
