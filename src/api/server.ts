/**
 * HonoXエントリ。routesを配し、API以外はSPAのindex.htmlへフォールバックする。
 * devはViteのHTML変換、WorkersはStatic Assetsから配信する。APIの404はJSONで返す。
 * 定時ハンドラは保持中の全Vaultを逐次で両方向同期し、失敗はmetaへ記録する。
 * 衝突時は中断して次回Cronで再試行し、1Vaultの失敗が他へ波及しない。
 */

import { createApp } from 'honox/server';
import type { ViteDevServer } from 'vite';
import indexHtml from '../../index.html?raw';

import { isAuthConfigError, resolveAuthConfig } from '@/api/_lib/env';
import { getServerAccessToken } from '@/api/_lib/token-store';
import {
  listSyncedVaults,
  recordSyncFailure,
  syncVault,
  type SyncFailureReason,
} from '@/api/_lib/vault-sync';

// Hono の Env 型（Bindings / Variables）に合わせて Bindings に tektite の Env を指定する。
// root はルートディレクトリ（src/api/routes）を指す。テストファイルはルートから除外する。
const app = createApp<{ Bindings: Env }>({
  root: '/src/api/routes',
  ROUTES: import.meta.glob(
    [
      '/src/api/routes/**/*.{ts,tsx}',
      '!/src/api/routes/**/_*.{ts,tsx}',
      '!/src/api/routes/**/-*.{ts,tsx}',
      '!/src/api/routes/**/$*.{ts,tsx}',
      '!/src/api/routes/**/*.test.{ts,tsx}',
      '!/src/api/routes/**/*.spec.{ts,tsx}',
      '!/src/api/routes/**/-*/**/*',
    ],
    { eager: true },
  ),
});

// API 以外の 404 は SPA の index.html へフォールバックする
app.notFound(async (c) => {
  if (c.req.path.startsWith('/api')) {
    return c.json({ error: 'not_found' }, 404);
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- HonoX の dev サーバー連携（vite）はフレームワークが Env へ動的合成するため境界で確定する
  const env = c.env as Env & { vite?: ViteDevServer };
  if (env.vite) {
    // dev: Vite の HTML 変換を適用して返す（/src/ui/main.tsx の解決と HMR）
    const html = await env.vite.transformIndexHtml(c.req.url, indexHtml);
    return c.html(html);
  }
  if (env.ASSETS) {
    // Workers: Static Assets から配信する。実ファイルが無ければ index.html（SPA）
    const asset = await env.ASSETS.fetch(c.req.raw);
    if (asset.status !== 404) {
      return asset;
    }
    const url = new URL(c.req.url);
    url.pathname = '/';
    const index = await env.ASSETS.fetch(new Request(url));
    if (index.status === 200) {
      return index;
    }
  }
  return c.json({ error: 'not_found' }, 404);
});

/** 定時同期（1時間）。全Vaultを両方向同期し失敗は記録、衝突は中断する。 */
export async function runScheduledSync(env: Env): Promise<void> {
  const bucket = env.VAULT_BUCKET;
  if (!bucket) {
    // oxlint-disable-next-line no-console -- Cloudflare Workers の標準出力ログ（Cron 観測性のため維持）
    console.log('[tektite] scheduled sync: VAULT_BUCKET が未設定のためスキップ');
    return;
  }
  let config;
  try {
    config = resolveAuthConfig(env);
  } catch (error) {
    if (isAuthConfigError(error)) {
      // oxlint-disable-next-line no-console -- Cloudflare Workers の標準出力ログ（Cron 観測性のため維持）
      console.error(`[tektite] scheduled sync: 設定エラー（${error.message}）`);
      return;
    }
    throw error;
  }
  const vaults = await listSyncedVaults(bucket);
  // Vault は逐次同期する（並列にすると GitHub のレートリミットを同時に消費する
  // ため。1 Vault の失敗が他へ影響しないよう try-catch を Vault 単位で区切る）
  for (const vault of vaults) {
    const label = `${vault.owner}/${vault.repo}`;
    try {
      // oxlint-disable-next-line no-await-in-loop -- トークン取得（Vault 単位の逐次実行）のため
      const tokenResult = await getServerAccessToken(env, config, vault.owner);
      if (!tokenResult.ok) {
        const _reason = tokenResult.reason;
        const reason: SyncFailureReason =
          _reason === 'refresh_failed'
            ? 'refresh_failed'
            : _reason === 'kv_missing'
              ? 'kv_missing'
              : 'no_token';
        // oxlint-disable-next-line no-console -- Cloudflare Workers の標準出力ログ（Cron 観測性のため維持）
        console.error(`[tektite] scheduled sync: ${label} トークン取得失敗（${reason}）`);
        await recordSyncFailure(bucket, vault.owner, vault.repo, reason);
      }
      if (tokenResult.ok) {
        // oxlint-disable-next-line no-await-in-loop -- 同期実行（Vault 単位の逐次実行）のため
        const outcome = await syncVault(
          config.apiBaseUrl,
          tokenResult.accessToken,
          bucket,
          vault.owner,
          vault.repo,
          'scheduled',
        );
        if (!outcome.ok) {
          // oxlint-disable-next-line no-console -- Cloudflare Workers の標準出力ログ（Cron 観測性のため維持）
          console.error(`[tektite] scheduled sync: ${label} 失敗（${outcome.reason}）`);
          await recordSyncFailure(bucket, vault.owner, vault.repo, outcome.reason);
        }
        if (outcome.ok && outcome.result.status === 'syncing') {
          // チャンク化により 1 回の Cron で処理しきれない差分が残っている。
          // 冪等なので次回 Cron で続きが消化される
          // oxlint-disable-next-line no-console -- Cloudflare Workers の標準出力ログ（Cron 観測性のため維持）
          console.log(
            `[tektite] scheduled sync: ${label} 途中（remaining=${outcome.result.remaining}, pulled=${outcome.result.pulled}）`,
          );
        }
        if (outcome.ok && outcome.result.status !== 'syncing') {
          // oxlint-disable-next-line no-console -- Cloudflare Workers の標準出力ログ（Cron 観測性のため維持）
          console.log(
            `[tektite] scheduled sync: ${label} 完了（pulled=${outcome.result.pulled}, pushed=${outcome.result.pushed}）`,
          );
        }
      }
    } catch (error) {
      // oxlint-disable-next-line no-console -- Cloudflare Workers の標準出力ログ（Cron 観測性のため維持）
      console.error(`[tektite] scheduled sync: ${label} 予期しないエラー`, error);
      await recordSyncFailure(bucket, vault.owner, vault.repo, 'github_error');
    }
  }
}

/**
 * Worker エントリ。fetch は Hono アプリへ委譲し、scheduled は定時同期
 * （runScheduledSync）を実行する（M5）。
 */
const worker = {
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> =>
    app.fetch(request, env, ctx),
  scheduled: (controller: ScheduledController, env: Env, ctx: ExecutionContext): void => {
    // oxlint-disable-next-line no-console -- Cloudflare Workers の標準出力ログ（Cron 観測性のため維持）
    console.log(`[tektite] scheduled handler: ${controller.cron}（定時同期を開始）`);
    ctx.waitUntil(runScheduledSync(env));
  },
} satisfies ExportedHandler<Env>;

export default worker;
