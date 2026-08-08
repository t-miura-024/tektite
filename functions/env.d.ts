/**
 * Cloudflare Pages Functions の環境バインディング定義。
 * `wrangler.jsonc` の vars / secrets と対応する。
 *
 * M2（認証）で次を追加予定:
 * - GITHUB_CLIENT_ID: string     … OAuth App client ID（変数）
 * - GITHUB_CLIENT_SECRET: string … OAuth App client secret（シークレット）
 * - SESSION_SECRET: string       … AES-GCM 暗号化 Cookie の鍵（シークレット）
 */
interface Env {
  // M2 で追加: GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / SESSION_SECRET
}
