/**
 * CSSProperties へ CSS カスタムプロパティ（`--var`）のインデックスシグネチャを
 * 再追加するモジュール拡張。
 *
 * @types/react v19 は csstype の closed typing のためカスタムプロパティを
 * 直接受け付けず、テンプレート側では `as CSSProperties`（型アサーション禁止）
 * でしか書けない。公式ドキュメント（frenic/csstype FAQ）が案内している
 * モジュール拡張で型を広げ、オブジェクトリテラルを直接 style に渡せるようにする。
 */

// oxlint-disable-next-line import/no-unassigned-import -- モジュール拡張（declaration merging）のために react の型を読み込む副作用インポート
import 'react';

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- モジュール拡張（interface merging）は type では表現できない
  export interface CSSProperties {
    [index: `--${string}`]: string | number | undefined;
  }
}
