/**
 * 同期完了後の最新化（M5。完了条件 9）を担うフック。
 * 未保存（dirty）でなければノートを再読み込みして同期後の内容へ更新する。
 * 編集中（未保存）の Note はエディタの内容を保持し、既存 Conflict フローで
 * 同期後の内容とマージされる。
 */

import { useEffect, useRef } from 'react';

import type { NotePaneCore } from '@/ui/components/use-note-pane-core';

export function useSyncRefresh(core: NotePaneCore, load: () => Promise<void>): void {
  const previousSyncVersion = useRef(core.syncVersion);

  useEffect(() => {
    if (core.syncVersion === previousSyncVersion.current) {
      return;
    }
    previousSyncVersion.current = core.syncVersion;
    // 初回（同期前）は何もしない。同期実行後のバージョン更新のみ処理する
    if (core.syncVersion === 0) {
      return;
    }
    if (core.dirtyRef.current || core.conflictRef.current || core.loadState.kind !== 'ready') {
      return;
    }
    void load();
  }, [core, load]);
}
