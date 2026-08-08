/**
 * GitHub API のインフラ層（ブラウザ側アダプタ）。
 *
 * GitHub API 呼び出しはすべて Pages Functions プロキシ（functions/api/**）
 * 経由に集約する。このアダプタはそのプロキシを叩く HTTP クライアントであり、
 * 後続の子計画（Note 取得・保存など）も同じパターンで拡張する。
 */

export { HttpVaultGateway } from './http-gateway';
