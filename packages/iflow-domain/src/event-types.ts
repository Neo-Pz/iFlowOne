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
  AcceptanceDecider,
  AgentCoordination,
  AgentExecution,
  AgentPresence,
  AgentRelationType,
  ConversationParticipant,
  PublicationKind,
  PublicationResponse,
  PublicationVisibility,
  PrincipalRef,
  SettlementVisibility,
  TrustEvidence,
} from './objects.js'

export const EVENT_TYPES = [
  // Stable Principal identity and its current rotatable authority.
  'principal.declared',
  'authority.rotated',
  'authority.revoked',
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
  'delivery.submitted',
  'delivery.accepted',
  'delivery.rejected',
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
  'grant.issued',
  'grant.revoked',
  'trust_evidence.recorded',
  // Which local runtime an Agent acts in. Never carries the path.
  'workspace.bound',
  // Publishing is a new signed act; it never mutates a local fact.
  'publication.created',
  // Withdrawal is also a new signed fact. It removes an item from the active
  // view, never from the immutable public Journal.
  'publication.withdrawn',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES)

export function isKnownEventType(type: string): type is EventType {
  return EVENT_TYPE_SET.has(type)
}

/** How a non-fact must be labelled if it ever travels as an event payload. */
export type SuggestionKind = 'declared_plan' | 'derived_next_step' | 'suggested_action'

export interface EventPayloadMap {
  'principal.declared': {
    principalId: string
    authorityDid: string
    authorityVersion: number
    recoveryPolicy?: { policyId: string; version: number; digest: string }
  }
  'authority.rotated': {
    principalId: string
    previousAuthorityDid: string
    authorityDid: string
    authorityVersion: number
    proof: string
  }
  'authority.revoked': {
    principalId: string
    authorityDid: string
    authorityVersion: number
    reason?: string
  }
  'agent.registered': {
    label: string
    did?: string
    nodeId: string
    runtimeKind: string
    capabilities: string[]
    discovery?: import('iflow-protocol').AgentDiscoveryProfile | null
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
  'task.delegated': {
    toAgentId: string
    fromAgentId?: string
    reason?: string
    grantRef?: string
    /**
     * Whether the work is going to another Principal's Agent. Stated by the
     * delegating side, which is the only one that knows; the fold uses it to
     * decide whether the executor may end the Task on its own.
     */
    crossesOwnershipBoundary?: boolean
  }
  'task.started': { agentId: string; attemptId: string }
  'task.waiting': { reason: string }
  'task.blocked': { reason: string; blockedOnTaskId?: string }
  'task.awaiting_approval': { approvalId: string; reason: string }
  /**
   * Legacy. Kept because older nodes still emit it, and folded as a Delivery
   * that was accepted the moment it arrived — which is what it meant, though
   * nobody signed that acceptance. New emitters use `delivery.submitted`.
   */
  'task.completed': { summary?: string; outputs?: { kind: 'artifact' | 'message'; id: string; summary: string }[] }
  /**
   * The executor hands work back. Subject is the Task.
   *
   * This does not finish the Task. Whoever asked for the work rules on it in a
   * separate fact, and until then the Task is `delivered`.
   */
  'delivery.submitted': {
    deliveryId: string
    byAgentId: string
    outputs?: { kind: 'artifact' | 'message'; id: string; summary: string }[]
    /** Digests or artifact ids a reader can check. Never the content itself. */
    evidence?: string[]
    summary?: string
  }
  /**
   * The requesting side accepted. Subject is the Task.
   *
   * Two fields, because they answer two questions. `acceptedByAgentId` is who
   * acted on the network, and principle 0 makes that an Agent whether a person
   * clicked Accept or a standing grant did; `decidedBy` is where the ruling
   * came from. The previous `decidedBy` + `decidedByKind` pair answered
   * neither cleanly: a person clicking Accept put a human id in the actor
   * field, which also meant the self-acceptance check below compared an Agent
   * id against a person's and never fired.
   *
   * `acceptedByAgentId` must not be the Agent that submitted the Delivery: an
   * executor accepting its own work is the whole failure this split exists to
   * stop, and the reducer records it as an anomaly rather than completing the
   * Task.
   */
  'delivery.accepted': {
    deliveryId: string
    acceptedByAgentId: string
    decidedBy: AcceptanceDecider
    reason?: string
  }
  /** The requesting side sent it back. The Task returns to `running`. */
  'delivery.rejected': {
    deliveryId: string
    rejectedByAgentId: string
    decidedBy: AcceptanceDecider
    reason: string
  }
  'task.failed': { reason: string }
  'room.created': { title: string; goalId?: string; rootTaskId?: string }
  'room.participant_joined': { agentId: string }
  'tool.call_started': { callId: string; toolName: string; agentId: string; argumentsDigest?: string }
  'tool.call_completed': { callId: string; toolName: string; outcome: 'ok' | 'error' | 'denied'; errorMessage?: string }
  'approval.requested': { approvalId: string; toolName?: string; reason: string; agentId: string }
  /**
   * Somebody ruled on a held tool call.
   *
   * `decidedBy` exists because this used to be recorded by naming a person as
   * the event's issuer, which principle 0 no longer allows. The information
   * was worth keeping and the issuer was the wrong place for it: "did a human
   * ever look at this" is a property of the decision, not of the actor.
   */
  'approval.resolved': {
    approvalId: string
    decision: 'allowed' | 'rejected' | 'cancelled' | 'unavailable'
    decidedBy: AcceptanceDecider
  }
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
  'conversation.accepted': { acceptedByAgentId: string; decidedBy: AcceptanceDecider }
  'conversation.rejected': { rejectedByAgentId: string; decidedBy: AcceptanceDecider; reason?: string }
  'conversation.closed': { reason?: string }
  /**
   * A grant was signed. Subject is the Agent it was issued to.
   *
   * This records that authority exists and on what terms. It does not carry
   * the authority: the signed document is verified by `iflow-id`, and
   * `grantRef` is the content hash to check it against.
   */
  'grant.issued': {
    grantRef: string
    issuerDid: string
    subjectDid: string
    scope: string[]
    constraints?: string[]
    level?: 'L0' | 'L1' | 'L2' | 'L3'
    expiresAt: string
  }
  /** Authority ends going forward. Nothing already recorded changes. */
  'grant.revoked': { grantRef: string; reason?: string }
  /**
   * Something happened that bears on whether an Agent can be believed.
   *
   * Evidence, deliberately not a score. A score is one weighting of the facts;
   * making it a fact of its own would hand every reader that weighting with no
   * way to disagree. Reputation is a projection over these.
   */
  'trust_evidence.recorded': {
    subjectAgentId: string
    kind: 'did_verified' | 'agent_card_signed' | 'grant_accepted' | 'peer_endorsement'
    detail?: string
  }
  'relation.recorded': {
    sourceAgentId: string
    targetAgentId: string
    type: AgentRelationType
    visibility?: 'private' | 'public'
  }
  /** Subject is the Agent. Deliberately without `workspaceRoot`. */
  'workspace.bound': { agentId: string; runtime: string; nodeId: string }
  'publication.created': {
    publicationId: string
    /** Domain-separated, nonce-hardened commitment to selected local facts. */
    commitment: string
    commitmentScheme: 'iflow-commitment-v1'
    publishedByAgentId: string
    /** P1 discovery permits only explicit Agent-signed public statements. */
    visibility: PublicationVisibility
    kind: PublicationKind
    /** Intentionally public; never runtime context, a chat message, or a prompt. */
    summary: string
    domains: string[]
    capabilities?: string[]
    tags?: string[]
    /** A preference only; discovery itself never conveys authority. */
    expectedResponses?: PublicationResponse[]
    expiresAt: string
  }
  'publication.withdrawn': {
    publicationId: string
    publishedByAgentId: string
    /** Optional public explanation. It cannot redact the original statement. */
    reason?: string
  }
}

/** Who produced the words in a message. The network actor is always the Agent. */
export type MessageActorType = 'human' | 'agent'

/** How the message came to exist. */
export type MessageOrigin = 'keyboard' | 'agent' | 'api' | 'a2a' | 'autonomous'

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
