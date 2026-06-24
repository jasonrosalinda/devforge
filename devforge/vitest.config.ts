import { defineConfig } from 'vitest/config'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // Match the app's path aliases so tests can import via @ / @shared.
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './shared'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: [
      'electron/**/*.test.mjs',
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
    ],
  },
})
