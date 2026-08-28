/**
 * The executable half of `docs/p3-acceptance.md`.
 *
 * P3 is the claim that two Agents on different machines can take on work,
 * deliver it, and be held to the result — before money exists. What makes that
 * claim worth anything is not the happy path but the prohibitions: no fact in
 * the chain may silently produce the next one's authority or conclusion.
 *
 *   Conversation ⇏ Relationship ⇏ Grant ⇏ Task ⇏ Delivery ⇏ Acceptance ≢ score
 *
 * Every guard below states its own strength. That matters here more than
 * usual: a weak test in this file would read as proof that a boundary holds,
 * which is worse than no test, because someone would stop checking.
 */

import { describe, expect, it } from 'vitest'

import type { AnyIFlowEvent } from '../src/event-types.js'
import { TASK_TRANSITIONS } from '../src/objects.js'
import { reduceEvents } from '../src/reducers/network-state.js'
import { AUTHORITY_SHAPED, fieldsOf, keysDeep, prose, repoDoc, src } from './source.js'

// ---------------------------------------------------------------------------
// The scenario registry.
//
// Each scenario in the document is in exactly one of three states, and the last
// test in this file proves that. `it.todo` was deliberately not used: a list of
// todos is a wish, while an unaccounted scenario here is a failure.
// ---------------------------------------------------------------------------

const covered = new Set<string>()

function scenario(id: string, name: string, fn: () => void) {
  covered.add(id)
  it(`${id} · ${name}`, fn)
}

/** Enforced, but not from this file — duplicating it here would let the two drift. */
const ENFORCED_ELSEWHERE: Record<string, string> = {
  'P3-10':
    'iflowone-ifo · apps/iflowone-community/test/opacity.test.mjs — the Community cannot read, sign for, or act as an offline Agent',
  'P3-11':
    'authority-separation.test.ts — a discovery result carries nothing readable as a right to make contact',
}

/** Not yet checkable, each with the thing it waits on. Shrinks as P3 lands. */
const PENDING: Record<string, string> = {
  'P3-03': 'grant.issued — the journal records no grant, so scope and expiry cannot be asserted',
  'P3-04': 'grant.issued — a Task has nothing to trace its authority to yet',
  'P3-05': 'grant.revoked — revocation exists in iflow-id, not as a recorded fact',
  'P3-06': 'the plugin re-checking policy on the accepting machine; not a domain fold',
  'P3-12': 'the whole chain; this is the graduation test and lands last',
  'P3-R-B': 'grant.issued and grant.revoked',
}

// ---------------------------------------------------------------------------

let seq = 0

function event(
  type: string,
  subject: AnyIFlowEvent['subject'],
  payload: unknown,
  issuerId = 'agent-a',
): AnyIFlowEvent {
  seq += 1
  return {
    id: `evt-collab-${seq}`,
    schemaVersion: 1,
    origin: { nodeId: 'node-a', streamId: 'edge', seq },
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    correlationId: 'corr-collab',
    type,
    issuer: { id: issuerId, kind: 'agent' },
    subject,
    payload,
  } as AnyIFlowEvent
}

const participant = (agentId: string, principalId: string) => ({
  agentId,
  principalId,
  did: `did:key:z${agentId}`,
})

describe('P3-01 — a conversation is not a relationship', () => {
  scenario('P3-01', 'talking to a stranger records no relation', () => {
    // Strong: folds the real reducer over real events. If anyone makes
    // `conversation.accepted` establish a relation because the two parties
    // "clearly know each other now", this fails.
    const state = reduceEvents([
      event('conversation.opened', { kind: 'conversation', id: 'conv-1' }, {
        participants: [participant('agent-a', 'principal-1'), participant('agent-b', 'principal-2')],
        initiatedBy: 'agent-a',
        crossesOwnershipBoundary: true,
      }),
      event('conversation.accepted', { kind: 'conversation', id: 'conv-1' }, {
        acceptedBy: 'agent-b',
        decidedBy: 'human',
      }),
    ])

    expect(state.conversations['conv-1']?.state).toBe('accepted')
    expect(Object.keys(state.relations), 'accepting a conversation established a relation').toEqual(
      [],
    )
  })

  it('says so where someone changing the reducer would read it', () => {
    // Weak by design: prose. It is what a reviewer is held to, not a guarantee.
    expect(prose('reducers/network-state.ts')).toMatch(/that separation IS the/i)
  })
})

describe('P3-02, P3-R-A, P3-R-D — a relationship is not a grant, and trust is not either', () => {
  scenario('P3-02', 'a recorded relation carries nothing a policy could spend', () => {
    // Strong on the declaration, which is where such a change would be made.
    const declared = fieldsOf('objects.ts', 'AgentRelation').map((f) => f.toLowerCase())
    const leaked = AUTHORITY_SHAPED.filter((key) => declared.includes(key.toLowerCase()))
    expect(leaked, `AgentRelation would carry ${leaked.join(', ')}`).toEqual([])
  })

  scenario('P3-R-A', 'folding a relation produces no authority either', () => {
    // Strong on the output, which also covers a reducer computing a field
    // nobody declared. Declaration and output together — the pairing the
    // discovery guards had to learn.
    const state = reduceEvents([
      event('relation.recorded', { kind: 'agent', id: 'agent-b' }, {
        sourceAgentId: 'agent-a',
        targetAgentId: 'agent-b',
        type: 'collaborates_with',
        visibility: 'public',
      }),
    ])

    const relation = Object.values(state.relations)[0]
    expect(relation, 'the relation was not recorded at all').toBeDefined()

    const keys = keysDeep(relation)
    const leaked = AUTHORITY_SHAPED.filter((key) => keys.has(key))
    expect(leaked, `a folded relation exposes ${leaked.join(', ')}`).toEqual([])
  })

  scenario('P3-R-D', 'trust evidence is evidence, and confers nothing', () => {
    // Strong: TrustEvidence is a kind, a time and a detail. The moment it grows
    // a number, something will compare that number to a threshold and act on
    // the result — authority manufactured out of behaviour.
    expect(fieldsOf('objects.ts', 'TrustEvidence').sort()).toEqual(['at', 'detail', 'kind'])
    expect(src('objects.ts')).not.toMatch(/trustScore|reputationScore|trustLevel\s*:/i)
  })
})

describe('P3-09 — a score is a projection, never a fact', () => {
  scenario('P3-09', 'the journal records evidence and not a reputation', () => {
    // Strong: an event vocabulary is a contract. `reputation.updated` would
    // turn one weighting of the facts into a fact of its own, and every reader
    // would inherit that weighting with no way to disagree.
    const types = src('event-types.ts')
    for (const forbidden of ['reputation.updated', 'reputation.recorded', 'trust.scored']) {
      expect(types, `${forbidden} makes a score into a fact`).not.toContain(forbidden)
    }
  })
})

describe('P3-07, P3-08, P3-R-C — delivery is not acceptance', () => {
  const submitted = (byAgentId = 'agent-b') =>
    event('delivery.submitted', { kind: 'task', id: 'task-1' }, {
      deliveryId: 'del-1',
      byAgentId,
      outputs: [{ kind: 'artifact', id: 'art-1', summary: 'the report' }],
      evidence: ['sha256:abc'],
      summary: 'done',
    })

  const ruling = (type: string, decidedBy: string) =>
    event(type, { kind: 'task', id: 'task-1' }, {
      deliveryId: 'del-1',
      decidedBy,
      decidedByKind: 'agent',
      reason: type === 'delivery.rejected' ? 'not what was asked for' : undefined,
    })

  scenario('P3-R-C', 'completed is unreachable except through a ruling', () => {
    // The strongest form available: not "the reducer happens not to do it" but
    // "the state machine has no edge". Every path to `completed` goes through
    // `delivered`, and the only thing that leaves `delivered` for `completed`
    // is an accepted Delivery.
    const reachCompleted = Object.entries(TASK_TRANSITIONS)
      .filter(([, to]) => to.includes('completed'))
      .map(([from]) => from)
    expect(reachCompleted, 'some state reaches completed without a delivery').toEqual(['delivered'])
  })

  scenario('P3-07', 'a delivery binds its task, its author and its evidence, and settles nothing', () => {
    const state = reduceEvents([submitted()])
    const task = state.tasks['task-1']!
    const delivery = task.deliveries[0]!

    expect(task.state, 'submitting a delivery finished the task').toBe('delivered')
    expect(delivery.taskId).toBe('task-1')
    expect(delivery.byAgentId).toBe('agent-b')
    expect(delivery.evidence).toEqual(['sha256:abc'])
    expect(delivery.acceptance, 'a delivery arrived already accepted').toBeUndefined()
  })

  scenario('P3-08', 'only the other side may rule, and the ruling is its own fact', () => {
    const accepted = reduceEvents([submitted(), ruling('delivery.accepted', 'agent-a')])
    const task = accepted.tasks['task-1']!
    expect(task.state).toBe('completed')
    expect(task.deliveries[0]?.acceptance?.decidedBy).toBe('agent-a')
    expect(task.deliveries[0]?.acceptance?.legacy).toBeUndefined()
    expect(accepted.anomalies).toEqual([])

    // The executor ruling on its own work: refused, and kept visible.
    const self = reduceEvents([submitted(), ruling('delivery.accepted', 'agent-b')])
    expect(self.tasks['task-1']?.state, 'an agent accepted its own delivery').toBe('delivered')
    expect(self.tasks['task-1']?.deliveries[0]?.acceptance).toBeUndefined()
    expect(self.anomalies[0]?.reason).toBe('self_acceptance')

    // A ruling on a delivery that does not exist must not conjure one.
    const phantom = reduceEvents([ruling('delivery.accepted', 'agent-a')])
    expect(phantom.tasks['task-1']?.deliveries).toEqual([])
    expect(phantom.anomalies[0]?.reason).toBe('unknown_delivery')
  })

  it('sends rejected work back without erasing what happened', () => {
    const state = reduceEvents([submitted(), ruling('delivery.rejected', 'agent-a')])
    const task = state.tasks['task-1']!
    expect(task.state).toBe('running')
    // The delivery and its rejection both remain. History is appended to.
    expect(task.deliveries).toHaveLength(1)
    expect(task.deliveries[0]?.acceptance?.outcome).toBe('rejected')
    expect(task.deliveries[0]?.acceptance?.reason).toBe('not what was asked for')
  })

  it('folds a pre-split task.completed honestly rather than silently', () => {
    // Legacy nodes still emit it. Folding it as delivery-only would strand
    // every historical Task in `delivered`; folding it as a real acceptance
    // would invent a ruling nobody signed. It is folded as what it was, with
    // the acceptance flagged.
    const state = reduceEvents([
      event('task.completed', { kind: 'task', id: 'task-old' }, {
        summary: 'finished',
        outputs: [{ kind: 'artifact', id: 'art-9', summary: 'output' }],
      }),
    ])
    const task = state.tasks['task-old']!
    expect(task.state).toBe('completed')
    expect(task.deliveries[0]?.acceptance?.legacy, 'a legacy completion posed as a real ruling').toBe(true)
    expect(state.anomalies, 'the legacy path tripped the state machine').toEqual([])
  })
})

describe('the matrix and the guards cannot drift apart', () => {
  it('accounts for every scenario in docs/p3-acceptance.md', () => {
    const doc = repoDoc('docs/p3-acceptance.md')
    const declared = new Set([...doc.matchAll(/\bP3-(?:\d{2}|R-[A-D])\b/g)].map((m) => m[0]))
    const accounted = new Set([
      ...covered,
      ...Object.keys(ENFORCED_ELSEWHERE),
      ...Object.keys(PENDING),
    ])

    const unaccounted = [...declared].filter((id) => !accounted.has(id))
    expect(
      unaccounted,
      `the document defines ${unaccounted.join(', ')} and nothing here tracks them`,
    ).toEqual([])

    const orphaned = [...accounted].filter((id) => !declared.has(id))
    expect(
      orphaned,
      `${orphaned.join(', ')} is tracked here but no longer in the document`,
    ).toEqual([])

    const stale = Object.keys(PENDING).filter((id) => covered.has(id))
    expect(stale, `${stale.join(', ')} is listed as pending but is enforced`).toEqual([])
  })

  it('keeps what is still owed visible', () => {
    const total =
      covered.size + Object.keys(ENFORCED_ELSEWHERE).length + Object.keys(PENDING).length
    expect(total, 'the matrix is 12 scenarios and 4 reverse acceptances').toBe(16)
    // Not a measure of progress — a place progress is visible. P3 is finished
    // when PENDING is empty.
    expect(Object.keys(PENDING).length).toBeLessThanOrEqual(6)
  })
})
