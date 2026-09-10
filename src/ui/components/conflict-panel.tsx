/**
 * 競合解決パネル。保存時の sha 衝突と同期中の GitHub 衝突を同じ差分表示と二者択一で解決し、
 * 自動マージはしない。リモートとローカルを二ペインで並べて内容を確認させ、上書きか取り込みかを
 * 選択させる。diff ライブラリは使わず、表示文言は保存時と同期時で切り替えて解決中は saving で
 * 無効化する。
 */

import type { JSX } from 'react';

import type { NoteContent } from '@/application/note';

export type ConflictVariant = 'save' | 'sync';

export type ConflictPanelProps = {
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
};

export function ConflictPanel({
  variant = 'save',
  local,
  remote,
  saving,
  onOverwrite,
  onAdopt,
}: ConflictPanelProps): JSX.Element {
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
