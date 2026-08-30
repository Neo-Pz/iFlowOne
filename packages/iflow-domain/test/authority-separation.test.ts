/**
 * The structural half of `docs/principles.md`.
 *
 * `discovery.test.ts` checks that Discovery behaves correctly. This file checks
 * that it cannot quietly stop being Discovery — that nobody adds the one field
 * which turns a recommendation into a permission, or promotes a view into the
 * domain, or collapses a field whose whole purpose is to have more values
 * later.
 *
 * Every failure here should read as "you are about to change what iFlow is",
 * not "you forgot a property".
 */

import { describe, expect, it } from 'vitest'

import { validateEvent } from 'iflow-protocol'

import type { AnyIFlowEvent } from '../src/event-types.js'
import { reduceEvents } from '../src/reducers/network-state.js'
import { projectActivityFeed, projectDiscoveryFeed } from '../src/projectors/index.js'
import { AUTHORITY_SHAPED, fieldsOf, keysDeep, prose, repoDoc, src } from './source.js'

function publication(id: string, overrides: Record<string, unknown> = {}): AnyIFlowEvent {
  return {
    id: `evt-${id}`,
    schemaVersion: 1,
    origin: { nodeId: 'node-1', streamId: 'edge', seq: 1 },
    occurredAt: '2026-01-01T00:00:00.000Z',
    correlationId: 'corr-authority',
    type: 'publication.created',
    issuer: { id: 'agent-publisher', kind: 'agent' },
    subject: { kind: 'publication', id },
    payload: {
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
    },
  } as AnyIFlowEvent
}

const feed = () =>
  projectDiscoveryFeed(
    reduceEvents([publication('pub-1')]),
    { builtAt: '2026-01-15T00:00:00.000Z' },
    {},
  )

/** The field names an interface declares, read from the source it is declared in. */
function fieldsOf(file: string, name: string): string[] {
  const text = src(file)
  const start = text.indexOf(`export interface ${name} {`)
  if (start < 0) throw new Error(`${name} is not declared in ${file}`)
  const body = text.slice(start, text.indexOf('\n}', start))
  return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!)
}

/** Every key appearing anywhere in a value, however deeply nested. */
function keysDeep(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysDeep(item, found)
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.add(key)
      keysDeep(child, found)
    }
  }
  return found
}

/** A well-formed envelope, so a failure below is about the issuer and nothing else. */
function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'evt-p0',
    schemaVersion: 2,
    origin: { nodeId: 'node-1', streamId: 'edge', seq: 1 },
    occurredAt: '2026-01-01T00:00:00.000Z',
    correlationId: 'corr-p0',
    visibility: 'local',
    type: 'task.created',
    issuer: { id: 'agent-a', kind: 'agent' },
    subject: { kind: 'task', id: 'task-1' },
    payload: { title: 'One' },
    ...overrides,
  }
}

function fact(
  type: string,
  subject: AnyIFlowEvent['subject'],
  payload: unknown,
  extra: Record<string, unknown> = {},
): AnyIFlowEvent {
  return { ...envelope({ type, subject, payload, ...extra }), id: `evt-${type}` } as AnyIFlowEvent
}

describe('principle 0 — the Human is a Principal, not a network Actor', () => {
  it('refuses a new fact issued by a person', () => {
    const result = validateEvent(envelope({ issuer: { id: 'user-1', kind: 'human' } }), { emitting: true })
    expect(result.valid).toBe(false)
    expect(result.issues.map((issue) => issue.path)).toContain('issuer.kind')
  })

  it('refuses a new fact issued by the runtime or the Community', () => {
    // The regression this exists to stop is not a return of `human`. It is
    // `human` coming back as `system`: a Community or a runtime signing a
    // social action with no accountable Agent behind it, which is principle 6
    // approached from the other side. Infrastructure that wants to attest
    // something says so in a fact of its own, under its own type.
    const result = validateEvent(envelope({ issuer: { id: 'hub-1', kind: 'system' } }), { emitting: true })
    expect(result.valid).toBe(false)
  })

  it('leaves exactly one kind of thing able to issue a fact', () => {
    // The behavioural tests above pass just as well against a set of two.
    // This is the one that notices a third value being added to it.
    expect(repoDoc('packages/iflow-protocol/src/validate.ts')).toContain(
      "const EMITTABLE_ISSUER_KINDS = new Set(['agent'])",
    )
  })

  it('reads a fact written before the invariant and refuses to re-emit it', () => {
    const legacy = envelope({ issuer: { id: 'user-1', kind: 'human' } })
    expect(validateEvent(legacy).valid, 'history became unreadable').toBe(true)
    expect(validateEvent(legacy, { emitting: true }).valid, 'history became re-emittable').toBe(false)
  })

  it('keeps human-typed words under an Agent network actor', () => {
    const state = reduceEvents([
      fact('conversation.opened', { kind: 'conversation', id: 'conv-1' }, {
        participants: [
          { agentId: 'agent-a', principalId: 'principal-1' },
          { agentId: 'agent-b', principalId: 'principal-2' },
        ],
        initiatedBy: 'agent-a',
        crossesOwnershipBoundary: true,
      }, { conversationId: 'conv-1' }),
      fact('conversation.message_sent', { kind: 'conversation', id: 'conv-1' }, {
        messageId: 'msg-1',
        toAgentId: 'agent-b',
        actorType: 'human',
        origin: 'keyboard',
        contentDigest: 'sha256:hello',
      }, { conversationId: 'conv-1', principalId: 'principal-1' }),
    ])

    const entry = projectActivityFeed(state, { builtAt: '2026-01-01T00:00:00.000Z' }).data.entries.find(
      (candidate) => candidate.type === 'conversation.message_sent',
    )

    // A person typed it; their Agent said it. Both facts survive the
    // projection, in different fields — that pair is what a UI renders as
    // `👤 You · via GenOnA`.
    expect(entry?.actorId).toBe('agent-a')
    expect(entry?.actorKind).toBe('agent')
    expect(entry?.contentOrigin).toBe('human')
    expect(entry?.principalId).toBe('principal-1')
  })

  it('records an Agent as the actor when a person clicks Accept', () => {
    const state = reduceEvents([
      fact('delivery.submitted', { kind: 'task', id: 'task-1' }, {
        deliveryId: 'del-1',
        byAgentId: 'agent-b',
        outputs: [],
        evidence: [],
      }, { taskId: 'task-1' }),
      fact('delivery.accepted', { kind: 'task', id: 'task-1' }, {
        deliveryId: 'del-1',
        acceptedByAgentId: 'agent-a',
        decidedBy: 'human',
      }, { taskId: 'task-1' }),
    ])

    const acceptance = state.tasks['task-1']?.deliveries[0]?.acceptance
    expect(state.tasks['task-1']?.state).toBe('completed')
    expect(acceptance?.ruledByAgentId, 'a person ended up in the actor field').toBe('agent-a')
    expect(acceptance?.decidedBy).toBe('human')
  })

  it('does not let a decision origin type itself as an identifier', () => {
    // The shape that produced the bug: one field holding either a person or
    // an Agent, with a `kind` beside it to say which. The self-acceptance
    // check compares that field against an Agent id, so a person in it made
    // the check compare two things that could never be equal, and it never
    // fired on exactly the path a person took.
    expect(src('event-types.ts')).not.toMatch(/decidedBy: string/)
    expect(src('objects.ts')).not.toMatch(/decidedBy: string/)
    // The declaration, not the prose: the comment above the payload explains
    // what the old pair got wrong, and is allowed to name it.
    expect(src('event-types.ts')).not.toMatch(/decidedByKind??:/)
    expect(src('objects.ts')).not.toMatch(/decidedByKind??:/)
    expect(src('objects.ts')).toContain("export type AcceptanceDecider = 'human' | 'policy'")
  })

  it('gives the activity view no way to name a person as the actor', () => {
    const declared = fieldsOf('views.ts', 'ActivityEntry')
    expect(declared).toContain('contentOrigin')
    expect(declared).toContain('principalId')
    // `legacy` is allowed and `human` is not: a pre-invariant fact is shown
    // as what it was, never relabelled, and never as a live actor kind.
    expect(src('views.ts')).toContain("actorKind: 'agent' | 'legacy'")
  })
})

describe('principle 1 — discovery evidence is not authority', () => {
  it('declares no field on a Publication that could be read as a permission', () => {
    // The guard that actually bites. The reducer whitelists payload fields, so
    // an authority-shaped key smuggled into an event never reaches a view — the
    // change that would matter is someone adding the field to this interface,
    // and this is the file they would open first.
    const declared = fieldsOf('objects.ts', 'Publication').map((f) => f.toLowerCase())
    const leaked = AUTHORITY_SHAPED.filter((key) => declared.includes(key.toLowerCase()))
    expect(leaked, `Publication would carry ${leaked.join(', ')}`).toEqual([])
  })

  it('declares no such field on what the feed hands back either', () => {
    for (const name of ['DiscoveryPublication', 'DiscoveryFeedView']) {
      const declared = fieldsOf('views.ts', name).map((f) => f.toLowerCase())
      const leaked = AUTHORITY_SHAPED.filter((key) => declared.includes(key.toLowerCase()))
      expect(leaked, `${name} would carry ${leaked.join(', ')}`).toEqual([])
    }
  })

  it('puts nothing in the projected feed that could be read as a permission', () => {
    // Weaker than the two above and kept deliberately: it watches the output
    // rather than the declaration, so it also covers a projector that computes
    // a field nobody declared.
    const keys = keysDeep(feed().data)
    const leaked = AUTHORITY_SHAPED.filter((key) => keys.has(key))
    expect(leaked, `discovery would hand the reader ${leaked.join(', ')}`).toEqual([])
  })

  it('gives the reader no way to reach the publisher from the feed alone', () => {
    // Contacting the publisher must go through the same policy path as any
    // other first contact. A DID is an identity to look up, not a route.
    const keys = keysDeep(feed().data)
    for (const route of ['endpoint', 'url', 'address', 'host', 'port']) {
      expect(keys.has(route), `the feed exposes ${route}`).toBe(false)
    }
  })

  it('says in the source that acting on a publication needs its own authorization', () => {
    // Prose, but load-bearing prose: it is what a reviewer is checked against
    // when someone proposes adding a "contact" button's worth of data here.
    expect(prose('objects.ts')).toMatch(/never gives the reader a right to/i)
    expect(prose('views.ts')).toMatch(/not a source of permission/i)
  })
})

describe('principle 2 — relationship, trust and grant stay separate', () => {
  it('keeps authority out of a relation', () => {
    const objects = src('objects.ts')
    const relation = objects.slice(
      objects.indexOf('export interface AgentRelation'),
      objects.indexOf('}', objects.indexOf('export interface AgentRelation')),
    )
    for (const field of ['grant', 'permission', 'allowed', 'scope', 'token']) {
      expect(relation.toLowerCase(), `AgentRelation carries ${field}`).not.toContain(field)
    }
  })

  it('keeps a relation’s count from reading as a reputation score', () => {
    const objects = src('objects.ts')
    expect(prose('objects.ts')).toMatch(/Not a reputation score/i)
    // `strength` counts reassertions. If it ever becomes a ratio or a rating,
    // the name stops describing it and principle 1 gets a number to lean on.
    expect(objects).not.toMatch(/trustScore|reputationScore|rating\s*:/i)
  })

  it('does not issue authority from this package', () => {
    // Grants are signed by a key in `iflow-id`. A grant that a projection can
    // mint is a grant nobody signed.
    const objects = src('objects.ts')
    expect(objects).not.toMatch(/export (interface|type) DelegationGrant\b/)
  })
})

describe('principle 3 — a feed is a projection, never a domain object', () => {
  it('defines the feed in the view layer only', () => {
    expect(src('views.ts')).toContain('DiscoveryFeedView')
    expect(src('objects.ts')).not.toContain('DiscoveryFeedView')
  })

  it('records no feed as a fact', () => {
    // Journalled facts are publications. A `feed.*` event would make a
    // rendering decision part of history.
    expect(src('event-types.ts')).not.toMatch(/'feed\./)
  })

  it('derives state at projection time instead of writing it back', () => {
    const state = reduceEvents([publication('pub-1')])
    const before = JSON.stringify(state)
    projectDiscoveryFeed(state, { builtAt: '2099-01-01T00:00:00.000Z' }, { includeInactive: true })
    expect(JSON.stringify(state), 'projecting mutated the journal state').toBe(before)
  })

  it('shows the same publication as expired later without changing history', () => {
    const state = reduceEvents([publication('pub-1')])
    const active = projectDiscoveryFeed(state, { builtAt: '2026-01-15T00:00:00.000Z' }, {})
    const later = projectDiscoveryFeed(
      state,
      { builtAt: '2026-03-01T00:00:00.000Z' },
      { includeInactive: true },
    )
    expect(active.data.publications[0]?.state).toBe('active')
    expect(later.data.publications[0]?.state).toBe('expired')
  })
})

describe('principle 4 — visibility is a field, not a constant', () => {
  it('carries visibility on the publication itself', () => {
    // If this is ever dropped because "it is always public", every stored fact
    // needs migrating on the day the second value arrives.
    expect(feed().data.publications[0]?.publication.visibility).toBe('public')
  })

  it('keeps a named type for it rather than inlining the literal', () => {
    const objects = src('objects.ts')
    expect(objects).toMatch(/export type PublicationVisibility/)
    expect(objects).toMatch(/visibility: PublicationVisibility/)
  })
})

describe('principle 5 — the four kinds', () => {
  it('are offer, request, signal and alert', () => {
    expect(src('objects.ts')).toContain(
      "export type PublicationKind = 'offer' | 'request' | 'signal' | 'alert'",
    )
  })
})

describe('principle 8 — a recommendation is named as one', () => {
  it('does not export a bare Match', () => {
    // Matching is not built yet. When it is, it is `MatchEvidence`: an opinion
    // with reasons, not a fact about two Agents. The guard is here now because
    // the name is chosen once and lived with.
    for (const file of ['objects.ts', 'views.ts', 'index.ts']) {
      expect(src(file), `${file} exports a bare Match`).not.toMatch(
        /export (interface|type|const) Match\b(?!Evidence)/,
      )
    }
  })
})
