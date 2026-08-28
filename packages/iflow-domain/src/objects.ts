/**
 * The five first-class iFlow objects.
 *
 * IFLOWONE-ARCHITECTURE.md, "Domain model". `iflow-domain` is the only layer
 * allowed to define these and their state semantics; transport and adapters
 * may carry them but never redefine them.
 */

/** Is the Agent reachable? */
export type AgentPresence = 'online' | 'offline' | 'unknown'

/** Is the Agent doing work right now? */
export type AgentExecution = 'idle' | 'running' | 'paused' | 'failed'

/** Is the Agent able to make progress with others? */
export type AgentCoordination = 'ready' | 'waiting' | 'blocked' | 'awaiting_approval'

/**
 * The three axes are independent on purpose: an Agent may legitimately be
 * `online + running + awaiting_approval` at the same instant. Collapsing them
 * into one enum is what makes a network view lie.
 */
export interface AgentState {
  presence: AgentPresence
  execution: AgentExecution
  coordination: AgentCoordination
}

export const INITIAL_AGENT_STATE: AgentState = {
  presence: 'unknown',
  execution: 'idle',
  coordination: 'ready',
}

/**
 * Who an Agent answers to.
 *
 * Identity has two layers: a Principal — a person or an organization — holds a
 * key and may operate several Agents, each with a key of its own. The binding
 * is a grant the Principal signed naming that Agent as its delegate, so a third
 * party can verify "this Agent is operated by that Principal" without trusting
 * either of them.
 *
 * This is what makes an autonomous Agent accountable rather than unowned. An
 * Agent with no Principal is not forbidden — a node may run one before anyone
 * has claimed it — but nothing it agrees to can bind a human.
 */
export interface PrincipalRef {
  /** Stable person/organization identity. It does not change with a key rotation. */
  principalId: string
  /** The current authority key that signed this binding. */
  authorityDid: string
  /** Monotonic authority generation. A verifier refuses rollback. */
  authorityVersion: number
  /** The grant binding this Agent to that Principal, by its content hash. */
  grantRef: string
  /** Display name, when the Principal chose to publish one. */
  label?: string
}

/** A future recovery protocol is referenced, not implemented, by P0. */
export interface RecoveryPolicyRef {
  policyId: string
  version: number
  digest: string
}

/** Stable identity with a rotatable authority key. */
export interface PrincipalDocument {
  principalId: string
  authorityDid: string
  authorityVersion: number
  recoveryPolicy?: RecoveryPolicyRef
}

/** Why a Principal may select an Agent in the private From picker. */
export interface FromAgentGrant {
  principalId: string
  agentId: string
  right: 'send_as'
  scope?: string[]
  expiresAt?: string
}

/** Who is acting. */
export interface Agent {
  id: string
  did?: string
  label: string
  nodeId: string
  runtimeKind: string
  capabilities: string[]
  state: AgentState
  /**
   * The Principal this Agent acts for.
   *
   * Optional because the field arrived after the first agents did, and a fact
   * already written is not rewritten. Absent means unclaimed, which a reader
   * should treat as "nobody has accepted responsibility for this", not as
   * "trusted by default".
   */
  principal?: PrincipalRef
  /** Evidence a peer can check, not a score we assert. */
  trustEvidence: TrustEvidence[]
  registeredAt: string
  lastSeenAt?: string
}

export interface TrustEvidence {
  kind: 'did_verified' | 'agent_card_signed' | 'grant_accepted' | 'peer_endorsement'
  at: string
  detail?: string
}

/** Why work is happening. */
export interface Goal {
  id: string
  title: string
  issuerId: string
  constraints?: string[]
  budget?: { currency: string; limit: number }
  createdAt: string
  roomId?: string
}

export type TaskState =
  | 'created'
  | 'delegated'
  | 'running'
  | 'waiting'
  | 'blocked'
  | 'awaiting_approval'
  /**
   * Work was handed back and nobody has ruled on it yet.
   *
   * This state exists so that finishing and being accepted are two events with
   * two authors. Before it, the executor emitted one fact that both delivered
   * the work and terminated the Task, which meant an Agent could accept its
   * own output and the requester had no place to disagree.
   */
  | 'delivered'
  | 'completed'
  | 'failed'

/**
 * Legal transitions. A Task is work that must be completed; a retry is a new
 * ExecutionAttempt inside the same Task, never a new Task, so runtime retry
 * behavior cannot rewrite collaborative semantics.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = Object.freeze({
  created: ['delegated', 'running', 'waiting', 'blocked', 'delivered', 'failed'],
  delegated: ['running', 'waiting', 'blocked', 'awaiting_approval', 'delivered', 'failed'],
  running: ['waiting', 'blocked', 'awaiting_approval', 'delivered', 'failed'],
  waiting: ['running', 'blocked', 'awaiting_approval', 'delivered', 'failed'],
  blocked: ['running', 'waiting', 'awaiting_approval', 'delivered', 'failed'],
  awaiting_approval: ['running', 'waiting', 'blocked', 'delivered', 'failed'],
  // A rejected Delivery sends the work back rather than ending it.
  delivered: ['completed', 'running', 'failed'],
  completed: [],
  failed: ['running'],
})

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to)
}

/**
 * One real execution of a Task. Not a sixth first-class object: it exists only
 * inside its Task, and a trace observes an Attempt rather than the Task.
 */
export interface ExecutionAttempt {
  attemptId: string
  agentId: string
  startedAt: string
  finishedAt?: string
  outcome?: 'succeeded' | 'failed' | 'cancelled'
  traceId?: string
}

/** What concrete work is happening. */
export interface Task {
  id: string
  title: string
  state: TaskState
  goalId?: string
  roomId?: string
  ownerAgentId?: string
  parentTaskId?: string
  dependsOn: string[]
  attempts: ExecutionAttempt[]
  blockingReason?: string
  outputs: TaskOutput[]
  /** Every hand-back, in order. A rejection is followed by another, not a rewrite. */
  deliveries: Delivery[]
  /**
   * The grant a delegation cited, if it cited one.
   *
   * A reference to check, not a permission. Whether the work may actually run
   * is decided by policy on the machine that would run it; recording this only
   * makes the claim auditable afterwards.
   */
  authorizedBy?: string
  /** What this work was priced at, once it settled. */
  settlement?: Settlement
  createdAt: string
  updatedAt: string
}

/**
 * Work handed back for a Task.
 *
 * A Delivery binds three things a reader needs in order to hold anyone to it:
 * the Task, the Agent that executed it, and the evidence. It is deliberately
 * not a conclusion — submitting one says the executor is finished, and says
 * nothing at all about whether the work was any good.
 */
export interface Delivery {
  deliveryId: string
  taskId: string
  /** Who did the work, and therefore who may not rule on it. */
  byAgentId: string
  outputs: TaskOutput[]
  /** References a reader can check — digests, artifact ids. Never the content. */
  evidence: string[]
  summary?: string
  submittedAt: string
  /** Absent until somebody rules. Absence is not tacit approval. */
  acceptance?: Acceptance
}

/**
 * Somebody ruled on a Delivery.
 *
 * A separate fact with a separate author, because the alternative is that
 * finishing work is the same act as approving it. Only the party that asked
 * for the work may sign this; a fold that sees the executor accept its own
 * Delivery records an anomaly and leaves the Task delivered.
 */
export interface Acceptance {
  outcome: 'accepted' | 'rejected'
  decidedBy: string
  decidedByKind: 'agent' | 'human'
  at: string
  reason?: string
  /**
   * Reconstructed from a pre-split `task.completed`, where finishing and
   * accepting were one event and no decision was ever recorded. Kept visible
   * rather than presented as a real ruling nobody actually made.
   */
  legacy?: boolean
}

export interface TaskOutput {
  kind: 'artifact' | 'message' | 'error'
  id: string
  summary: string
  at: string
}

/**
 * A price one Agent offered another for a Task.
 *
 * Amounts are integer micro-units of the currency, never floats: the canonical
 * form rejects non-integer numbers so that two languages sign the same bytes
 * (see iflow-protocol/canonical.ts). 1_500_000 micros = 1.50 of the currency.
 */
export interface Quote {
  quoteId: string
  taskId: string
  /** The Agent that would do the work and named this price. */
  offeredBy: string
  /** The Agent that would pay. */
  offeredTo: string
  amountMicros: number
  currency: string
  /**
   * What kind of work this price is for, as an `iflow.cap:` id. This is the
   * key a market aggregate groups by — without it a price is a number with no
   * comparable.
   */
  capability?: string
  expiresAt: string
  terms?: string
  offeredAt: string
  acceptedAt?: string
  /** Set when the offer was accepted; the pair is what makes a price binding. */
  acceptedBy?: string
}

/**
 * How much actually changed hands, and who may see it.
 *
 * Distinct from `usage.recorded`, which is COST — what the compute burned.
 * A settlement is PRICE — what one party charged another. Conflating them
 * would make a market aggregate meaningless.
 */
export interface Settlement {
  taskId: string
  quoteId?: string
  payerAgentId: string
  payeeAgentId: string
  amountMicros: number
  currency: string
  /**
   * Who may see this number.
   *
   *   private   — only the two parties; never leaves their journals
   *   aggregate — may be counted in market statistics, but not shown per-deal
   *   public    — the parties chose to publish this specific deal
   *
   * Default is `private`. A marketplace that publishes every deal by default
   * destroys legitimate price discrimination and invites wash trading; the
   * decision belongs to the parties, not to the protocol.
   */
  visibility: SettlementVisibility
  /** Where the price came from. */
  basis: 'quote' | 'metered' | 'negotiated'
  /** External payment reference, when settlement happened off-network. */
  settlementRef?: string
  settledAt: string
}

export type SettlementVisibility = 'private' | 'aggregate' | 'public'

/** Who is collaborating — a coordination space for a Goal or root Task. */
export interface Room {
  id: string
  title: string
  goalId?: string
  rootTaskId?: string
  participantAgentIds: string[]
  createdAt: string
}

/** A tool invocation observed on an edge. */
export interface ToolCall {
  callId: string
  taskId?: string
  agentId: string
  toolName: string
  startedAt: string
  finishedAt?: string
  outcome?: 'ok' | 'error' | 'denied'
  errorMessage?: string
}

/** An approval that gated real work. */
export interface Approval {
  approvalId: string
  taskId?: string
  agentId: string
  reason: string
  requestedAt: string
  resolvedAt?: string
  decision?: 'allowed' | 'rejected' | 'cancelled' | 'unavailable'
}

/**
 * A Conversation is a communication thread between Agents. A Session is a
 * Runtime's private execution container. They are different objects with
 * different lifetimes, and this is the single most important distinction in
 * the model.
 *
 * Two edges talking share one `conversationId`; each independently maps it to
 * a local session id that the other never learns. Deleting a local session
 * does not end the Conversation — the next message on the same id simply binds
 * a fresh one.
 *
 * There is no transcript here, and there never will be. iFlow owns
 * relationships, not conversations.
 */
export type ConversationState = 'pending' | 'accepted' | 'active' | 'rejected' | 'closed'

export interface ConversationParticipant {
  agentId: string
  did?: string
  /**
   * The Principal that owns this participant.
   *
   * This is what makes "does this Conversation cross an ownership boundary" a
   * computable predicate rather than a comment. iFlow governs crossings of
   * ownership boundaries: two Agents under the same Principal coordinating is
   * that Principal's internal business, while two Agents under different
   * Principals is precisely what needs identity, authorization and settlement.
   */
  principalId?: string
  role: 'initiator' | 'recipient'
  joinedAt: string
}

export interface Conversation {
  conversationId: string
  participants: ConversationParticipant[]
  state: ConversationState
  createdAt: string
  updatedAt: string
  /** Derived from the participants, never asserted by a peer. */
  crossesOwnershipBoundary: boolean
  lastMessageId?: string
}

/**
 * How two Agents are related, as a durable object rather than something
 * re-derived from task history.
 *
 * The Network graph renders these. An edge drawn from a Task is a snapshot of
 * work; an edge drawn from an AgentRelation is a relationship, which is what a
 * network is actually made of.
 */
export type AgentRelationType =
  | 'followed'
  | 'contacted'
  | 'trusted'
  | 'worked_with'
  | 'delegated_to'
  | 'transacted_with'

/**
 * A record that a grant exists — deliberately not the grant.
 *
 * Named `GrantRecord` rather than `Grant` because that is what it is. The
 * authority lives in a document signed by the Principal's key and verified by
 * `iflow-id grant verify`; what the journal keeps is the content hash and the
 * terms, so a reader can say "this Task cited that grant" and go check it.
 *
 * A grant a projection could mint is a grant nobody signed, so this object is
 * never sufficient to permit anything. Its state is derived at read time by
 * `grantStateAt` and never written back: a revocation ends authority going
 * forward and does not edit what was true before it.
 */
export interface GrantRecord {
  /** Content hash of the signed grant, issued by iflow-id. */
  grantRef: string
  /** The Principal that signed it. */
  issuerDid: string
  /** The Agent it was issued to. */
  subjectDid: string
  scope: string[]
  constraints: string[]
  level?: 'L0' | 'L1' | 'L2' | 'L3'
  issuedAt: string
  expiresAt: string
  revokedAt?: string
  revocationReason?: string
}

export type GrantState = 'active' | 'expired' | 'revoked'

/**
 * How a grant stands at a given instant.
 *
 * Derived, never stored. Asking "was this grant valid then" must keep working
 * after a revocation, because a Task authorized while it held remains
 * verifiable — that is the difference between a journal and an opinion.
 */
export function grantStateAt(record: GrantRecord, at: string): GrantState {
  if (record.revokedAt && record.revokedAt <= at) return 'revoked'
  if (record.expiresAt <= at) return 'expired'
  return 'active'
}

export interface AgentRelation {
  sourceAgentId: string
  targetAgentId: string
  type: AgentRelationType
  createdAt: string
  updatedAt: string
  /** How many times this relation has been reasserted. Not a reputation score. */
  strength: number
  visibility: 'private' | 'public'
}

/**
 * An intentionally public statement an Agent signed for discovery.
 *
 * A Publication is not a task, a grant, a relationship, or a message. It can
 * help another Agent find an opportunity, but it never gives the reader a
 * right to contact, invoke, delegate to, or pay the publisher. Those actions
 * still require their own policy and authorization path.
 */
export type PublicationKind = 'offer' | 'request' | 'signal' | 'alert'

/** P1 deliberately permits only public discovery publications. */
export type PublicationVisibility = 'public'

/** How the active Discovery projection currently regards the publication. */
export type PublicationState = 'active' | 'expired' | 'withdrawn'

export interface Publication {
  publicationId: string
  /** The Agent that made this public statement, never its Node or Principal. */
  publishedByAgentId: string
  kind: PublicationKind
  visibility: PublicationVisibility
  /** Short, intentionally public text. Runtime context and chat text never go here. */
  summary: string
  /** Stable, human- and machine-readable discovery namespaces. */
  domains: string[]
  /** Optional `iflow.cap:` identifiers that make capability matching explicit. */
  capabilities: string[]
  /** Optional narrow labels; ranking is deliberately outside this object. */
  tags: string[]
  /** A non-authoritative hint about the response the publisher is willing to receive. */
  expectedResponses: PublicationResponse[]
  /** The statement leaves the active view at this instant unless withdrawn earlier. */
  expiresAt: string
  /**
   * Domain-separated, nonce-hardened commitment to selected local facts.
   * This is evidence that may later be opened locally; it is not the content
   * of the Discovery publication and does not disclose the selected facts.
   */
  commitment: string
  commitmentScheme: 'iflow-commitment-v1'
  createdAt: string
  withdrawnAt?: string
  withdrawalReason?: string
}

/** A response preference, never a grant or an automatically allowed action. */
export type PublicationResponse = 'contact' | 'proposal' | 'quote' | 'information'

/**
 * Something waiting on a human at this node.
 *
 * The local question is never "what happened" — that is the Activity feed —
 * but "what is waiting for me". Contact requests, permission requests, task
 * proposals, quotes and payment requests all answer that question, so they
 * share one object and one inbox.
 */
export type IncomingRequestKind =
  | 'conversation'
  | 'permission'
  | 'task_proposal'
  | 'quote'
  | 'delivery'
  | 'payment'

export interface IncomingRequest {
  requestId: string
  kind: IncomingRequestKind
  conversationId?: string
  fromAgentId: string
  fromDid?: string
  receivedAt: string
  expiresAt?: string
  state: 'pending' | 'accepted' | 'rejected' | 'expired'
  /**
   * A short excerpt so a person can decide. Local only: it is the one free-text
   * field on this object and it is never published.
   */
  preview: string
}

/**
 * Which local working directory an Agent acts in.
 *
 * `workspaceRoot` is a path on someone's disk. The fact that a binding exists
 * may be public; the path never is — see the publish filter in
 * `iflow-adapter-sdk`, which keeps `workspace.bound` off the wire entirely.
 */
export interface WorkspaceBinding {
  agentId: string
  runtime: string
  nodeId: string
  workspaceRoot: string
  boundAt: string
}
