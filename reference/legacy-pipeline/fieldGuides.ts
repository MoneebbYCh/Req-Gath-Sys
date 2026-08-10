export const CHARTER_GUIDE = `PROJECT CHARTER — PRACTITIONER SCHEMA (authorization + soft agreement)

Dual framing the agent must internalize:
1) Formal: sponsor/initiator issues the charter authorizing the project and giving the PM
   authority to apply organizational resources.
2) Practical: it is a soft agreement between PM and owners NOT to change timeline, scope,
   or budget without proper consideration and impact analysis.
Every draft field should answer: "If this changes later, could we point here and say
that is outside what was agreed?"

HARD LENGTH CONSTRAINT (enforce, do not merely suggest):
Keep the charter short — readable in a few minutes. Target ≤ ~1500–2000 words
(about 5 pages equivalent). If a draft would bloat past that, compress; verbosity is failure.

SECTION SCHEMA (hard-code this structure):
Required every time:
- Project Title & Short Name (heading + short abbreviation for downstream PRD/design naming)
- Project Description (plain language vision + background; simplify jargon; ask what's deliberately NOT included)
- Assigned Project Manager (may default to the current user if known)
- PM's Authority Level (ALWAYS ask explicitly — users skip this; never silent-default)
- Business Case (MOST IMPORTANT — later changes get checked against this; if a change isn't
  aligned with the business case it should be rejected. Store with stable anchors.businessCaseId)
- Stakeholders (names + role only — in-depth analysis is later phases)
- Known Requirements (high-level only; may point to other docs — natural handoff to PRD)
- Deliverables
- Assumptions
- Constraints (timeline, deadline/must-dates, must-have scope, budget, resources — ask each category)
- Measurable Objectives (STRICT GATE — concrete & measurable; store anchors.objectivesId)
- Approval Requirements (who approves what, at which milestone)
- Project Risks (high-level only)
- Sponsor Signature / sign-off (even if informal/digital)

Conditional:
- Preassigned Resources — skip gracefully for solo/small teams; do not force

ELICITATION ORDER (do not let the user skip):
1. Business Case FIRST — problem, why now, cost of inaction — BEFORE objectives or deep scope.
2. Project Description + explicit "what is deliberately NOT included?"
3. Measurable Objectives — each must contain a number, date, or binary success condition.
   If user says "improve performance," push back: by how much, measured how, by when?
4. Constraints as a forced checklist across: timeline, budget, must-have scope, resources, tooling/platform.
5. Stakeholders + Deliverables + Risks — one line each, high-level only.
6. Approval Requirements — who signs off on what.

Never let the user skip Business Case to jump to objectives.
Never accept an objective without a measurable condition.`

export const PRD_GUIDE = `PRODUCT REQUIREMENTS DOCUMENT — canvas (not fixed form fields)

Purpose: translate the approved Charter into buildable product requirements.
Trace every major requirement back to charter business case / objectives when possible
(reference anchors.businessCaseId / anchors.objectivesId / shortName if present).

HARD LENGTH: prefer decision-dense docs. Target ≤ ~2500–3500 words unless the user asks for depth.

Suggested structure (use headings + custom blocks freely):
1. Title / Short Name (align with charter)
2. Solution overview (paragraphs) + scopeBounds (in / out)
3. Goals & success metrics — kpiGrid where measurable
4. Personas / primary users (short callouts or bullets)
5. Functional requirements — epics / user stories / acceptance criteria (bullets or tables via prose)
6. Non-functional requirements — performance, security, scalability, compliance, usability
7. Data & AI considerations (if relevant)
8. Integrations & rollout notes
9. Risks / open questions — riskList
10. Review & sign-off — callout

Prefer custom blocks (callout, kpiGrid, scopeBounds, stakeholderTable, riskList) over long prose.
Do not invent custom block types beyond the catalog.`

export const SYSTEM_DESIGN_GUIDE = `SYSTEM DESIGN — canvas technical blueprint

Purpose: decide how the PRD will be built. Decision-dense; no novel-length architecture essays.
Reference PRD / charter shortName and objectives when choices trade off against them.

HARD LENGTH: ≤ ~2000–3000 words unless asked for deep dive.

Suggested structure:
1. Architecture summary (heading + paragraphs) + key components
2. Data design — stores, core entities, retention
3. Model / AI design (if applicable) — selection, eval, fallback
4. APIs & interfaces — endpoints / contracts (bullets)
5. Infrastructure & deployment — hosting, scaling, CI/CD, monitoring, security
6. Key design decisions — callouts with rationale / alternatives considered
7. Risks & open questions — riskList
8. Design review / sign-off — callout

Prefer custom blocks for decisions, scope, risks. Do not invent new block types.`

export const DEV_GUIDE = `DEVELOPMENT NOTES — canvas

Purpose: implementation plan and working notes against System Design + PRD.
Keep actionable: spikes, milestones, integration checklist, demo script.

Suggested structure:
1. Build plan / milestones
2. Spikes & unknowns
3. Implementation notes by component
4. Integration checklist
5. Demo / internal review criteria
6. Open blockers — riskList or callouts`

export const QA_GUIDE = `QA / VERIFICATION — canvas

Purpose: prove the build meets PRD acceptance criteria and charter objectives.
Evidence over prose.

Suggested structure:
1. Test plan overview
2. Acceptance criteria checklist (trace to PRD)
3. Model / AI eval notes (if applicable)
4. Regression / edge cases
5. Defects & risks — riskList
6. Sign-off — callout`

export const POST_DEV_GUIDE = `POST DEV / HANDOVER — canvas

Purpose: ship, monitor, and hand over. Close the loop on the original business case.

Suggested structure:
1. Release plan
2. Deployment steps / rollback
3. Monitoring & alerts
4. Runbooks / ownership
5. Stakeholder handover notes
6. Follow-ups vs charter objectives — callout or kpiGrid`

export function getFieldGuide(phase: string): string {
  if (phase === 'project-charter') return CHARTER_GUIDE
  if (phase === 'prd') return PRD_GUIDE
  if (phase === 'system-design') return SYSTEM_DESIGN_GUIDE
  if (phase === 'dev') return DEV_GUIDE
  if (phase === 'qa') return QA_GUIDE
  if (phase === 'post-dev') return POST_DEV_GUIDE
  return ''
}
