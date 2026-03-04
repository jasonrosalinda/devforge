import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
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