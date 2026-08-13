/// <reference types="vitest/config" />
import build from '@hono/vite-build/cloudflare-workers';
import adapter from '@hono/vite-dev-server/cloudflare';
import react from '@vitejs/plugin-react';
import honox from 'honox/vite';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    react(),
    honox({
      // API は HonoX のファイルベースルーティング（src/api/routes/**）で処理する。
      // entry を src/api/server.ts に指定し、createApp({ root: '/src/api' }) で
      // ルートディレクトリを src/api/ にする（Pages Functions 廃止後の移行先）。
      entry: '/src/api/server.ts',
      devServer: {
        // dev 時に wrangler.jsonc のバインディング（KV / R2 / Static Assets）を注入する
        adapter,
      },
      // SPA（index.html）をクライアントビルドの入力にする
      client: { input: ['/index.html'] },
    }),
    // Workers 向けサーバービルド（dist/index.js を出力。scheduled 等のハンドラをマージ）
    build({ entry: '/src/api/server.ts' }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
