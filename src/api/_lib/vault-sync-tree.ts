export type GithubTreeEntry = {
  path: string | undefined;
  type: string | undefined;
  sha: string | undefined;
};

export type GithubTreeResponse = {
  sha?: unknown;
  truncated?: unknown;
  tree?: GithubTreeEntry[];
};

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** オブジェクトから文字列プロパティを読む（存在しない・型不一致は undefined） */
function readStringProp(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

/** ツリー応答を GithubTreeResponse 形へ正規化する（形式不正は null） */
export function parseTreeBody(body: unknown): GithubTreeResponse | null {
  if (typeof body !== 'object' || body === null || !('tree' in body)) {
    return null;
  }
  const rawTree = body.tree;
  if (!Array.isArray(rawTree)) {
    return null;
  }
  const sha = 'sha' in body && typeof body.sha === 'string' ? body.sha : null;
  const truncated = 'truncated' in body && body.truncated === true;
  const tree: GithubTreeEntry[] = [];
  for (const rawItem of rawTree) {
    if (!isRecordObject(rawItem)) {
      continue;
    }
    tree.push({
      path: readStringProp(rawItem, 'path'),
      type: readStringProp(rawItem, 'type'),
      sha: readStringProp(rawItem, 'sha'),
    });
  }
  return { sha, truncated, tree };
}
