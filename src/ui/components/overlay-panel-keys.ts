/**
 * オーバーレイパネル（全文検索 / クイックスイッチャー）共通のキーボード操作。
 * キーボード主導（方針 3）: 矢印キーで選択、Enter で開く、Esc で閉じる。
 */

import type { KeyboardEvent } from 'react';

export type OverlayListKeyArgs = {
  /** 候補数（0 の間は矢印 / Enter を無視する） */
  itemCount: number;
  /** 選択を差し替える（関数型更新で呼ばれる） */
  selectIndex: (update: (index: number) => number) => void;
  /** 現在の選択を開く */
  onOpenSelected: () => void;
  /** パネルを閉じる */
  onClose: () => void;
};

/** パネルのリスト操作ハンドラを作る（毎レンダーで呼び出して最新値を閉じ込める） */
export function createOverlayListKeyHandler(
  args: OverlayListKeyArgs,
): (event: KeyboardEvent<HTMLElement>) => void {
  const { itemCount, selectIndex, onOpenSelected, onClose } = args;
  return (event: KeyboardEvent<HTMLElement>): void => {
    // 日本語 IME の変換中・変換確定の Enter（isComposing / keyCode 229）を
    // パネル操作として解釈しない（変換確定の Enter で選択中の候補が誤って
    // 開いてパネルが閉じるのを防ぐ。確定後の keydown は 229 で一度スキップされる）
    // 注: React 合成イベントは isComposing をラップしないため nativeEvent を読む
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (itemCount === 0) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selectIndex((index) => (index + 1) % itemCount);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectIndex((index) => (index - 1 + itemCount) % itemCount);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      onOpenSelected();
    }
  };
}
