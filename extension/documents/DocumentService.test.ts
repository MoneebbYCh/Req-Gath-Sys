import { describe, expect, it } from 'vitest'
import { DocumentService, memoryDocumentStore } from './DocumentService'
import type { DocumentIR } from './DocumentIR'

function ir(sections: DocumentIR['sections']): DocumentIR {
  return { title: 'Generated Doc', sections }
}

describe('DocumentService', () => {
  it('creates document types in the registry with an empty openable canvas', async () => {
    const store = memoryDocumentStore()
    const service = new DocumentService(store)

    const created = await service.createDocType('Security Architecture')
    expect(created.id).toBe('doc-security-architecture')
    expect(created.created).toBe(true)
    expect(store.docTypes).toHaveLength(1)

    const canvas = await service.loadDocument(created.id)
    expect(canvas?.blocks).toEqual([{ type: 'paragraph', content: '' }])

    // Collision-safe: same name gets a suffix, never overwrites.
    const second = await service.createDocType('Security Architecture')
    expect(second.id).not.toBe(created.id)
    expect(store.docTypes).toHaveLength(2)
  })

  it('does not lose a registry entry when documents are created concurrently', async () => {
    const store = memoryDocumentStore()
    // Introduce an async gap so two createDocType read-modify-writes interleave,
    // mirroring the parallel-document path that used to clobber one entry.
    const gapped: typeof store = {
      ...store,
      async listDocTypes() {
        await new Promise((r) => setTimeout(r, 5))
        return store.listDocTypes()
      },
      async saveDocTypes(data: unknown[]) {
        await new Promise((r) => setTimeout(r, 5))
        return store.saveDocTypes(data)
      },
    }
    const service = new DocumentService(gapped)

    const [a, b] = await Promise.all([
      service.createDocType('PRD'),
      service.createDocType('System Architecture'),
    ])

    const ids = (await service.listDocTypes()).map((v) => (v as { id: string }).id)
    expect(ids).toContain(a.id)
    expect(ids).toContain(b.id)
    expect(ids).toHaveLength(2)
  })

  it('checkpoints full rendered documents revision-safely', async () => {
    const store = memoryDocumentStore()
    const service = new DocumentService(store)
    const { id } = await service.createDocType('PRD')

    const first = await service.checkpoint(id, 0, ir([{ heading: 'Overview', blocks: [{ type: 'paragraph', text: 'one' }] }]))
    expect(first.ok).toBe(true)
    expect(first.conflict).toBe(false)
    expect(first.revision).toBe(1)

    const saved = await service.loadDocument(id)
    expect(saved?.blocks).toContainEqual({ type: 'paragraph', content: 'one' })

    const second = await service.checkpoint(id, 1, ir([{ heading: 'Overview', blocks: [{ type: 'paragraph', text: 'two' }] }]))
    expect(second.revision).toBe(2)
    expect((await service.loadDocument(id))?.blocks).toContainEqual({ type: 'paragraph', content: 'two' })
  })

  it('never overwrites user edits — parks the agent draft and reports the conflict', async () => {
    const store = memoryDocumentStore()
    const service = new DocumentService(store)
    const { id } = await service.createDocType('PRD')

    await service.checkpoint(id, 0, ir([{ heading: 'A', blocks: [{ type: 'paragraph', text: 'agent-1' }] }]))
    // User edits while the agent generates (revision 1 → 2).
    service.noteUserWrite(id)

    const result = await service.checkpoint(id, 1, ir([{ heading: 'A', blocks: [{ type: 'paragraph', text: 'agent-2' }] }]))
    expect(result.conflict).toBe(true)
    expect(result.pendingDraftId).toBeTruthy()

    // Disk still has the user's version — the agent draft was NOT applied.
    const saved = await service.loadDocument(id)
    expect(saved?.blocks).toContainEqual({ type: 'paragraph', content: 'agent-1' })

    const draft = service.pendingDraft(result.pendingDraftId!)
    expect(draft?.ir.sections[0].blocks[0]).toEqual({ type: 'paragraph', text: 'agent-2' })
    expect(service.pendingDraftsFor(id)).toHaveLength(1)
  })

  it('serializes a user save with an agent checkpoint so user content cannot be overwritten', async () => {
    const store = memoryDocumentStore()
    const service = new DocumentService(store)
    const { id } = await service.createDocType('PRD')

    await service.checkpoint(id, 0, ir([{ heading: 'A', blocks: [{ type: 'paragraph', text: 'agent-1' }] }]))
    const userCanvas = { version: 1, kind: 'blocknote' as const, blocks: [{ type: 'paragraph', content: 'user' }], anchors: {} }
    const [userRevision, agentResult] = await Promise.all([
      service.saveUserDocument(id, userCanvas),
      service.checkpoint(id, 1, ir([{ heading: 'A', blocks: [{ type: 'paragraph', text: 'agent-2' }] }])),
    ])

    expect(userRevision).toBe(2)
    expect(agentResult.conflict).toBe(true)
    expect((await service.loadDocument(id))?.blocks).toEqual(userCanvas.blocks)
  })

  it('restores parked drafts after restart', async () => {
    const store = memoryDocumentStore()
    const first = new DocumentService(store)
    const { id } = await first.createDocType('PRD')
    await first.checkpoint(id, 0, ir([{ heading: 'A', blocks: [{ type: 'paragraph', text: 'agent-1' }] }]))
    first.noteUserWrite(id)
    const parked = await first.checkpoint(id, 1, ir([{ heading: 'A', blocks: [{ type: 'paragraph', text: 'agent-2' }] }]))

    const restarted = new DocumentService(store)
    await restarted.ready()
    expect(restarted.pendingDraft(parked.pendingDraftId!)).toMatchObject({ documentId: id })
    expect(restarted.pendingDraftsFor(id)).toHaveLength(1)
  })

  it('rejects invalid IR instead of writing partial documents', async () => {
    const store = memoryDocumentStore()
    const service = new DocumentService(store)
    const { id } = await service.createDocType('PRD')

    const result = await service.checkpoint(id, 0, { title: 'x', sections: [{ heading: '', blocks: [] }] })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid document IR')
    // Nothing invalid was written to disk.
    const saved = await service.loadDocument(id)
    expect(saved?.blocks).toEqual([{ type: 'paragraph', content: '' }])
  })

  it('deletes the canvas file, registry entry, drafts, and agent IR', async () => {
    const store = memoryDocumentStore()
    const service = new DocumentService(store)
    const { id } = await service.createDocType('PRD')
    await service.checkpoint(id, 0, ir([{ heading: 'A', blocks: [{ type: 'paragraph', text: 'keep' }] }]))
    service.noteUserWrite(id)
    await service.checkpoint(id, 1, ir([{ heading: 'A', blocks: [{ type: 'paragraph', text: 'parked' }] }]))

    await service.deleteDocType(id)

    expect(await service.listDocTypes()).toEqual([])
    expect(await service.loadDocument(id)).toBeNull()
    expect(service.loadIR(id)).toBeNull()
    expect(service.pendingDraftsFor(id)).toHaveLength(0)
  })
})
