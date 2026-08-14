// CJS config: eslint-plugin-react-hooks and @typescript-eslint/eslint-plugin
// deadlock when loaded via ESM dynamic import on Node 24. `require()` works.
const js = require('@eslint/js')
const globals = require('globals')
const reactHooks = require('eslint-plugin-react-hooks')
const reactRefresh = require('eslint-plugin-react-refresh')
const tseslint = require('typescript-eslint')
const { defineConfig, globalIgnores } = require('eslint/config')

module.exports = defineConfig([
  globalIgnores(['dist', 'out']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.default.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
])
