/**
 * 空リポジトリの CTA（「最初のノートを作成」）。
 *
 * Markdown ファイルが 1 つもない（ツリーが空の）Vault を開いたとき、
 * メインペインに表示する。Obsidian 式の新規作成フロー（Q16:1 で全入口を統一）に
 * 合わせ、ボタンを押すとデフォルト名（Untitled.md）で未確定の新規ノートが
 * エディタに開く（名前はエディタのインラインタイトル編集で決める）。
 * 作成のコミット・遷移は親（VaultScreen）のコールバックが担う。
 */

export interface EmptyVaultCtaProps {
  /** 新規ノート作成を開始する（Obsidian 式: デフォルト名でエディタを開く） */
  onCreateNote: () => void;
}

export function EmptyVaultCta({ onCreateNote }: EmptyVaultCtaProps) {
  return (
    <div className="empty-vault-cta" data-testid="empty-vault-cta">
      <p className="empty-vault-cta-title">この Vault にはまだファイルがありません。</p>
      <p className="empty-vault-cta-description">最初のノートを作成して編集を始めましょう。</p>
      <button
        type="button"
        className="button-primary"
        data-testid="empty-vault-cta-submit"
        onClick={onCreateNote}
      >
        最初のノートを作成
      </button>
    </div>
  );
}
