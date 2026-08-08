機能: GitHub OAuth ログインとセッション
  OAuth App フローでログインすると暗号化 Cookie でセッションが確立し、
  ログアウトで Cookie が削除されることを実ブラウザで検証する（完了条件 2）。

  GitHub のエンドポイントは E2E 内でモックする:
  - 認可ページ（github.com/login/oauth/authorize）… この Playwright / Chromium では
    リダイレクトのホップを route で捕捉できないため、/api/auth/login の 302 応答を
    route ハンドラで書き換えて「認可承認後のリダイレクト」を再現する（詳細は
    features/steps/auth.steps.ts）
  - トークン交換・ユーザー取得 … Pages Functions がサーバー側で fetch するため
    ローカルのモックサーバー（features/support/mock-github-server.mjs）に向ける

  シナリオ: 未ログインからログインしてセッションが確立し、ログアウトで Cookie が削除される
    前提 GitHub OAuth のモックが有効である
    かつ ユーザーはログイン画面にいる
    もし ユーザーがログインボタン "GitHub でログイン" を押す
    ならば ユーザー "octocat" のセッションが確立する
    もし ユーザーがログアウトする
    ならば ログイン画面が再び表示される

  シナリオ: state が一致しないコールバックは拒否される（CSRF 対策）
    もし ユーザーが不正な state でコールバック URL にアクセスする
    ならば 認証エラーのトーストが表示される
    かつ ログイン画面が再び表示される
