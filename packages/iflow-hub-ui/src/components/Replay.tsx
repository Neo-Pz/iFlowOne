/**
 * Replay — read the Journal back and explain what actually happened.
 *
 * This is the view that makes the whole event-sourced design pay off: the
 * projections tell you the current state, and this tells you how it got there,
 * from the same append-only facts, with nothing reconstructed or inferred.
 *
 * It reads `getJournal` rather than a projection on purpose. A projection is a
 * derived, replaceable summary; an audit question has to be answerable from
 * the governing Journal itself.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import type { AnyIFlowEvent } from 'iflow-domain'
import { summarizeEvent } from 'iflow-domain'

import { useProjectionSource } from '../hooks.js'
import { Empty, ErrorPanel, Loading, Panel, RelativeTime } from './primitives.js'

/** One collaboration flow, as the journal recorded it. */
interface Flow {
  correlationId: string
  events: AnyIFlowEvent[]
  startedAt: string
  endedAt: string
  /** What the journal says this flow came to. */
  outcome: FlowOutcome
  /** Detail behind the outcome. Absent for a clean completion. */
  note?: string
}

/** `open` means the journal holds no terminal fact for this flow — not that it failed. */
type FlowOutcome = 'completed' | 'failed' | 'open'

/**
 * Explain a flow's outcome from its own facts.
 *
 * Deliberately mechanical: every branch names the event it read. A replay that
 * guesses is worse than one that says nothing, because the reader cannot tell
 * the guess from the record.
 */
function explain(events: AnyIFlowEvent[]): { outcome: FlowOutcome; note?: string } {
  const byType = (type: string) => events.filter((event) => event.type === type)

  const failures = byType('task.failed')
  if (failures.length > 0) {
    const reason = (failures[failures.length - 1]?.payload as { reason?: string })?.reason
    return { outcome: 'failed', note: reason ?? 'task.failed with no reason recorded' }
  }

  const blocked = byType('task.blocked')
  if (blocked.length > 0 && byType('task.completed').length === 0) {
    const reason = (blocked[blocked.length - 1]?.payload as { reason?: string })?.reason
    return { outcome: 'open', note: `Still blocked: ${reason ?? 'no reason recorded'}` }
  }

  const requested = byType('approval.requested')
  const resolved = byType('approval.resolved')
  if (requested.length > resolved.length) {
    const reason = (requested[requested.length - 1]?.payload as { reason?: string })?.reason
    return { outcome: 'open', note: `Waiting on a human approval: ${reason ?? 'no reason recorded'}` }
  }

  const failedTools = events.filter(
    (event) => event.type === 'tool.call_completed' && (event.payload as { outcome?: string })?.outcome !== 'ok',
  )

  // Completion is checked BEFORE tool errors on purpose. A flow that hit a
  // denied tool call, got approved, and then finished did NOT end there —
  // labelling it with that error reads as "this is why it stopped", which is
  // exactly the wrong answer to an audit question.
  if (byType('task.completed').length > 0) {
    return {
      outcome: 'completed',
      note: failedTools.length > 0 ? `completed after ${failedTools.length} recovered tool error(s)` : undefined,
    }
  }

  const lastFailure = failedTools[failedTools.length - 1]
  if (lastFailure) {
    const payload = lastFailure.payload as { toolName?: string; outcome?: string; errorMessage?: string }
    return {
      outcome: 'open',
      note: `Tool ${payload.toolName} returned ${payload.outcome}${payload.errorMessage ? `: ${payload.errorMessage}` : ''}`,
    }
  }

  const started = byType('task.started').length > 0
  return { outcome: 'open', note: started ? 'Still running: no terminal fact yet' : 'No work started in this flow' }
}

function groupIntoFlows(events: AnyIFlowEvent[]): Flow[] {
  const byCorrelation = new Map<string, AnyIFlowEvent[]>()
  for (const event of events) {
    const list = byCorrelation.get(event.correlationId)
    if (list) list.push(event)
    else byCorrelation.set(event.correlationId, [event])
  }

  return [...byCorrelation.entries()]
    .map(([correlationId, flowEvents]) => {
      const ordered = [...flowEvents].sort((a, b) => a.origin.seq - b.origin.seq)
      const outcome = explain(ordered)
      return {
        correlationId,
        events: ordered,
        startedAt: ordered[0]?.occurredAt ?? '',
        endedAt: ordered[ordered.length - 1]?.occurredAt ?? '',
        outcome: outcome.outcome,
        note: outcome.note,
      }
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export function Replay({ pageSize = 500 }: { pageSize?: number }) {
  const source = useProjectionSource()
  const [events, setEvents] = useState<AnyIFlowEvent[]>([])
  const [error, setError] = useState<Error | undefined>()
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | undefined>()

  const load = useCallback(async () => {
    if (!source.getJournal) {
      setError(new Error('This source cannot serve the raw journal, so a replay is not available.'))
      setLoading(false)
      return
    }
    try {
      // Page to the end: a replay that silently stops at the first page would
      // answer an audit question with part of the record.
      const collected: AnyIFlowEvent[] = []
      let fromSeq = 0
      for (;;) {
        const page = await source.getJournal(fromSeq, pageSize)
        collected.push(...page.events)
        if (!page.hasMore || page.events.length === 0) break
        fromSeq = page.lastSeq
      }
      setEvents(collected)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)))
    } finally {
      setLoading(false)
    }
  }, [source, pageSize])

  useEffect(() => {
    void load()
    return source.subscribe(() => void load())
  }, [load, source])

  const flows = useMemo(() => groupIntoFlows(events), [events])

  if (error) return <ErrorPanel error={error} />
  if (loading) return <Loading what="the journal" />

  return (
    <Panel
      title={`Replay (${flows.length} flows, ${events.length} facts)`}
      actions={<span className="ifo-stamp ifo-mono">from the Journal, not a projection</span>}
    >
      {flows.length === 0 ? (
        <Empty>This node has journaled nothing yet.</Empty>
      ) : (
        <ol className="ifo-flows">
          {flows.map((flow) => (
            <li key={flow.correlationId} className="ifo-flow-row">
              <button
                type="button"
                className="ifo-flow-row__head"
                onClick={() => setExpanded(expanded === flow.correlationId ? undefined : flow.correlationId)}
                aria-expanded={expanded === flow.correlationId}
              >
                <span className="ifo-flow-row__caret">{expanded === flow.correlationId ? '▾' : '▸'}</span>
                <span className="ifo-mono ifo-truncate">{flow.correlationId}</span>
                <span className="ifo-muted">{flow.events.length} facts</span>
                <span className="ifo-muted">
                  <RelativeTime iso={flow.startedAt} />
                </span>
                {flow.outcome === 'open' ? (
                  <span className="ifo-flow-row__cause">{flow.note}</span>
                ) : (
                  <span className={`ifo-chip ifo-chip--task-${flow.outcome}`}>{flow.note ?? flow.outcome}</span>
                )}
              </button>

              {expanded === flow.correlationId ? (
                <ol className="ifo-timeline ifo-flow-row__events">
                  {flow.events.map((event) => (
                    <li key={event.id} className={`ifo-timeline__row ifo-timeline__row--${event.type.split('.')[0]}`}>
                      <span className="ifo-timeline__time ifo-mono">#{event.origin.seq}</span>
                      <span className="ifo-timeline__type ifo-mono">{event.type}</span>
                      <span className="ifo-timeline__summary">{summarizeEvent(event)}</span>
                      <span className="ifo-timeline__actor ifo-muted">
                        <RelativeTime iso={event.occurredAt} />
                      </span>
                    </li>
                  ))}
                </ol>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  )
}
