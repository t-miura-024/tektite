/**
 * インフラ層（アダプタ）。
 *
 * application 層のポートの実装を置く:
 * - GitHub API クライアント（Pages Functions プロキシ経由、infra/github）
 * - 認証・セッションアダプタ（infra/auth）
 * - localStorage 等のストレージアダプタ
 *
 * 方針: GitHub API 呼び出しはすべて Pages Functions プロキシ経由に集約する。
 * ブラウザから api.github.com を直接呼ばない。
 */

export * from './auth';
