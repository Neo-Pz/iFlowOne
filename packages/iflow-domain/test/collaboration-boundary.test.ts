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
import { TASK_TRANSITIONS, grantStateAt } from '../src/objects.js'
import { applyEvent, emptyNetworkState, reduceEvents } from '../src/reducers/network-state.js'
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
  'P3-06': 'the plugin re-checking policy on the accepting machine; not a domain fold',
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
    expect(task.deliveries[0]?.acceptance?.selfDeclared).toBeUndefined()
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
    expect(task.deliveries[0]?.acceptance?.selfDeclared, 'a legacy completion posed as a real ruling').toBe(true)
    expect(state.anomalies, 'the legacy path tripped the state machine').toEqual([])
  })
})

describe('P3-04 — work for someone else cannot be finished by the one doing it', () => {
  const delegated = (crosses: boolean) => [
    event('task.created', { kind: 'task', id: 'task-x' }, { title: 'analyse' }),
    event('task.delegated', { kind: 'task', id: 'task-x' }, {
      toAgentId: 'agent-b',
      fromAgentId: 'agent-a',
      grantRef: 'sha256:grant-1',
      crossesOwnershipBoundary: crosses,
    }),
    event('task.completed', { kind: 'task', id: 'task-x' }, {
      summary: 'all done',
      outputs: [{ kind: 'artifact', id: 'art-2', summary: 'result' }],
    }),
  ]

  scenario('P3-04', 'a cross-boundary task stops at delivered, however the executor reports it', () => {
    // Strong, and the case that matters most: `task.completed` is the shape of
    // event an older or careless runtime will keep sending. Across an ownership
    // boundary the fold takes the work and refuses the conclusion.
    const state = reduceEvents(delegated(true))
    const task = state.tasks['task-x']!

    expect(task.state, 'the executor completed work it was doing for someone else').toBe('delivered')
    expect(task.deliveries).toHaveLength(1)
    expect(task.deliveries[0]?.acceptance, 'it accepted on the requester’s behalf').toBeUndefined()
    expect(state.anomalies[0]?.reason).toBe('unratified_completion')
    // The work itself is kept. Refusing the conclusion is not discarding the
    // evidence — the requester still needs to see what was produced.
    expect(task.outputs).toHaveLength(1)
    expect(task.authorizedBy).toBe('sha256:grant-1')
  })

  it('leaves work inside one Principal alone', () => {
    // The counterweight. An Agent finishing its own Principal's work has nobody
    // to ask, and demanding a ruling there would be bureaucracy with no
    // counterparty in it.
    const state = reduceEvents(delegated(false))
    expect(state.tasks['task-x']?.state).toBe('completed')
    expect(state.tasks['task-x']?.deliveries[0]?.acceptance?.selfDeclared).toBe(true)
    expect(state.anomalies).toEqual([])
  })
})

describe('P3-03, P3-05, P3-R-B — a grant is recorded, never minted', () => {
  const issued = (expiresAt = '2026-06-01T00:00:00.000Z') =>
    event('grant.issued', { kind: 'agent', id: 'agent-b' }, {
      grantRef: 'sha256:grant-1',
      issuerDid: 'did:key:zPrincipal',
      subjectDid: 'did:key:zAgentB',
      scope: ['iflow.cap:task.run'],
      constraints: ['budget <= 50 USD'],
      level: 'L2',
      expiresAt,
    })

  scenario('P3-03', 'a grant record names its issuer, subject, scope, expiry and limits', () => {
    // Strong: all five are what a reader needs to check the signed document
    // this record points at. Any one missing makes the reference unusable.
    const record = reduceEvents([issued()]).grants['sha256:grant-1']!
    expect(record.issuerDid).toBe('did:key:zPrincipal')
    expect(record.subjectDid).toBe('did:key:zAgentB')
    expect(record.scope).toEqual(['iflow.cap:task.run'])
    expect(record.constraints).toEqual(['budget <= 50 USD'])
    expect(record.expiresAt).toBe('2026-06-01T00:00:00.000Z')
  })

  scenario('P3-03', 'the domain declares no object that could be a grant itself', () => {
    // Authority is issued by a signing key and verified by iflow-id. A `Grant`
    // this package could construct would be a grant nobody signed.
    expect(src('objects.ts')).not.toMatch(/export interface Grant(?!Record)/)
    expect(fieldsOf('objects.ts', 'GrantRecord')).toContain('grantRef')
  })

  scenario('P3-05', 'revocation ends authority ahead, and edits nothing behind', () => {
    // Strong: state is derived from an instant, so the same record answers
    // differently for "then" and "now" without the journal being touched.
    // The same two events, folded with and without the revocation, so the
    // comparison is about what revoking changed and not about wall-clock.
    const grant = issued()
    const revocation = event('grant.revoked', { kind: 'agent', id: 'agent-b' }, {
      grantRef: 'sha256:grant-1',
      reason: 'contract ended',
    })
    const before = reduceEvents([grant]).grants['sha256:grant-1']!
    const after = reduceEvents([grant, revocation]).grants['sha256:grant-1']!

    expect(after.issuedAt, 'revocation rewrote when it was issued').toBe(before.issuedAt)
    expect(after.scope, 'revocation emptied the terms').toEqual(before.scope)
    expect(after.constraints).toEqual(before.constraints)
    expect(after.revocationReason).toBe('contract ended')

    // Same record, different answers, depending only on when you ask.
    expect(grantStateAt(after, grant.occurredAt)).toBe('active')
    expect(grantStateAt(after, '2026-05-01T00:00:00.000Z')).toBe('revoked')
  })

  scenario('P3-R-B', 'work authorized while a grant held stays verifiable after it does not', () => {
    const state = reduceEvents([
      issued(),
      event('task.created', { kind: 'task', id: 'task-1' }, { title: 'analyse' }),
      event('task.delegated', { kind: 'task', id: 'task-1' }, {
        toAgentId: 'agent-b',
        grantRef: 'sha256:grant-1',
      }),
      event('grant.revoked', { kind: 'agent', id: 'agent-b' }, { grantRef: 'sha256:grant-1' }),
    ])

    // The citation survives, so the claim can still be audited.
    expect(state.tasks['task-1']?.authorizedBy).toBe('sha256:grant-1')
    // And the grant is plainly no longer usable for anything new.
    expect(grantStateAt(state.grants['sha256:grant-1']!, '2026-02-01T00:00:00.000Z')).toBe('revoked')
  })

  it('expires without anyone emitting anything', () => {
    const record = reduceEvents([issued('2026-01-02T00:00:00.000Z')]).grants['sha256:grant-1']!
    expect(record.revokedAt).toBeUndefined()
    expect(grantStateAt(record, '2026-03-01T00:00:00.000Z')).toBe('expired')
  })
})

describe('trust evidence accumulates as evidence', () => {
  scenario('P3-09', 'recording evidence never produces a number', () => {
    const state = reduceEvents([
      event('trust_evidence.recorded', { kind: 'agent', id: 'agent-b' }, {
        subjectAgentId: 'agent-b',
        kind: 'grant_accepted',
        detail: 'accepted a limited grant',
      }),
    ])
    const evidence = state.agents['agent-b']?.trustEvidence ?? []
    expect(evidence).toHaveLength(1)
    expect(Object.keys(evidence[0]!).sort()).toEqual(['at', 'detail', 'kind'])
  })
})

describe('a snapshot is not a window onto a later one', () => {
  it('does not let a later ruling reach back into a state already handed out', () => {
    // Regression. `applyEvent` clones the previous state and returns a new one,
    // so callers hold onto earlier snapshots — the Community's fold cache is
    // exactly that. `cloneState` spread the Task but copied `deliveries` by
    // reference, so accepting a Delivery mutated the object the earlier
    // snapshot was still pointing at.
    //
    // Two independent `reduceEvents` calls do NOT exercise this: each starts
    // from an empty state and shares nothing. The bug only appears when one
    // fold continues from another, which is what this does.
    const submitted = event('delivery.submitted', { kind: 'task', id: 'task-1' }, {
      deliveryId: 'del-1',
      byAgentId: 'agent-b',
      outputs: [],
      evidence: [],
    })
    const accepted = event('delivery.accepted', { kind: 'task', id: 'task-1' }, {
      deliveryId: 'del-1',
      decidedBy: 'agent-a',
      decidedByKind: 'agent',
    })

    const afterDelivery = applyEvent(emptyNetworkState(), submitted)
    const afterRuling = applyEvent(afterDelivery, accepted)

    expect(afterRuling.tasks['task-1']?.deliveries[0]?.acceptance?.outcome).toBe('accepted')
    expect(
      afterDelivery.tasks['task-1']?.deliveries[0]?.acceptance,
      'accepting reached back into a snapshot that was taken before it',
    ).toBeUndefined()
    expect(afterDelivery.tasks['task-1']?.state).toBe('delivered')
  })
})

describe('P3-12 — the graduation test', () => {
  scenario('P3-12', 'two Agents on two Nodes take on work, deliver it, and are held to it', () => {
    // The whole chain, with no money in it. If this closes, iFlowOne has a
    // collaboration layer; if it does not, it has an A2A message system with
    // good manners.
    //
    // Two node ids, because the point is that the parties are not each other.
    // The fold is where the guarantees live, so this is a fold — a real
    // two-machine run belongs to the plugin, and proves delivery rather than
    // the rules delivery has to obey.
    const A = 'node-a'
    const B = 'node-b'
    let seqA = 0
    let seqB = 0
    const from = (node: string, type: string, subject: AnyIFlowEvent['subject'], payload: unknown, issuer: string) => {
      const seq = node === A ? (seqA += 1) : (seqB += 1)
      return {
        id: `${node}-${seq}`,
        schemaVersion: 1,
        origin: { nodeId: node, streamId: 'edge', seq },
        occurredAt: new Date(Date.UTC(2026, 0, 1, 0, seqA + seqB)).toISOString(),
        correlationId: 'graduation',
        type,
        issuer: { id: issuer, kind: 'agent' },
        subject,
        payload,
      } as AnyIFlowEvent
    }

    const CONV = { kind: 'conversation', id: 'conv-1' } as const
    const TASK = { kind: 'task', id: 'task-1' } as const
    const BEE = { kind: 'agent', id: 'agent-b' } as const

    const state = reduceEvents([
      // They meet, and A's side accepts the thread. Accepting a conversation is
      // not yet a relationship, and the earlier guards hold that line.
      from(A, 'conversation.opened', CONV, {
        participants: [participant('agent-a', 'principal-1'), participant('agent-b', 'principal-2')],
        initiatedBy: 'agent-a',
        crossesOwnershipBoundary: true,
      }, 'agent-a'),
      from(B, 'conversation.accepted', CONV, { acceptedBy: 'agent-b', decidedBy: 'human' }, 'agent-b'),

      // A relationship, and separately a grant. Neither follows from the other.
      from(A, 'relation.recorded', BEE, {
        sourceAgentId: 'agent-a', targetAgentId: 'agent-b', type: 'collaborates_with',
      }, 'agent-a'),
      from(A, 'grant.issued', BEE, {
        grantRef: 'sha256:grant-1',
        issuerDid: 'did:key:zPrincipalA',
        subjectDid: 'did:key:zAgentB',
        scope: ['iflow.cap:task.run'],
        constraints: ['no spending'],
        level: 'L2',
        expiresAt: '2026-12-01T00:00:00.000Z',
      }, 'agent-a'),

      // A asks B to do the work, citing the grant and saying it leaves the
      // Principal — which is what makes B unable to finish it alone.
      from(A, 'task.created', TASK, { title: 'Request from agent-a', ownerAgentId: 'agent-b' }, 'agent-a'),
      from(A, 'task.delegated', TASK, {
        toAgentId: 'agent-b',
        fromAgentId: 'agent-a',
        grantRef: 'sha256:grant-1',
        crossesOwnershipBoundary: true,
      }, 'agent-a'),

      // B does it and hands it back. Evidence, never the work.
      from(B, 'task.started', TASK, { agentId: 'agent-b', attemptId: 'att-1' }, 'agent-b'),
      from(B, 'delivery.submitted', TASK, {
        deliveryId: 'del-1',
        byAgentId: 'agent-b',
        outputs: [{ kind: 'artifact', id: 'art-1', summary: 'the analysis' }],
        evidence: ['sha256:answer'],
      }, 'agent-b'),

      // A rules. Only now is the work finished.
      from(A, 'delivery.accepted', TASK, {
        deliveryId: 'del-1', decidedBy: 'agent-a', decidedByKind: 'human',
      }, 'agent-a'),
      from(A, 'trust_evidence.recorded', BEE, {
        subjectAgentId: 'agent-b', kind: 'grant_accepted', detail: 'delivered and accepted',
      }, 'agent-a'),
    ])

    const task = state.tasks['task-1']!
    expect(task.state, 'the chain did not close').toBe('completed')
    expect(task.crossesOwnershipBoundary).toBe(true)
    expect(task.authorizedBy).toBe('sha256:grant-1')
    expect(task.deliveries[0]?.acceptance?.decidedBy).toBe('agent-a')
    // Not `selfDeclared`: somebody who was not the executor actually ruled.
    expect(task.deliveries[0]?.acceptance?.selfDeclared).toBeUndefined()

    expect(Object.keys(state.relations)).toHaveLength(1)
    expect(grantStateAt(state.grants['sha256:grant-1']!, '2026-06-01T00:00:00.000Z')).toBe('active')
    expect(state.agents['agent-b']?.trustEvidence).toHaveLength(1)

    // Nothing was refused, nothing was unreadable, and nothing was inferred.
    expect(state.anomalies, 'a step exceeded its authority').toEqual([])
    expect(state.unknownEventTypes).toEqual({})

    // And no money was involved at any point — the whole claim of P3. Checked
    // on the containers rather than by searching the serialised state, which
    // matches the empty `quotes` key and proves nothing.
    expect(Object.keys(state.quotes), 'the chain needed a price').toEqual([])
    expect(task.settlement, 'the chain needed a settlement').toBeUndefined()
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
    expect(Object.keys(PENDING).length).toBeLessThanOrEqual(1)
  })
})
