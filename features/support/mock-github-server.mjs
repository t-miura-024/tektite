/**
 * E2E 用の GitHub モックサーバー（playwright.config.ts の webServer が起動する）。
 *
 * Pages Functions がサーバー側で行う fetch（トークン交換・/user 取得・
 * リポジトリ一覧・ファイルツリー取得）はブラウザ外のリクエストのため
 * Playwright の route ハンドラでは捕捉できない。そのため、Functions の
 * テストシーム環境変数（GITHUB_TOKEN_URL / GITHUB_API_BASE_URL）でこの
 * モックに向け、OAuth フロー全体と Vault 選択 → ツリー表示を実ブラウザで検証する。
 *
 * ブラウザが訪れる認可ページ（github.com/login/oauth/authorize）は常に本物の URL のまま、
 * Playwright の route ハンドラでモックする（features/steps/auth.steps.ts 参照）。
 *
 * エンドポイント:
 * - GET  /__health                              … webServer の起動確認用
 * - POST /__mock/contents/:owner/:repo/:path    … モック内部のノート内容を直接変更（Conflict 再現用）（M3）
 * - POST /login/oauth/access_token              … code=e2e-test-code ならテストトークンを返す
 * - GET  /user                                  … テストトークンなら octocat を返す
 * - GET  /user/repos                            … Vault 候補の検証用リポジトリ一覧（M3）
 * - GET  /repos/:owner/:repo                    … リポジトリ情報（デフォルトブランチ解決）（M3）
 * - GET  /repos/:owner/:repo/git/trees/:branch  … ファイルツリー（recursive 想定）（M3）
 * - GET  /repos/:owner/:repo/contents/:path     … ノート本文 + sha（M1）
 * - PUT  /repos/:owner/:repo/contents/:path     … ノート保存（sha 楽観ロック + 409 シミュレーション）（M3）
 *
 * PUT の 409 シミュレーション: body.sha が保存済みの sha と一致しない場合に
 * 409 { message: 'sha does not match current blob sha' } を返す（GitHub 実挙動の模倣）。
 * E2E で「読込後にリモートが変更された」状態を作るには、保存前の読み込みの後に
 * POST /__mock/contents/... でモック内の保存状態（sha 含む）を変更してから PUT する。
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_GITHUB_PORT ?? 4174);
export const EXPECTED_CODE = 'e2e-test-code';
export const EXPECTED_TOKEN = 'gho_e2e_test_token';

/**
 * リポジトリ一覧のモックデータ。Vault 候補フィルタ（write 権限あり・
 * 非アーカイブ）の検証のため、除外対象（read-only / archived）も含める。
 */
const REPOS = [
  {
    id: 1,
    name: 'notes',
    full_name: 'octocat/notes',
    private: false,
    archived: false,
    default_branch: 'main',
    description: 'Daily notes',
    pushed_at: '2026-08-07T12:00:00Z',
    updated_at: '2026-08-07T12:00:00Z',
    owner: { login: 'octocat' },
    permissions: { admin: true, push: true, pull: true },
  },
  {
    id: 2,
    name: 'private-vault',
    full_name: 'octocat/private-vault',
    private: true,
    archived: false,
    default_branch: 'main',
    description: null,
    pushed_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    owner: { login: 'octocat' },
    permissions: { admin: true, push: true, pull: true },
  },
  {
    id: 3,
    name: 'read-only',
    full_name: 'octocat/read-only',
    private: false,
    archived: false,
    default_branch: 'main',
    description: 'push 権限なし（Vault 候補から除外される）',
    pushed_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    owner: { login: 'octocat' },
    permissions: { admin: false, push: false, pull: true },
  },
  {
    id: 4,
    name: 'archived-notes',
    full_name: 'octocat/archived-notes',
    private: false,
    archived: true,
    default_branch: 'main',
    description: 'アーカイブ済み（Vault 候補から除外される）',
    pushed_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    owner: { login: 'octocat' },
    permissions: { admin: true, push: true, pull: true },
  },
];

const REPO_BY_FULL_NAME = new Map(REPOS.map((repo) => [repo.full_name, repo]));

/** Git Trees API（recursive=1）想定のフラットエントリ。隠れディレクトリも含む */
const TREES = {
  'octocat/notes:main': [
    { path: '.obsidian', type: 'tree' },
    { path: '.obsidian/app.json', type: 'blob' },
    { path: '.gitignore', type: 'blob' },
    { path: 'README.md', type: 'blob' },
    { path: 'attachments', type: 'tree' },
    { path: 'attachments/logo.png', type: 'blob' },
    { path: 'daily', type: 'tree' },
    { path: 'daily/2026-08-07.md', type: 'blob' },
    { path: 'daily/2026-08-08.md', type: 'blob' },
    { path: 'decoration.md', type: 'blob' },
    { path: 'projects', type: 'tree' },
    { path: 'projects/tektite.md', type: 'blob' },
  ],
  'octocat/private-vault:main': [
    { path: 'README.md', type: 'blob' },
    { path: 'secrets.md', type: 'blob' },
  ],
};

/** Contents API 想定のノート本文と sha（キーは "owner/repo:path"） */
const NOTES = {
  'octocat/notes:README.md': {
    sha: 'sha-readme',
    content: '# README\n\ntektite の Vault です。\n',
  },
  'octocat/notes:daily/2026-08-07.md': {
    sha: 'sha-2026-08-07',
    content: '# 2026-08-07\n\n- 朝会メモ\n',
  },
  'octocat/notes:daily/2026-08-08.md': {
    sha: 'sha-2026-08-08',
    content: '# 2026-08-08\n\n- CM6 エディタ\n- ライブプレビュー\n',
  },
  'octocat/notes:projects/tektite.md': {
    sha: 'sha-tektite',
    content: '# tektite\n\nWeb で完結するマークダウンエディタ。\n',
  },
  'octocat/notes:decoration.md': {
    sha: 'sha-decoration',
    content:
      '# 装飾サンプル\n\n**太字テキスト** と *斜体テキスト* と `コード`\n\n- 箇条書き\n1. 番号付きリスト\n\n> 引用文\n\n- [ ] 未完了タスク\n- [x] 完了タスク\n',
  },
};

/** テストシーム（POST /__mock/contents/...）で採番する sha の連番 */
let MOCK_SHA_COUNTER = 0;

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

/** テストトークンを持たないリクエストは 401（GitHub の認証挙動を模倣） */
function requireToken(req, res) {
  if (req.headers.authorization === `Bearer ${EXPECTED_TOKEN}`) {
    return true;
  }
  sendJson(res, 401, { message: 'Bad credentials' });
  return false;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/__health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // モック内部の保存状態を直接変更するテストシーム（GitHub API とは別系統）。
  // 別クライアントによるリモート変更を再現し、その後の PUT を 409 に導く。
  const mockContentsMatch = url.pathname.match(/^\/__mock\/contents\/([^/]+)\/([^/]+)\/(.+)$/);
  if (req.method === 'POST' && mockContentsMatch) {
    const raw = await readBody(req);
    const body = JSON.parse(raw || '{}');
    if (typeof body.content !== 'string') {
      sendJson(res, 400, { message: 'content must be a string' });
      return;
    }
    const notePath = decodeURIComponent(mockContentsMatch[3] ?? '');
    const key = `${mockContentsMatch[1]}/${mockContentsMatch[2]}:${notePath}`;
    const sha = `sha-mock-${++MOCK_SHA_COUNTER}`;
    NOTES[key] = { sha, content: body.content };
    sendJson(res, 200, { sha });
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
    if (!requireToken(req, res)) {
      return;
    }
    sendJson(res, 200, { login: 'octocat', id: 583231, name: 'The Octocat' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/user/repos') {
    if (!requireToken(req, res)) {
      return;
    }
    const page = Number(url.searchParams.get('page') ?? '1');
    sendJson(res, 200, page <= 1 ? REPOS : []);
    return;
  }

  const treeMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([^/]+)$/);
  if (req.method === 'GET' && treeMatch) {
    if (!requireToken(req, res)) {
      return;
    }
    const key = `${treeMatch[1]}/${treeMatch[2]}:${decodeURIComponent(treeMatch[3] ?? '')}`;
    const tree = TREES[key];
    if (!tree) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, 200, { sha: 'mock-tree-sha', truncated: false, tree });
    return;
  }

  const repoMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)$/);
  if (req.method === 'GET' && repoMatch) {
    if (!requireToken(req, res)) {
      return;
    }
    const repo = REPO_BY_FULL_NAME.get(`${repoMatch[1]}/${repoMatch[2]}`);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, 200, repo);
    return;
  }

  const contentsMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
  if (req.method === 'GET' && contentsMatch) {
    if (!requireToken(req, res)) {
      return;
    }
    const notePath = decodeURIComponent(contentsMatch[3] ?? '');
    const note = NOTES[`${contentsMatch[1]}/${contentsMatch[2]}:${notePath}`];
    if (!note) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(note.content, 'utf8').toString('base64'),
      sha: note.sha,
    });
    return;
  }

  if (req.method === 'PUT' && contentsMatch) {
    if (!requireToken(req, res)) {
      return;
    }
    const notePath = decodeURIComponent(contentsMatch[3] ?? '');
    const key = `${contentsMatch[1]}/${contentsMatch[2]}:${notePath}`;
    const raw = await readBody(req);
    const body = JSON.parse(raw || '{}');
    if (typeof body.content !== 'string' || body.content.length === 0) {
      sendJson(res, 400, { message: 'content must be a base64 string' });
      return;
    }
    const existing = NOTES[key];
    // sha 楽観ロック: 更新時（既存ファイル）は読込時の sha と一致しないと 409。
    // これが 409（Conflict）シミュレーションそのもので、一致しない sha を渡せば再現できる。
    if (existing && body.sha !== existing.sha) {
      sendJson(res, 409, { message: 'sha does not match current blob sha' });
      return;
    }
    const content = Buffer.from(body.content, 'base64').toString('utf8');
    const sha = `sha-saved-${++MOCK_SHA_COUNTER}`;
    NOTES[key] = { sha, content };
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      content: body.content,
      sha,
    });
    return;
  }

  sendJson(res, 404, { message: `no mock for ${req.method} ${url.pathname}` });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-github] ready on http://127.0.0.1:${PORT}`);
});
