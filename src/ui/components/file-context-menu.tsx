/**
 * ファイルツリーのコンテキストメニュー本体（role="menu"）。
 * キーボード操作（↑↓ で移動 / Enter で実行 / Escape で閉じる）と
 * 開いた時の最初の項目へのフォーカスを担う。
 */

import { Fragment, useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';

import type { MenuState } from '@/ui/components/file-tree-utils';

export type FileContextMenuProps = {
  menu: MenuState;
  /** 項目を実行せずに閉じる */
  onClose: () => void;
};

export function FileContextMenu({ menu, onClose }: FileContextMenuProps): JSX.Element {
  /** キーボード操作中のメニュー項目位置 */
  const [activeIndex, setActiveIndex] = useState(0);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // メニューが開いたら最初の項目へフォーカスする（キーボード操作の起点）
  useEffect(() => {
    setActiveIndex(0);
    itemRefs.current[0]?.focus();
  }, [menu]);

  const focusAt = (index: number): void => {
    setActiveIndex(index);
    itemRefs.current[index]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const count = menu.items.length;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusAt((activeIndex + 1) % count);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusAt((activeIndex - 1 + count) % count);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = menu.items[activeIndex];
      if (item !== undefined) {
        onClose();
        item.onSelect();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="file-context-menu"
      role="menu"
      data-testid="file-context-menu"
      style={{ left: menu.x, top: menu.y }}
      onKeyDown={handleKeyDown}
    >
      {menu.items.map((item, index) => (
        <Fragment key={item.key}>
          {index > 0 && item.group !== menu.items[index - 1]?.group && (
            <div className="file-context-menu-separator" role="separator" />
          )}
          <button
            type="button"
            role="menuitem"
            data-testid={`file-menu-${item.key}`}
            ref={(element) => {
              itemRefs.current[index] = element;
            }}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
