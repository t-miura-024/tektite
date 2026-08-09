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

import { useEffect, useMemo, useState } from 'react';

import type { NoteSearcher, SearchHit } from '@/application/search';
import type { VaultRef } from '@/domain/vault';

import { navigate, noteRoutePath } from '@/ui/router';

/** パスから表示名（拡張子を除いた最終セグメント）を得る */
function noteDisplayName(path: string): string {
  const base = path.split('/').at(-1) ?? path;
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

export interface SearchPanelProps {
  vaultRef: VaultRef;
  /** 検索器（null は索引未ロード） */
  searcher: NoteSearcher | null;
  onClose: () => void;
}

export function SearchPanel({ vaultRef, searcher, onClose }: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

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
      className="search-overlay"
      data-testid="search-panel"
      role="dialog"
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
        {searcher === null ? (
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
