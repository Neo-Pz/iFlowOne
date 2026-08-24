/**
 * The event vocabulary and its payloads.
 *
 * Events describe facts that ALREADY happened. Anything a model merely intends
 * or suggests must be carried as `declared_plan` / `derived_next_step` /
 * `suggested_action` (see `SuggestionKind`) so a UI can never present a guess
 * as an observation.
 */

import type { IFlowEvent } from 'iflow-protocol'
import type {
  AgentCoordination,
  AgentExecution,
  AgentPresence,
  AgentRelationType,
  ConversationParticipant,
  PrincipalRef,
  SettlementVisibility,
  TrustEvidence,
} from './objects.js'

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
  // The economic layer. A price is a two-party fact, so it arrives as a pair:
  // a signed offer, and an acceptance that embeds and countersigns it.
  'quote.offered',
  'quote.accepted',
  'task.settled',
  // The conversation layer. A Conversation is the durable thread between two
  // Agents; each side's Session is a private execution container underneath it.
  // These carry structure and digests only — never message text — so they are
  // safe by construction rather than by redaction.
  'conversation.opened',
  'conversation.message_sent',
  'conversation.message_received',
  'conversation.accepted',
  'conversation.rejected',
  'conversation.closed',
  // Relationships as durable objects, so the network graph has a real source.
  'relation.recorded',
  // Which local runtime an Agent acts in. Never carries the path.
  'workspace.bound',
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
    /** The Principal this Agent acts for, when one has claimed it. */
    principal?: PrincipalRef
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
  /** The supplier names a price. Subject is the Task; the issuer is the offerer. */
  'quote.offered': {
    quoteId: string
    offeredBy: string
    offeredTo: string
    /** Integer micro-units. The canonical form rejects floats. */
    amountMicros: number
    currency: string
    /** `iflow.cap:` id, so a market aggregate has something to group by. */
    capability?: string
    expiresAt: string
    terms?: string
  }
  /**
   * The buyer accepts, and countersigns.
   *
   * `offerEventId` and `offerSignature` bind this acceptance to one specific
   * signed offer. Either half alone is a one-sided claim; the pair is what a
   * third party can verify without trusting either participant.
   */
  'quote.accepted': {
    quoteId: string
    acceptedBy: string
    offerEventId: string
    offerSignature: string
  }
  /** What actually changed hands. */
  'task.settled': {
    quoteId?: string
    payerAgentId: string
    payeeAgentId: string
    amountMicros: number
    currency: string
    visibility: SettlementVisibility
    basis: 'quote' | 'metered' | 'negotiated'
    settlementRef?: string
  }
  'usage.recorded': {
    model: string
    /** Integers only — the canonical form rejects floats (see iflow-protocol/canonical.ts). */
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
    /** Micro-units of currency, integer, to stay canonicalizable. */
    costMicros: number
    currency: string
    priceSource: string
  }
  /** Subject is the Conversation. */
  'conversation.opened': {
    participants: ConversationParticipant[]
    initiatedBy: string
    crossesOwnershipBoundary: boolean
  }
  /**
   * One message crossed the wire.
   *
   * `contentDigest` and NOT the text. The plaintext is the most revealing thing
   * a node holds; it belongs to the local runtime record, not to a
   * network-shaped fact. A digest still proves "this exact message was the one
   * exchanged" to anyone who holds the plaintext, which is the only party who
   * should be able to check.
   *
   * `actorType` distinguishes a human typing from the Agent speaking on its own
   * initiative. Both enter the network under the same Agent identity — the
   * Agent is always the network actor — but a reader is entitled to know which
   * one produced the words.
   */
  'conversation.message_sent': {
    messageId: string
    toAgentId: string
    actorType: MessageActorType
    origin: MessageOrigin
    contentDigest: string
  }
  'conversation.message_received': {
    messageId: string
    fromAgentId: string
    actorType: MessageActorType
    origin: MessageOrigin
    contentDigest: string
  }
  /**
   * The recipient side let this Conversation exist.
   *
   * `decidedBy` separates a person clicking Accept from a standing policy
   * matching. Both are legitimate; conflating them would make an audit unable
   * to answer "did a human ever look at this".
   */
  'conversation.accepted': { acceptedBy: string; decidedBy: AcceptanceDecider }
  'conversation.rejected': { rejectedBy: string; decidedBy: AcceptanceDecider; reason?: string }
  'conversation.closed': { reason?: string }
  'relation.recorded': {
    sourceAgentId: string
    targetAgentId: string
    type: AgentRelationType
    visibility?: 'private' | 'public'
  }
  /** Subject is the Agent. Deliberately without `workspaceRoot`. */
  'workspace.bound': { agentId: string; runtime: string; nodeId: string }
}

/** Who produced the words in a message. The network actor is always the Agent. */
export type MessageActorType = 'human' | 'agent'

/** How the message came to exist. */
export type MessageOrigin = 'keyboard' | 'agent' | 'api' | 'a2a' | 'autonomous'

/** Whether a person or a standing policy made an acceptance decision. */
export type AcceptanceDecider = 'human' | 'policy'

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
