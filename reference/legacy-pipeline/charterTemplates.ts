import type { BlockNoteBlock } from '../types/document'

/** A selectable starting point for a canvas document. */
export interface CharterTemplate {
  id: string
  name: string
  /** Short origin label shown as a badge, e.g. "PMI · PMBOK". */
  category: string
  /** One-line pitch shown in the card. */
  tagline: string
  /** Longer blurb shown in the preview pane. */
  description: string
  /** Whether this is the empty "start from scratch" option. */
  custom?: boolean
  /** Produces the block set applied to the canvas. */
  build: () => BlockNoteBlock[]
}

// --- Block builder helpers (kept terse; the sanitizer normalizes props on apply) ---

const heading = (text: string, level = 2): BlockNoteBlock => ({
  type: 'heading',
  props: { level },
  content: [{ type: 'text', text }],
})

const para = (text = ''): BlockNoteBlock => ({
  type: 'paragraph',
  content: text ? [{ type: 'text', text }] : [],
})

const bullet = (text: string): BlockNoteBlock => ({
  type: 'bulletListItem',
  content: [{ type: 'text', text }],
})

type CalloutVariant = 'info' | 'warn' | 'success' | 'error'
const callout = (title: string, body: string, variant: CalloutVariant = 'info'): BlockNoteBlock => ({
  type: 'callout',
  props: { variant, title },
  content: body,
})

const kpiGrid = (
  items: Array<{ metric: string; target: string; method: string }>,
): BlockNoteBlock => ({ type: 'kpiGrid', props: { items } })

const scopeBounds = (inScope: string[], outOfScope: string[]): BlockNoteBlock => ({
  type: 'scopeBounds',
  props: { inScope, outOfScope },
})

const stakeholderTable = (
  rows: Array<{ nameRole: string; interest: string; influence: string; concern: string }>,
): BlockNoteBlock => ({ type: 'stakeholderTable', props: { rows } })

const riskList = (
  rows: Array<{ risk: string; likelihood: string; impact: string; mitigation: string }>,
): BlockNoteBlock => ({ type: 'riskList', props: { rows } })

// --- Templates ---

const PMBOK_CLASSIC: CharterTemplate = {
  id: 'pmbok-classic',
  name: 'Classic Project Charter',
  category: 'PMI · PMBOK',
  tagline: 'The comprehensive, sponsor-ready charter used on traditional projects.',
  description:
    'A full PMBOK-style charter covering purpose, business case, measurable objectives, scope boundaries, milestones, stakeholders, risks, budget and formal authority. Best when you need a thorough authorization document a steering committee can sign off on.',
  build: () => [
    heading('Project Charter: [Project Name]', 1),
    para('This charter formally authorizes the project and appoints the project manager. It is the baseline for scope, schedule, and budget decisions.'),

    heading('Project Purpose & Business Case'),
    callout(
      'Business Case',
      'Describe the business problem or opportunity, the cost of inaction, and the expected return. Quantify wherever possible (revenue, cost savings, risk reduction, ROI / payback period).',
      'success',
    ),

    heading('Measurable Objectives & Success Criteria'),
    kpiGrid([
      { metric: 'Primary objective', target: 'Measurable, time-bound target', method: 'How it will be verified' },
      { metric: 'Secondary objective', target: 'Measurable target', method: 'How it will be verified' },
    ]),

    heading('Scope'),
    scopeBounds(
      ['Key deliverable or capability that is in scope', 'Another in-scope item'],
      ['Explicit exclusion — what this project will NOT do', 'Deferred to a later phase'],
    ),

    heading('High-Level Requirements'),
    bullet('Key requirement the solution must satisfy'),
    bullet('Compliance / regulatory requirement, if any'),
    bullet('Performance or capacity requirement'),

    heading('Milestones & Schedule'),
    bullet('Charter approved — [date]'),
    bullet('Requirements & design complete — [date]'),
    bullet('Build / implementation complete — [date]'),
    bullet('Launch / go-live — [date]'),

    heading('Budget Summary'),
    para('Total authorized budget: $[amount] (including [x]% contingency). Funding source: [source].'),

    heading('Stakeholders'),
    stakeholderTable([
      { nameRole: '[Name] / Sponsor', interest: 'H', influence: 'H', concern: 'Primary concern' },
      { nameRole: '[Name] / Project Manager', interest: 'H', influence: 'H', concern: 'Delivery on time and budget' },
      { nameRole: '[Name] / Key stakeholder', interest: 'M', influence: 'M', concern: 'Primary concern' },
    ]),

    heading('Assumptions & Constraints'),
    callout('Constraint', 'Hard limit on timeline, budget, resources, or technology that the project must respect.', 'warn'),

    heading('High-Level Risks'),
    riskList([
      { risk: 'Describe the risk', likelihood: 'M', impact: 'H', mitigation: 'Planned mitigation / response' },
    ]),

    heading('Project Manager Authority'),
    callout(
      'PM Authority',
      'The Project Manager may make day-to-day decisions within the approved scope, budget, and timeline. Changes to these baselines require sponsor / steering committee approval.',
      'info',
    ),

    heading('Approval & Sign-Off'),
    callout('Sign-Off', 'Approved by:\n\nName: [Sponsor name]\nTitle: [Title]\nDate: [Date]\nSignature: __________________', 'success'),
  ],
}

const LEAN_ONE_PAGER: CharterTemplate = {
  id: 'lean-one-pager',
  name: 'Lean One-Page Charter',
  category: 'Lean · Startup',
  tagline: 'A tight one-pager to align the team fast without ceremony.',
  description:
    'A lightweight charter for fast-moving teams: problem, objective, scope guardrails, the people involved, and the top risks — nothing more. Ideal for small projects, internal tools, and experiments where a heavy document would slow you down.',
  build: () => [
    heading('[Project Name] — Project Charter', 1),
    para('One page. Enough to get everyone pointed the same direction.'),

    heading('Problem / Opportunity'),
    callout('Why now', 'In one or two sentences: what problem are we solving and why does it matter today?', 'info'),

    heading('Objective'),
    kpiGrid([
      { metric: 'The one metric that matters', target: 'Target by [date]', method: 'How we measure it' },
    ]),

    heading('Scope Guardrails'),
    scopeBounds(['What we will build'], ['What we are explicitly NOT doing']),

    heading('Team & Owner'),
    bullet('Owner / DRI: [Name]'),
    bullet('Contributors: [Names]'),
    bullet('Sponsor: [Name]'),

    heading('Top Risks'),
    riskList([
      { risk: 'Biggest thing that could derail this', likelihood: 'M', impact: 'H', mitigation: 'How we de-risk it' },
    ]),
  ],
}

const AGILE_CHARTER: CharterTemplate = {
  id: 'agile-charter',
  name: 'Agile Project Charter',
  category: 'Agile · Scrum',
  tagline: 'Vision-led charter built around outcomes and an empowered team.',
  description:
    'An outcome-oriented charter for Agile delivery: a product vision statement, success metrics, in/out scope for the initial increments, the team and working agreements, a milestone roadmap, and key risks. Emphasizes value and adaptability over fixed scope.',
  build: () => [
    heading('[Product / Initiative] — Agile Charter', 1),

    heading('Vision'),
    callout(
      'Product Vision',
      'FOR [target customer] WHO [need], the [product] IS A [category] THAT [key benefit]. UNLIKE [alternative], our product [key differentiator].',
      'info',
    ),

    heading('Success Metrics'),
    kpiGrid([
      { metric: 'Outcome metric (not output)', target: 'Target', method: 'Instrumentation / analytics' },
      { metric: 'Adoption / satisfaction metric', target: 'Target', method: 'How measured' },
    ]),

    heading('Scope of Initial Increments'),
    scopeBounds(
      ['Capability targeted for the first releases', 'Another in-scope capability'],
      ['Out of scope for now — candidate for later', 'Explicitly excluded'],
    ),

    heading('Team & Working Agreements'),
    stakeholderTable([
      { nameRole: '[Name] / Product Owner', interest: 'H', influence: 'H', concern: 'Backlog value & priorities' },
      { nameRole: '[Name] / Scrum Master', interest: 'H', influence: 'M', concern: 'Flow & impediments' },
      { nameRole: '[Name] / Development Team', interest: 'H', influence: 'M', concern: 'Sustainable delivery' },
    ]),
    bullet('Cadence: [e.g. 2-week sprints], ceremonies: planning, review, retro'),
    bullet('Definition of Done: [link or summary]'),

    heading('Milestone Roadmap'),
    bullet('MVP / first release — [target]'),
    bullet('Increment 2 — [target]'),
    bullet('General availability — [target]'),

    heading('Risks & Dependencies'),
    riskList([
      { risk: 'Key risk or external dependency', likelihood: 'M', impact: 'H', mitigation: 'Response / owner' },
    ]),
  ],
}

const SIX_SIGMA_CHARTER: CharterTemplate = {
  id: 'six-sigma-dmaic',
  name: 'Six Sigma (DMAIC) Charter',
  category: 'Six Sigma · DMAIC',
  tagline: 'Process-improvement charter framed around problem and goal statements.',
  description:
    'A DMAIC-style charter for process-improvement projects: business case, a crisp problem statement, a measurable goal statement, process scope (SIPOC boundaries), the improvement team, a phased timeline, and risks. Best for quality, operations, and efficiency initiatives.',
  build: () => [
    heading('[Process] Improvement — Project Charter', 1),

    heading('Business Case'),
    callout('Business Case', 'Why this process matters to the business, the cost of the current performance gap, and the expected financial impact of closing it.', 'success'),

    heading('Problem Statement'),
    callout(
      'Problem',
      'Between [start] and [end], [process / metric] has [performed at X] against a target of [Y], resulting in [impact: cost, defects, delay]. The root cause is not yet known.',
      'warn',
    ),

    heading('Goal Statement'),
    kpiGrid([
      { metric: 'Primary process metric (Y)', target: 'From [baseline] to [target] by [date]', method: 'Measurement system / data source' },
    ]),

    heading('Process Scope (SIPOC boundaries)'),
    scopeBounds(
      ['Process start (first step in scope)', 'Process end (last step in scope)'],
      ['Upstream steps out of scope', 'Downstream steps out of scope'],
    ),

    heading('Team'),
    stakeholderTable([
      { nameRole: '[Name] / Champion (Sponsor)', interest: 'H', influence: 'H', concern: 'Resources & barrier removal' },
      { nameRole: '[Name] / Black/Green Belt (Lead)', interest: 'H', influence: 'M', concern: 'Analysis & delivery' },
      { nameRole: '[Name] / Process Owner', interest: 'H', influence: 'H', concern: 'Sustaining the improvement' },
    ]),

    heading('DMAIC Timeline'),
    bullet('Define — [dates]'),
    bullet('Measure — [dates]'),
    bullet('Analyze — [dates]'),
    bullet('Improve — [dates]'),
    bullet('Control — [dates]'),

    heading('Risks'),
    riskList([
      { risk: 'Risk to the improvement effort', likelihood: 'M', impact: 'M', mitigation: 'Mitigation' },
    ]),
  ],
}

/** The "build it myself" option — an empty canvas. */
export const CUSTOM_CHARTER_TEMPLATE: CharterTemplate = {
  id: 'custom',
  name: 'Build from scratch',
  category: 'Blank',
  tagline: 'Start with an empty canvas and craft it exactly how you want.',
  description:
    'A blank document. Use the tools sidebar (or type "/") to add headings, callouts, KPI grids, scope bounds, stakeholder tables, risk lists, and diagrams as you go. You can switch to a template at any time from the Templates tab.',
  custom: true,
  build: () => [para('')],
}

/** Industry-standard charter templates offered on first open. */
export const CHARTER_TEMPLATES: CharterTemplate[] = [
  PMBOK_CLASSIC,
  LEAN_ONE_PAGER,
  AGILE_CHARTER,
  SIX_SIGMA_CHARTER,
]

export function getCharterTemplate(id: string | undefined): CharterTemplate | undefined {
  if (!id) return undefined
  if (id === CUSTOM_CHARTER_TEMPLATE.id) return CUSTOM_CHARTER_TEMPLATE
  return CHARTER_TEMPLATES.find((t) => t.id === id)
}

/** A readable section outline for previewing a template without rendering the editor. */
export function templateOutline(template: CharterTemplate): string[] {
  const shapeLabels: Record<string, string> = {
    callout: 'Callout',
    kpiGrid: 'KPI grid',
    scopeBounds: 'Scope bounds',
    stakeholderTable: 'Stakeholder table',
    riskList: 'Risk list',
    diagram: 'Diagram',
  }
  const out: string[] = []
  for (const block of template.build()) {
    const type = String(block.type || '')
    if (type === 'heading') {
      const content = block.content
      const text = Array.isArray(content)
        ? content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('')
        : ''
      if (text.trim()) out.push(text.trim())
    } else if (shapeLabels[type] && out.length > 0) {
      // Attach a shape hint to the section it lives under.
      const last = out[out.length - 1]
      if (!last.includes('·')) out[out.length - 1] = `${last}  ·  ${shapeLabels[type]}`
    }
  }
  return out
}
