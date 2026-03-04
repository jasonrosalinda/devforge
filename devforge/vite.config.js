import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { VitePWA } from 'vite-plugin-pwa'

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  base: '/devforge/',
  plugins: [react(), VitePWA({
    registerType: 'autoUpdate',
    manifest: {
      name: 'devForge',
      short_name: 'devForge',
      start_url: '.',
      display: 'standalone',
      background_color: '#000000',
      theme_color: '#000000',
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }
      ]
    },
  })],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },
  server: {
    port: 5173,
  },
})
