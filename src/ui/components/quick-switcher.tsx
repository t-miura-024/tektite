/**
 * クイックスイッチャー（M4: M3。Cmd+O / 移動ボタンで開くノート移動パレット）。
 *
 * ノートのファイル名を fzf 的な部分列一致（ファジー）で検索し、Enter / クリックで
 * 開く。検索入力 + 結果一覧のオーバーレイで、キー操作は全文検索パネル
 * （SearchPanel）と同じキーボード主導（方針 3）。開いたノートは既存のルーティング
 * （noteRoutePath + navigate）で表示する（WikiLink 遷移と同じ仕組み）。
 *
 * 全文検索（Cmd+K）との棲み分け: 検索は本文込みの全文検索、クイックスイッチャーは
 * ファイル名のみの高速移動。対象は共有ノート索引（NoteIndex.notes）のパス一覧で、
 * VaultScreen が渡す。モバイルではサイドバーの「移動」ボタンから同じパレットを
 * 開ける（完了条件 4）。空クエリは全ノートを表示する（一覧から直接選ぶ導線）。
 */

import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { searchNoteNames } from '@/application/quick-switch';
import type { VaultRef } from '@/domain/vault';

import { createOverlayListKeyHandler } from '@/ui/components/overlay-panel-keys';
import { useFocusTrap } from '@/ui/focus-trap';
import { navigate, noteRoutePath } from '@/ui/router';

/** 一致位置の文字を <mark> で装飾した断片を返す（一致がなければ素の文字列） */
function highlightParts(text: string, positions: readonly number[]): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const position of positions) {
    if (position > cursor) {
      parts.push(text.slice(cursor, position));
    }
    parts.push(
      <mark key={position} className="quick-switch-mark">
        {text[position]}
      </mark>,
    );
    cursor = position + 1;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return parts;
}

export type QuickSwitcherProps = {
  vaultRef: VaultRef;
  /** 検索対象ノートのパス一覧（null は索引未ロード） */
  notePaths: readonly string[] | null;
  /** 索引の読み込みに失敗したか（true のとき読み込み中ではなくエラーを表示） */
  indexFailed: boolean;
  /** 索引の再読込（VaultScreen の load を再実行する） */
  onRetry: () => void;
  onClose: () => void;
};

type SwitchHit = ReturnType<typeof searchNoteNames>[number];

/** パレット本体の状態表示（索引未ロード / エラー / 候補なし / 一覧） */
function QuickSwitcherBody({
  notePaths,
  indexFailed,
  onRetry,
  results,
  selectedIndex,
  onOpen,
}: {
  notePaths: readonly string[] | null;
  indexFailed: boolean;
  onRetry: () => void;
  results: readonly SwitchHit[];
  selectedIndex: number;
  onOpen: (path: string) => void;
}): JSX.Element {
  if (notePaths === null && indexFailed) {
    return (
      <div className="quick-switch-error">
        <p className="quick-switch-status" role="status">
          ノート索引を読み込めませんでした。
        </p>
        <button type="button" className="button-secondary" onClick={onRetry}>
          再試行
        </button>
      </div>
    );
  }
  if (notePaths === null) {
    return (
      <p className="quick-switch-status" role="status">
        ノート索引を読み込み中…
      </p>
    );
  }
  if (results.length === 0) {
    return (
      <p className="quick-switch-status" role="status">
        一致するノートはありません。
      </p>
    );
  }
  return (
    <ul className="quick-switch-results" role="listbox" aria-label="ノート候補">
      {results.map((hit, index) => (
        <li
          key={hit.path}
          className={
            index === selectedIndex ? 'quick-switch-result is-selected' : 'quick-switch-result'
          }
          role="option"
          aria-selected={index === selectedIndex}
          data-testid="quick-switch-result"
          onClick={() => onOpen(hit.path)}
        >
          <span className="quick-switch-result-name">
            {hit.matchedField === 'name' ? highlightParts(hit.name, hit.positions) : hit.name}
          </span>
          <span className="quick-switch-result-path">
            {hit.matchedField === 'path' ? highlightParts(hit.path, hit.positions) : hit.path}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function QuickSwitcher({
  vaultRef,
  notePaths,
  indexFailed,
  onRetry,
  onClose,
}: QuickSwitcherProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  // Tab キーでフォーカスをパレット内に留める（背景のツリー・エディタへ抜けない）
  useFocusTrap(containerRef, true);

  const results = useMemo(
    () => (notePaths === null ? [] : searchNoteNames(notePaths, query)),
    [notePaths, query],
  );

  // クエリ変更で選択を先頭へ戻す
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const openNote = (path: string): void => {
    navigate(noteRoutePath(vaultRef, path));
    onClose();
  };

  const handleKeyDown = createOverlayListKeyHandler({
    itemCount: results.length,
    selectIndex: setSelectedIndex,
    onOpenSelected: () => {
      const hit = results[selectedIndex];
      if (hit !== undefined) {
        openNote(hit.path);
      }
    },
    onClose,
  });

  return (
    <div
      ref={containerRef}
      className="quick-switch-overlay"
      data-testid="quick-switcher"
      role="dialog"
      aria-modal="true"
      aria-label="クイックスイッチャー"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="quick-switch-panel">
        <input
          className="quick-switch-input"
          type="search"
          placeholder="ノート名で移動…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
          aria-label="ノート名クエリ"
        />
        <QuickSwitcherBody
          notePaths={notePaths}
          indexFailed={indexFailed}
          onRetry={onRetry}
          results={results}
          selectedIndex={selectedIndex}
          onOpen={(path) => openNote(path)}
        />
      </div>
    </div>
  );
}
