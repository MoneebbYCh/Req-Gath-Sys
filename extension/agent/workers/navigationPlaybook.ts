/**
 * Shared navigation strategy embedded in every repository-facing system prompt
 * (RepositoryExplorerWorker, AnalysisWorker). Applies prompt-engineering best
 * practices: worked few-shot traces beat abstract rules ("show, don't tell"),
 * recovery branches are stated explicitly instead of left to guessing, and the
 * stop condition prevents budget burn on redundant calls.
 *
 * Tool names referenced here MUST exist in ToolDefinition's catalogue —
 * navigationPlaybook.test.ts enforces this so the prompt can't drift.
 */
export const NAVIGATION_PLAYBOOK = [
  'Navigation strategy (progressive narrowing — structure, then narrow, then read):',
  '1. Orient first: get_project_structure gives top-level packages with file counts. Pick the 1–2 most relevant.',
  '2. Narrow with scoped search before reading: search_code with a tight regex AND a path scope beats reading files blind.',
  '3. Read bounded ranges around search hits: read_file_range with ±30 lines around the hit line. Use read_file only for small files.',
  '4. Follow symbols, not guesses: find_symbol / find_definition / find_references / get_imports to trace usage across files.',
  '',
  'Worked example — objective "Where are API requests authenticated?":',
  '  get_project_structure {}',
  '    → src/server (120 files, ts), src/web (90 files, ts)',
  '  search_code {"pattern":"auth|verifyToken","path":"src/server"}',
  '    → src/server/middleware/auth.ts:41 [EVIDENCE:e-3]',
  '  read_file_range {"path":"src/server/middleware/auth.ts","startLine":25,"endLine":70}',
  '    → [EVIDENCE:e-7] token verification logic found',
  '  find_references {"path":"src/server/middleware/auth.ts","line":41}',
  '    → applied in src/server/routes/*.ts — question answered with citations.',
  '',
  'Recovery rules:',
  '- search_code returns truncated/refineHint: tighten the regex or scope to a directory before paging with offset=nextCursor.',
  '- read_file returns tooLarge or binary: switch to read_file_range.',
  '- An LSP tool returning available:false (no language server): fall back to search_code with the symbol name.',
  '- If a named tool was not provided to you, substitute the closest available tool.',
  '',
  'Stop condition: stop calling tools once every question has a cited answer or is proven unanswerable —',
  'record remaining gaps under "unknowns" instead of spending more calls. Never re-read what',
  '"Prior analysis results" already covers.',
].join('\n')
