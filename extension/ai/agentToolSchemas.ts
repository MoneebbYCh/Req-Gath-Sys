/** OpenAI-compatible tool schemas for native tool calling in the agent loop. */

export interface AgentToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export const AGENT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description:
        'List a directory tree with file counts to orient in the workspace. Start with path "." before searching when the folder layout is unknown. Flags relevant folders (src, extension, api, etc.). Prefer this before broad grep.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory path (default ".")' },
          depth: { type: 'number', description: '1 or 2 (default 2)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description:
        'Find files by glob pattern within the workspace. Returns concise relative paths. Use path to narrow and max_results to bound results. Does not search file contents — use grep for that. Prefer presets (config, entry points, tests) for common intents. Reports how many hits .gitignore hid.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern e.g. src/**/*.ts' },
          preset: {
            type: 'string',
            enum: ['config', 'entry points', 'tests'],
            description: 'Common preset instead of pattern',
          },
          path: { type: 'string', description: 'Relative directory to search (default ".")' },
          max_results: { type: 'number', description: 'Maximum files to return (default 50)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Search file contents by regex. Use path to narrow, include for file globs (e.g. "*.ts"), and patterns:[...] for synonyms in one call. Case-insensitive by default. Returns path:line previews — confirm with read_file before stating facts. Cap per pattern; when hit, narrow by directory or include. For category coverage, second-pass SDK/import anchors via patterns.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Single regex pattern' },
          patterns: {
            type: 'array',
            items: { type: 'string' },
            description: 'Multiple patterns searched in one call',
          },
          path: { type: 'string', description: 'Relative directory or file to search (default ".")' },
          include: {
            type: 'string',
            description: 'File glob filter, e.g. "*.ts" or "*.{ts,tsx}"',
          },
          case_sensitive: { type: 'boolean', description: 'Default false (case-insensitive)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a UTF-8 text file with line numbers. Page with offset/limit (1-based). Follow truncation hints; if output was saved to .charter-ai/tool-output/, read that path next. For API/route inventories, call many read_file tools in one turn (one per mounted route module). Cite path:line from files you actually opened.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          offset: { type: 'number', description: '1-based starting line (default 1)' },
          limit: { type: 'number', description: 'Max lines to read (default 2000)' },
          line_start: { type: 'number', description: 'Legacy alias for offset' },
          line_end: { type: 'number', description: 'Legacy end line' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'validate_mermaid',
      description:
        'Validate Mermaid diagram syntax before including in a document. Draft Mermaid yourself from codebase/chat first — do not use a fixed template. On success returns a diagram block JSON for "document".',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Mermaid source' },
          title: { type: 'string', description: 'Diagram title' },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_pipeline',
      description:
        'List custom document slots on the Home pipeline (id, name). Call before claiming what exists, or before remove/replace.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_pipeline',
      description:
        'Create or replace document slots on the Home pipeline. mode "append" (default) adds; "replace" rebuilds the list. Prefer 1–8 focused docs. Do not put full canvas bodies here — create the slot, then finish with document+targetDoc to draft.',
      parameters: {
        type: 'object',
        properties: {
          documents: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                icon: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['name'],
            },
          },
          mode: { type: 'string', enum: ['append', 'replace'] },
        },
        required: ['documents'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_pipeline_docs',
      description:
        'Remove pipeline documents by id, name, or all:true. Call list_pipeline first if unsure.',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          names: { type: 'array', items: { type: 'string' } },
          all: { type: 'boolean' },
        },
      },
    },
  },
]

export const READ_TOOL_NAMES = new Set(['list_dir', 'glob', 'grep', 'read_file'])
