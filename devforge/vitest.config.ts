import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: [
      'electron/**/*.test.cjs',
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
    ],
  },
})
