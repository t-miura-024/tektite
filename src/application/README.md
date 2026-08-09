# src/application — アプリケーション層

ユースケースを進行させる層。

## 置くもの

- ユースケース（例: ログイン、Vault 一覧取得、Note 保存）。Effect プログラム
  （`Effect<A, E, ポート>`）として定義する
- 外部サービス向けのポート定義。Effect の Service（`Context.GenericTag`）として定義する

## 依存規則

- `src/domain` には依存してよい
- `src/infra` の具体実装は import しない（依存性逆転: ポートはここで Effect Service として
  定義し、実装（Layer）は `src/infra` が、組成は `src/composition.ts` が担う）
- React コンポーネントは置かない（→ `src/ui`）
