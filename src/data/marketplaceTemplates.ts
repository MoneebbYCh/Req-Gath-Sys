import type { BlockNoteBlock } from '../types/document'
import type { DocTemplate } from './docTemplateTypes'
import { listDocumentTypes } from './documentTypes'
import { templatesForType } from './docTemplates'

/** Marketplace entry — a browseable starting point, independent of any doc type. */
export interface MarketplaceTemplate extends DocTemplate {
  /** Material symbol shown on the card. */
  icon: string
  /** Suggested name when creating a document from this template. */
  suggestedDocName: string
  /** Credibility / standards pill on the card (arc42, MADR, Diátaxis, …). */
  standard?: string
  /** Search keywords beyond name/description. */
  keywords?: string[]
  /** True for built-in catalog entries (vs user-saved). */
  curated?: boolean
  /**
   * Optional sub-templates (e.g. ADR → Nygard vs MADR).
   * When present, the gallery card opens a chooser before Use.
   */
  variants?: MarketplaceTemplate[]
}

const h = (level: 1 | 2 | 3, text: string): BlockNoteBlock => ({
  type: 'heading',
  props: { level },
  content: text,
})

const p = (text = ''): BlockNoteBlock => ({
  type: 'paragraph',
  content: text,
})

const bullet = (text: string): BlockNoteBlock => ({
  type: 'bulletListItem',
  content: text,
})

const numbered = (text: string): BlockNoteBlock => ({
  type: 'numberedListItem',
  content: text,
})

const callout = (
  title: string,
  body: string,
  variant: 'info' | 'warn' | 'success' | 'error' = 'info',
): BlockNoteBlock => ({
  type: 'callout',
  props: { variant, title },
  content: body,
})

/** Inline field-guide prompt — delete once real content lands. */
const guide = (body: string): BlockNoteBlock => callout('Guide', body, 'info')

const code = (language: string, source: string): BlockNoteBlock => ({
  type: 'codeBlock',
  props: { language },
  content: source,
})

const table = (header: string[], rows: string[][]): BlockNoteBlock => ({
  type: 'table',
  content: {
    type: 'tableContent',
    rows: [{ cells: header }, ...rows.map((r) => ({ cells: r }))],
  },
})

const kpi = (
  items: Array<{ metric: string; target: string; method: string }>,
): BlockNoteBlock => ({
  type: 'kpiGrid',
  props: { itemsJson: JSON.stringify(items) },
})

const scope = (inScope: string[], outOfScope: string[]): BlockNoteBlock => ({
  type: 'scopeBounds',
  props: {
    inScopeJson: JSON.stringify(inScope),
    outOfScopeJson: JSON.stringify(outOfScope),
  },
})

const stakeholders = (
  rows: Array<{ nameRole: string; interest: string; influence: string; concern: string }>,
): BlockNoteBlock => ({
  type: 'stakeholderTable',
  props: { rowsJson: JSON.stringify(rows) },
})

const risks = (
  rows: Array<{ risk: string; likelihood: string; impact: string; mitigation: string }>,
): BlockNoteBlock => ({
  type: 'riskList',
  props: { rowsJson: JSON.stringify(rows) },
})

/** Nygard ADR (2011) — genuinely minimal: five headers + one guiding sentence each. */
const ADR_NYGARD: MarketplaceTemplate = {
  id: 'mp-adr-nygard',
  name: 'Nygard ADR',
  category: 'Engineering',
  standard: 'Nygard',
  tagline: 'Classic five-section ADR (Nygard, 2011).',
  description:
    'An Architectural Decision Record captures one significant decision: what was decided, why, and what it cost. The format comes from Michael Nygard’s 2011 proposal, which listed title, status, context, decision, and consequences, and still shapes most ADR tools today. Teams pick Nygard for speed when a decision does not need a full option comparison.',
  curated: true,
  icon: 'gavel',
  suggestedDocName: 'Architecture Decision',
  keywords: ['adr', 'nygard', 'decision'],
  build: () => [
    h(1, 'ADR-0001: Short Title of Decision'),
    p('Status: Proposed · YYYY-MM-DD'),
    h(2, 'Context'),
    p('Describe the forces at play and why a decision is needed now.'),
    h(2, 'Decision'),
    p('State the change we are making, in the present tense.'),
    h(2, 'Consequences'),
    p('List what becomes easier, harder, or newly required because of this decision.'),
  ],
}

/** MADR v4 — full sub-structure pre-filled. */
const ADR_MADR: MarketplaceTemplate = {
  id: 'mp-adr-madr',
  name: 'MADR v4',
  category: 'Engineering',
  standard: 'MADR',
  tagline: 'Markdown Architectural Decision Records (v4.0.0).',
  description:
    'An Architectural Decision Record captures one significant decision: what was decided, why, and what it cost. MADR builds on Nygard’s 2011 format by adding structure for comparing the options you actually considered, which helps when a decision gets questioned later. Teams pick MADR when a decision needs more justification.',
  curated: true,
  icon: 'gavel',
  suggestedDocName: 'Architecture Decision',
  keywords: ['adr', 'madr', 'decision'],
  build: () => [
    h(1, 'ADR-0001: Short Title of Decision'),
    callout('Status', 'Proposed · date TBD · authors TBD', 'info'),
    h(2, 'Context and problem statement'),
    guide(
      'Frame the situation as: In the context of <…>, facing <…>, we need to decide <…>.',
    ),
    p(
      'In the context of our service boundary for checkout, facing rising coupling between billing and inventory, we need to decide how ownership of the order aggregate should be split.',
    ),
    h(2, 'Decision drivers'),
    guide('Bullet the forces that will decide the option — latency, operability, team skill, cost, compliance.'),
    bullet('Independently deployable services'),
    bullet('Clear ownership for on-call'),
    bullet('Minimal migration risk for in-flight orders'),
    h(2, 'Considered options'),
    guide('Number each realistic option. Include “do nothing” when it is a real choice.'),
    numbered('Keep a single order service; extract billing later'),
    numbered('Split into Order + Billing now with a shared events bus'),
    numbered('Adopt an existing commercial order platform'),
    h(2, 'Decision outcome'),
    guide('Use the Y-statement shape so the choice and rationale stay inseparable.'),
    p('Chosen option: Split into Order + Billing now with a shared events bus, because it unlocks independent deployability without a multi-year rewrite.'),
    h(3, 'Good consequences'),
    bullet('Teams can ship billing changes without coordinating order releases'),
    bullet('On-call ownership maps cleanly to service boundaries'),
    h(3, 'Bad consequences'),
    bullet('Temporary dual-write period increases operational load'),
    bullet('Event schema versioning becomes a first-class concern'),
    h(2, 'Confirmation / compliance'),
    guide(
      'Optional: how this decision is verified — lint rules, ADR index, review checklist, CI gate.',
    ),
    p('Architecture review checklist includes “ADR linked from service README.” Event schemas validated in CI.'),
    h(2, 'More information'),
    p('Links to PRs, tickets, related ADRs, or design docs.'),
  ],
}

/**
 * Built-in marketplace catalog — five Phase 1 templates with finished-looking seeds.
 * ADR is one gallery entry with Nygard + MADR as variants.
 */
export const MARKETPLACE_TEMPLATES: MarketplaceTemplate[] = [
  {
    id: 'mp-readme',
    name: 'README',
    category: 'Docs',
    standard: 'standard-readme',
    tagline: 'standard-readme–aligned project README — looks finished empty.',
    description:
      'The README is often the first thing anyone reads before deciding whether to use or contribute to a project. standard-readme is an open source specification that fixes the order and required sections of a README, including description, install, usage, API, contributing, and license, so readers know where to find what they need in any repo. A consistent structure means people find the install command quickly instead of scrolling through unstructured text.',
    curated: true,
    icon: 'menu_book',
    suggestedDocName: 'README',
    keywords: ['readme', 'standard-readme', 'github', 'docs'],
    build: () => [
      h(1, 'your-package'),
      p('One-line description of what this project does and who it is for.'),
      p(
        '![Build](https://img.shields.io/badge/build-passing-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue) ![Version](https://img.shields.io/badge/version-0.1.0-informational)',
      ),
      h(2, 'Table of contents'),
      bullet('Background'),
      bullet('Install'),
      bullet('Usage'),
      bullet('Configuration'),
      bullet('API'),
      bullet('Contributing'),
      bullet('License'),
      h(2, 'Background'),
      guide('Why this exists — problem space, intended audience, and what “done” looks like for a reader.'),
      p(
        'Teams were copying the same setup steps across repos. This package packages the happy path so a new contributor can go from clone to first successful run in under ten minutes.',
      ),
      h(2, 'Install'),
      guide('List prerequisites, then show the exact install command in a fenced code block.'),
      p('Requires Node.js 20+ and npm 10+.'),
      code('bash', 'npm install your-package'),
      p('Verify the install:'),
      code('bash', 'npx your-package --version'),
      h(2, 'Usage'),
      guide('Smallest useful example — copy-pasteable, with expected output if helpful.'),
      code(
        'ts',
        `import { run } from 'your-package'\n\nawait run({\n  projectRoot: process.cwd(),\n  dryRun: true,\n})\n`,
      ),
      h(2, 'Configuration'),
      guide('Env vars / flags — purpose and default. Prefer a table once you have more than two.'),
      table(
        ['Name', 'Purpose', 'Default'],
        [
          ['YOUR_PACKAGE_TOKEN', 'API token for remote calls', '(required)'],
          ['YOUR_PACKAGE_LOG', 'Log level: error | warn | info | debug', 'info'],
        ],
      ),
      h(2, 'API'),
      guide('Optional overview of the public surface, or link out to full API docs.'),
      table(
        ['Export', 'Kind', 'Notes'],
        [
          ['run(options)', 'function', 'Primary entry — see Usage'],
          ['PackageOptions', 'type', 'Shared options bag'],
        ],
      ),
      h(2, 'Contributing'),
      guide('How to report issues, propose changes, and run local checks.'),
      numbered('Fork and create a feature branch'),
      numbered('npm test && npm run lint'),
      numbered('Open a PR with a short “why” in the description'),
      h(2, 'License'),
      p('MIT © Your Org — see LICENSE for the full text.'),
    ],
  },
  {
    id: 'mp-prd',
    name: 'Product Requirements (PRD)',
    category: 'Product',
    standard: 'Convention',
    tagline: 'Industry-converged PRD with metadata, TL;DR, and filled tables.',
    description:
      'There is no official standard for a PRD, but product teams have converged on a similar shape because the same questions always need answers: what problem you’re solving, who it’s for, what success looks like, and what’s out of scope. A PRD keeps engineering, design, and stakeholders aligned before any code gets written, which makes it one of the most requested documents in early stage product work.',
    curated: true,
    icon: 'lightbulb',
    suggestedDocName: 'Product Requirements',
    keywords: ['prd', 'requirements', 'product', 'jtbd', 'user stories'],
    build: () => [
      h(1, 'Product Requirements Document'),
      table(
        ['Field', 'Value'],
        [
          ['Author', 'Your name'],
          ['Status', 'Draft'],
          ['Last updated', 'YYYY-MM-DD'],
          ['Stakeholders', 'PM, Eng lead, Design, Support'],
        ],
      ),
      callout(
        'TL;DR',
        'In one or two sentences: who this is for, what changes, and how we will know it worked. Replace this callout when the brief is stable.',
        'success',
      ),
      h(2, 'Problem statement / background'),
      guide('What is broken or missing today? Who feels it, how often, and what workaround do they use?'),
      p(
        'Support spends ~4 hours/week manually reconciling failed webhook deliveries. Customers see “payment succeeded” while fulfillment never starts.',
      ),
      h(2, 'Goals and non-goals'),
      guide('Keep goals and non-goals side by side so scope arguments stay concrete.'),
      table(
        ['Goals', 'Non-goals'],
        [
          ['Auto-retry failed webhooks with backoff', 'Rebuilding the entire payments stack'],
          ['Surface delivery status in the admin UI', 'Multi-region active-active in v1'],
          ['Cut manual reconciliation time by 80%', 'Changing merchant pricing models'],
        ],
      ),
      h(2, 'User stories / Jobs-to-be-Done'),
      guide('Keep the “As a … I want … so that …” shape — one story per bullet.'),
      bullet('As a [ops engineer], I want [failed deliveries queued with reason codes], so that [I can fix root causes without grepping logs].'),
      bullet('As a [support agent], I want [a timeline of webhook attempts on the order], so that [I can answer merchants without escalating].'),
      bullet('As a [merchant], I want [fulfillment to start after a successful payment], so that [customers receive orders on time].'),
      h(2, 'Requirements'),
      h(3, 'Functional'),
      guide('Each requirement should be testable. Prefer “system shall…” over vague wishes.'),
      bullet('System shall enqueue failed webhook deliveries with attempt count and last error.'),
      bullet('System shall expose delivery status on the order detail page within 30s of an attempt.'),
      h(3, 'Non-functional'),
      bullet('p95 enqueue latency < 200ms under peak load'),
      bullet('Retries must be idempotent for the same delivery id'),
      bullet('Admin views meet WCAG 2.2 AA for status badges and tables'),
      h(2, 'Success metrics'),
      guide('Baseline vs target — if you lack a baseline, write “TBD” and a plan to measure.'),
      table(
        ['Metric', 'Baseline', 'Target'],
        [
          ['Manual reconciliation hours / week', '4h', '≤ 0.8h'],
          ['Orders stuck > 15m after paid', '2.1%', '< 0.3%'],
          ['Mean time to diagnose webhook failure', '45m', '< 10m'],
        ],
      ),
      h(2, 'Out of scope'),
      scope(
        ['Webhook retry worker', 'Admin delivery timeline', 'Alerting on retry exhaustion'],
        ['Payment provider migration', 'Multi-region active-active', 'Merchant-facing status page'],
      ),
      h(2, 'Open questions'),
      guide('Unanswered decisions that block build or launch.'),
      bullet('Do we keep delivery payloads longer than 30 days?'),
      bullet('Who owns the on-call rotation for the retry worker?'),
    ],
  },
  {
    id: 'mp-arc42',
    name: 'Architecture (arc42)',
    category: 'Architecture',
    standard: 'arc42',
    tagline: 'arc42’s 12 sections with worked-example seed tables.',
    description:
      'arc42 is a widely used template for documenting software architecture, maintained as an open source project and taught in the iSAQB certification used across Europe. It splits architecture documentation into 12 fixed sections, covering goals, building blocks, runtime behavior, deployment, and known risks, so every doc answers the same core questions no matter who wrote it. It works well as plain text stored in git next to your code, reviewed through pull requests like any other change.',
    curated: true,
    icon: 'schema',
    suggestedDocName: 'Architecture',
    keywords: ['arc42', 'architecture', 'c4', 'system design'],
    build: () => [
      h(1, 'Architecture Documentation (arc42)'),
      callout(
        'Diagram layer',
        'Prefer C4 views (context → container → component → code) inside §§3, 5, 6, and 7 — not as a competing template.',
        'info',
      ),
      h(2, '1. Introduction and goals'),
      guide('Name the system, its top quality goals, and who cares. Tables beat prose for stakeholders and priorities.'),
      p(
        'This document describes the architecture of Checkout Platform — the system that accepts payment events and drives fulfillment hand-off.',
      ),
      h(3, 'Stakeholders'),
      table(
        ['Role', 'Concerns'],
        [
          ['Product owner', 'Time-to-market for payment methods; clear scope'],
          ['Engineering lead', 'Deployability, operability, team boundaries'],
          ['SRE / on-call', 'Alert quality, runbooks, blast radius'],
          ['Security', 'PCI scope, secrets, audit trails'],
          ['Support', 'Explainable order state to merchants'],
        ],
      ),
      h(3, 'Quality goals'),
      table(
        ['Priority', 'Goal', 'Motivation'],
        [
          ['1', 'Reliability of paid → fulfill path', 'Direct revenue and trust impact'],
          ['2', 'Independent deployability of billing vs order', 'Team throughput'],
          ['3', 'Observability of async hand-offs', 'Cut mean-time-to-diagnose'],
        ],
      ),
      h(2, '2. Constraints'),
      guide('Technical and organizational constraints that are non-negotiable.'),
      bullet('Must remain within existing PCI network segment for card data'),
      bullet('Primary datastore is PostgreSQL (org standard)'),
      bullet('Releases go through the shared GitHub Actions pipeline'),
      h(2, '3. Context and scope'),
      guide('Business and technical context; external interfaces. C4 System Context fits here.'),
      p(
        'External actors: Merchant Admin, Payment Provider, Fulfillment Service, Notification Bus. Checkout Platform owns order capture and payment confirmation; it does not own warehouse operations.',
      ),
      scope(
        ['Payment confirmation ingestion', 'Order state machine', 'Webhook outbound to merchants'],
        ['Warehouse WMS', 'Merchant marketing site', 'Long-term analytics warehouse'],
      ),
      h(2, '4. Solution strategy'),
      guide('Technology and top-level decomposition decisions that shape the rest of the doc.'),
      p(
        'Event-driven hand-off between Order and Billing services; PostgreSQL for transactional state; OpenTelemetry for traces across async boundaries.',
      ),
      h(2, '5. Building block view'),
      guide(
        'Drill down Level 1 → 2 → n. Each whitebox lists contained blackboxes, responsibilities, and interfaces. Align with source modularization.',
      ),
      h(3, 'Level 1 — System whitebox'),
      p('Checkout Platform contains: Order Service, Billing Service, Admin API, shared Event Bus.'),
      h(3, 'Level 2 — Order Service whitebox'),
      p('Contains: Order API, State Machine, Outbox Publisher. Interfaces: REST from Admin API; emits OrderPaid / OrderFailed.'),
      h(3, 'Level 3 — Outbox Publisher (example blackbox)'),
      p(
        'Responsibility: reliably publish domain events after commit. Interface: reads outbox table; writes to Event Bus. Quality: at-least-once with idempotent consumers.',
      ),
      h(2, '6. Runtime view'),
      guide('Important scenarios as runtime interactions (sequence / collaboration).'),
      numbered('Happy path: payment confirmed → order paid → fulfillment notified'),
      numbered('Retry path: webhook failure → backoff → exhaust → alert'),
      h(2, '7. Deployment view'),
      guide('Infrastructure, environments, and how building blocks map onto them.'),
      table(
        ['Building block', 'Runtime', 'Environment notes'],
        [
          ['Order Service', 'Kubernetes deployment', '2 replicas staging / 4 prod'],
          ['Billing Service', 'Kubernetes deployment', 'Same cluster, separate namespace'],
          ['PostgreSQL', 'Managed RDS', 'Multi-AZ prod'],
          ['Event Bus', 'Managed Kafka', 'Shared with notifications'],
        ],
      ),
      h(2, '8. Crosscutting concepts'),
      guide('Domain model, persistence, security, UX, and ops patterns that apply everywhere.'),
      bullet('Domain events are versioned (cloudevents-compatible envelopes)'),
      bullet('AuthN via org SSO; service-to-service mTLS'),
      bullet('PII redacted in logs; card data never leaves PCI segment'),
      h(2, '9. Architectural decisions'),
      guide('Key decisions — or links to ADRs. Seed a log so the section never looks empty.'),
      table(
        ['ID', 'Decision', 'Status', 'Link'],
        [
          ['ADR-0001', 'Split Order + Billing with event bus', 'Accepted', 'ADRs/ADR-0001'],
          ['ADR-0002', 'Outbox pattern for publish-after-commit', 'Accepted', 'ADRs/ADR-0002'],
          ['ADR-0003', 'Retain webhook payloads 30 days', 'Proposed', 'ADRs/ADR-0003'],
        ],
      ),
      h(2, '10. Quality requirements'),
      guide('Quality tree / scenarios — priority, scenario, metric. Pair with §1 quality goals.'),
      table(
        ['Priority', 'Quality scenario', 'Metric'],
        [
          ['High', 'Under peak checkout, paid orders reach fulfillment within 15s p95', 'p95 hand-off latency'],
          ['High', 'A failed webhook is retried without duplicate fulfillments', 'Idempotent delivery rate'],
          ['Medium', 'On-call diagnoses a stuck order from traces alone', 'MTTD < 10m'],
        ],
      ),
      kpi([
        { metric: 'Paid → fulfill p95', target: '< 15s', method: 'Trace-derived SLO' },
        { metric: 'Duplicate fulfillments', target: '0 / month', method: 'Idempotency key audit' },
      ]),
      h(2, '11. Risks and technical debt'),
      risks([
        {
          risk: 'Dual-write window during Order/Billing split',
          likelihood: 'M',
          impact: 'H',
          mitigation: 'Feature flag + reconciliation job',
        },
        {
          risk: 'Event schema drift across consumers',
          likelihood: 'M',
          impact: 'M',
          mitigation: 'Contract tests in CI',
        },
      ]),
      h(2, '12. Glossary'),
      guide('Terms that appear elsewhere in the doc — keep definitions short.'),
      table(
        ['Term', 'Definition'],
        [
          ['Outbox', 'DB table of events written in the same transaction as state changes'],
          ['Delivery', 'One attempt to push a webhook payload to a merchant endpoint'],
          ['Paid', 'Order state after payment provider confirmation is accepted'],
        ],
      ),
    ],
  },
  {
    id: 'mp-api-docs',
    name: 'API Documentation',
    category: 'Engineering',
    standard: 'Diátaxis',
    tagline: 'Diátaxis four modes wrapping an OpenAPI-shaped reference.',
    description:
      'Good API documentation covers four different needs: teaching a first integration, solving a specific problem, listing every endpoint, and explaining why the API works the way it does. Diátaxis is a documentation framework built around that split, and many modern developer docs sites follow it. Combined with an OpenAPI generated reference that stays current with your actual API, this template pairs accurate reference material with the context developers need to get unstuck.',
    curated: true,
    icon: 'api',
    suggestedDocName: 'API Documentation',
    keywords: ['api', 'openapi', 'swagger', 'diataxis', 'docs'],
    build: () => [
      h(1, 'API Documentation'),
      callout(
        'OpenAPI / Swagger',
        'Link or embed the generated OpenAPI reference under Reference. Keep tutorials, how-tos, and explanations hand-written so the spec is not a bare dump.',
        'info',
      ),
      h(2, 'Tutorials — learning-oriented'),
      guide(
        'A tutorial teaches by doing. Goal: a new consumer completes one meaningful path end-to-end. Not a task cheat-sheet (that’s How-to) and not an exhaustive catalog (that’s Reference).',
      ),
      p('Goal: authenticate and create your first order in the sandbox.'),
      numbered('Create a sandbox API key in the developer portal'),
      numbered('Export it: export API_KEY=sk_test_…'),
      numbered('Create an order (see code below) and confirm you receive 201 with an id'),
      code(
        'bash',
        `curl -s -X POST https://api.example.com/v1/orders \\\n  -H "Authorization: Bearer $API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"sku":"sku_123","quantity":1}'`,
      ),
      h(2, 'How-to guides — task-oriented'),
      guide(
        'How-tos assume the reader already knows the product. Each guide answers “How do I…?” with steps — no narrative learning arc.',
      ),
      h(3, 'How to paginate list endpoints'),
      numbered('Pass ?limit=50 (max 100)'),
      numbered('Follow next_cursor from the response until null'),
      h(3, 'How to retry safely'),
      numbered('Send Idempotency-Key on POST/PUT'),
      numbered('Retry on 409 / 429 / 5xx with exponential backoff'),
      h(2, 'Reference — information-oriented'),
      guide(
        'Reference is for looking things up. Prefer generated OpenAPI for schemas; keep a short human index of the most-used endpoints here.',
      ),
      p('Auth: Bearer token. Versioning: /v1 prefix. Errors: { "error": { "code", "message", "request_id" } }.'),
      table(
        ['Method', 'Path', 'Description', 'Response'],
        [
          ['GET', '/v1/orders', 'List orders for the caller', '200 order[] + cursor'],
          ['POST', '/v1/orders', 'Create an order', '201 order'],
          ['GET', '/v1/orders/{id}', 'Fetch one order', '200 order | 404'],
          ['POST', '/v1/orders/{id}/cancel', 'Cancel if not fulfilled', '200 order | 409'],
        ],
      ),
      h(2, 'Explanation — understanding-oriented'),
      guide(
        'Explanation clarifies why the API is shaped this way — trade-offs, consistency model, migration notes. Not steps, not an endpoint dump.',
      ),
      p(
        'Orders are the aggregate root because fulfillment and payment both need a single id merchants can quote. Webhook deliveries are separate resources so retries do not mutate order history.',
      ),
      h(2, 'Open questions'),
      bullet('Should cancel be DELETE /orders/{id} or a dedicated action resource?'),
      bullet('Do we expose raw provider decline codes or a normalized enum?'),
    ],
  },
  {
    id: 'mp-adr',
    name: 'Architecture Decision Record',
    category: 'Engineering',
    standard: 'ADR',
    tagline: 'Choose Nygard (classic) or MADR v4.',
    description:
      'An Architectural Decision Record captures one significant decision: what was decided, why, and what it cost. The format comes from Michael Nygard’s 2011 proposal, which listed title, status, context, decision, and consequences, and still shapes most ADR tools today. MADR builds on that by adding structure for comparing the options you actually considered, which helps when a decision gets questioned later. Teams pick Nygard for speed and MADR when a decision needs more justification.',
    curated: true,
    icon: 'gavel',
    suggestedDocName: 'Architecture Decision',
    keywords: ['adr', 'nygard', 'madr', 'decision', 'architecture'],
    build: () => ADR_NYGARD.build(),
    variants: [ADR_NYGARD, ADR_MADR],
  },
]

export const MARKETPLACE_CATEGORIES = [
  'All',
  'Docs',
  'Product',
  'Architecture',
  'Engineering',
  'Saved',
] as const

export type MarketplaceCategory = (typeof MARKETPLACE_CATEGORIES)[number]

/** Flatten curated entries including ADR variants (for seed lookup). */
export function listCuratedMarketplaceTemplatesFlat(): MarketplaceTemplate[] {
  const out: MarketplaceTemplate[] = []
  for (const t of MARKETPLACE_TEMPLATES) {
    out.push(t)
    if (t.variants?.length) out.push(...t.variants)
  }
  return out
}

/** User-saved templates across all document types, adapted for the marketplace. */
export function listSavedMarketplaceTemplates(): MarketplaceTemplate[] {
  const out: MarketplaceTemplate[] = []
  for (const doc of listDocumentTypes()) {
    for (const t of templatesForType(doc.id)) {
      out.push({
        ...t,
        icon: doc.icon || 'bookmark',
        suggestedDocName: t.name,
        curated: false,
        keywords: ['saved', doc.title, doc.id],
        category: 'Saved',
        description: t.description || `Saved from “${doc.title}”.`,
        tagline: t.tagline || `From ${doc.title}`,
      })
    }
  }
  return out
}

/** Gallery list: curated cards (ADR as one) + user-saved. */
export function listMarketplaceTemplates(): MarketplaceTemplate[] {
  return [...MARKETPLACE_TEMPLATES, ...listSavedMarketplaceTemplates()]
}

export function getMarketplaceTemplate(id: string): MarketplaceTemplate | undefined {
  return (
    listCuratedMarketplaceTemplatesFlat().find((t) => t.id === id) ??
    listSavedMarketplaceTemplates().find((t) => t.id === id)
  )
}

export function filterMarketplaceTemplates(
  templates: MarketplaceTemplate[],
  query: string,
  category: MarketplaceCategory,
): MarketplaceTemplate[] {
  const q = query.trim().toLowerCase()
  return templates.filter((t) => {
    if (category !== 'All' && t.category !== category) return false
    if (!q) return true
    const hay = [
      t.name,
      t.tagline,
      t.description,
      t.category,
      t.standard ?? '',
      ...(t.keywords ?? []),
    ]
      .join(' ')
      .toLowerCase()
    return hay.includes(q)
  })
}
