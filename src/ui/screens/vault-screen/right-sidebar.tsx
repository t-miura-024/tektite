/**
 * 補助ペイン（アウトライン / バックリンク / タグ一覧）。
 */

import type { JSX } from 'react';
import type { VaultRef } from '@/domain/vault';

import { BacklinkPanel } from '@/ui/components/backlink-panel';
import { Link } from '@/ui/components/link';
import { TagPanel } from '@/ui/components/tag-panel';
import { noteRoutePath } from '@/ui/router';
import type { RightPanelKind } from '@/ui/screens/vault-screen/use-panel-states';
import type { VaultWorkspace } from '@/ui/screens/vault-screen/use-vault-workspace';

export type RightSidebarProps = {
  vaultRef: VaultRef;
  /** 選択中のノートパス（未選択は null。バックリンクはノート単位） */
  notePath: string | null;
  rightPanel: RightPanelKind;
  setRightPanel: (panel: RightPanelKind) => void;
  ws: VaultWorkspace;
};

export function RightSidebar({
  vaultRef,
  notePath,
  rightPanel,
  setRightPanel,
  ws,
}: RightSidebarProps): JSX.Element {
  return (
    <aside className="workspace-right-sidebar" aria-label="補助ペイン">
      <div className="workspace-right-tabs" role="tablist" aria-label="補助ペイン">
        <button
          type="button"
          className={rightPanel === 'outline' ? 'is-active' : ''}
          role="tab"
          aria-selected={rightPanel === 'outline'}
          onClick={() => setRightPanel('outline')}
        >
          アウトライン
        </button>
        <button
          type="button"
          className={rightPanel === 'backlinks' ? 'is-active' : ''}
          role="tab"
          aria-selected={rightPanel === 'backlinks'}
          onClick={() => setRightPanel('backlinks')}
        >
          バックリンク
        </button>
      </div>
      {rightPanel === 'outline' && (
        <OutlineNav notePath={notePath} vaultRef={vaultRef} outline={ws.outline} />
      )}
      {rightPanel === 'backlinks' && ws.notation !== null && (
        <>
          {notePath !== null && (
            <section className="vault-sidebar-section" aria-label="バックリンク">
              <h3 className="vault-sidebar-section-title">バックリンク</h3>
              <BacklinkPanel
                vaultRef={vaultRef}
                links={ws.notation.backlinks.get(notePath) ?? []}
              />
            </section>
          )}
          <section className="vault-sidebar-section" aria-label="タグ一覧">
            <h3 className="vault-sidebar-section-title">タグ</h3>
            <TagPanel
              vaultRef={vaultRef}
              tagIndex={ws.notation.tagIndex}
              notes={ws.notation.notes}
            />
          </section>
        </>
      )}
    </aside>
  );
}

/** 開いているノートの見出し一覧（クリックで見出しへ遷移する） */
function OutlineNav({
  notePath,
  vaultRef,
  outline,
}: {
  notePath: string | null;
  vaultRef: VaultRef;
  outline: VaultWorkspace['outline'];
}): JSX.Element {
  if (outline.length === 0) {
    return <p className="app-placeholder">見出しがありません。</p>;
  }
  return (
    <nav className="workspace-outline" aria-label="アウトライン">
      {outline.map((heading) => (
        <Link
          key={`${heading.slug}-${heading.level}`}
          to={`${noteRoutePath(vaultRef, notePath ?? '')}#${heading.slug}`}
          className="workspace-outline-link"
          style={{ '--outline-level': heading.level }}
        >
          {heading.text}
        </Link>
      ))}
    </nav>
  );
}
