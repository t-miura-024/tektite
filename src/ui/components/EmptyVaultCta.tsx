/**
 * 空リポジトリの CTA（M2: 「最初のノートを作成」）。
 *
 * Markdown ファイルが 1 つもない（ツリーが空の）Vault を開いたとき、
 * メインペインに表示する。既定名（index.md）の入力を編集でき、
 * 確定でノート作成（一括コミット）へ進む。作成後の遷移・ツリー再読込は
 * 親（VaultScreen）のコールバックが担う。名前の検証はファイル操作と
 * 同じ validateEntryName を使う。
 */

import { useEffect, useRef, useState } from 'react';

import { validateEntryName } from '@/application/file';

export interface EmptyVaultCtaProps {
  /** ノート名の既定値（空 Vault の最初のノート） */
  defaultName?: string;
  /** ノート作成をコミットする（名前は検証済み） */
  onCreateNote: (name: string) => void;
}

export function EmptyVaultCta({ defaultName = 'index.md', onCreateNote }: EmptyVaultCtaProps) {
  const [value, setValue] = useState(defaultName);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 表示直後に入力へフォーカスする（Enter だけで作成できるようにする）
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (): void => {
    const name = value.trim();
    const message = validateEntryName(name, true);
    if (message !== null) {
      setError(message);
      return;
    }
    onCreateNote(name);
  };

  return (
    <div className="empty-vault-cta" data-testid="empty-vault-cta">
      <p className="empty-vault-cta-title">この Vault にはまだファイルがありません。</p>
      <p className="empty-vault-cta-description">最初のノートを作成して編集を始めましょう。</p>
      <div className="empty-vault-cta-form">
        <input
          ref={inputRef}
          type="text"
          value={value}
          aria-label="最初のノート名"
          data-testid="empty-vault-cta-input"
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="button"
          className="button-primary"
          data-testid="empty-vault-cta-submit"
          onClick={submit}
        >
          最初のノートを作成
        </button>
      </div>
      {error !== null && (
        <p className="file-tree-editor-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
