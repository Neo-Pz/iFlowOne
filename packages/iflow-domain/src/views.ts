/**
 * Read-model contracts.
 *
 * This file is the entire surface the Hub UI is allowed to know about: it
 * never sees a Journal, a reducer, or a transport. A new graph algorithm or
 * state rule ships as a v2 projection with a new `projectionVersion`; it never
 * mutates historical facts.
 */

import type {
  Agent,
  Approval,
  Conversation,
  ExecutionAttempt,
  Goal,
  IncomingRequest,
  Quote,
  Room,
  Settlement,
  SettlementVisibility,
  Task,
  TaskState,
  ToolCall,
} from './objects.js'

/** Every view carries where it was built from, so a stale read is detectable. */
export interface ProjectionMeta {
  projectionVersion: number
  /** Last event id folded into this view. */
  cursor?: string
  /** Per-origin-stream high-water mark: `streamId -> seq`. */
  streamCursors: Record<string, number>
  eventCount: number
  builtAt: string
}

export interface ViewEnvelope<T> {
  meta: ProjectionMeta
  data: T
}

export interface AgentStateView {
  agents: Agent[]
}

export interface NetworkNode {
  id: string
  kind: 'agent' | 'goal' | 'task' | 'room'
  label: string
  /** Free-form badge the renderer may show, e.g. an Agent's execution axis. */
  status?: string
}

/**
 * Conversations as threads, with no message content anywhere in the shape.
 *
 * A reader can see that a thread exists, who is in it, whether it crosses an
 * ownership boundary and whether it is waiting on someone. What was said is
 * not here and is not obtainable from here.
 */
export interface ConversationListView {
  conversations: Conversation[]
  /** How many are waiting on a decision at this node. */
  pending: number
}

/**
 * The local "what is waiting for me" list.
 *
 * Deliberately not an activity feed: an activity feed answers what happened,
 * which is a different and much less useful question for the person sitting in
 * front of the machine.
 *
 * `preview` is absent here. The excerpt lives in local runtime state and is
 * joined in by the edge that owns it, so the shared model never carries
 * message text even for a request that is about a message.
 */
export interface RequestsView {
  requests: Omit<IncomingRequest, 'preview'>[]
}

/**
 * Relationship edges only. Raw log lines are deliberately NOT edges — the graph
 * shows delegation, dependency, participation, trust, delivery and approval.
 */
export type NetworkEdgeKind =
  | 'delegation'
  | 'dependency'
  | 'participation'
  | 'ownership'
  | 'trust'
  | 'delivery'
  | 'approval'
  // Drawn from AgentRelation rather than from work: who has talked to whom,
  // who has actually worked with whom, who has transacted. A network is made
  // of relationships, and these are the only edges that are one.
  | 'contact'
  | 'collaboration'
  | 'transaction'

export interface NetworkEdge {
  id: string
  source: string
  target: string
  kind: NetworkEdgeKind
  label?: string
}

export interface NetworkGraphView {
  nodes: NetworkNode[]
  edges: NetworkEdge[]
}

export interface TaskGraphNode {
  task: Task
  depth: number
}

export interface TaskGraphView {
  roomId?: string
  goalId?: string
  nodes: TaskGraphNode[]
  edges: { source: string; target: string; kind: 'dependency' | 'subtask' }[]
}

export interface ActivityEntry {
  eventId: string
  type: string
  occurredAt: string
  correlationId: string
  actorId: string
  actorKind: 'agent' | 'human' | 'system'
  subjectKind: 'agent' | 'goal' | 'task' | 'room' | 'artifact' | 'conversation'
  subjectId: string
  taskId?: string
  goalId?: string
  roomId?: string
  conversationId?: string
  /** One-line human summary derived from the payload — never a model guess. */
  summary: string
}

export interface ActivityFeedView {
  entries: ActivityEntry[]
  /** True when older entries were dropped by the retention window. */
  truncated: boolean
}

export interface RoomView {
  room: Room
  goal?: Goal
  participants: Agent[]
  tasks: Task[]
  approvals: Approval[]
  toolCalls: ToolCall[]
}

/**
 * What a price looks like once it is safe to publish.
 *
 * Deliberately a DISTRIBUTION, not a list of deals. Publishing every
 * counterparty and amount would destroy legitimate price discrimination — the
 * same supplier may charge a high-volume buyer less, for good reason — so the
 * default shape a market exposes is the shape of the market, not its contents.
 * A specific deal appears only when both parties marked it `public`.
 */
export interface PriceBand {
  /** `iflow.cap:` id this band prices. */
  capability: string
  currency: string
  /** Integer micro-units. */
  lowMicros: number
  medianMicros: number
  highMicros: number
  /** How many settlements this band summarizes. */
  settlements: number
  /**
   * Distinct counterparty PAIRS behind those settlements.
   *
   * A band with many settlements but one pair is one relationship repeating,
   * not a market rate — and it is exactly the shape wash trading produces.
   * Publishing this alongside the price lets a reader judge for themselves
   * rather than trusting the aggregate.
   */
  distinctPairs: number
}

export interface MarketView {
  bands: PriceBand[]
  /** Deals both parties chose to publish, in full. */
  published: Settlement[]
  /** Settlements excluded from every band because they were marked private. */
  withheld: number
}

export interface TrustEvidenceView {
  agentId: string
  did?: string
  evidence: Agent['trustEvidence']
}

/** Everything a Hub can ask an edge for. Implementations live outside the domain. */
export interface ProjectionSet {
  agents: ViewEnvelope<AgentStateView>
  network: ViewEnvelope<NetworkGraphView>
  activity: ViewEnvelope<ActivityFeedView>
  tasks: ViewEnvelope<TaskGraphView>
  conversations: ViewEnvelope<ConversationListView>
  requests: ViewEnvelope<RequestsView>
}

export type {
  Agent,
  Approval,
  Conversation,
  ExecutionAttempt,
  Goal,
  IncomingRequest,
  Quote,
  Room,
  Settlement,
  SettlementVisibility,
  Task,
  TaskState,
  ToolCall,
}
