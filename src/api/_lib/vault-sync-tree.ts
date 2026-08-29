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

/** ツリー応答を GithubTreeResponse 形へ正規化する（形式不正は null） */
export function parseTreeBody(body: unknown): GithubTreeResponse | null {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;
  if (!isRecord(body) || !('tree' in body)) {
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
    if (!isRecord(rawItem)) {
      continue;
    }
    const path = typeof rawItem.path === 'string' ? rawItem.path : undefined;
    const type = typeof rawItem.type === 'string' ? rawItem.type : undefined;
    const itemSha = typeof rawItem.sha === 'string' ? rawItem.sha : undefined;
    tree.push({ path, type, sha: itemSha });
  }
  return { sha, truncated, tree };
}
