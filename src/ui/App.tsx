/**
 * アプリのシェル（M1 骨格）。
 * ログイン画面・Vault 選択・ファイルツリーは後続ミッション（M2/M3）で実装する。
 */
export function App() {
  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>tektite</h1>
      </header>
      <p className="app-placeholder">GitHub を Vault として使うマークダウンエディタ（構築中）</p>
    </main>
  );
}
