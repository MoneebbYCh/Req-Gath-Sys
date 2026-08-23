import { z } from 'zod'
import type { TaskNode } from '../contracts/TaskGraph'
import {
  documentValidationReportSchema,
  crossDocumentReportSchema,
  type ClaimResult,
  type CrossDocumentContradiction,
  type DocumentValidationReport,
  type CrossDocumentReport,
  type ReplanSignal,
  type ValidationReport,
} from '../contracts/Validation'
import { claimKey } from '../contracts/Finding'
import type { EvidenceCandidate, EvidenceRecord } from '../contracts/Evidence'
import { EvidenceLedger } from '../knowledge/EvidenceLedger'
import { FindingStore } from '../knowledge/FindingStore'
import { ProjectFactBase } from '../knowledge/ProjectFactBase'
import {
  runToolLoop,
  type ToolLoopConfig,
  type ToolExecutor,
} from '../model/toolLoopTaskRunner'
import { extractJsonBlock } from '../model/jsonBlock'
import type { ModelProvider } from '../model/ModelProvider'
import type { NodeRunContext } from '../runtime/OrchestratorRunner'

/**
 * Validation worker runtime (plan §13). One runtime, two dynamic modes:
 *
 *  - 'document': deterministic checks (evidence resolves, files exist, content
 *    hashes current) + a model claim-validation pass. Current-state claims and
 *    proposed claims are judged differently; contradicted current-state claims
 *    mark their section for targeted regeneration.
 *  - 'cross-document': compares normalized claims across the document set;
 *    conflicts are resolved against the shared fact base deterministically
 *    (claimKey match) or reported explicitly unresolved.
 *
 * Validation output is operational progress + a structured report — model
 * reasoning deltas are suppressed (plan §3.6: no chain-of-thought streaming).
 */

export interface ValidationWorkerDeps {
  provider: ModelProvider
  executor: ToolExecutor
  baseConfig: ToolLoopConfig
  findings: FindingStore
  facts: ProjectFactBase
  evidence: EvidenceLedger
}

/** Parsed dependency payload from the document node that produced a document. */
interface DocNodePayload {
  documentId: string
  title: string
  sectionTexts: Array<{ heading: string; text: string }>
}

const MAX_EVIDENCE_CHECKS = 10
const MAX_SECTION_TEXT = 1_500
const MAX_FACTS_TEXT = 8_000

const claimListSchema = z.object({
  claims: z
    .array(
      z.object({
        claim: z.string().min(1),
        kind: z.enum(['current', 'proposed']).default('current'),
        verdict: z.enum(['supported', 'weak', 'contradicted', 'unsupported']),
        evidenceIds: z.array(z.string()).default([]),
        sectionHeading: z.string().optional(),
        note: z.string().default(''),
      }),
    )
    .max(40),
})

const contradictionListSchema = z.object({
  contradictions: z
    .array(
      z.object({
        a: z.string().min(1),
        b: z.string().min(1),
        note: z.string().default(''),
      }),
    )
    .max(40),
})

function factsContext(facts: ProjectFactBase, findings: FindingStore): string {
  const lines: string[] = []
  for (const f of facts.all().slice(0, 30)) {
    lines.push(`FACT [${f.domain}] ${f.statement}`)
  }
  for (const f of findings.all().slice(0, 40)) {
    lines.push(`FINDING [${f.type}] (${f.domain}): ${f.claim}`)
  }
  return lines.join('\n').slice(0, MAX_FACTS_TEXT) || '(no established facts yet)'
}

/**
 * Plan §18 deterministic completeness: every required coverage item must be
 * satisfied by a document section or an explicit `unknown` finding for the
 * same domain. Uncovered items surface as issues — never silently dropped.
 */
function missingCoverageIssues(
  requiredCoverage: string[],
  sectionTexts: Array<{ heading: string; text: string }>,
  findings: FindingStore,
): string[] {
  const sections = sectionTexts.map((s) => `${s.heading}\n${s.text}`.toLowerCase())
  const issues: string[] = []
  for (const item of requiredCoverage) {
    const needle = item.trim().toLowerCase()
    if (!needle) continue
    if (sections.some((s) => s.includes(needle))) continue
    const explicitlyUnknown =
      findings.byDomain(needle).some((f) => f.type === 'unknown') ||
      findings.byType('unknown').some((f) => f.domain.toLowerCase() === needle)
    if (explicitlyUnknown) continue
    issues.push(`Missing required coverage: "${item}" — no document section and no explicit unknown finding.`)
  }
  return issues
}

function parseDocPayload(raw: string | undefined): DocNodePayload | undefined {  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<DocNodePayload>
    if (
      typeof parsed.documentId !== 'string' ||
      typeof parsed.title !== 'string' ||
      !Array.isArray(parsed.sectionTexts)
    ) {
      return undefined
    }
    return parsed as DocNodePayload
  } catch {
    return undefined
  }
}

function parseReport(raw: string): ValidationReport | undefined {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.mode === 'cross-document') {
      const r = crossDocumentReportSchema.safeParse(parsed)
      return r.success ? r.data : undefined
    }
    if (parsed && typeof parsed === 'object' && parsed.mode === 'document') {
      const r = documentValidationReportSchema.safeParse(parsed)
      return r.success ? r.data : undefined
    }
    return undefined
  } catch {
    return undefined
  }
}

export class ValidationWorker {
  constructor(private readonly deps: ValidationWorkerDeps) {}

  async run(node: TaskNode, ctx: NodeRunContext): Promise<{ outputs: string[]; followups: ReplanSignal[] }> {
    const kind = node.roleSpec.validationKind ?? 'document'
    if (kind === 'cross-document') {
      const report = await this.validateCrossDocument(node, ctx)
      return { outputs: [JSON.stringify(report)], followups: [] }
    }
    const report = await this.validateDocument(node, ctx)
    const followups: ReplanSignal[] = report.failedSections.map((sectionHeading) => ({
      kind: 'regenerate-section',
      documentId: report.documentId ?? '',
      title: report.title,
      sectionHeading,
      note: `A current-state claim in "${sectionHeading}" contradicted the repository evidence during validation.`,
      dependencies: [node.id],
    }))
    return { outputs: [JSON.stringify(report)], followups }
  }

  // ── Deterministic layer ─────────────────────────────────────────────────

  /**
   * Evidence resolves, files still exist, hashes current. Stale evidence is
   * marked for revalidation (refresh) and recorded as a caveat — it is never
   * silently deleted (invariant: compaction/invalidation never drops evidence).
   */
  private async checkEvidence(signal: AbortSignal): Promise<{ staleIds: string[]; issues: string[] }> {
    const ids = new Set<string>()
    for (const f of this.deps.facts.all()) for (const id of f.evidenceIds) ids.add(id)
    for (const f of this.deps.findings.all()) for (const id of f.evidenceIds) ids.add(id)
    const targets = [...ids].slice(0, MAX_EVIDENCE_CHECKS)

    const staleIds: string[] = []
    const staleReasons = new Map<string, string>()
    const issues: string[] = []

    for (const id of targets) {
      const record = this.deps.evidence.get(id)
      if (!record) {
        staleIds.push(id)
        staleReasons.set(id, `Evidence ${id} is no longer in the ledger.`)
        continue
      }
      if (record.kind !== 'source' || !record.range) continue

      const start = Math.max(1, record.range.startLine)
      const end = Math.max(start, record.range.endLine)
      const res = await this.deps.executor.execute(
        'read_file_range',
        {
          path: record.path,
          startLine: start,
          endLine: end,
        },
        signal,
      )
      if (!res.ok) {
        staleIds.push(id)
        staleReasons.set(id, `Evidence file ${record.path} no longer exists or is unreadable — marked stale.`)
        continue
      }
      const payload = res.result as
        | { evidenceCandidates?: Array<{ contentHash?: string }>; repositoryVersion?: string }
        | undefined
      const currentHash = payload?.evidenceCandidates?.[0]?.contentHash ?? ''
      if (record.contentHash && currentHash && currentHash !== record.contentHash) {
        staleIds.push(id)
        staleReasons.set(id, `Evidence ${record.path} is stale (the file changed) — findings using it need revalidation.`)
      }
      // Plan §18 deterministic: referenced symbol/range is resolvable (LSP).
      if (record.symbol && record.contentHash && currentHash === record.contentHash) {
        const def = await this.deps.executor.execute('find_definition', { path: record.path, line: start }, signal)
        const locations = (def.result as { locations?: Array<{ path: string }> } | undefined)?.locations
        if (!def.ok || !locations?.some((l) => l.path === record.path)) {
          issues.push(`Evidence ${record.path} symbol "${record.symbol}" is not resolvable at line ${start}.`)
        }
      }
      // Plan §18 deterministic: repository version is current (hash may match after a revert).
      if (
        record.repositoryVersion &&
        payload?.repositoryVersion &&
        payload.repositoryVersion !== record.repositoryVersion
      ) {
        issues.push(
          `Evidence ${record.path} was recorded at repository version ${record.repositoryVersion}; current version is ${payload.repositoryVersion}.`,
        )
      }
      // Refresh the ledger with the current read so later validations are cheap.
      if (payload && Array.isArray(payload.evidenceCandidates) && payload.evidenceCandidates.length > 0 && this.deps.baseConfig.recordEvidence) {
        this.deps.baseConfig.recordEvidence(
          payload.evidenceCandidates as EvidenceCandidate[],
          payload.repositoryVersion ?? 'unknown',
          'read_file_range',
        )
      }
    }

    // Plan §12: symbol re-resolution remaps shifted ranges instead of dropping
    // the evidence — refreshed ids leave the stale set (never deleted).
    const refreshed = await this.deps.evidence.refreshRanges(staleIds, (record) => this.resolveSymbolRange(record, signal))
    if (refreshed > 0) {
      for (const [id] of [...staleReasons]) if (!staleIds.includes(id)) staleReasons.delete(id)
      issues.push(`${refreshed} stale evidence record(s) were refreshed by re-resolving their symbols — ranges remapped, not deleted.`)
    }
    issues.push(...staleReasons.values())

    if (staleIds.length > 0) {
      this.deps.findings.markStaleEvidence(staleIds)
      this.deps.facts.markStaleEvidence(staleIds)
    }
    return { staleIds, issues }
  }

  /** Re-locate a record's symbol via find_definition; undefined when it moved files or vanished. */
  private async resolveSymbolRange(
    record: EvidenceRecord,
    signal: AbortSignal,
  ): Promise<{ startLine: number; endLine: number } | undefined> {
    const res = await this.deps.executor.execute(
      'find_definition',
      { path: record.path, line: record.range?.startLine ?? 1 },
      signal,
    )
    if (!res.ok) return undefined
    const locations = (
      res.result as { locations?: Array<{ path: string; startLine: number; endLine: number }> } | undefined
    )?.locations
    const loc = locations?.find((l) => l.path === record.path)
    return loc ? { startLine: loc.startLine, endLine: loc.endLine } : undefined
  }

  // ── Per-document validation ────────────────────────────────────────────

  private async validateDocument(node: TaskNode, ctx: NodeRunContext): Promise<DocumentValidationReport> {
    const payload = parseDocPayload(ctx.dependencyOutputs[0])
    if (!payload || payload.sectionTexts.length === 0) {
      ctx.validationProgress({
        phase: 'deterministic',
        documentId: payload?.documentId,
        message: `Skipped validation of "${payload?.title ?? node.title}": document content unavailable (conflict or cancellation).`,
      })
      return {
        mode: 'document',
        documentId: payload?.documentId,
        title: payload?.title ?? node.title,
        status: 'issues',
        claims: [],
        staleEvidenceIds: [],
        failedSections: [],
        issues: ['Document content was unavailable for validation.'],
      }
    }
    const { documentId, title } = payload

    // 1. Deterministic evidence checks.
    ctx.validationProgress({ phase: 'deterministic', documentId, message: `Validating ${title} — checking evidence freshness` })
    const { staleIds, issues } = await this.checkEvidence(ctx.signal)
    if (ctx.signal.aborted) {
      return {
        mode: 'document',
        documentId,
        title,
        status: 'issues',
        claims: [],
        staleEvidenceIds: staleIds,
        failedSections: [],
        issues: [...issues, 'Validation was cancelled.'],
      }
    }

    // Plan §18: required coverage — a document section or an explicit unknown
    // finding must cover each item; uncovered items surface, never silent.
    issues.push(...missingCoverageIssues(node.roleSpec.requiredCoverage, payload.sectionTexts, this.deps.findings))

    // 2. Model-based claim validation (bounded retrieval allowed).
    ctx.validationProgress({ phase: 'claim', documentId, message: `Validating repository claims in ${title}` })
    const sectionsText = payload.sectionTexts
      .map((s) => `## ${s.heading}\n${s.text.slice(0, MAX_SECTION_TEXT)}`)
      .join('\n\n')
      .slice(0, 16_000)

    const allowed = new Set<string>(node.roleSpec.allowedTools)
    const tools = (this.deps.baseConfig.tools ?? []).filter((t) => allowed.has(t.name))

    const loop = await runToolLoop(
      this.deps.provider,
      this.deps.executor,
      { ...this.deps.baseConfig, maxIterations: 2, maxToolCalls: 4, tools, budgetController: ctx.budgetController, telemetryContext: { ...this.deps.baseConfig.telemetryContext, taskId: ctx.taskId, nodeId: node.id, workerType: 'validation' } },
      {
        text:
          `Validate the repository claims in the document "${title}".\n\n` +
          `DOCUMENT SECTIONS:\n${sectionsText}\n\n` +
          `KNOWN FACTS AND FINDINGS (evidence ids in brackets are citable):\n${factsContext(this.deps.facts, this.deps.findings)}\n\n` +
          `Rules:\n` +
          `- Extract up to 15 IMPORTANT claims that assert repository/implementation behavior ("current") or future intent ("proposed").\n` +
          `- For each CURRENT claim, judge whether the cited evidence supports it. Use the repository tools to check anything you are unsure about.\n` +
          `- For each PROPOSED claim, judge whether it misrepresents current state as existing; a proposal that differs from today's implementation is fine and intentional.\n` +
          `- Cite evidence ids from the KNOWN FACTS list only; use an empty array when none apply.\n` +
          `- Report which section each claim came from (sectionHeading) so failures can be fixed precisely.\n` +
          `Respond with ONLY a JSON block:\n` +
          '```json\n' +
          '{"claims":[{"claim":"...","kind":"current|proposed","verdict":"supported|weak|contradicted|unsupported",' +
          '"evidenceIds":["..."],"sectionHeading":"...","note":"..."}]}\n' +
          '```',
        signal: ctx.signal,
        // Tool-loop internals are operational activity; phase transitions go
        // through validationProgress. Never stream validator reasoning (plan §3.6).
        activity: ctx.activity,
        context: { task: { nodeId: node.id, title: node.title, objective: node.objective, status: node.status, dependencies: node.dependencies } },
      },
    )

    let parsed = this.parseClaims(loop.text)
    if (parsed.claims === undefined && loop.text.trim().length > 0) {
      // Plan §14: model repair — one bounded JSON-only retry instead of a silent gap.
      ctx.activity('Claim validator output was not valid JSON — requesting one JSON-only repair pass')
      const repair = await runToolLoop(
        this.deps.provider,
        this.deps.executor,
        { ...this.deps.baseConfig, tools: [], maxIterations: 1, maxToolCalls: 0, budgetController: ctx.budgetController, telemetryContext: { ...this.deps.baseConfig.telemetryContext, taskId: ctx.taskId, nodeId: node.id, workerType: 'validation' } },
        {
          text:
            'Your previous response was not valid JSON. Respond with ONLY the JSON block now:\n' +
            '```json\n' +
            '{"claims":[{"claim":"...","kind":"current|proposed","verdict":"supported|weak|contradicted|unsupported",' +
            '"evidenceIds":["..."],"sectionHeading":"...","note":"..."}]}\n' +
            '```',
          signal: ctx.signal,
          activity: ctx.activity,
          context: { task: { nodeId: node.id, title: node.title, objective: node.objective, status: node.status, dependencies: node.dependencies } },
        },
      )
      parsed = this.parseClaims(repair.text)
    }
    const { claims, claimIssues, failedSections } = this.judgeClaims(parsed.claims ?? [])

    if ((parsed.claims ?? []).length === 0 && loop.text.trim().length > 0) {
      claimIssues.push('The claim validator produced no parseable claims — treated as a validation gap.')
    }

    const status = failedSections.length > 0 ? 'failed' : issues.length > 0 || claimIssues.length > 0 || staleIds.length > 0 ? 'issues' : 'passed'
    const report: DocumentValidationReport = {
      mode: 'document',
      documentId,
      title,
      status,
      claims,
      staleEvidenceIds: staleIds,
      failedSections,
      issues: [...issues, ...claimIssues],
    }

    const message =
      status === 'failed'
        ? `Validation FAILED for ${title}: ${failedSections.length} section(s) contradict repository evidence — queued for targeted regeneration.`
        : status === 'issues'
          ? `Validation of ${title} finished with caveats (${report.issues.length} issue(s)).`
          : `Validation of ${title} passed.`
    ctx.validationProgress({
      phase: 'claim',
      documentId,
      message,
      finalStatus: status === 'failed' ? 'failed' : 'completed',
    })
    return report
  }

  private parseClaims(text: string): { claims: ClaimResult[] | undefined } {
    const raw = extractJsonBlock(text)
    const result = raw === undefined ? undefined : claimListSchema.safeParse(raw)
    if (!result?.success) return { claims: undefined }
    return {
      claims: result.data.claims.map((c) => ({
        claim: c.claim,
        kind: c.kind,
        verdict: c.verdict,
        evidenceIds: c.evidenceIds,
        sectionHeading: c.sectionHeading,
        note: c.note,
      })),
    }
  }

  /**
   * Current-state vs proposed-state claims are judged differently (plan §13
   * acceptance): a contradicted CURRENT claim fails its section; a PROPOSED
   * claim that differs from current implementation is intentional and only
   * surfaces as a note.
   */
  private judgeClaims(claims: ClaimResult[]): {
    claims: ClaimResult[]
    claimIssues: string[]
    failedSections: string[]
  } {
    const claimIssues: string[] = []
    const failedSections: string[] = []
    for (const c of claims) {
      if (c.kind === 'current') {
        if (c.verdict === 'contradicted') {
          if (c.sectionHeading && !failedSections.includes(c.sectionHeading)) failedSections.push(c.sectionHeading)
          claimIssues.push(`Claim "${c.claim.slice(0, 120)}" contradicts evidence — section "${c.sectionHeading ?? 'unknown'}" needs regeneration.`)
        } else if (c.verdict === 'unsupported') {
          claimIssues.push(`Claim "${c.claim.slice(0, 120)}" is unsupported by available evidence.`)
        } else if (c.verdict === 'weak') {
          claimIssues.push(`Claim "${c.claim.slice(0, 120)}" is only weakly supported.`)
        }
      } else if (c.verdict === 'contradicted') {
        claimIssues.push(`Proposed claim "${c.claim.slice(0, 120)}" conflicts with the current implementation — flagged for review (may be intentional).`)
      }
    }
    return { claims, claimIssues, failedSections }
  }

  // ── Cross-document consistency ─────────────────────────────────────────

  private async validateCrossDocument(node: TaskNode, ctx: NodeRunContext): Promise<CrossDocumentReport> {
    ctx.validationProgress({ phase: 'cross-document', message: 'Checking cross-document consistency' })

    const reports = ctx.dependencyOutputs
      .map(parseReport)
      .filter((r): r is DocumentValidationReport => r !== undefined && r.mode === 'document')
    const claims: Array<ClaimResult & { documentTitle: string }> = reports.flatMap((r) =>
      r.claims.map((c) => ({ ...c, documentTitle: r.title })),
    )
    if (claims.length < 2) {
      ctx.validationProgress({
        phase: 'cross-document',
        message: 'Cross-document check skipped — not enough validated claims to compare.',
      })
      return { mode: 'cross-document', status: 'passed', contradictions: [], issues: [] }
    }

    const claimsText = claims
      .map((c) => `- [${c.documentTitle}] (${c.kind}) ${c.claim}`)
      .join('\n')
      .slice(0, 16_000)

    const loop = await runToolLoop(
      this.deps.provider,
      this.deps.executor,
      { ...this.deps.baseConfig, tools: [], maxIterations: 1, maxToolCalls: 0, budgetController: ctx.budgetController, telemetryContext: { ...this.deps.baseConfig.telemetryContext, taskId: ctx.taskId, nodeId: node.id, workerType: 'validation' } },
      {
        text:
          `Compare these claims from the generated document set for CONTRADICTIONS:\n\n${claimsText}\n\n` +
          `Two claims contradict when they cannot both describe the same system. ` +
          `Ignore stylistic wording differences; only report real factual conflicts (technology, auth, storage, API, deployment, terminology, decisions).\n` +
          `Respond with ONLY a JSON block:\n` +
          '```json\n' +
          '{"contradictions":[{"a":"claim from one document","b":"the contradicting claim","note":"why they conflict"}]}\n' +
          '```',
        signal: ctx.signal,
        activity: () => {},
        context: { task: { nodeId: node.id, title: node.title, objective: node.objective, status: node.status, dependencies: node.dependencies } },
      },
    )

    const raw = extractJsonBlock(loop.text)
    const parsed = raw === undefined ? undefined : contradictionListSchema.safeParse(raw)
    const pairs = parsed?.success ? parsed.data.contradictions : []

    // Deterministic resolution against the fact base: a claim matching a
    // canonical fact wins; everything else is explicitly unresolved.
    const factStatements = new Map(this.deps.facts.all().map((f) => [claimKey(f.statement), f.statement]))
    const contradictions: CrossDocumentContradiction[] = pairs.map((p) => {
      const factA = factStatements.get(claimKey(p.a))
      const factB = factStatements.get(claimKey(p.b))
      if (factA) return { a: p.a, b: p.b, note: p.note, resolved: true, resolution: `Fact base confirms: ${factA}` }
      if (factB) return { a: p.a, b: p.b, note: p.note, resolved: true, resolution: `Fact base confirms: ${factB}` }
      return { a: p.a, b: p.b, note: p.note, resolved: false }
    })

    if (pairs.length === 0 && loop.text.trim().length > 0) {
      ctx.validationProgress({
        phase: 'cross-document',
        message: 'Cross-document validator returned no parseable comparison — treated as a validation gap.',
      })
    }

    const unresolved = contradictions.filter((c) => !c.resolved)
    const issues = unresolved.map(
      (c) => `Unresolved contradiction: "${c.a.slice(0, 100)}" vs "${c.b.slice(0, 100)}"${c.note ? ` (${c.note.slice(0, 200)})` : ''}.`,
    )
    const message =
      unresolved.length > 0
        ? `Cross-document check: ${unresolved.length} unresolved contradiction(s) — see the validation summary.`
        : `Cross-document check: ${contradictions.length} contradiction(s), all resolved by the fact base.`
    ctx.validationProgress({ phase: 'cross-document', message })

    return { mode: 'cross-document', status: unresolved.length > 0 ? 'issues' : 'passed', contradictions, issues }
  }
}
