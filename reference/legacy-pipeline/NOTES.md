# Extra notes archived from the agent

## Former `PHASE_LABELS` (agentLoop)

```
project-charter → Project Charter
prd → Product Requirements Document (PRD)
system-design → System Design
dev → Development notes
qa → QA / verification
post-dev → Post Dev / handover
```

## Former charter-only system-prompt addendum (agentLoop)

When `phase === 'project-charter'`:

- Business Case FIRST, then measurable objectives (number/date/binary).
- Return anchors: `{ "businessCaseId", "objectivesId", "shortName" }` when drafting.
- Keep it short (≤ ~1500–2000 words). Prefer custom blocks over long prose.

## Former on-disk filenames (formStateManager)

| Phase id | File |
|----------|------|
| project-charter | charter.json |
| prd | prd.json |
| system-design | system-design.json |
| dev | dev.json |
| qa | qa.json |
| post-dev | post-dev.json |

Live code now stores every doc as `<safe-id>.json` under `.charter-ai/`.
