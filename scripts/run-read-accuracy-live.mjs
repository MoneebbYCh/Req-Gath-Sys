#!/usr/bin/env node
/** Runs Charter live eval via vitest and writes JSON report + OpenCode comparison template. */
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const useRepo = process.env.CHARTER_EVAL_USE_REPO === '1'
let evalRoot = process.env.CHARTER_EVAL_ROOT?.trim()

if (!useRepo && !evalRoot) {
  const prep = spawnSync('node', ['scripts/prepare-eval-sandbox.mjs'], {
    cwd: root,
    stdio: 'inherit',
  })
  if (prep.status !== 0) process.exit(prep.status ?? 1)
  evalRoot = join(root, '.charter-ai', 'eval-sandbox')
  console.log(`Using Charter-only eval sandbox (set CHARTER_EVAL_USE_REPO=1 to scan full repo including opencode/)`)
}

const result = spawnSync('npm', ['run', 'eval:read-accuracy:live'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    CHARTER_LIVE_EVAL: '1',
    ...(evalRoot ? { CHARTER_EVAL_ROOT: evalRoot } : {}),
  },
})

process.exit(result.status ?? 1)
