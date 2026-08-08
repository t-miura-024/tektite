/**
 * バックリンクパネル（開いているノートを参照するノート群の一覧）。
 *
 * 参照元のノートパス一覧は Vault 全体の記法索引（VaultNotationIndex の
 * backlinks。M1 で実装済み）から引く。各項目はクリックで対象ノートへ
 * SPA 遷移する（既存の Link / noteRoutePath を使用）。
 */

import type { VaultRef } from '@/domain/vault';

import { Link } from '@/ui/components/Link';
import { noteRoutePath } from '@/ui/router';

/** パスから表示名（拡張子を除いた最終セグメント）を得る */
function noteDisplayName(path: string): string {
  const base = path.split('/').at(-1) ?? path;
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

export interface BacklinkPanelProps {
  vaultRef: VaultRef;
  /** 開いているノートを参照するノートパス一覧（出現順・重複なし） */
  links: readonly string[];
}

export function BacklinkPanel({ vaultRef, links }: BacklinkPanelProps) {
  if (links.length === 0) {
    return (
      <p className="backlink-empty" role="status" data-testid="backlink-panel">
        このノートへのバックリンクはありません。
      </p>
    );
  }
  return (
    <ul className="backlink-list" data-testid="backlink-panel">
      {links.map((path) => (
        <li className="backlink-item" key={path}>
          <Link to={noteRoutePath(vaultRef, path)} className="backlink-link">
            {noteDisplayName(path)}
            <span className="backlink-path">{path}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
