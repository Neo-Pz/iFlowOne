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

/** Who is acting. */
export interface Agent {
  id: string
  did?: string
  label: string
  nodeId: string
  runtimeKind: string
  capabilities: string[]
  state: AgentState
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
  createdAt: string
  updatedAt: string
}

export interface TaskOutput {
  kind: 'artifact' | 'message' | 'error'
  id: string
  summary: string
  at: string
}

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
