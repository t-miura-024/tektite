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
  {
    id: 5,
    name: 'empty-vault',
    full_name: 'octocat/empty-vault',
    private: false,
    archived: false,
    default_branch: 'main',
    description: 'コミット 0 件の空リポジトリ（「最初のノートを作成」CTA 用）',
    pushed_at: '2026-08-09T00:00:00Z',
    updated_at: '2026-08-09T00:00:00Z',
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
    { path: 'embeds.md', type: 'blob' },
    { path: 'meeting.md', type: 'blob' },
    { path: 'projects', type: 'tree' },
    { path: 'projects/tektite.md', type: 'blob' },
    { path: 'render.md', type: 'blob' },
    { path: 'tags.md', type: 'blob' },
    { path: 'wiki.md', type: 'blob' },
  ],
  'octocat/private-vault:main': [
    { path: 'README.md', type: 'blob' },
    { path: 'secrets.md', type: 'blob' },
  ],
};

/** 1x1 透明 PNG（画像 Embed の表示検証用） */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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
  // 記法の E2E（features/notation.feature）用。保存系シナリオが書き換える
  // projects/tektite.md には依存させず、シナリオ間の独立性を保つ
  'octocat/notes:wiki.md': {
    sha: 'sha-wiki',
    content:
      '# Wiki\n\n[[tags]] と [[tags#セクション|タグの一覧]] を参照する。\n\n壊れリンク: [[存在しないノート]]\n\n#wiki\n',
  },
  'octocat/notes:tags.md': {
    sha: 'sha-tags',
    content:
      '---\ntags:\n  - area/project\n---\n# タグのノート\n\n## セクション\n\nバックリンクとタグ一覧の検証用ノートです。\n\n#tagged\n',
  },
  // タグ一致の検索 E2E（features/navigation.feature）用。タグ語（tagged）を本文に
  // 含めずフロントマテリアのタグのみを持たせることで、検索時に kind='tag' として
  // 分類されることを検証する（tags.md のインライン #tagged は content 一致になる）
  'octocat/notes:meeting.md': {
    sha: 'sha-meeting',
    content:
      '---\ntags:\n  - tagged\n---\n# ミーティングのノート\n\nタグ一致の検索を検証するためのノートです。\n',
  },
  'octocat/notes:embeds.md': {
    sha: 'sha-embeds',
    content: '# 埋め込み\n\n![[attachments/logo.png]]\n\n![[tags]]\n',
  },
  // 描画拡張（数式 / コールアウト / タスクリスト / コードハイライト）の E2E 用
  'octocat/notes:render.md': {
    sha: 'sha-render',
    content:
      '# 描画サンプル\n\n数式: $a^2 + b^2 = c^2$\n\n> [!note] メモ\n> コールアウトの本文です\n\n- [ ] 未完了タスク\n- [x] 完了タスク\n\n```ts\nconst value: number = 1;\n```\n',
  },
  // 画像（raw 配信）。rawContent は GET /contents が Accept:
  // application/vnd.github.raw のときバイナリとして返す
  'octocat/notes:attachments/logo.png': {
    sha: 'sha-logo',
    contentType: 'image/png',
    rawContent: TINY_PNG_BASE64,
  },
};

/** テストシーム（POST /__mock/contents/...）で採番する sha の連番 */
let MOCK_SHA_COUNTER = 0;

/** 一括コミット（M5）で作成された blob（sha → base64 本文） */
const BLOBS = new Map();

/** 一括コミット（M5）で作成された commit（sha → メタデータ。参照更新の検証用） */
const COMMITS = new Map();

/** ブランチ先頭コミット sha（キーは "owner/repo:branch"。初回アクセス時に確定する） */
const HEAD_COMMITS = new Map();

/** パス拡張子から Content-Type を推測する（画像 round-trip の raw 配信用） */
function contentTypeForPath(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.md')) return 'text/markdown';
  return 'application/octet-stream';
}

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
    // GitHub の Trees API 応答に合わせ、blob エントリにはファイル sha を含める
    // （M4 の一括取得 /api/notes/:owner/:repo/all が Git Blobs API の取得に使う）
    const entries = tree.map((entry) => {
      if (entry.type !== 'blob') {
        return entry;
      }
      const note = NOTES[`${treeMatch[1]}/${treeMatch[2]}:${entry.path}`];
      return { ...entry, sha: note?.sha ?? `mock-sha-${entry.path}` };
    });
    sendJson(res, 200, { sha: 'mock-tree-sha', truncated: false, tree: entries });
    return;
  }

  // Git Blobs API（M4 の一括取得 /api/notes/:owner/:repo/all が使用）。
  // sha は Contents API のファイル sha と同じ値（GitHub 実挙動の模倣）のため、
  // NOTES を sha で逆引きして本文を返す。一括コミット（M5）で作られた blob は
  // BLOBS（sha → base64）に積まれるため、そちらも引く
  const blobMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/blobs\/([^/]+)$/);
  if (req.method === 'GET' && blobMatch) {
    if (!requireToken(req, res)) {
      return;
    }
    const sha = decodeURIComponent(blobMatch[3] ?? '');
    const note = Object.values(NOTES).find((candidate) => candidate.sha === sha);
    if (note) {
      sendJson(res, 200, {
        sha,
        encoding: 'base64',
        content: Buffer.from(note.content, 'utf8').toString('base64'),
      });
      return;
    }
    const blob = BLOBS.get(sha);
    if (blob !== undefined) {
      sendJson(res, 200, { sha, encoding: 'base64', content: blob });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // ---- M5: 一括コミット（Git Trees/Blobs API）のモック ----
  // フロー: ref（先頭コミット）→ trees（base tree）→ blobs → trees（差分適用）→
  // commits → refs（PATCH）。コミットのたびに NOTES / TREES へ変更を反映し、
  // その後の /api/tree と /api/notes が新しい状態を返すようにする

  // Blob 作成: body { content: base64, encoding } → sha。本文は BLOBS に保持する
  const blobPostMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/blobs$/);
  if (req.method === 'POST' && blobPostMatch) {
    if (!requireToken(req, res)) {
      return;
    }
    const raw = await readBody(req);
    const body = JSON.parse(raw || '{}');
    if (typeof body.content !== 'string') {
      sendJson(res, 400, { message: 'content must be a base64 string' });
      return;
    }
    const sha = `mock-blob-${++MOCK_SHA_COUNTER}`;
    BLOBS.set(sha, body.content);
    sendJson(res, 200, { sha });
    return;
  }

  // ブランチ先頭コミットの取得（一括コミットの parents 解決用）。
  // コミット 0 件のリポジトリ（TREES 未定義）は GitHub 同様 404 を返す
  const refMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/([^/]+)$/);
  if (req.method === 'GET' && refMatch) {
    if (!requireToken(req, res)) {
      return;
    }
    const branch = decodeURIComponent(refMatch[3] ?? '');
    const key = `${refMatch[1]}/${refMatch[2]}:${branch}`;
    if (TREES[key] === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const sha = HEAD_COMMITS.get(key) ?? `mock-commit-${key}`;
    HEAD_COMMITS.set(key, sha);
    sendJson(res, 200, {
      ref: `refs/heads/${branch}`,
      object: { sha, type: 'commit', url: 'http://mock.invalid/commit' },
    });
    return;
  }

  // 新 tree 作成: 差分エントリ（sha: null は削除）を NOTES / TREES へ反映する
  const treePostMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/trees$/);
  if (req.method === 'POST' && treePostMatch) {
    if (!requireToken(req, res)) {
      return;
    }
    const raw = await readBody(req);
    const body = JSON.parse(raw || '{}');
    if (!Array.isArray(body.tree)) {
      sendJson(res, 400, { message: 'tree must be an array' });
      return;
    }
    const owner = treePostMatch[1];
    const repo = treePostMatch[2];
    const treeKey = `${owner}/${repo}:main`;
    // 空リポジトリの初回コミット（TREES 未定義）ではエントリ配列を初期化する
    // （以降の trees / ref 取得が 404 にならないようにする）
    if (TREES[treeKey] === undefined) {
      TREES[treeKey] = [];
    }
    // 1) 追加エントリ（sha あり）を先に適用する。BLOBS にあれば新規本文、
    //    なければ同じ sha の既存 NOTES から引き継ぐ（move の内容保持）
    for (const entry of body.tree) {
      if (entry.sha === null || typeof entry.path !== 'string') {
        continue;
      }
      const noteKey = `${owner}/${repo}:${entry.path}`;
      const blob = BLOBS.get(entry.sha);
      if (blob !== undefined) {
        // バイナリ（画像）の round-trip 用に元の base64 と Content-Type も保持する。
        // raw 配信（Accept: application/vnd.github.raw）は rawContent をそのまま返す
        NOTES[noteKey] = {
          sha: entry.sha,
          content: Buffer.from(blob, 'base64').toString('utf8'),
          rawContent: blob,
          contentType: contentTypeForPath(entry.path),
        };
      } else {
        const existing = Object.entries(NOTES).find(([, note]) => note.sha === entry.sha);
        if (existing) {
          NOTES[noteKey] = { ...existing[1], sha: entry.sha };
        }
      }
      const tree = TREES[treeKey];
      if (tree) {
        const index = tree.findIndex((item) => item.path === entry.path);
        if (index !== -1) {
          tree[index] = { path: entry.path, type: 'blob', sha: entry.sha };
        } else {
          tree.push({ path: entry.path, type: 'blob', sha: entry.sha });
        }
      }
    }
    // 2) 削除エントリ（sha: null）を適用する（move の元パス除去は追加の後に）
    for (const entry of body.tree) {
      if (entry.sha !== null || typeof entry.path !== 'string') {
        continue;
      }
      delete NOTES[`${owner}/${repo}:${entry.path}`];
      const tree = TREES[treeKey];
      if (tree) {
        const index = tree.findIndex((item) => item.path === entry.path);
        if (index !== -1) {
          tree.splice(index, 1);
        }
      }
    }
    sendJson(res, 200, {
      sha: `mock-tree-${++MOCK_SHA_COUNTER}`,
      truncated: false,
      tree: body.tree,
    });
    return;
  }

  // コミット作成: body { message, tree, parents } → sha
  const commitPostMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/commits$/);
  if (req.method === 'POST' && commitPostMatch) {
    if (!requireToken(req, res)) {
      return;
    }
    const raw = await readBody(req);
    const body = JSON.parse(raw || '{}');
    if (typeof body.message !== 'string' || typeof body.tree !== 'string') {
      sendJson(res, 400, { message: 'message and tree are required' });
      return;
    }
    const sha = `mock-commit-${++MOCK_SHA_COUNTER}`;
    COMMITS.set(sha, { message: body.message, tree: body.tree, parents: body.parents ?? [] });
    sendJson(res, 200, { sha, commit: { message: body.message, tree: body.tree } });
    return;
  }

  // ブランチ参照の更新（一括コミットの最後。force は無視して成功させる）。
  // ref 未作成（コミット 0 件）のリポジトリは GitHub 同様 404 を返し、
  // クライアント（commit.ts）が POST /git/refs で新規作成する
  const refsPatchMatch = url.pathname.match(
    /^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/([^/]+)$/,
  );
  if (req.method === 'PATCH' && refsPatchMatch) {
    if (!requireToken(req, res)) {
      return;
    }
    const branch = decodeURIComponent(refsPatchMatch[3] ?? '');
    const key = `${refsPatchMatch[1]}/${refsPatchMatch[2]}:${branch}`;
    if (!HEAD_COMMITS.has(key)) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const raw = await readBody(req);
    const body = JSON.parse(raw || '{}');
    if (typeof body.sha !== 'string') {
      sendJson(res, 400, { message: 'sha is required' });
      return;
    }
    HEAD_COMMITS.set(key, body.sha);
    sendJson(res, 200, {
      ref: `refs/heads/${branch}`,
      object: { sha: body.sha, type: 'commit' },
    });
    return;
  }

  // ブランチ参照の新規作成（空リポジトリの初回コミットで使用）。
  // body: { ref: 'refs/heads/main', sha }
  const refsPostMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs$/);
  if (req.method === 'POST' && refsPostMatch) {
    if (!requireToken(req, res)) {
      return;
    }
    const raw = await readBody(req);
    const body = JSON.parse(raw || '{}');
    if (typeof body.ref !== 'string' || typeof body.sha !== 'string') {
      sendJson(res, 400, { message: 'ref and sha are required' });
      return;
    }
    const branch = body.ref.replace(/^refs\/heads\//, '');
    const key = `${refsPostMatch[1]}/${refsPostMatch[2]}:${branch}`;
    if (HEAD_COMMITS.has(key)) {
      sendJson(res, 422, { message: 'Reference already exists' });
      return;
    }
    HEAD_COMMITS.set(key, body.sha);
    sendJson(res, 201, {
      ref: body.ref,
      object: { sha: body.sha, type: 'commit' },
    });
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
    // raw 配信（Accept: application/vnd.github.raw）はバイナリ本文を返す（画像 Embed 用）
    if ((req.headers.accept ?? '').includes('application/vnd.github.raw')) {
      const raw = note.rawContent
        ? Buffer.from(note.rawContent, 'base64')
        : Buffer.from(note.content, 'utf8');
      res.writeHead(200, { 'Content-Type': note.contentType ?? 'application/octet-stream' });
      res.end(raw);
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
    // 空文字（空ファイル保存）も許容する（Buffer.from('', 'base64') は空バッファになる）
    if (typeof body.content !== 'string') {
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
    // GitHub Contents API の PUT 応答形式（content オブジェクトを返す）に合わせる
    sendJson(res, 200, {
      content: {
        type: 'file',
        encoding: 'base64',
        content: body.content,
        sha,
      },
    });
    return;
  }

  sendJson(res, 404, { message: `no mock for ${req.method} ${url.pathname}` });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-github] ready on http://127.0.0.1:${PORT}`);
});
