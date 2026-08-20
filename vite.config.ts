import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

const stub = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    environmentMatchGlobs: [
      // Live LLM eval must run in Node — jsdom triggers OpenAI's browser credential guard.
      ['extension/ai/readAccuracy.live.test.ts', 'node'],
    ],
    // globals enable @testing-library/react's auto-cleanup between tests
    globals: true,
    include: ['src/**/*.test.{ts,tsx}', 'extension/**/*.test.{ts,tsx}'],
  },
  // Test-only aliases: mermaid and @blocknote/* cannot be imported in Node (they
  // hang native ESM resolution), so tests resolve them to stubs. Build output
  // is untouched — VITEST is only set by the vitest runner.
  ...(process.env.VITEST
    ? {
        resolve: {
          alias: [
            { find: '@blocknote/core/fonts/inter.css', replacement: stub('./src/test/stubs/empty.css') },
            { find: '@blocknote/mantine/style.css', replacement: stub('./src/test/stubs/empty.css') },
            { find: '@blocknote/react', replacement: stub('./src/test/stubs/browserPackages.ts') },
            { find: '@blocknote/mantine', replacement: stub('./src/test/stubs/browserPackages.ts') },
            { find: '@blocknote/core', replacement: stub('./src/test/stubs/browserPackages.ts') },
            { find: 'mermaid', replacement: stub('./src/test/stubs/browserPackages.ts') },
            { find: 'vscode', replacement: stub('./src/test/stubs/vscode.ts') },
          ],
        },
      }
    : {}),
  build: {
    outDir: 'dist',
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/index.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
