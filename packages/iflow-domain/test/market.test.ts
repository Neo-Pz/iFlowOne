/**
 * Pricing semantics.
 *
 * Two things are being pinned here, and both are policy expressed as code:
 *
 *   - cost and price are different facts. `usage.recorded` is what the compute
 *     burned; `task.settled` is what one party charged another. A market
 *     aggregate built from the wrong one is meaningless.
 *   - visibility is enforced in the PROJECTOR, not at the network edge, so no
 *     consumer of the view can leak a private price by forgetting to filter.
 */

import { describe, expect, it } from 'vitest'

import type { AnyIFlowEvent } from '../src/event-types.js'
import { reduceEvents } from '../src/reducers/network-state.js'
import { projectMarket } from '../src/projectors/index.js'

let seq = 0
function event<T>(type: string, taskId: string, payload: T, issuerId = 'agent-seller'): AnyIFlowEvent {
  seq += 1
  return {
    id: `evt-${seq}`,
    schemaVersion: 1,
    origin: { nodeId: 'node-1', streamId: 'edge', seq },
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    correlationId: `corr-${taskId}`,
    type,
    issuer: { id: issuerId, kind: 'agent' },
    subject: { kind: 'task', id: taskId },
    taskId,
    payload,
  } as AnyIFlowEvent
}

/** One priced deal: offer, acceptance, settlement. */
function deal(options: {
  taskId: string
  quoteId: string
  seller: string
  buyer: string
  amountMicros: number
  capability?: string
  visibility: 'private' | 'aggregate' | 'public'
}): AnyIFlowEvent[] {
  return [
    event('task.created', options.taskId, { title: options.taskId }),
    event(
      'quote.offered',
      options.taskId,
      {
        quoteId: options.quoteId,
        offeredBy: options.seller,
        offeredTo: options.buyer,
        amountMicros: options.amountMicros,
        currency: 'USD',
        capability: options.capability,
        expiresAt: '2026-12-31T00:00:00.000Z',
      },
      options.seller,
    ),
    event(
      'quote.accepted',
      options.taskId,
      {
        quoteId: options.quoteId,
        acceptedBy: options.buyer,
        offerEventId: 'evt-offer',
        offerSignature: 'sig-offer',
      },
      options.buyer,
    ),
    event('task.settled', options.taskId, {
      quoteId: options.quoteId,
      payerAgentId: options.buyer,
      payeeAgentId: options.seller,
      amountMicros: options.amountMicros,
      currency: 'USD',
      visibility: options.visibility,
      basis: 'quote',
    }),
  ]
}

describe('quotes', () => {
  it('records an offer, and marks it accepted only when the acceptance lands', () => {
    const state = reduceEvents([
      event('task.created', 'task-1', { title: 'One' }),
      event('quote.offered', 'task-1', {
        quoteId: 'q1',
        offeredBy: 'agent-seller',
        offeredTo: 'agent-buyer',
        amountMicros: 2_500_000,
        currency: 'USD',
        capability: 'iflow.cap:fs.read',
        expiresAt: '2026-12-31T00:00:00.000Z',
      }),
    ])
    expect(state.quotes['q1']?.amountMicros).toBe(2_500_000)
    expect(state.quotes['q1']?.acceptedBy).toBeUndefined()

    const accepted = reduceEvents([
      ...[
        event('task.created', 'task-1', { title: 'One' }),
        event('quote.offered', 'task-1', {
          quoteId: 'q1',
          offeredBy: 'agent-seller',
          offeredTo: 'agent-buyer',
          amountMicros: 2_500_000,
          currency: 'USD',
          expiresAt: '2026-12-31T00:00:00.000Z',
        }),
      ],
      event('quote.accepted', 'task-1', {
        quoteId: 'q1',
        acceptedBy: 'agent-buyer',
        offerEventId: 'evt-x',
        offerSignature: 'sig-x',
      }),
    ])
    expect(accepted.quotes['q1']?.acceptedBy).toBe('agent-buyer')
  })

  it('ignores an acceptance with no offer — half a pair is not a price', () => {
    const state = reduceEvents([
      event('task.created', 'task-1', { title: 'One' }),
      event('quote.accepted', 'task-1', {
        quoteId: 'ghost',
        acceptedBy: 'agent-buyer',
        offerEventId: 'evt-x',
        offerSignature: 'sig-x',
      }),
    ])
    expect(state.quotes['ghost']).toBeUndefined()
  })
})

describe('market projection', () => {
  const options = { builtAt: '2026-01-01T00:00:00.000Z' }

  it('never leaks a private settlement, and says how many it withheld', () => {
    const state = reduceEvents([
      ...deal({
        taskId: 'task-p',
        quoteId: 'qp',
        seller: 'a',
        buyer: 'b',
        amountMicros: 9_000_000,
        capability: 'iflow.cap:fs.read',
        visibility: 'private',
      }),
      ...deal({
        taskId: 'task-a',
        quoteId: 'qa',
        seller: 'c',
        buyer: 'd',
        amountMicros: 1_000_000,
        capability: 'iflow.cap:fs.read',
        visibility: 'aggregate',
      }),
    ])

    const view = projectMarket(state, options).data
    expect(view.withheld).toBe(1)
    expect(view.published).toHaveLength(0)

    // The private 9.00 must not move the band at all.
    const band = view.bands.find((b) => b.capability === 'iflow.cap:fs.read')
    expect(band?.settlements).toBe(1)
    expect(band?.highMicros).toBe(1_000_000)
  })

  it('lists a deal in full only when the parties marked it public', () => {
    const state = reduceEvents([
      ...deal({
        taskId: 'task-1',
        quoteId: 'q1',
        seller: 'a',
        buyer: 'b',
        amountMicros: 3_000_000,
        capability: 'iflow.cap:fs.read',
        visibility: 'public',
      }),
    ])
    const view = projectMarket(state, options).data
    expect(view.published).toHaveLength(1)
    expect(view.published[0]?.amountMicros).toBe(3_000_000)
    expect(view.published[0]?.payeeAgentId).toBe('a')
  })

  it('reports a price band as a distribution, in integer micro-units', () => {
    const state = reduceEvents([
      ...deal({ taskId: 't1', quoteId: 'q1', seller: 'a', buyer: 'b', amountMicros: 1_000_000, capability: 'iflow.cap:fs.read', visibility: 'aggregate' }),
      ...deal({ taskId: 't2', quoteId: 'q2', seller: 'c', buyer: 'd', amountMicros: 2_000_000, capability: 'iflow.cap:fs.read', visibility: 'aggregate' }),
      ...deal({ taskId: 't3', quoteId: 'q3', seller: 'e', buyer: 'f', amountMicros: 6_000_000, capability: 'iflow.cap:fs.read', visibility: 'aggregate' }),
    ])
    const band = projectMarket(state, options).data.bands[0]

    expect(band?.lowMicros).toBe(1_000_000)
    expect(band?.medianMicros).toBe(2_000_000)
    expect(band?.highMicros).toBe(6_000_000)
    expect(Number.isInteger(band?.medianMicros)).toBe(true)
    expect(band?.settlements).toBe(3)
    expect(band?.distinctPairs).toBe(3)
  })

  it('exposes counterparty concentration, so wash trading is visible to a reader', () => {
    // Ten settlements that are one relationship repeating, not a market rate.
    const events = Array.from({ length: 10 }, (_, i) =>
      deal({
        taskId: `t${i}`,
        quoteId: `q${i}`,
        seller: 'agent-self-a',
        buyer: 'agent-self-b',
        amountMicros: 50_000_000,
        capability: 'iflow.cap:fs.read',
        visibility: 'aggregate',
      }),
    ).flat()

    const band = projectMarket(reduceEvents(events), options).data.bands[0]
    expect(band?.settlements).toBe(10)
    // The projection cannot prove these parties are independent — it can only
    // publish the shape so a reader is not misled by the volume.
    expect(band?.distinctPairs).toBe(1)
  })

  it('groups an unclassified price separately rather than dropping it', () => {
    const state = reduceEvents([
      ...deal({ taskId: 't1', quoteId: 'q1', seller: 'a', buyer: 'b', amountMicros: 1_000_000, visibility: 'aggregate' }),
    ])
    const view = projectMarket(state, options).data
    expect(view.bands[0]?.capability).toBe('iflow.cap:*')
    expect(view.bands[0]?.settlements).toBe(1)
  })

  it('keeps cost and price apart', () => {
    const state = reduceEvents([
      event('task.created', 't1', { title: 'One' }),
      // Metered compute cost — must NOT appear in the market view.
      event('usage.recorded', 't1', {
        model: 'deepseek-v4',
        tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
        costMicros: 34_000,
        currency: 'USD',
        priceSource: 'pricing.json',
      }),
    ])
    const view = projectMarket(state, options).data
    expect(view.bands).toHaveLength(0)
    expect(view.withheld).toBe(0)
  })
})
