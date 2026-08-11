# tektite

Web で完結する Obsidian ライク・マークダウンエディタ。GitHub リポジトリを Vault として閲覧/編集し、変更は再び GitHub へコミットする。

## Language

### 核心

**Vault**:
GitHub リポジトリ 1 個に対応するノート置き場。ユーザーがログイン後に一覧から選択して開く単位。
_Avoid_: repo, workspace, notebook

**Note**:
Vault 内の 1 つの Markdown ファイル。閲覧・編集・リンク・検索の対象となる最小単位。
_Avoid_: page, document, file

**Attachment**:
画像など Vault 内に置かれる Note 以外のファイル。Embed やダウンロードの対象。
_Avoid_: asset, resource, binary

### 記法

**WikiLink**:
`[[ノート名]]` 形式で、ある Note から別の Note を指す参照。エイリアス（`[[ノート名|表示名]]`）と見出しリンク（`[[ノート名#見出し]]`）の派生形を持つ。解決規則は大文字小文字を区別しない最短パス一致。
_Avoid_: internal link, backlink

**Alias**:
WikiLink の `|` 以降に書く表示名。参照先は変えずにリンクの表示テキストだけを上書きする。
_Avoid_: label, display text

**Embed**:
`![[...]]` 形式で、画像 Attachment の表示または Note 本文のインライン展開を行う記法。
_Avoid_: include, import

**Backlink**:
WikiLink によってある Note を参照している側の Note。バックリンクパネルに列挙される。
_Avoid_: reference, incoming link

**Tag**:
`#タグ` 形式で Note に付与されるラベル。インライン記述と Frontmatter の両方で付き、`#area/project` のようなネスト形式も持つ。
_Avoid_: label, category

**Frontmatter**:
Note 先頭の YAML メタデータブロック。MVP では表示のみで編集しない。
_Avoid_: properties, metadata

### 編集と保存

**ライブプレビュー**:
記法を入力しながらインラインでレンダリングする編集モード。tektite の既定モード。
_Avoid_: WYSIWYG, rich text

**明示保存**:
Cmd+S または保存ボタンによってコミットを確定する操作。
_Avoid_: commit（UI 層では使わない）, manual save

**自動保存**:
エディタからのフォーカス喪失をトリガーに自動で行われるコミット確定。
_Avoid_: 定期保存, timer save

**Draft**:
未保存の編集バッファを localStorage に退避したもの。次回開いた時に復元される。
_Avoid_: cache, temporary file, backup

**Conflict**:
読み込み後にリモートの Note が変更されており、保存時の sha チェックで検出される状態。差分表示 + 上書き/取り込みの選択で解決する。
_Avoid_: merge conflict, collision

### ナビゲーションと操作

**クイックスイッチャー**:
Cmd+O で Note 名をファジー検索して開く機能。
_Avoid_: command palette, file finder

**全文検索**:
全 Note の本文を対象とするクライアント側の検索。
_Avoid_: grep, find

**リンク張り替え**:
Note のリネーム/移動に伴い、その Note を参照する全 WikiLink を一括で更新する処理。
_Avoid_: refactoring, redirect

### 認証と環境

**PAT モード**:
GitHub OAuth を介さず、ローカル環境変数に設定した個人アクセストークンで認証する開発専用の動作モード。`TEKTITE_PAT_AUTH=true` と `GITHUB_PERSONAL_TOKEN` の両方が設定された時のみ有効で、有効中はセッション Cookie より優先してトークンが使われる。
_Avoid_: token auth, personal token login
