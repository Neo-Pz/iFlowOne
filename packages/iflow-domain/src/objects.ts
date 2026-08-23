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
  /** The Principal's did:key. The signature on any human authorization. */
  did: string
  /** The grant binding this Agent to that Principal, by its content hash. */
  grantRef: string
  /** Display name, when the Principal chose to publish one. */
  label?: string
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
  | 'completed'
  | 'failed'

/**
 * Legal transitions. A Task is work that must be completed; a retry is a new
 * ExecutionAttempt inside the same Task, never a new Task, so runtime retry
 * behavior cannot rewrite collaborative semantics.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = Object.freeze({
  created: ['delegated', 'running', 'waiting', 'blocked', 'failed', 'completed'],
  delegated: ['running', 'waiting', 'blocked', 'awaiting_approval', 'failed', 'completed'],
  running: ['waiting', 'blocked', 'awaiting_approval', 'completed', 'failed'],
  waiting: ['running', 'blocked', 'awaiting_approval', 'completed', 'failed'],
  blocked: ['running', 'waiting', 'awaiting_approval', 'completed', 'failed'],
  awaiting_approval: ['running', 'waiting', 'blocked', 'completed', 'failed'],
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
  /** What this work was priced at, once it settled. */
  settlement?: Settlement
  createdAt: string
  updatedAt: string
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
