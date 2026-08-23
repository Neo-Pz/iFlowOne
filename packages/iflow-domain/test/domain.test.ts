/**
 * Domain semantics that the conformance suite exercises only indirectly.
 */

import { describe, expect, it } from 'vitest'

import type { AnyIFlowEvent } from '../src/event-types.js'
import { EVENT_TYPES, isKnownEventType } from '../src/event-types.js'
import { TASK_TRANSITIONS, canTransition } from '../src/objects.js'
import { emptyNetworkState, reduceEvents } from '../src/reducers/network-state.js'
import { projectActivityFeed, projectNetworkGraph, projectTaskGraph, summarizeEvent } from '../src/projectors/index.js'

let seq = 0
function event<T>(type: string, subject: AnyIFlowEvent['subject'], payload: T, extra: Partial<AnyIFlowEvent> = {}): AnyIFlowEvent {
  seq += 1
  return {
    id: `evt-${seq}`,
    schemaVersion: 1,
    origin: { nodeId: 'node-1', streamId: 'edge', seq },
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    correlationId: 'corr-1',
    type,
    issuer: { id: 'agent-1', kind: 'agent' },
    subject,
    payload,
    ...extra,
  } as AnyIFlowEvent
}

describe('task state machine', () => {
  it('treats completed as terminal', () => {
    expect(TASK_TRANSITIONS.completed).toHaveLength(0)
    expect(canTransition('completed', 'running')).toBe(false)
  })

  it('allows a failed task to be retried', () => {
    expect(canTransition('failed', 'running')).toBe(true)
  })

  it('lets a blocked task resume without inventing an intermediate state', () => {
    expect(canTransition('blocked', 'running')).toBe(true)
    expect(canTransition('awaiting_approval', 'running')).toBe(true)
  })
})

describe('the second identity layer', () => {
  const claim = { did: 'did:key:zPrincipal', grantRef: 'sha256:abcd', label: 'Acme Ltd' }

  it('records who an Agent answers to', () => {
    const state = reduceEvents([
      event('agent.registered', { kind: 'agent', id: 'a1' }, {
        label: 'writer',
        nodeId: 'node-1',
        runtimeKind: 'dsh',
        capabilities: ['iflow.cap:task.run'],
        principal: claim,
      }),
    ])

    expect(state.agents.a1?.principal).toEqual(claim)
  })

  it('reads a fact written before the field existed', () => {
    // The whole promise of an additive change: a journal recorded by an older
    // build still folds, and an Agent nobody has claimed says so by absence
    // rather than by failing to load.
    const state = reduceEvents([
      event('agent.registered', { kind: 'agent', id: 'a1' }, {
        label: 'writer',
        nodeId: 'node-1',
        runtimeKind: 'dsh',
        capabilities: [],
      }),
    ])

    expect(state.agents.a1).toBeDefined()
    expect(state.agents.a1?.principal).toBeUndefined()
  })

  it('does not disown an Agent that merely restarted', () => {
    // A node re-registers its agents on every boot, and an older build — or a
    // node whose principal key is temporarily unavailable — would omit the
    // claim. Treating that as "disowned" would silently drop accountability.
    const state = reduceEvents([
      event('agent.registered', { kind: 'agent', id: 'a1' }, {
        label: 'writer',
        nodeId: 'node-1',
        runtimeKind: 'dsh',
        capabilities: [],
        principal: claim,
      }),
      event('agent.registered', { kind: 'agent', id: 'a1' }, {
        label: 'writer',
        nodeId: 'node-1',
        runtimeKind: 'dsh',
        capabilities: [],
      }),
    ])

    expect(state.agents.a1?.principal).toEqual(claim)
  })
})

describe('event vocabulary', () => {
  it('recognizes exactly the published types', () => {
    for (const type of EVENT_TYPES) expect(isKnownEventType(type)).toBe(true)
    expect(isKnownEventType('reputation.endorsed')).toBe(false)
  })

  it('summarizes every known type without falling back to the raw name', () => {
    // A summary that is just the type name means the feed would show a slug to
    // a human, so each type must have real prose.
    const samples: Partial<Record<string, AnyIFlowEvent>> = {
      'agent.registered': event('agent.registered', { kind: 'agent', id: 'a1' }, {
        label: 'lead',
        nodeId: 'node-1',
        runtimeKind: 'dsh',
        capabilities: [],
      }),
      'goal.created': event('goal.created', { kind: 'goal', id: 'g1' }, { title: 'Ship it' }),
      'task.blocked': event('task.blocked', { kind: 'task', id: 't1' }, { reason: 'needs input' }),
      'tool.call_completed': event('tool.call_completed', { kind: 'task', id: 't1' }, {
        callId: 'c1',
        toolName: 'bash',
        outcome: 'error',
        errorMessage: 'exit 1',
      }),
      'usage.recorded': event('usage.recorded', { kind: 'task', id: 't1' }, {
        model: 'deepseek-v4',
        tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
        costMicros: 1200,
        currency: 'USD',
        priceSource: 'pricing.json',
      }),
    }

    for (const [type, sample] of Object.entries(samples)) {
      const summary = summarizeEvent(sample as AnyIFlowEvent)
      expect(summary).not.toBe(type)
      expect(summary.length).toBeGreaterThan(0)
    }

    expect(summarizeEvent(event('tool.call_completed', { kind: 'task', id: 't1' }, {
      callId: 'c1',
      toolName: 'bash',
      outcome: 'error',
      errorMessage: 'exit 1',
    }))).toBe('Tool bash error: exit 1')
  })

  it('passes an unrecognized type through untouched', () => {
    expect(summarizeEvent(event('reputation.endorsed', { kind: 'agent', id: 'a1' }, {}))).toBe('reputation.endorsed')
  })
})

describe('projectors', () => {
  it('starts from an empty, well-formed state', () => {
    const view = projectNetworkGraph(emptyNetworkState(), { builtAt: '2026-01-01T00:00:00.000Z' })
    expect(view.data.nodes).toHaveLength(0)
    expect(view.meta.eventCount).toBe(0)
    expect(view.meta.cursor).toBeUndefined()
  })

  it('never emits an edge whose endpoints are missing', () => {
    const state = reduceEvents([
      event('task.created', { kind: 'task', id: 't1' }, { title: 'One', dependsOn: ['t-nonexistent'] }),
    ])
    const graph = projectNetworkGraph(state, { builtAt: '2026-01-01T00:00:00.000Z' }).data
    expect(graph.edges).toHaveLength(0)
  })

  it('ranks task-graph nodes by depth so a DAG renders top-down', () => {
    const state = reduceEvents([
      event('task.created', { kind: 'task', id: 'root' }, { title: 'Root' }),
      event('task.created', { kind: 'task', id: 'child' }, { title: 'Child', parentTaskId: 'root' }),
      event('task.created', { kind: 'task', id: 'grandchild' }, { title: 'Grandchild', parentTaskId: 'child' }),
    ])
    const view = projectTaskGraph(state, { builtAt: '2026-01-01T00:00:00.000Z' }).data
    expect(view.nodes.map((n) => n.depth)).toEqual([0, 1, 2])
  })

  it('does not hang on a malformed parent cycle', () => {
    const state = reduceEvents([
      event('task.created', { kind: 'task', id: 'a' }, { title: 'A', parentTaskId: 'b' }),
      event('task.created', { kind: 'task', id: 'b' }, { title: 'B', parentTaskId: 'a' }),
    ])
    const view = projectTaskGraph(state, { builtAt: '2026-01-01T00:00:00.000Z' }).data
    expect(view.nodes).toHaveLength(2)
  })

  it('reports truncation instead of silently dropping history', () => {
    const events = Array.from({ length: 600 }, (_, i) =>
      event('task.created', { kind: 'task', id: `t${i}` }, { title: `T${i}` }),
    )
    const feed = projectActivityFeed(reduceEvents(events), { builtAt: '2026-01-01T00:00:00.000Z' }).data
    expect(feed.truncated).toBe(true)
    expect(feed.entries.length).toBeLessThan(events.length)
  })

  it('keeps the fold immutable so an earlier state stays valid', () => {
    const first = reduceEvents([event('task.created', { kind: 'task', id: 't1' }, { title: 'One' })])
    const second = reduceEvents([
      event('task.created', { kind: 'task', id: 't1' }, { title: 'One' }),
      event('task.completed', { kind: 'task', id: 't1' }, {}),
    ])
    expect(first.tasks['t1']?.state).toBe('created')
    expect(second.tasks['t1']?.state).toBe('completed')
  })
})
