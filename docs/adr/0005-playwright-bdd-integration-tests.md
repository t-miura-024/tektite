# Gherkin 統合テストは playwright-bdd で実ブラウザに対して実行する

BDD の統合テストは playwright-bdd を使い、`.feature` ファイルを実ブラウザ上の UI 操作として実行する。GitHub API は Playwright の route ハンドラでモックする。Web エディタである tektite では CM6 の描画・操作を含む UI 挙動が本丸であり、Gherkin シナリオがそのままユーザー操作になる。ランナーの成熟度（週 51 万 DL）も選定理由。

## Considered Options

- vitest-bdd: vitest との一体感は良いが 2026 年登場の若手であり、Node レベルでは CM6 の UI 挙動をカバーできない
- cucumber-js: 定番だが vitest とは別プロセスの独立ランナーになる
- 二層構成（E2E + ドメイン統合）: カバレッジは最強だが、2 系統のステップ定義は個人規模で維持コストが高い
