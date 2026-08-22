/**
 * The event vocabulary and its payloads.
 *
 * Events describe facts that ALREADY happened. Anything a model merely intends
 * or suggests must be carried as `declared_plan` / `derived_next_step` /
 * `suggested_action` (see `SuggestionKind`) so a UI can never present a guess
 * as an observation.
 */

import type { IFlowEvent } from 'iflow-protocol'
import type { AgentCoordination, AgentExecution, AgentPresence, TrustEvidence } from './objects.js'

export const EVENT_TYPES = [
  'agent.registered',
  'agent.presence_changed',
  'goal.created',
  'task.created',
  'task.delegated',
  'task.started',
  'task.waiting',
  'task.blocked',
  'task.awaiting_approval',
  'task.completed',
  'task.failed',
  'room.created',
  'room.participant_joined',
  'tool.call_started',
  'tool.call_completed',
  'approval.requested',
  'approval.resolved',
  'a2a.request_received',
  'execution.attempt_started',
  'execution.attempt_finished',
  // Not in the architecture doc's initial list: the DSH edge already meters
  // tokens per task (P4), and that fact needs a home in the journal rather
  // than a second private ledger.
  'usage.recorded',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES)

export function isKnownEventType(type: string): type is EventType {
  return EVENT_TYPE_SET.has(type)
}

/** How a non-fact must be labelled if it ever travels as an event payload. */
export type SuggestionKind = 'declared_plan' | 'derived_next_step' | 'suggested_action'

export interface EventPayloadMap {
  'agent.registered': {
    label: string
    did?: string
    nodeId: string
    runtimeKind: string
    capabilities: string[]
    trustEvidence?: TrustEvidence[]
  }
  'agent.presence_changed': {
    presence?: AgentPresence
    execution?: AgentExecution
    coordination?: AgentCoordination
  }
  'goal.created': {
    title: string
    constraints?: string[]
    budget?: { currency: string; limit: number }
    roomId?: string
  }
  'task.created': { title: string; parentTaskId?: string; dependsOn?: string[]; ownerAgentId?: string }
  'task.delegated': { toAgentId: string; fromAgentId?: string; reason?: string }
  'task.started': { agentId: string; attemptId: string }
  'task.waiting': { reason: string }
  'task.blocked': { reason: string; blockedOnTaskId?: string }
  'task.awaiting_approval': { approvalId: string; reason: string }
  'task.completed': { summary?: string; outputs?: { kind: 'artifact' | 'message'; id: string; summary: string }[] }
  'task.failed': { reason: string }
  'room.created': { title: string; goalId?: string; rootTaskId?: string }
  'room.participant_joined': { agentId: string }
  'tool.call_started': { callId: string; toolName: string; agentId: string; argumentsDigest?: string }
  'tool.call_completed': { callId: string; toolName: string; outcome: 'ok' | 'error' | 'denied'; errorMessage?: string }
  'approval.requested': { approvalId: string; toolName?: string; reason: string; agentId: string }
  'approval.resolved': { approvalId: string; decision: 'allowed' | 'rejected' | 'cancelled' | 'unavailable' }
  'a2a.request_received': { fromDid?: string; fromLabel?: string; remoteTaskId: string; grantRef?: string }
  'execution.attempt_started': { attemptId: string; agentId: string; traceId?: string }
  'execution.attempt_finished': { attemptId: string; outcome: 'succeeded' | 'failed' | 'cancelled' }
  'usage.recorded': {
    model: string
    /** Integers only — the canonical form rejects floats (see iflow-protocol/canonical.ts). */
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
    /** Micro-units of currency, integer, to stay canonicalizable. */
    costMicros: number
    currency: string
    priceSource: string
  }
}

/**
 * An event whose `type` and `payload` are known to belong together.
 *
 * Written as a mapped type rather than an intersection so `type` stays a
 * literal discriminant: that is what lets a reducer narrow the union with a
 * plain `event.type === '...'` check.
 */
export type DomainEvent<K extends EventType = EventType> = {
  [P in K]: Omit<IFlowEvent<EventPayloadMap[P]>, 'type'> & { type: P }
}[K]

/** A journal line whose type we may not recognize yet (forward compatibility). */
export type AnyIFlowEvent = IFlowEvent<unknown>

export function isDomainEvent(event: AnyIFlowEvent): event is DomainEvent {
  return isKnownEventType(event.type)
}

export function isEventOfType<K extends EventType>(event: AnyIFlowEvent, type: K): event is DomainEvent<K> {
  return event.type === type
}
