import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/ui/App';
import '@/ui/styles/global.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('ルート要素 #root が見つかりません');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
