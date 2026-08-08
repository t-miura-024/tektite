# エディタ基盤は CodeMirror 6

tektite は Obsidian の編集体験（ライブプレビュー + 独自記法の装飾）を Web で再現する。Obsidian 本体が CodeMirror 6 を採用しているため、同一エンジンを選ぶことで記法再現の先行知見をそのまま活用でき、モバイル入力対応も実証済みである。

## Considered Options

- ProseMirror 系（Milkdown / Tiptap）: リッチ WYSIWYG は作りやすいが、ソーステキスト準拠の Obsidian 記法モデルと相性が悪い
- Monaco: 高機能だが重く、モバイル対応が弱い
