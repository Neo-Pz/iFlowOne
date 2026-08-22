/**
 * Projectors: NetworkState -> versioned Read Models.
 *
 * `Journal -> Projector -> versioned Read Model -> Hub`. Each view stamps its
 * own `projectionVersion`: changing a graph rule ships a v2 projection that can
 * be rebuilt from the same Journal, never an edit to a historical fact.
 */

import type { AnyIFlowEvent } from '../event-types.js'
import { isEventOfType, isKnownEventType } from '../event-types.js'
import type { NetworkState } from '../reducers/network-state.js'
import type {
  ActivityEntry,
  MarketView,
  PriceBand,
  ActivityFeedView,
  AgentStateView,
  NetworkEdge,
  NetworkGraphView,
  NetworkNode,
  ProjectionMeta,
  ProjectionSet,
  RoomView,
  TaskGraphView,
  TrustEvidenceView,
  ViewEnvelope,
} from '../views.js'

export const AGENT_STATE_PROJECTION_VERSION = 1
export const NETWORK_GRAPH_PROJECTION_VERSION = 1
export const ACTIVITY_FEED_PROJECTION_VERSION = 1
export const TASK_GRAPH_PROJECTION_VERSION = 1
export const ROOM_PROJECTION_VERSION = 1
export const TRUST_EVIDENCE_PROJECTION_VERSION = 1
export const MARKET_PROJECTION_VERSION = 1

/**
 * `builtAt` is the only place a projector needs a clock, so it is injected
 * rather than read from the ambient environment — that keeps every projection
 * byte-reproducible in tests and in a replay.
 */
export interface ProjectOptions {
  builtAt: string
}

function meta(state: NetworkState, projectionVersion: number, options: ProjectOptions): ProjectionMeta {
  return {
    projectionVersion,
    cursor: state.lastEventId,
    streamCursors: { ...state.streamCursors },
    eventCount: state.eventCount,
    builtAt: options.builtAt,
  }
}

export function projectAgentState(state: NetworkState, options: ProjectOptions): ViewEnvelope<AgentStateView> {
  const agents = Object.values(state.agents).sort((a, b) => a.id.localeCompare(b.id))
  return { meta: meta(state, AGENT_STATE_PROJECTION_VERSION, options), data: { agents } }
}

/**
 * The relationship graph. Deliberately NOT a log: an edge exists because two
 * objects stand in a durable relation, not because a line was written.
 */
export function projectNetworkGraph(state: NetworkState, options: ProjectOptions): ViewEnvelope<NetworkGraphView> {
  const nodes: NetworkNode[] = []
  const edges: NetworkEdge[] = []
  const nodeIds = new Set<string>()

  const addNode = (node: NetworkNode): void => {
    if (nodeIds.has(node.id)) return
    nodeIds.add(node.id)
    nodes.push(node)
  }
  const addEdge = (edge: NetworkEdge): void => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return
    if (edges.some((e) => e.id === edge.id)) return
    edges.push(edge)
  }

  for (const agent of Object.values(state.agents)) {
    addNode({
      id: agent.id,
      kind: 'agent',
      label: agent.label,
      status: `${agent.state.presence}/${agent.state.execution}/${agent.state.coordination}`,
    })
  }
  for (const goal of Object.values(state.goals)) {
    addNode({ id: goal.id, kind: 'goal', label: goal.title })
  }
  for (const room of Object.values(state.rooms)) {
    addNode({ id: room.id, kind: 'room', label: room.title })
  }
  for (const task of Object.values(state.tasks)) {
    addNode({ id: task.id, kind: 'task', label: task.title, status: task.state })
  }

  for (const task of Object.values(state.tasks)) {
    if (task.ownerAgentId) {
      addEdge({
        id: `own:${task.ownerAgentId}->${task.id}`,
        source: task.ownerAgentId,
        target: task.id,
        kind: 'ownership',
      })
    }
    if (task.parentTaskId) {
      addEdge({
        id: `deleg:${task.parentTaskId}->${task.id}`,
        source: task.parentTaskId,
        target: task.id,
        kind: 'delegation',
      })
    }
    for (const dependency of task.dependsOn) {
      addEdge({ id: `dep:${task.id}->${dependency}`, source: task.id, target: dependency, kind: 'dependency' })
    }
    if (task.goalId) {
      addEdge({ id: `goal:${task.goalId}->${task.id}`, source: task.goalId, target: task.id, kind: 'delivery' })
    }
    if (task.roomId) {
      addEdge({ id: `room:${task.roomId}->${task.id}`, source: task.roomId, target: task.id, kind: 'participation' })
    }
  }

  for (const room of Object.values(state.rooms)) {
    for (const agentId of room.participantAgentIds) {
      addEdge({ id: `part:${agentId}->${room.id}`, source: agentId, target: room.id, kind: 'participation' })
    }
    if (room.goalId) {
      addEdge({ id: `rgoal:${room.id}->${room.goalId}`, source: room.id, target: room.goalId, kind: 'delivery' })
    }
  }

  for (const approval of Object.values(state.approvals)) {
    if (!approval.taskId) continue
    addEdge({
      id: `appr:${approval.approvalId}`,
      source: approval.agentId,
      target: approval.taskId,
      kind: 'approval',
      label: approval.decision ?? 'pending',
    })
  }

  for (const agent of Object.values(state.agents)) {
    if (agent.trustEvidence.length === 0 || !agent.did) continue
    // Trust is shown as evidence attached to the Agent node, not as a score.
    const node = nodes.find((n) => n.id === agent.id)
    if (node) node.status = `${node.status} · trust:${agent.trustEvidence.length}`
  }

  return { meta: meta(state, NETWORK_GRAPH_PROJECTION_VERSION, options), data: { nodes, edges } }
}

/** Micro-units back to a human-readable amount, for display only. */
function formatAmount(micros: number, currency: string): string {
  return `${(micros / 1_000_000).toFixed(2)} ${currency}`
}

/** One line of prose per fact. Derived from the payload only — never inferred. */
export function summarizeEvent(event: AnyIFlowEvent): string {
  if (!isKnownEventType(event.type)) return event.type

  if (isEventOfType(event, 'agent.registered')) return `Agent ${event.payload.label} registered on ${event.payload.nodeId}`
  if (isEventOfType(event, 'agent.presence_changed')) {
    const parts = [
      event.payload.presence && `presence=${event.payload.presence}`,
      event.payload.execution && `execution=${event.payload.execution}`,
      event.payload.coordination && `coordination=${event.payload.coordination}`,
    ].filter(Boolean)
    return `Agent state ${parts.join(' ')}`
  }
  if (isEventOfType(event, 'goal.created')) return `Goal created: ${event.payload.title}`
  if (isEventOfType(event, 'task.created')) return `Task created: ${event.payload.title}`
  if (isEventOfType(event, 'task.delegated')) return `Task delegated to ${event.payload.toAgentId}`
  if (isEventOfType(event, 'task.started')) return `Task started by ${event.payload.agentId}`
  if (isEventOfType(event, 'task.waiting')) return `Task waiting: ${event.payload.reason}`
  if (isEventOfType(event, 'task.blocked')) return `Task blocked: ${event.payload.reason}`
  if (isEventOfType(event, 'task.awaiting_approval')) return `Task awaiting approval: ${event.payload.reason}`
  if (isEventOfType(event, 'task.completed')) return `Task completed${event.payload.summary ? `: ${event.payload.summary}` : ''}`
  if (isEventOfType(event, 'task.failed')) return `Task failed: ${event.payload.reason}`
  if (isEventOfType(event, 'room.created')) return `Room created: ${event.payload.title}`
  if (isEventOfType(event, 'room.participant_joined')) return `${event.payload.agentId} joined the room`
  if (isEventOfType(event, 'tool.call_started')) return `Tool ${event.payload.toolName} started`
  if (isEventOfType(event, 'tool.call_completed')) {
    return `Tool ${event.payload.toolName} ${event.payload.outcome}${event.payload.errorMessage ? `: ${event.payload.errorMessage}` : ''}`
  }
  if (isEventOfType(event, 'approval.requested')) return `Approval requested: ${event.payload.reason}`
  if (isEventOfType(event, 'approval.resolved')) return `Approval ${event.payload.decision}`
  if (isEventOfType(event, 'a2a.request_received')) {
    return `A2A request from ${event.payload.fromLabel ?? event.payload.fromDid ?? 'unknown peer'}`
  }
  if (isEventOfType(event, 'execution.attempt_started')) return `Attempt ${event.payload.attemptId} started`
  if (isEventOfType(event, 'execution.attempt_finished')) {
    return `Attempt ${event.payload.attemptId} ${event.payload.outcome}`
  }
  if (isEventOfType(event, 'usage.recorded')) {
    const { input, output } = event.payload.tokens
    return `Usage ${event.payload.model}: ${input} in / ${output} out`
  }
  if (isEventOfType(event, 'quote.offered')) {
    return `Quoted ${formatAmount(event.payload.amountMicros, event.payload.currency)} by ${event.payload.offeredBy}`
  }
  if (isEventOfType(event, 'quote.accepted')) {
    return `Quote ${event.payload.quoteId} accepted by ${event.payload.acceptedBy}`
  }
  if (isEventOfType(event, 'task.settled')) {
    return `Settled ${formatAmount(event.payload.amountMicros, event.payload.currency)} (${event.payload.visibility})`
  }
  return event.type
}

export function projectActivityFeed(state: NetworkState, options: ProjectOptions): ViewEnvelope<ActivityFeedView> {
  const entries: ActivityEntry[] = state.recent.map((event) => ({
    eventId: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
    correlationId: event.correlationId,
    actorId: event.issuer.id,
    actorKind: event.issuer.kind,
    subjectKind: event.subject.kind,
    subjectId: event.subject.id,
    taskId: event.taskId,
    goalId: event.goalId,
    roomId: event.roomId,
    summary: summarizeEvent(event),
  }))
  return {
    meta: meta(state, ACTIVITY_FEED_PROJECTION_VERSION, options),
    data: { entries, truncated: state.recentTruncated },
  }
}

export interface TaskGraphFilter {
  roomId?: string
  goalId?: string
}

export function projectTaskGraph(
  state: NetworkState,
  options: ProjectOptions,
  filter: TaskGraphFilter = {},
): ViewEnvelope<TaskGraphView> {
  const tasks = Object.values(state.tasks).filter((task) => {
    if (filter.roomId !== undefined && task.roomId !== filter.roomId) return false
    if (filter.goalId !== undefined && task.goalId !== filter.goalId) return false
    return true
  })

  const byId = new Map(tasks.map((task) => [task.id, task]))
  const depthOf = (taskId: string, seen: Set<string>): number => {
    if (seen.has(taskId)) return 0 // a parent cycle is malformed data, not a hang
    seen.add(taskId)
    const parentId = byId.get(taskId)?.parentTaskId
    return parentId && byId.has(parentId) ? depthOf(parentId, seen) + 1 : 0
  }

  const nodes = tasks
    .map((task) => ({ task, depth: depthOf(task.id, new Set<string>()) }))
    .sort((a, b) => a.depth - b.depth || a.task.createdAt.localeCompare(b.task.createdAt))

  const edges: TaskGraphView['edges'] = []
  for (const task of tasks) {
    if (task.parentTaskId && byId.has(task.parentTaskId)) {
      edges.push({ source: task.parentTaskId, target: task.id, kind: 'subtask' })
    }
    for (const dependency of task.dependsOn) {
      if (byId.has(dependency)) edges.push({ source: task.id, target: dependency, kind: 'dependency' })
    }
  }

  return {
    meta: meta(state, TASK_GRAPH_PROJECTION_VERSION, options),
    data: { roomId: filter.roomId, goalId: filter.goalId, nodes, edges },
  }
}

export function projectRoom(
  state: NetworkState,
  options: ProjectOptions,
  roomId: string,
): ViewEnvelope<RoomView> | undefined {
  const room = state.rooms[roomId]
  if (!room) return undefined
  const tasks = Object.values(state.tasks).filter((task) => task.roomId === roomId)
  const taskIds = new Set(tasks.map((task) => task.id))
  return {
    meta: meta(state, ROOM_PROJECTION_VERSION, options),
    data: {
      room,
      goal: room.goalId ? state.goals[room.goalId] : undefined,
      participants: room.participantAgentIds.map((id) => state.agents[id]).filter((a) => a !== undefined),
      tasks,
      approvals: Object.values(state.approvals).filter((a) => a.taskId !== undefined && taskIds.has(a.taskId)),
      toolCalls: Object.values(state.toolCalls).filter((c) => c.taskId !== undefined && taskIds.has(c.taskId)),
    },
  }
}

/**
 * Turn settlements into a publishable market picture.
 *
 * The visibility rule is enforced HERE rather than at the edge of the network,
 * so no consumer of this projection can accidentally leak a private price:
 *
 *   private   — excluded entirely, and counted in `withheld` so the omission
 *               is visible rather than silent
 *   aggregate — counted in a band, never shown individually
 *   public    — counted in a band AND listed in full
 *
 * Bands need a capability to group by. A settlement whose quote named none is
 * grouped under `iflow.cap:*` rather than dropped: an unclassified price is
 * still market information, it just cannot be compared like for like.
 */
export function projectMarket(state: NetworkState, options: ProjectOptions): ViewEnvelope<MarketView> {
  const settlements = Object.values(state.tasks)
    .map((task) => task.settlement)
    .filter((settlement) => settlement !== undefined)

  const withheld = settlements.filter((settlement) => settlement.visibility === 'private').length
  const publishable = settlements.filter((settlement) => settlement.visibility !== 'private')

  const grouped = new Map<string, { settlements: typeof publishable; pairs: Set<string> }>()
  for (const settlement of publishable) {
    const capability = settlement.quoteId
      ? (state.quotes[settlement.quoteId]?.capability ?? 'iflow.cap:*')
      : 'iflow.cap:*'
    const key = `${capability}|${settlement.currency}`
    const bucket = grouped.get(key) ?? { settlements: [], pairs: new Set<string>() }
    bucket.settlements.push(settlement)
    // Order-independent, so A->B and B->A count as the same relationship.
    bucket.pairs.add([settlement.payerAgentId, settlement.payeeAgentId].sort().join('<->'))
    grouped.set(key, bucket)
  }

  const bands: PriceBand[] = [...grouped.entries()]
    .map(([key, bucket]) => {
      const [capability = 'iflow.cap:*', currency = 'USD'] = key.split('|')
      const amounts = bucket.settlements.map((settlement) => settlement.amountMicros).sort((a, b) => a - b)
      return {
        capability,
        currency,
        lowMicros: amounts[0] ?? 0,
        medianMicros: median(amounts),
        highMicros: amounts[amounts.length - 1] ?? 0,
        settlements: amounts.length,
        distinctPairs: bucket.pairs.size,
      }
    })
    .sort((a, b) => a.capability.localeCompare(b.capability))

  return {
    meta: meta(state, MARKET_PROJECTION_VERSION, options),
    data: {
      bands,
      published: publishable.filter((settlement) => settlement.visibility === 'public'),
      withheld,
    },
  }
}

/** Median of a pre-sorted list; the lower of the two middles for even counts. */
function median(sorted: number[]): number {
  if (sorted.length === 0) return 0
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] as number
  // Integer micro-units in, integer out — the canonical form rejects floats.
  return Math.round(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2)
}

export function projectTrustEvidence(state: NetworkState, options: ProjectOptions): ViewEnvelope<TrustEvidenceView[]> {
  const data = Object.values(state.agents).map((agent) => ({
    agentId: agent.id,
    did: agent.did,
    evidence: agent.trustEvidence,
  }))
  return { meta: meta(state, TRUST_EVIDENCE_PROJECTION_VERSION, options), data }
}

/** The four views the first slice serves, built from one state in one pass. */
export function projectAll(state: NetworkState, options: ProjectOptions): ProjectionSet {
  return {
    agents: projectAgentState(state, options),
    network: projectNetworkGraph(state, options),
    activity: projectActivityFeed(state, options),
    tasks: projectTaskGraph(state, options),
  }
}
