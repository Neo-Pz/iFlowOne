/**
 * Conversation semantics.
 *
 * The distinction these tests defend: a Conversation is a durable thread
 * between Agents on the network, and a Session is a Runtime's private
 * execution container. Nothing in this file — and nothing in the projections
 * it exercises — may carry what was actually said.
 */

import { describe, expect, it } from 'vitest'

import type { AnyIFlowEvent } from '../src/event-types.js'
import type { ConversationParticipant } from '../src/objects.js'
import { reduceEvents, relationKeyOf } from '../src/reducers/network-state.js'
import {
  projectConversations,
  projectNetworkGraph,
  projectRequests,
  summarizeEvent,
} from '../src/projectors/index.js'

let seq = 0
function event<T>(
  type: string,
  subject: AnyIFlowEvent['subject'],
  payload: T,
  extra: Partial<AnyIFlowEvent> = {},
): AnyIFlowEvent {
  seq += 1
  return {
    id: `evt-${seq}`,
    schemaVersion: 1,
    origin: { nodeId: 'node-1', streamId: 'edge', seq },
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    correlationId: 'corr-1',
    type,
    issuer: { id: 'agent-a', kind: 'agent' },
    subject,
    payload,
    ...extra,
  } as AnyIFlowEvent
}

const options = { builtAt: '2026-01-01T00:00:00.000Z' }

function participants(aPrincipal?: string, bPrincipal?: string): ConversationParticipant[] {
  return [
    { agentId: 'agent-a', role: 'initiator', joinedAt: '2026-01-01T00:00:00.000Z', principalId: aPrincipal },
    { agentId: 'agent-b', role: 'recipient', joinedAt: '2026-01-01T00:00:00.000Z', principalId: bPrincipal },
  ]
}

function opened(crosses = true, who = participants('owner-a', 'owner-b')): AnyIFlowEvent {
  return event(
    'conversation.opened',
    { kind: 'conversation', id: 'conv-1' },
    { participants: who, initiatedBy: 'agent-a', crossesOwnershipBoundary: crosses },
    { conversationId: 'conv-1' },
  )
}

describe('conversation lifecycle', () => {
  it('opens pending — an opening is not an agreement to talk', () => {
    const state = reduceEvents([opened()])
    const conversation = state.conversations['conv-1']
    expect(conversation?.state).toBe('pending')
    expect(conversation?.participants.map((p) => p.agentId)).toEqual(['agent-a', 'agent-b'])
  })

  it('becomes active only after acceptance', () => {
    const state = reduceEvents([
      opened(),
      event(
        'conversation.accepted',
        { kind: 'conversation', id: 'conv-1' },
        { acceptedBy: 'agent-b', decidedBy: 'human' },
        { conversationId: 'conv-1' },
      ),
      event(
        'conversation.message_received',
        { kind: 'conversation', id: 'conv-1' },
        {
          messageId: 'msg-1',
          fromAgentId: 'agent-a',
          actorType: 'human',
          origin: 'keyboard',
          contentDigest: 'sha256:beef',
        },
        { conversationId: 'conv-1' },
      ),
    ])
    expect(state.conversations['conv-1']?.state).toBe('active')
    expect(state.conversations['conv-1']?.lastMessageId).toBe('msg-1')
  })

  it('does not let traffic revive a thread someone already rejected', () => {
    const state = reduceEvents([
      opened(),
      event(
        'conversation.rejected',
        { kind: 'conversation', id: 'conv-1' },
        { rejectedBy: 'agent-b', decidedBy: 'human' },
        { conversationId: 'conv-1' },
      ),
      event(
        'conversation.message_received',
        { kind: 'conversation', id: 'conv-1' },
        {
          messageId: 'msg-2',
          fromAgentId: 'agent-a',
          actorType: 'agent',
          origin: 'a2a',
          contentDigest: 'sha256:cafe',
        },
        { conversationId: 'conv-1' },
      ),
    ])
    // The message is still a fact and still recorded; what it must not do is
    // undo a decision a person made.
    expect(state.conversations['conv-1']?.state).toBe('rejected')
    expect(state.conversations['conv-1']?.lastMessageId).toBe('msg-2')
  })

  it('tolerates a message for a thread it never saw open', () => {
    const state = reduceEvents([
      event(
        'conversation.message_received',
        { kind: 'conversation', id: 'conv-9' },
        {
          messageId: 'msg-1',
          fromAgentId: 'agent-a',
          actorType: 'agent',
          origin: 'a2a',
          contentDigest: 'sha256:1234',
        },
        { conversationId: 'conv-9' },
      ),
    ])
    expect(state.conversations['conv-9']).toBeDefined()
  })
})

describe('ownership boundary', () => {
  it('is recorded when the participants answer to different Principals', () => {
    const state = reduceEvents([opened(true)])
    expect(state.conversations['conv-1']?.crossesOwnershipBoundary).toBe(true)
  })

  it('is absent for two Agents under one Principal', () => {
    const state = reduceEvents([opened(false, participants('owner-a', 'owner-a'))])
    expect(state.conversations['conv-1']?.crossesOwnershipBoundary).toBe(false)
  })
})

describe('no transcript, anywhere', () => {
  const state = reduceEvents([
    opened(),
    event(
      'conversation.message_sent',
      { kind: 'conversation', id: 'conv-1' },
      {
        messageId: 'msg-1',
        toAgentId: 'agent-b',
        actorType: 'human',
        origin: 'keyboard',
        contentDigest: 'sha256:deadbeef',
      },
      { conversationId: 'conv-1' },
    ),
  ])

  it('keeps no message text on the Conversation object', () => {
    expect(JSON.stringify(state.conversations['conv-1'])).not.toContain('sha256:deadbeef')
    expect(Object.keys(state.conversations['conv-1'] ?? {})).not.toContain('messages')
  })

  it('summarizes a message without quoting it', () => {
    const message = state.recent.find((e) => e.type === 'conversation.message_sent')
    const summary = summarizeEvent(message as AnyIFlowEvent)
    expect(summary).toContain('agent-b')
    expect(summary).toContain('human')
    expect(summary).not.toContain('sha256:deadbeef')
  })
})

describe('the requests inbox', () => {
  it('lists a pending conversation as something waiting on a human', () => {
    const view = projectRequests(reduceEvents([opened()]), options)
    expect(view.data.requests).toHaveLength(1)
    expect(view.data.requests[0]).toMatchObject({
      kind: 'conversation',
      conversationId: 'conv-1',
      fromAgentId: 'agent-a',
      state: 'pending',
    })
  })

  it('carries no excerpt — the preview never leaves local state', () => {
    const view = projectRequests(reduceEvents([opened()]), options)
    expect(view.data.requests[0]).not.toHaveProperty('preview')
  })

  it('drops the request once the conversation is answered', () => {
    const state = reduceEvents([
      opened(),
      event(
        'conversation.accepted',
        { kind: 'conversation', id: 'conv-1' },
        { acceptedBy: 'agent-b', decidedBy: 'policy' },
        { conversationId: 'conv-1' },
      ),
    ])
    expect(projectRequests(state, options).data.requests).toHaveLength(0)
    expect(projectConversations(state, options).data.pending).toBe(0)
  })
})

describe('relations as the source of the network graph', () => {
  const recorded = (type: string) =>
    event(
      'relation.recorded',
      { kind: 'agent', id: 'agent-a' },
      { sourceAgentId: 'agent-a', targetAgentId: 'agent-b', type },
    )

  it('counts reassertions as strength rather than duplicating the edge', () => {
    const state = reduceEvents([recorded('worked_with'), recorded('worked_with')])
    const relation = state.relations[relationKeyOf('agent-a', 'agent-b', 'worked_with')]
    expect(relation?.strength).toBe(2)
    expect(Object.keys(state.relations)).toHaveLength(1)
  })

  it('draws an agent-to-agent edge that no Task produced', () => {
    const state = reduceEvents([recorded('trusted')])
    const graph = projectNetworkGraph(state, options)
    const edge = graph.data.edges.find((e) => e.id.startsWith('rel:'))
    expect(edge).toMatchObject({ source: 'agent-a', target: 'agent-b', kind: 'trust' })
  })

  it('maps each relation type onto a distinct edge kind', () => {
    const state = reduceEvents([
      recorded('contacted'),
      recorded('worked_with'),
      recorded('transacted_with'),
      recorded('delegated_to'),
    ])
    const kinds = projectNetworkGraph(state, options)
      .data.edges.filter((e) => e.id.startsWith('rel:'))
      .map((e) => e.kind)
      .sort()
    expect(kinds).toEqual(['collaboration', 'contact', 'delegation', 'transaction'])
  })
})

describe('workspace binding', () => {
  it('records the runtime and node without the path', () => {
    const bound = event('workspace.bound', { kind: 'agent', id: 'agent-a' }, {
      agentId: 'agent-a',
      runtime: 'dsh',
      nodeId: 'node-1',
    })
    const state = reduceEvents([bound])
    expect(state.agents['agent-a']).toMatchObject({ runtimeKind: 'dsh', nodeId: 'node-1' })
    expect(JSON.stringify(bound)).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//)
  })
})
