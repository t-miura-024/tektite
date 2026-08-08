/**
 * アプリケーション層（ユースケース）。
 *
 * ドメインオブジェクトを操作してユースケース（ログイン、Vault 選択、
 * Note の読み書き、保存など）を進行させる。
 *
 * 外部サービス（GitHub API / ストレージ）には直接依存せず、
 * この層で定義するポート（インターフェース）を src/infra が実装する。
 */

export { SessionFetchError, SessionUseCases } from './session';
export type { Session, SessionGateway, SessionUser } from './session';
