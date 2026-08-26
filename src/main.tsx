import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Enable Material Symbols after first paint without inline onload (blocked by CSP).
document.querySelectorAll('link[data-icons-font]').forEach((el) => {
  el.setAttribute('media', 'all')
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
