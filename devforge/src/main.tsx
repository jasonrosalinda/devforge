import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted Inter — bundled rather than fetched from the Google Fonts CDN so
// the packaged Electron app renders correctly with no network.
import '@fontsource-variable/inter'
import './index.css'
import App from './app'
import { HashRouter } from 'react-router-dom'
import { registerSW } from 'virtual:pwa-register'

registerSW({
    onNeedRefresh() {
        window.location.reload()
    },
    onOfflineReady() {
        console.log('App ready to work offline')
    }
})

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <HashRouter>
            <App />
        </HashRouter>
    </StrictMode>,
)