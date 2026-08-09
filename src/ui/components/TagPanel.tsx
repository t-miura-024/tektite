/**
 * タグ一覧パネル（タグ単位でのノート一覧）。
 *
 * 記法索引（VaultNotationIndex の tagIndex / notes。M1 で実装済み）を表示し、
 * タグ（インライン #タグ・フロントマテリア tags:・ネスト #area/project を含む）
 * を列挙する。タグを選ぶとそのタグを持つノート一覧が展開され、ノートを選ぶと
 * SPA 遷移する。タグは索引キー（小文字）ではなくノート内の原表記で表示する。
 */

import { useMemo, useState } from 'react';

import { noteDisplayName } from '@/application/note-name';
import type { NoteNotation } from '@/domain/notation/index';
import type { VaultRef } from '@/domain/vault';

import { Link } from '@/ui/components/Link';
import { noteRoutePath } from '@/ui/router';

/** タグ 1 件の表示エントリ */
export interface TagEntry {
  /** 索引キー（小文字正規化） */
  readonly key: string;
  /** 表示名（ノート内の原表記） */
  readonly display: string;
  /** このタグを持つノートパス一覧 */
  readonly paths: readonly string[];
}

export interface TagPanelProps {
  vaultRef: VaultRef;
  /** タグ索引（キーは小文字。値はノートパス一覧） */
  tagIndex: ReadonlyMap<string, readonly string[]>;
  /** ノートごとの解析結果（タグの原表記の復元に使う） */
  notes: ReadonlyMap<string, NoteNotation>;
}

export function TagPanel({ vaultRef, tagIndex, notes }: TagPanelProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const tags = useMemo<TagEntry[]>(() => {
    const entries: TagEntry[] = [];
    for (const [key, paths] of tagIndex) {
      // 表示名は原表記を優先する（どのノートでもよい。見つからなければキー）
      let display = key;
      for (const path of paths) {
        const found = notes.get(path)?.tags.find((tag) => tag.toLowerCase() === key);
        if (found !== undefined) {
          display = found;
          break;
        }
      }
      entries.push({ key, display, paths });
    }
    return entries.toSorted((a, b) => a.display.localeCompare(b.display));
  }, [tagIndex, notes]);

  const toggle = (key: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  if (tags.length === 0) {
    return (
      <p className="tag-list-empty" role="status" data-testid="tag-panel">
        タグがありません。
      </p>
    );
  }

  return (
    <ul className="tag-list" data-testid="tag-panel">
      {tags.map((tag) => (
        <li className="tag-list-item" key={tag.key}>
          <button
            type="button"
            className="tag-list-toggle"
            aria-expanded={expanded.has(tag.key)}
            onClick={() => toggle(tag.key)}
          >
            <span className="tag-list-caret" aria-hidden="true">
              {expanded.has(tag.key) ? '▾' : '▸'}
            </span>
            <span className="tag-list-name">#{tag.display}</span>
          </button>
          {expanded.has(tag.key) && (
            <ul className="tag-list-notes" role="group">
              {[...tag.paths]
                .toSorted((a, b) => a.localeCompare(b))
                .map((path) => (
                  <li className="tag-list-note" key={path}>
                    <Link to={noteRoutePath(vaultRef, path)} className="tag-list-note-link">
                      {noteDisplayName(path)}
                      <span className="tag-list-note-path">{path}</span>
                    </Link>
                  </li>
                ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
