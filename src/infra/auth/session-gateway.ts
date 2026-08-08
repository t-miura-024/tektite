/**
 * SessionGateway のブラウザ実装: Pages Functions の認証エンドポイントを呼ぶ。
 *
 * - GET  /api/auth/me     … セッション検証（暗号化 Cookie の復号 + GitHub /user 確認）
 * - POST /api/auth/logout … セッション Cookie の削除
 *
 * トークンは Workers 側のみ保持（ADR-0002）のため、ブラウザは Cookie の存在を
 * 直接読むことなく、これらのエンドポイントの応答だけでログイン状態を判定する。
 */

import type { Session, SessionGateway } from '@/application/session';
import { SessionFetchError } from '@/application/session';

interface MeResponseBody {
  authenticated?: boolean;
  login?: string;
}

export class HttpSessionGateway implements SessionGateway {
  async getCurrentSession(): Promise<Session> {
    let response: Response;
    try {
      response = await fetch('/api/auth/me');
    } catch (error) {
      throw new SessionFetchError('セッション状態を確認できませんでした。', { cause: error });
    }
    if (response.status === 401) {
      return { status: 'anonymous' };
    }
    if (!response.ok) {
      throw new SessionFetchError(`セッション確認に失敗しました（HTTP ${response.status}）。`);
    }
    const body = (await response.json()) as MeResponseBody;
    if (body.authenticated === true && typeof body.login === 'string' && body.login.length > 0) {
      return { status: 'authenticated', user: { login: body.login } };
    }
    return { status: 'anonymous' };
  }

  async logout(): Promise<void> {
    let response: Response;
    try {
      response = await fetch('/api/auth/logout', { method: 'POST' });
    } catch (error) {
      throw new SessionFetchError('ログアウトできませんでした。', { cause: error });
    }
    if (!response.ok) {
      throw new SessionFetchError(`ログアウトに失敗しました（HTTP ${response.status}）。`);
    }
  }
}
