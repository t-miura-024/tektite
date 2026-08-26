# レイヤー依存の機械的強制

手動レビューではなく `no-restricted-imports` の `overrides` でレイヤー依存の完全DAGを機械的に強制する。`domain→外部依存なし / application→domainのみ / infra・api→domain+application / ui→domain+application+composition経由 / composition.tsのみinfra許可` とし、組成ルート（`src/composition.ts`）のみがinfraを知ることを許される唯一のモジュールとする。代替案としてドキュメント＋レビューでの担保を検討したが、属人化と漏れを防ぐため機械的強制を選んだ。
