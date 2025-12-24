import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import Popup from './Popup.tsx'

const isPopup = window.location.hash.startsWith('#/popup')
if (isPopup) {
  document.documentElement.classList.add('popup')
  document.body.classList.add('popup')
}

// #region agent log
function agentLog(message: string, data: Record<string, unknown>) {
  fetch('http://127.0.0.1:7242/ingest/71db1e77-df5f-480c-9275-0e41f17d2b1f', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'debug-session',
      runId: 'popup-style',
      hypothesisId: 'S1',
      location: 'desktop/src/main.tsx',
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {})
}
// #endregion

if (isPopup) {
  // #region agent log
  agentLog('popup boot', {
    href: window.location.href,
    hash: window.location.hash,
    htmlClass: document.documentElement.className,
    bodyClass: document.body.className,
  })
  // #endregion
}

createRoot(document.getElementById('root')!).render(isPopup ? <Popup /> : <App />)
