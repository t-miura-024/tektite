# テストファイルにおける `as` / `class` の例外的許容

本番コードでは `as`（`as const` 除く）と `class` を全面禁止するが、テストファイル（`*.test.ts` / `*.test.tsx`）では `as`（DOMアサーション `as HTMLElement` 等）と `class`（Fake R2Bucket/Storage等のモック）を `overrides` で許可する。テストの実用性を優先しつつ本番コードの厳密性は維持する。代替案としてテストも全面禁止（Fakeを関数ファクトリへ全面置換）を検討したが、修正コストに見合う保守性向上が得られないため例外とした。
