/**
 * E2E 用の GitHub モックサーバー（playwright.config.ts の webServer が起動する）。
 *
 * Pages Functions がサーバー側で行う fetch（トークン交換・/user 取得）は
 * ブラウザ外のリクエストのため Playwright の route ハンドラでは捕捉できない。
 * そのため、Functions のテストシーム環境変数（GITHUB_TOKEN_URL / GITHUB_API_BASE_URL）
 * でこのモックに向け、OAuth フロー全体を実ブラウザで検証する。
 *
 * ブラウザが訪れる認可ページ（github.com/login/oauth/authorize）は常に本物の URL のまま、
 * Playwright の route ハンドラでモックする（features/steps/auth.steps.ts 参照）。
 *
 * エンドポイント:
 * - GET  /__health                    … webServer の起動確認用
 * - POST /login/oauth/access_token    … code=e2e-test-code ならテストトークンを返す
 * - GET  /user                        … テストトークンなら octocat を返す
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_GITHUB_PORT ?? 4174);
export const EXPECTED_CODE = 'e2e-test-code';
export const EXPECTED_TOKEN = 'gho_e2e_test_token';

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/__health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
    const raw = await readBody(req);
    const contentType = req.headers['content-type'] ?? '';
    const params = contentType.includes('application/json')
      ? JSON.parse(raw || '{}')
      : Object.fromEntries(new URLSearchParams(raw));
    if (params.code === EXPECTED_CODE) {
      sendJson(res, 200, {
        access_token: EXPECTED_TOKEN,
        token_type: 'bearer',
        scope: 'repo',
      });
    } else {
      sendJson(res, 400, {
        error: 'bad_verification_code',
        error_description: 'The code passed is incorrect or expired.',
      });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/user') {
    if (req.headers.authorization === `Bearer ${EXPECTED_TOKEN}`) {
      sendJson(res, 200, { login: 'octocat', id: 583231, name: 'The Octocat' });
    } else {
      sendJson(res, 401, { message: 'Bad credentials' });
    }
    return;
  }

  sendJson(res, 404, { message: `no mock for ${req.method} ${url.pathname}` });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-github] ready on http://127.0.0.1:${PORT}`);
});
