import { describe, expect, it } from 'vitest'

import type { AnyIFlowEvent } from '../src/event-types.js'
import { reduceEvents } from '../src/reducers/network-state.js'
import { projectDiscoveryFeed, summarizeEvent } from '../src/projectors/index.js'

let sequence = 0

function event<T>(
  type: string,
  subject: AnyIFlowEvent['subject'],
  payload: T,
  issuerId = 'agent-publisher',
): AnyIFlowEvent {
  sequence += 1
  return {
    id: `evt-discovery-${sequence}`,
    schemaVersion: 1,
    origin: { nodeId: 'node-1', streamId: 'edge', seq: sequence },
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    correlationId: 'corr-discovery',
    type,
    issuer: { id: issuerId, kind: 'agent' },
    subject,
    payload,
  } as AnyIFlowEvent
}

function publication(id: string, overrides: Record<string, unknown> = {}): AnyIFlowEvent {
  return event('publication.created', { kind: 'publication', id }, {
    publicationId: id,
    publishedByAgentId: 'agent-publisher',
    commitment: `sha256:${id}`,
    commitmentScheme: 'iflow-commitment-v1',
    visibility: 'public',
    kind: 'offer',
    summary: `Offer ${id}`,
    domains: ['research'],
    capabilities: ['iflow.cap:research'],
    tags: ['analysis'],
    expectedResponses: ['contact'],
    expiresAt: '2026-02-01T00:00:00.000Z',
    ...overrides,
  })
}

describe('public discovery publications', () => {
  it('projects active Agent-signed publications and makes filters explicit', () => {
    const state = reduceEvents([
      publication('pub-offer'),
      publication('pub-request', {
        kind: 'request',
        domains: ['translation'],
        capabilities: ['iflow.cap:translation'],
        tags: ['zh'],
      }),
    ])

    const view = projectDiscoveryFeed(state, { builtAt: '2026-01-15T00:00:00.000Z' }, {
      kinds: ['request'],
      capability: 'iflow.cap:translation',
    })

    expect(view.meta.projectionVersion).toBe(1)
    expect(view.data.filter).toEqual({ kinds: ['request'], capability: 'iflow.cap:translation' })
    expect(view.data.publications).toHaveLength(1)
    expect(view.data.publications[0]?.publication.publicationId).toBe('pub-request')
    expect(view.data.publications[0]?.state).toBe('active')
  })

  it('hides expired and withdrawn facts by default without changing history', () => {
    const created = publication('pub-short', { expiresAt: '2026-01-02T00:00:00.000Z' })
    const withdrawn = event('publication.withdrawn', { kind: 'publication', id: 'pub-short' }, {
      publicationId: 'pub-short',
      publishedByAgentId: 'agent-publisher',
      reason: 'capacity changed',
    })
    const state = reduceEvents([created, withdrawn])

    const active = projectDiscoveryFeed(state, { builtAt: '2026-01-01T12:00:00.000Z' })
    expect(active.data.publications).toEqual([])

    const history = projectDiscoveryFeed(state, { builtAt: '2026-01-03T00:00:00.000Z' }, { includeInactive: true })
    expect(history.data.publications).toHaveLength(1)
    expect(history.data.publications[0]?.state).toBe('withdrawn')
    expect(history.data.publications[0]?.publication.summary).toBe('Offer pub-short')
    expect(state.publications['pub-short']?.withdrawalReason).toBe('capacity changed')
  })

  it('refuses an Agent attempting to publish or withdraw on another Agent’s behalf', () => {
    const forged = event('publication.created', { kind: 'publication', id: 'pub-forged' }, {
      publicationId: 'pub-forged',
      publishedByAgentId: 'agent-owner',
      commitment: 'sha256:forged',
      commitmentScheme: 'iflow-commitment-v1',
      visibility: 'public',
      kind: 'alert',
      summary: 'Forged',
      domains: ['security'],
      expiresAt: '2026-02-01T00:00:00.000Z',
    }, 'agent-attacker')
    const valid = publication('pub-valid')
    const badWithdrawal = event('publication.withdrawn', { kind: 'publication', id: 'pub-valid' }, {
      publicationId: 'pub-valid',
      publishedByAgentId: 'agent-publisher',
    }, 'agent-attacker')

    const state = reduceEvents([forged, valid, badWithdrawal])
    expect(state.publications['pub-forged']).toBeUndefined()
    expect(state.publications['pub-valid']?.withdrawnAt).toBeUndefined()
  })

  it('does not let a reused publication id rewrite a signed public fact', () => {
    const first = publication('pub-immutable', { summary: 'Original public statement' })
    const attemptedRewrite = publication('pub-immutable', { summary: 'Replacement public statement' })
    const state = reduceEvents([first, attemptedRewrite])

    expect(state.publications['pub-immutable']?.summary).toBe('Original public statement')
  })

  it('labels public discovery in activity without claiming it grants authority', () => {
    const publicationEvent = publication('pub-summary')
    expect(summarizeEvent(publicationEvent)).toBe('Agent agent-publisher published offer: Offer pub-summary')
  })
})
