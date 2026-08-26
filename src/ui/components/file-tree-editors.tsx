/**
 * ファイルツリーのインライン入力（新規フォルダー作成 / リネーム）。
 * Enter で確定・Escape で解除。名前の検証は入力側で行う。
 */

import { useEffect, useRef, useState, type JSX } from 'react';

import { validateEntryName } from '@/application/file';

/** 新規フォルダーのインライン入力（Enter で確定・Escape で解除。検証は入力内で行う） */
export function CreateDirectoryEditor({
  onSubmit,
  onCancel,
}: {
  onSubmit: (name: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (): void => {
    const name = value.trim();
    const message = validateEntryName(name, false);
    if (message !== null) {
      setError(message);
      return;
    }
    onSubmit(name);
  };

  return (
    <div className="file-tree-editor" data-testid="file-tree-editor">
      <input
        ref={inputRef}
        type="text"
        value={value}
        aria-label="新しいフォルダー名"
        data-testid="file-tree-editor-input"
        placeholder="フォルダー名（例: daily）"
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <button
        type="button"
        className="button-primary"
        data-testid="file-tree-editor-submit"
        onClick={submit}
      >
        作成
      </button>
      <button type="button" className="button-secondary" onClick={onCancel}>
        キャンセル
      </button>
      {error !== null && (
        <p className="file-tree-editor-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** リネームのインライン入力（Enter で確定・Escape で解除。検証は入力内で行う） */
export function InlineRenameInput({
  defaultValue,
  indent,
  onSubmit,
  onCancel,
}: {
  defaultValue: string;
  indent: number;
  onSubmit: (newName: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [value, setValue] = useState(defaultValue);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = (): void => {
    const name = value.trim();
    const message = validateEntryName(name, defaultValue.endsWith('.md'));
    if (message !== null) {
      setError(message);
      return;
    }
    if (name === defaultValue) {
      onCancel();
      return;
    }
    onSubmit(name);
  };

  return (
    <div className="file-tree-rename" style={{ '--tree-depth': indent }}>
      <input
        ref={inputRef}
        type="text"
        className="file-tree-rename-input"
        aria-label="新しい名前"
        data-testid="file-rename-input"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      {error !== null && (
        <p className="file-tree-editor-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
