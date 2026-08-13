/**
 * 競合（Conflict）解決パネル（M3: 保存パイプライン / M5: 同期衝突）。
 *
 * 2 種類の競合を同じ「差分表示 + 二者択一」で解決する（自動マージなし）:
 *
 * - 保存時（variant: 'save'）: 保存時にリモートの sha が読込時から変わっていた
 *   場合。「上書きで保存」= 編集中の内容を最新 sha で再コミット /
 *   「リモートの変更を取り込む」= リモートを再取得して編集中の変更を破棄
 * - 同期衝突（variant: 'sync'）: 明示同期で GitHub 側の変更と R2 側のローカル
 *   保存が同一 Note で衝突した場合（完了条件 6）。「上書き」= GitHub 側の内容を
 *   採用 / 「取り込み」= ローカル側の内容を GitHub へ反映
 *
 * 差分表示は diff ライブラリを導入せず、リモートとローカルの内容を 2 ペインで
 * 並べる軽量な方式。解決中の再保存状態は saving で表現し、ボタンを無効化する。
 */

import type { NoteContent } from '@/application/note';

export type ConflictVariant = 'save' | 'sync';

export interface ConflictPanelProps {
  variant?: ConflictVariant;
  /** ローカル側の内容（保存時: 編集中の内容 / 同期時: R2 のローカル保存内容） */
  local: string;
  /** リモート側の内容（保存時: NoteContent / 同期時: GitHub の現在内容） */
  remote:
    | NoteContent
    | { readonly path: string; readonly content: string; readonly sha: string | null };
  /** 解決中（上書き再保存 / 同期解決の通信中）かどうか */
  saving: boolean;
  onOverwrite: () => void;
  onAdopt: () => void;
}

export function ConflictPanel({
  variant = 'save',
  local,
  remote,
  saving,
  onOverwrite,
  onAdopt,
}: ConflictPanelProps) {
  const isSync = variant === 'sync';
  const title = isSync
    ? '同期中に GitHub の内容と編集中の内容が衝突しました。'
    : '保存できませんでした。リモートの内容が変更されています。';
  const note = isSync
    ? 'どちらの内容を採用するか選んでください（自動マージは行いません）。「GitHub の内容で更新」で GitHub 側を採用し、「編集中の内容を保持」でローカル側を GitHub へ反映します。'
    : '編集中の内容とリモートの内容を確認し、どちらかを選んでください（自動マージは行いません）。';
  return (
    <section className="conflict-panel" data-testid="conflict-panel" role="alertdialog">
      <h3 className="conflict-panel-title">{title}</h3>
      <p className="conflict-panel-note">{note}</p>
      <div className="conflict-panes">
        <div className="conflict-pane">
          <h4 className="conflict-pane-title">{isSync ? 'GitHub の内容' : 'リモートの内容'}</h4>
          <pre className="conflict-content" data-testid="conflict-remote">
            {remote.content}
          </pre>
        </div>
        <div className="conflict-pane">
          <h4 className="conflict-pane-title">編集中の内容</h4>
          <pre className="conflict-content" data-testid="conflict-local">
            {local}
          </pre>
        </div>
      </div>
      <div className="conflict-actions">
        <button
          type="button"
          className="button-primary"
          data-testid="conflict-overwrite"
          onClick={onOverwrite}
          disabled={saving}
        >
          {isSync ? 'GitHub の内容で更新' : '上書きで保存'}
        </button>
        <button
          type="button"
          className="button-secondary"
          data-testid="conflict-adopt"
          onClick={onAdopt}
          disabled={saving}
        >
          {isSync ? '編集中の内容を保持' : 'リモートの変更を取り込む'}
        </button>
      </div>
    </section>
  );
}
