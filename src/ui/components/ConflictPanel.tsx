/**
 * 競合（Conflict）解決パネル（M3: 保存パイプライン）。
 *
 * 保存時にリモートの sha が読込時から変わっていた場合（NoteSaveError kind:
 * conflict）、「差分表示 + 上書き/取り込みの二者択一」で解決する（自動マージなし）。
 * 差分表示は diff ライブラリを導入せず、リモートと編集中の内容を 2 ペインで
 * 並べる軽量な方式（方針: AI 判断範囲）。
 *
 * - 上書きで保存: 編集中の内容を最新 sha で再コミットする（データ損失はユーザーが明示的に選ぶ）
 * - リモートの変更を取り込む: リモートの内容を再取得して編集中の変更を破棄する
 *
 * 解決中の再保存状態は saving で表現し、ボタンを無効化する。
 */

import type { NoteContent } from '@/application/note';

export interface ConflictPanelProps {
  /** 編集中（保存に失敗した）内容 */
  local: string;
  /** リモートの最新内容（競合検出後に再取得したもの） */
  remote: NoteContent;
  /** 解決中（上書き再保存の通信中）かどうか */
  saving: boolean;
  onOverwrite: () => void;
  onAdopt: () => void;
}

export function ConflictPanel({ local, remote, saving, onOverwrite, onAdopt }: ConflictPanelProps) {
  return (
    <section className="conflict-panel" data-testid="conflict-panel" role="alertdialog">
      <h3 className="conflict-panel-title">
        保存できませんでした。リモートの内容が変更されています。
      </h3>
      <p className="conflict-panel-note">
        編集中の内容とリモートの内容を確認し、どちらかを選んでください（自動マージは行いません）。
      </p>
      <div className="conflict-panes">
        <div className="conflict-pane">
          <h4 className="conflict-pane-title">リモートの内容</h4>
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
          上書きで保存
        </button>
        <button
          type="button"
          className="button-secondary"
          data-testid="conflict-adopt"
          onClick={onAdopt}
          disabled={saving}
        >
          リモートの変更を取り込む
        </button>
      </div>
    </section>
  );
}
