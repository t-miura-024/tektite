/**
 * 404 画面（ルーティング解決不能なパス）。
 * Vault 一覧（ルート）への導線だけを置く。
 */

import { Link } from '@/ui/components/Link';

export function NotFoundScreen() {
  return (
    <section className="error-panel">
      <p>ページが見つかりませんでした。</p>
      <Link to="/" className="button-secondary">
        Vault 一覧へ戻る
      </Link>
    </section>
  );
}
