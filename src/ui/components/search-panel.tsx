/**
 * 全文検索パネル（M4: M2 検索 UI）。
 *
 * 検索入力 + 結果一覧のオーバーレイ。Cmd+K / Ctrl+K（VaultScreen 側の
 * ショートカット）または検索ボタンから開く。キー操作はキーボード主導
 * （方針 3）: 矢印キーで選択、Enter で開く、Esc で閉じる。
 *
 * 結果はノート名・パス・一致タグ・一致スニペット（<mark> ハイライト）を
 * 表示し、選択したノートは既存のルーティング（noteRoutePath + navigate）で
 * 開く（WikiLink 遷移と同じ仕組み）。モバイルではオーバーレイが全画面に
 * 広がり、同一機能を検索ボタンから使える（完了条件 4）。
 */

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';

import { noteDisplayName } from '@/application/note-name';
import type { NoteSearcher, SearchHit } from '@/application/search';
import type { VaultRef } from '@/domain/vault';

import { createOverlayListKeyHandler } from '@/ui/components/overlay-panel-keys';
import { useFocusTrap } from '@/ui/focus-trap';
import { navigate, noteRoutePath } from '@/ui/router';

export type SearchPanelProps = {
  vaultRef: VaultRef;
  /** 検索器（null は索引未ロード） */
  searcher: NoteSearcher | null;
  /** 索引の読み込みに失敗したか（true のとき読み込み中ではなくエラーを表示） */
  indexFailed: boolean;
  /** 索引の再読込（VaultScreen の load を再実行する） */
  onRetry: () => void;
  onClose: () => void;
};

/** パネル本体の状態表示（索引未ロード / エラー / 空クエリ / 候補なし / 一覧） */
function SearchPanelBody({
  searcher,
  indexFailed,
  onRetry,
  query,
  results,
  selectedIndex,
  onOpen,
}: {
  searcher: NoteSearcher | null;
  indexFailed: boolean;
  onRetry: () => void;
  query: string;
  results: readonly SearchHit[];
  selectedIndex: number;
  onOpen: (path: string) => void;
}): JSX.Element {
  if (searcher === null && indexFailed) {
    return (
      <div className="search-panel-error">
        <p className="search-panel-status" role="status">
          ノート索引を読み込めませんでした。
        </p>
        <button type="button" className="button-secondary" onClick={onRetry}>
          再試行
        </button>
      </div>
    );
  }
  if (searcher === null) {
    return (
      <p className="search-panel-status" role="status">
        ノート索引を読み込み中…
      </p>
    );
  }
  if (query.trim().length === 0) {
    return <p className="search-panel-status">ノート本文・ファイル名・タグを検索できます。</p>;
  }
  if (results.length === 0) {
    return (
      <p className="search-panel-status" role="status">
        一致するノートはありません。
      </p>
    );
  }
  return (
    <ul className="search-results" role="listbox" aria-label="検索結果">
      {results.map((hit, index) => (
        <SearchResultItem
          key={hit.path}
          hit={hit}
          selected={index === selectedIndex}
          onOpen={() => onOpen(hit.path)}
        />
      ))}
    </ul>
  );
}

/** 検索結果 1 件（タイトル / パス / 一致タグ / スニペット） */
function SearchResultItem({
  hit,
  selected,
  onOpen,
}: {
  hit: SearchHit;
  selected: boolean;
  onOpen: () => void;
}): JSX.Element {
  return (
    <li
      className={selected ? 'search-result is-selected' : 'search-result'}
      role="option"
      aria-selected={selected}
      data-testid="search-result"
      onClick={onOpen}
    >
      <span className="search-result-title">{noteDisplayName(hit.path)}</span>
      <span className="search-result-path">{hit.path}</span>
      {hit.kind === 'tag' && hit.matchedTags.length > 0 && (
        <span className="search-result-tags">
          {hit.matchedTags.map((tag) => (
            <span className="search-result-tag" key={tag}>
              #{tag}
            </span>
          ))}
        </span>
      )}
      {hit.snippet !== null && (
        <span className="search-result-snippet">
          {hit.snippet.map((part) =>
            part.highlight ? (
              <mark key={part.from}>{part.text}</mark>
            ) : (
              <span key={part.from}>{part.text}</span>
            ),
          )}
        </span>
      )}
    </li>
  );
}

export function SearchPanel({
  vaultRef,
  searcher,
  indexFailed,
  onRetry,
  onClose,
}: SearchPanelProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  // Tab キーでフォーカスをパネル内に留める（背景のツリー・エディタへ抜けない）
  useFocusTrap(containerRef, true);

  const results = useMemo<readonly SearchHit[]>(() => {
    if (searcher === null) {
      return [];
    }
    return searcher.search(query);
  }, [searcher, query]);

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
      className="search-overlay"
      data-testid="search-panel"
      role="dialog"
      aria-modal="true"
      aria-label="全文検索"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="search-panel">
        <input
          className="search-panel-input"
          type="search"
          placeholder="ノートを検索…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
          aria-label="検索クエリ"
        />
        <SearchPanelBody
          searcher={searcher}
          indexFailed={indexFailed}
          onRetry={onRetry}
          query={query}
          results={results}
          selectedIndex={selectedIndex}
          onOpen={(path) => openNote(path)}
        />
      </div>
    </div>
  );
}
