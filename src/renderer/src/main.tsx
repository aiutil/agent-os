import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles/tokens.css'
import './styles/global.css'
import { App } from './App'
import { ErrorBoundary } from './lib/ui/ErrorBoundary'
import { initializeAnalytics } from './analytics/mixpanel'

void initializeAnalytics()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
