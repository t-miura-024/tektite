/**
 * 移動先ディレクトリ選択ダイアログ（M5: ノート/ディレクトリの移動）。
 *
 * Vault 内のディレクトリ一覧（ルート含む）から移動先を選ぶ。
 * ディレクトリ自身の配下（自分を自分の中へ移動する操作）は禁止先として
 * 無効化する。実行前に必ずダイアログを挟む（誤操作の防止）。
 */

import { useMemo, useState } from 'react';

export interface MoveDialogProps {
  /** 移動対象のラベル（例: `a.md` や `daily/`） */
  targetLabel: string;
  /** 移動先候補のディレクトリパス一覧（ルートは ''。ツリー由来・ソート済み） */
  directories: readonly string[];
  /** 禁止する移動先（自分自身とその配下） */
  blocked: ReadonlySet<string>;
  onCancel: () => void;
  onConfirm: (targetDirectory: string) => void;
}

/** ディレクトリパスを深さ優先の表示名にする（ルートは「Vault ルート」） */
function displayName(directory: string): string {
  if (directory === '') {
    return '（Vault ルート）';
  }
  const segments = directory.split('/');
  return `${'　'.repeat(Math.max(segments.length - 1, 0))}${segments[segments.length - 1] ?? ''}/`;
}

export function MoveDialog({
  targetLabel,
  directories,
  blocked,
  onCancel,
  onConfirm,
}: MoveDialogProps) {
  const [selected, setSelected] = useState<string>('');

  // 選択中の候補が禁止先になった場合（操作対象の変化）はルートへ戻す
  const safeSelected = blocked.has(selected) ? '' : selected;
  const list = useMemo(() => [...directories].toSorted(), [directories]);

  return (
    <div className="dialog-overlay" data-testid="move-dialog">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="move-title">
        <h3 className="dialog-title" id="move-title">
          「{targetLabel}」の移動先
        </h3>
        <ul className="move-dialog-list" role="listbox" aria-label="移動先ディレクトリ">
          {list.map((directory) => {
            const isBlocked = blocked.has(directory);
            const isSelected = safeSelected === directory;
            return (
              <li key={directory} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={isBlocked}
                  data-testid={isBlocked ? 'move-dialog-blocked' : 'move-dialog-option'}
                  className={isSelected ? 'is-selected' : undefined}
                  onClick={() => setSelected(directory)}
                >
                  {displayName(directory)}
                  {isBlocked && <span className="move-dialog-blocked-note">（自身の配下）</span>}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="dialog-actions">
          <button type="button" className="button-secondary" onClick={onCancel}>
            キャンセル
          </button>
          <button
            type="button"
            className="button-primary"
            data-testid="move-dialog-confirm"
            onClick={() => onConfirm(safeSelected)}
          >
            移動
          </button>
        </div>
      </div>
    </div>
  );
}
