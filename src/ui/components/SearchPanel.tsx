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

import { useEffect, useMemo, useRef, useState } from 'react';

import { noteDisplayName } from '@/application/note-name';
import type { NoteSearcher, SearchHit } from '@/application/search';
import type { VaultRef } from '@/domain/vault';

import { useFocusTrap } from '@/ui/focus-trap';
import { navigate, noteRoutePath } from '@/ui/router';

export interface SearchPanelProps {
  vaultRef: VaultRef;
  /** 検索器（null は索引未ロード） */
  searcher: NoteSearcher | null;
  /** 索引の読み込みに失敗したか（true のとき読み込み中ではなくエラーを表示） */
  indexFailed: boolean;
  /** 索引の再読込（VaultScreen の load を再実行する） */
  onRetry: () => void;
  onClose: () => void;
}

export function SearchPanel({
  vaultRef,
  searcher,
  indexFailed,
  onRetry,
  onClose,
}: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  // Tab キーでフォーカスをパネル内に留める（背景のツリー・エディタへ抜けない）
  // （difit 指摘: フォーカストラップ未対応）
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

  const handleKeyDown = (event: React.KeyboardEvent): void => {
    // 日本語 IME の変換中・変換確定の Enter（isComposing / keyCode 229）を
    // パネル操作として解釈しない（変換確定の Enter で選択中の結果が誤って
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
    if (results.length === 0) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((index) => (index + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((index) => (index - 1 + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const hit = results[selectedIndex];
      if (hit !== undefined) {
        openNote(hit.path);
      }
    }
  };

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
        {searcher === null && indexFailed ? (
          <div className="search-panel-error">
            <p className="search-panel-status" role="status">
              ノート索引を読み込めませんでした。
            </p>
            <button type="button" className="button-secondary" onClick={onRetry}>
              再試行
            </button>
          </div>
        ) : searcher === null ? (
          <p className="search-panel-status" role="status">
            ノート索引を読み込み中…
          </p>
        ) : query.trim().length === 0 ? (
          <p className="search-panel-status">ノート本文・ファイル名・タグを検索できます。</p>
        ) : results.length === 0 ? (
          <p className="search-panel-status" role="status">
            一致するノートはありません。
          </p>
        ) : (
          <ul className="search-results" role="listbox" aria-label="検索結果">
            {results.map((hit, index) => (
              <li
                key={hit.path}
                className={index === selectedIndex ? 'search-result is-selected' : 'search-result'}
                role="option"
                aria-selected={index === selectedIndex}
                data-testid="search-result"
                onClick={() => openNote(hit.path)}
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
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
