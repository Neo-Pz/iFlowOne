/**
 * Principle 0 arrived after some facts were already written.
 *
 * The invariant is about what iFlow says from now on. It is not a licence to
 * reinterpret what it already said, and the difference is load-bearing: a
 * journal is the record of what happened, so a reader that quietly relabels a
 * `human`-issued fact as Agent-issued has forged the one thing the journal
 * exists to preserve. These pin the asymmetry — strict writer, tolerant
 * reader, and no rewriting in between.
 */

import { describe, expect, it } from 'vitest'

import { EVENT_SCHEMA_VERSION, isLegacyIssuer, validateEvent } from 'iflow-protocol'
import type { IFlowStoredIssuer } from 'iflow-protocol'

import { createEdge } from '../src/create-edge.js'
import { createMemoryHost } from '../src/testing.js'

/** A fact as it was legitimately written before the invariant existed. */
function legacyLine(seq: number, issuer: IFlowStoredIssuer): string {
  return JSON.stringify({
    id: `evt-legacy-${seq}`,
    schemaVersion: EVENT_SCHEMA_VERSION,
    origin: { nodeId: 'node-test', streamId: 'edge', seq },
    occurredAt: '2026-01-01T00:00:00.000Z',
    correlationId: 'corr-legacy',
    visibility: 'local',
    type: 'task.created',
    issuer,
    subject: { kind: 'task', id: `task-legacy-${seq}` },
    payload: { title: 'Written before principle 0' },
  })
}

describe('A3 — pre-principle-0 facts stay readable and stay as written', () => {
  it('opens a journal holding human- and system-issued facts', async () => {
    const host = createMemoryHost()
    const edge = await createEdge({ ports: host.ports, descriptor: host.descriptor })
    const existing = host.storage.files.get(edge.paths.origin) ?? ''
    host.storage.files.set(
      edge.paths.origin,
      `${existing}${legacyLine(900, { id: 'user-1', kind: 'human' })}\n` +
        `${legacyLine(901, { id: 'node-test', kind: 'system' })}\n`,
    )
    edge.dispose()

    const reopened = await createEdge({ ports: host.ports, descriptor: host.descriptor, registerSelf: false })
    const legacy = reopened.journal.all().filter((event) => isLegacyIssuer(event.issuer))

    expect(reopened.journal.skippedLineCount, 'history was read as corruption').toBe(0)
    expect(legacy.map((event) => event.issuer.kind)).toEqual(['human', 'system'])
    // The point of the whole exercise: read, marked, not rewritten.
    expect(legacy[0]?.issuer.id).toBe('user-1')
  })

  it('refuses to emit what it is willing to read', async () => {
    const host = createMemoryHost()
    const edge = await createEdge({ ports: host.ports, descriptor: host.descriptor })

    await expect(
      edge.journal.record({
        type: 'task.created',
        subject: { kind: 'task', id: 'task-new' },
        // Only reachable by lying to the compiler, which is the point: the
        // type says no and the runtime says no for the same reason.
        issuer: { id: 'user-1', kind: 'human' } as never,
        payload: { title: 'New' },
      }),
    ).rejects.toThrow(/issuer\.kind/)
  })

  it('reads a legacy issuer and rejects the same envelope on the way out', () => {
    const candidate = JSON.parse(legacyLine(902, { id: 'user-1', kind: 'human' })) as unknown

    expect(validateEvent(candidate).valid, 'history became unreadable').toBe(true)
    expect(validateEvent(candidate, { emitting: true }).valid, 'history became re-emittable').toBe(false)
  })

  it('marks nothing legacy about an Agent-issued fact', async () => {
    const host = createMemoryHost()
    const edge = await createEdge({ ports: host.ports, descriptor: host.descriptor })
    await edge.observer.taskCreated({ taskId: 'task-1', title: 'One' })

    expect(edge.journal.all().every((event) => !isLegacyIssuer(event.issuer))).toBe(true)
  })
})
