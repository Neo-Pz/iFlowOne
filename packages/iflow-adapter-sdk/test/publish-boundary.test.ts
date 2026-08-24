/**
 * The publish boundary.
 *
 * Some facts are local by definition, not secret by accident. This suite is
 * the structural guarantee: a fact excluded here never reaches the outbox at
 * all, so no redaction bug, sync misconfiguration, or future upload path can
 * carry it off the machine. Scrubbing on the way out is a weaker promise —
 * it holds only as long as every scrubber is correct.
 */

import { describe, expect, it } from 'vitest'

import type { AnyIFlowEvent } from 'iflow-domain'

import { createEdge, isPublishable } from '../src/create-edge.js'
import { createMemoryHost } from '../src/testing.js'

function fact(type: string): AnyIFlowEvent {
  return { type } as AnyIFlowEvent
}

describe('isPublishable', () => {
  it('keeps every conversation fact on the machine that observed it', () => {
    for (const type of [
      'conversation.opened',
      'conversation.message_sent',
      'conversation.message_received',
      'conversation.accepted',
      'conversation.rejected',
      'conversation.closed',
    ]) {
      expect(isPublishable(fact(type))).toBe(false)
    }
  })

  it('keeps workspace bindings local', () => {
    expect(isPublishable(fact('workspace.bound'))).toBe(false)
  })

  it('publishes relations — a network is made of them', () => {
    expect(isPublishable(fact('relation.recorded'))).toBe(true)
  })

  it('leaves every pre-existing fact publishable', () => {
    for (const type of [
      'agent.registered',
      'agent.presence_changed',
      'task.created',
      'task.completed',
      'tool.call_started',
      'approval.requested',
      'a2a.request_received',
      'usage.recorded',
      'quote.offered',
      'task.settled',
    ]) {
      expect(isPublishable(fact(type))).toBe(true)
    }
  })
})

describe('the outbox never sees a local-only fact', () => {
  it('journals a conversation and projects it, but queues nothing', async () => {
    const host = createMemoryHost()
    const edge = await createEdge({ ports: host.ports, descriptor: host.descriptor })

    const before = edge.outbox.pending().length

    await edge.observer.conversationOpened({
      conversationId: 'conv-1',
      initiatedBy: 'agent-a',
      participants: [
        { agentId: 'agent-a', role: 'initiator', joinedAt: '2026-01-01T00:00:00.000Z', principalId: 'owner-a' },
        { agentId: 'agent-b', role: 'recipient', joinedAt: '2026-01-01T00:00:00.000Z', principalId: 'owner-b' },
      ],
    })
    await edge.observer.conversationMessageReceived({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      fromAgentId: 'agent-a',
      contentDigest: 'sha256:deadbeef',
      actorType: 'human',
      origin: 'keyboard',
    })
    await edge.observer.workspaceBound({ agentId: 'agent-a' })

    // The facts exist locally: they are in the journal and in the read model.
    expect(edge.journal.all().some((e) => e.type === 'conversation.opened')).toBe(true)
    expect(edge.views.conversations().data.conversations).toHaveLength(1)
    expect(edge.views.requests().data.requests).toHaveLength(1)

    // And nothing about them is queued to leave.
    expect(edge.outbox.pending()).toHaveLength(before)

    edge.dispose()
  })

  it('still queues an ordinary fact recorded alongside them', async () => {
    const host = createMemoryHost()
    const edge = await createEdge({ ports: host.ports, descriptor: host.descriptor })

    await edge.observer.conversationOpened({
      conversationId: 'conv-2',
      initiatedBy: 'agent-a',
      participants: [{ agentId: 'agent-a', role: 'initiator', joinedAt: '2026-01-01T00:00:00.000Z' }],
    })
    await edge.observer.agentRegistered({ agentId: 'agent-a', label: 'A' })

    const queuedTypes = edge.outbox
      .pending()
      .map((entry) => edge.journal.all().find((e) => e.id === entry.eventId)?.type)
    expect(queuedTypes).toContain('agent.registered')
    expect(queuedTypes).not.toContain('conversation.opened')

    edge.dispose()
  })

  it('derives crossesOwnershipBoundary rather than trusting a caller', async () => {
    const host = createMemoryHost()
    const edge = await createEdge({ ports: host.ports, descriptor: host.descriptor })

    await edge.observer.conversationOpened({
      conversationId: 'conv-same',
      initiatedBy: 'agent-a',
      participants: [
        { agentId: 'agent-a', role: 'initiator', joinedAt: '2026-01-01T00:00:00.000Z', principalId: 'owner-a' },
        { agentId: 'agent-b', role: 'recipient', joinedAt: '2026-01-01T00:00:00.000Z', principalId: 'owner-a' },
      ],
    })
    await edge.observer.conversationOpened({
      conversationId: 'conv-cross',
      initiatedBy: 'agent-a',
      participants: [
        { agentId: 'agent-a', role: 'initiator', joinedAt: '2026-01-01T00:00:00.000Z', principalId: 'owner-a' },
        { agentId: 'agent-c', role: 'recipient', joinedAt: '2026-01-01T00:00:00.000Z', principalId: 'owner-c' },
      ],
    })

    const byId = Object.fromEntries(
      edge.views.conversations().data.conversations.map((c) => [c.conversationId, c]),
    )
    expect(byId['conv-same']?.crossesOwnershipBoundary).toBe(false)
    expect(byId['conv-cross']?.crossesOwnershipBoundary).toBe(true)

    edge.dispose()
  })
})
