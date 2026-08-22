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
  ExecutionAttempt,
  Goal,
  Room,
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
  subjectKind: 'agent' | 'goal' | 'task' | 'room' | 'artifact'
  subjectId: string
  taskId?: string
  goalId?: string
  roomId?: string
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
}

export type { Agent, Approval, ExecutionAttempt, Goal, Room, Task, TaskState, ToolCall }
