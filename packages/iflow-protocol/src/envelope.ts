/**
 * Versioned envelopes for every cross-component fact and request.
 *
 * IFLOWONE-ARCHITECTURE.md, "Domain model" / "Command contract": the transport
 * layer carries these shapes; it never interprets them. Payload semantics and
 * the legal `type` vocabulary belong to `iflow-domain`.
 */

/**
 * The only kind of thing that may perform a network action.
 *
 * Principle 0: a person originates intent and authority; an Agent originates
 * network facts. The union has one member on purpose — it is a statement, not
 * a placeholder waiting for a second value.
 */
export type IFlowNetworkActorKind = 'agent'

/**
 * Issuer kinds that appear in facts written before principle 0 was frozen.
 *
 * Readable forever, emittable never. `system` is here for the same reason as
 * `human`: an issuer named the Community or the runtime is an action with no
 * accountable Agent behind it, which principle 6 forbids from the other
 * direction. Infrastructure that wants to attest something says so in a fact
 * of its own rather than by signing as a social actor.
 */
export type IFlowLegacyIssuerKind = 'human' | 'system'

/** Who asserted the fact or issued the request. Always an Agent. */
export interface IFlowIssuer {
  id: string
  did?: string
  kind: IFlowNetworkActorKind
}

/**
 * An issuer as it may be found on disk or on the wire.
 *
 * Deliberately wider than `IFlowIssuer`: a reader that types every stored
 * envelope as Agent-issued would be asserting that history complied with a
 * principle that did not exist when it was written. Emitters take
 * `IFlowIssuer`; readers take this and check `isLegacyIssuer`.
 */
export interface IFlowStoredIssuer {
  id: string
  did?: string
  kind: IFlowNetworkActorKind | IFlowLegacyIssuerKind
}

/** True for a fact written before the Agent-only issuer invariant. */
export function isLegacyIssuer(issuer: IFlowStoredIssuer): boolean {
  return issuer.kind !== 'agent'
}

/** What the fact is about. */
export interface IFlowSubject {
  kind: 'agent' | 'goal' | 'task' | 'room' | 'artifact' | 'conversation' | 'principal' | 'publication'
  id: string
}

/**
 * Where the fact was born. `seq` is monotonically increasing only inside one
 * origin stream — never across nodes, and never a global order.
 */
export interface IFlowOrigin {
  nodeId: string
  streamId: string
  seq: number
}

export interface IFlowTrace {
  traceId?: string
  spanId?: string
  parentSpanId?: string
}

export interface IFlowEvidence {
  source: 'dsh' | 'a2a' | 'user' | 'projection'
  signature?: string
}

/**
 * Whether an origin fact may leave the node that observed it.
 *
 * `local` is the safe default. Visibility is part of the signed envelope, so
 * publishing a fact later requires a new publication event rather than
 * mutating history.
 */
export type IFlowVisibility = 'local' | 'public'

/** An append-only business fact. Events describe what already happened. */
export interface IFlowEvent<T = unknown> {
  id: string
  schemaVersion: number
  origin: IFlowOrigin
  /** Assigned only by a Journal that accepts the event. Never a substitute for origin order. */
  journalOffset?: number
  occurredAt: string
  observedAt?: string
  correlationId: string
  causationId?: string
  /** Stable owner/authorizer identity. Never substitute an authority, node, or Agent DID. */
  principalId?: string
  /** Signed at the origin. Schema v2 and later require this field. */
  visibility: IFlowVisibility
  type: string
  /** Read as stored. Everything newly emitted is an Agent; history may not be. */
  issuer: IFlowStoredIssuer
  subject: IFlowSubject
  goalId?: string
  taskId?: string
  roomId?: string
  /**
   * The Conversation this fact belongs to, when it belongs to one.
   *
   * A context shortcut like `taskId` and `roomId`, not a replacement for
   * `subject`. On the A2A wire this is carried by the protocol's existing
   * `contextId` field rather than a parallel header.
   */
  conversationId?: string
  trace?: IFlowTrace
  payload: T
  evidence?: IFlowEvidence
}

/**
 * A request for a future action. Commands are NOT events: they are proposals
 * an edge may accept or reject inside its own permission boundary.
 */
export interface IFlowCommand {
  commandId: string
  idempotencyKey: string
  issuer: { id: string; did?: string }
  target: { nodeId: string; agentId?: string; taskId?: string }
  requestedAction: string
  grantRef?: string
  budgetConstraint?: unknown
  expiresAt: string
  correlationId: string
  causationId?: string
}

/** The required chain every command follows before any domain event is emitted. */
export type CommandOutcome =
  | { kind: 'accepted'; commandId: string; attemptId: string }
  | { kind: 'rejected'; commandId: string; reason: string }

/** A signature detached from the envelope it covers. */
export interface IFlowSignature {
  alg: 'EdDSA'
  signerDid: string
  /** base64url, no padding — over `canonicalBytes(unsignedEvent)`. */
  value: string
}

/** An event plus the signature that makes it verifiable off-node. */
export interface SignedIFlowEvent<T = unknown> {
  event: IFlowEvent<T>
  signature: IFlowSignature
}
