/** Metadata for BlockNote canvas phases (Charter, PRD, System Design, …). */

export type CanvasPhaseId =
  | 'project-charter'
  | 'prd'
  | 'system-design'
  | 'dev'
  | 'qa'
  | 'post-dev'

export interface CanvasPhaseMeta {
  id: CanvasPhaseId
  number: number
  title: string
  kicker: string
  subtitle: string
  /** localStorage key in the webview */
  storageKey: string
  /** Pre-rebrand localStorage key (read fallback). */
  legacyStorageKey?: string
  /** Filename under .charter-ai/ */
  fileName: string
  /** Next phase to navigate to, if any */
  next?: { page: CanvasPhaseId; label: string }
}

export const CANVAS_PHASES: Record<CanvasPhaseId, CanvasPhaseMeta> = {
  'project-charter': {
    id: 'project-charter',
    number: 1,
    title: 'Project Charter',
    kicker: 'Phase 01 · Authorization boundary',
    subtitle:
      'Soft agreement that authorizes the work: business case first, measurable objectives, explicit exclusions, named authority — short enough to actually read.',
    storageKey: 'charter-ai-charter-doc-v1',
    legacyStorageKey: 'ascen-charter-doc-v1',
    fileName: 'charter.json',
    next: { page: 'prd', label: 'Proceed to PRD →' },
  },
  prd: {
    id: 'prd',
    number: 2,
    title: 'Product Requirements',
    kicker: 'Phase 02 · Requirements boundary',
    subtitle:
      'Turn the charter into concrete product requirements: users, stories, acceptance criteria, NFRs — traceable back to business case and objectives.',
    storageKey: 'charter-ai-prd-doc-v1',
    legacyStorageKey: 'ascen-prd-doc-v1',
    fileName: 'prd.json',
    next: { page: 'system-design', label: 'Proceed to System Design →' },
  },
  'system-design': {
    id: 'system-design',
    number: 3,
    title: 'System Design',
    kicker: 'Phase 03 · Technical blueprint',
    subtitle:
      'Architecture, data, APIs, and deployment decisions that satisfy the PRD — keep it decision-dense, not a novel.',
    storageKey: 'charter-ai-system-design-doc-v1',
    legacyStorageKey: 'ascen-system-design-doc-v1',
    fileName: 'system-design.json',
    next: { page: 'dev', label: 'Proceed to Development →' },
  },
  dev: {
    id: 'dev',
    number: 4,
    title: 'Development',
    kicker: 'Phase 04 · Build notes',
    subtitle:
      'Implementation plan, spikes, integration notes, and demo checklist against the design and PRD.',
    storageKey: 'charter-ai-dev-doc-v1',
    legacyStorageKey: 'ascen-dev-doc-v1',
    fileName: 'dev.json',
    next: { page: 'qa', label: 'Proceed to QA →' },
  },
  qa: {
    id: 'qa',
    number: 5,
    title: 'QA',
    kicker: 'Phase 05 · Verification',
    subtitle:
      'Test plan, acceptance evidence, model eval notes, and sign-off against charter objectives and PRD criteria.',
    storageKey: 'charter-ai-qa-doc-v1',
    legacyStorageKey: 'ascen-qa-doc-v1',
    fileName: 'qa.json',
    next: { page: 'post-dev', label: 'Proceed to Post Dev →' },
  },
  'post-dev': {
    id: 'post-dev',
    number: 6,
    title: 'Post Dev',
    kicker: 'Phase 06 · Deploy & handover',
    subtitle:
      'Release plan, monitoring, runbooks, and stakeholder handover — close the loop on the original business case.',
    storageKey: 'charter-ai-post-dev-doc-v1',
    legacyStorageKey: 'ascen-post-dev-doc-v1',
    fileName: 'post-dev.json',
  },
}

export const CANVAS_PHASE_IDS = Object.keys(CANVAS_PHASES) as CanvasPhaseId[]

export function isCanvasPhaseId(value: string): value is CanvasPhaseId {
  return value in CANVAS_PHASES
}

export function getCanvasPhase(id: string): CanvasPhaseMeta | undefined {
  return isCanvasPhaseId(id) ? CANVAS_PHASES[id] : undefined
}
