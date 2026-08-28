/**
 * Projectors: NetworkState -> versioned Read Models.
 *
 * `Journal -> Projector -> versioned Read Model -> Hub`. Each view stamps its
 * own `projectionVersion`: changing a graph rule ships a v2 projection that can
 * be rebuilt from the same Journal, never an edit to a historical fact.
 */

import type { AnyIFlowEvent } from '../event-types.js'
import { isEventOfType, isKnownEventType } from '../event-types.js'
import type { AgentRelationType, ConversationParticipant, Publication, PublicationState } from '../objects.js'
import type { NetworkState } from '../reducers/network-state.js'
import type {
  ActivityEntry,
  MarketView,
  PriceBand,
  ActivityFeedView,
  AgentStateView,
  ConversationListView,
  DiscoveryFeedView,
  DiscoveryFilter,
  NetworkEdge,
  NetworkGraphView,
  NetworkNode,
  ProjectionMeta,
  ProjectionSet,
  RequestsView,
  Settlement,
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
export const CONVERSATIONS_PROJECTION_VERSION = 1
export const REQUESTS_PROJECTION_VERSION = 1
export const DISCOVERY_FEED_PROJECTION_VERSION = 1

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

  // Agent-to-agent edges, drawn from AgentRelation rather than inferred from
  // work. Every edge above is a projection of a Task or a Room; these are the
  // only ones that say something about the agents themselves, which is what a
  // network view is for.
  for (const relation of Object.values(state.relations)) {
    addEdge({
      id: `rel:${relation.sourceAgentId}->${relation.targetAgentId}:${relation.type}`,
      source: relation.sourceAgentId,
      target: relation.targetAgentId,
      kind: RELATION_EDGE_KIND[relation.type],
      // Strength is a count of reassertions, and it is shown rather than
      // folded into the kind so a reader can tell one contact from fifty.
      label: relation.strength > 1 ? `${relation.type} ×${relation.strength}` : relation.type,
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

/** Which graph edge each relationship draws as. */
const RELATION_EDGE_KIND: Record<AgentRelationType, NetworkEdge['kind']> = {
  followed: 'contact',
  contacted: 'contact',
  trusted: 'trust',
  worked_with: 'collaboration',
  delegated_to: 'delegation',
  transacted_with: 'transaction',
}

/** Micro-units back to a human-readable amount, for display only. */
function formatAmount(micros: number, currency: string): string {
  return `${(micros / 1_000_000).toFixed(2)} ${currency}`
}

/** One line of prose per fact. Derived from the payload only — never inferred. */
export function summarizeEvent(event: AnyIFlowEvent): string {
  if (!isKnownEventType(event.type)) return event.type

  if (isEventOfType(event, 'principal.declared')) return `Principal ${event.payload.principalId} declared`
  if (isEventOfType(event, 'authority.rotated')) {
    return `Principal authority rotated to version ${event.payload.authorityVersion}`
  }
  if (isEventOfType(event, 'authority.revoked')) {
    return `Principal authority version ${event.payload.authorityVersion} revoked`
  }
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
  // Worded so a reader cannot mistake handing work back for having it approved.
  if (isEventOfType(event, 'delivery.submitted'))
    return `Work delivered for review${event.payload.summary ? `: ${event.payload.summary}` : ''}`
  if (isEventOfType(event, 'delivery.accepted')) return `Delivery accepted by ${event.payload.decidedBy}`
  if (isEventOfType(event, 'delivery.rejected'))
    return `Delivery sent back by ${event.payload.decidedBy}: ${event.payload.reason}`
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
  if (isEventOfType(event, 'conversation.opened')) {
    const who = event.payload.participants.map((p: ConversationParticipant) => p.agentId).join(' ↔ ')
    const boundary = event.payload.crossesOwnershipBoundary ? ' (crosses ownership boundary)' : ''
    return `Conversation opened: ${who}${boundary}`
  }
  // No excerpt, on purpose: an activity line is read by whoever can read the
  // projection, which is a wider audience than the two participants.
  if (isEventOfType(event, 'conversation.message_sent')) {
    return `Message sent to ${event.payload.toAgentId} (${event.payload.actorType} via ${event.payload.origin})`
  }
  if (isEventOfType(event, 'conversation.message_received')) {
    return `Message received from ${event.payload.fromAgentId} (${event.payload.actorType} via ${event.payload.origin})`
  }
  if (isEventOfType(event, 'conversation.accepted')) {
    return `Conversation accepted by ${event.payload.acceptedBy} (${event.payload.decidedBy})`
  }
  if (isEventOfType(event, 'conversation.rejected')) {
    const why = event.payload.reason ? `: ${event.payload.reason}` : ''
    return `Conversation rejected by ${event.payload.rejectedBy} (${event.payload.decidedBy})${why}`
  }
  if (isEventOfType(event, 'conversation.closed')) {
    return `Conversation closed${event.payload.reason ? `: ${event.payload.reason}` : ''}`
  }
  if (isEventOfType(event, 'relation.recorded')) {
    return `${event.payload.sourceAgentId} ${event.payload.type} ${event.payload.targetAgentId}`
  }
  if (isEventOfType(event, 'workspace.bound')) {
    return `Agent ${event.payload.agentId} bound to ${event.payload.runtime} on ${event.payload.nodeId}`
  }
  if (isEventOfType(event, 'publication.created')) {
    return `Agent ${event.payload.publishedByAgentId} published ${event.payload.kind}: ${event.payload.summary}`
  }
  if (isEventOfType(event, 'publication.withdrawn')) {
    return `Agent ${event.payload.publishedByAgentId} withdrew publication ${event.payload.publicationId}`
  }
  return event.type
}

/**
 * Threads, without their contents.
 *
 * `pending` is broken out because it is the number a person actually acts on:
 * it is how many conversations are waiting for someone here to say yes or no.
 */
export function projectConversations(
  state: NetworkState,
  options: ProjectOptions,
): ViewEnvelope<ConversationListView> {
  const conversations = Object.values(state.conversations).sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  )
  const pending = conversations.filter((c) => c.state === 'pending').length
  return {
    meta: meta(state, CONVERSATIONS_PROJECTION_VERSION, options),
    data: { conversations, pending },
  }
}

/**
 * What is waiting on a human at this node.
 *
 * Today the only kind derivable from the shared model is a pending
 * Conversation — a first contact nobody has answered yet. Permission requests,
 * task proposals, quotes and payment requests join this list as their own
 * events land, which is why the shape is a request list and not a
 * conversation list.
 *
 * The excerpt is not here. Whoever renders this joins it against local state
 * that never left the machine.
 */
export function projectRequests(state: NetworkState, options: ProjectOptions): ViewEnvelope<RequestsView> {
  const requests = Object.values(state.conversations)
    .filter((conversation) => conversation.state === 'pending')
    .map((conversation) => {
      const initiator = conversation.participants.find((p) => p.role === 'initiator')
      return {
        requestId: 'req-' + conversation.conversationId,
        kind: 'conversation' as const,
        conversationId: conversation.conversationId,
        fromAgentId: initiator?.agentId ?? 'unknown',
        fromDid: initiator?.did,
        receivedAt: conversation.createdAt,
        state: 'pending' as const,
      }
    })
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
  return { meta: meta(state, REQUESTS_PROJECTION_VERSION, options), data: { requests } }
}

/**
 * Public Discovery is a view over signed Publication facts. It intentionally
 * performs no personalization, scoring, relationship inference or action
 * authorization. Those are separate, explainable projections/contracts.
 */
export function projectDiscoveryFeed(
  state: NetworkState,
  options: ProjectOptions,
  filter: DiscoveryFilter = {},
): ViewEnvelope<DiscoveryFeedView> {
  const builtAt = Date.parse(options.builtAt)
  const stateOf = (publication: Publication): PublicationState => {
    if (publication.withdrawnAt) return 'withdrawn'
    const expiresAt = Date.parse(publication.expiresAt)
    // Malformed expiresAt is not silently made active. The emitting edge must
    // use an ISO instant; until it does, the public item remains unavailable.
    if (!Number.isFinite(expiresAt) || !Number.isFinite(builtAt) || expiresAt <= builtAt) return 'expired'
    return 'active'
  }

  const publications = Object.values(state.publications)
    .map((publication) => ({ publication, state: stateOf(publication) }))
    .filter((entry) => filter.includeInactive || entry.state === 'active')
    .filter((entry) => !filter.kinds || filter.kinds.includes(entry.publication.kind))
    .filter((entry) => !filter.domain || entry.publication.domains.includes(filter.domain))
    .filter((entry) => !filter.capability || entry.publication.capabilities.includes(filter.capability))
    .filter((entry) => !filter.tag || entry.publication.tags.includes(filter.tag))
    .sort((a, b) => b.publication.createdAt.localeCompare(a.publication.createdAt))

  return {
    meta: meta(state, DISCOVERY_FEED_PROJECTION_VERSION, options),
    data: { publications, filter: { ...filter } },
  }
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
    conversationId: event.conversationId,
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
 * Which settlements may leave this node, and which must not.
 *
 * This filter is PUBLIC on purpose. The promise it encodes — "a price you
 * marked private never leaves your machine" — is only credible if the code
 * making that decision can be read by the party relying on it. A hidden
 * privacy filter is not a privacy guarantee, and an agent runtime deciding
 * whether to join a network is exactly the reader who needs to check.
 *
 * What may be published is settled here. HOW published prices are aggregated
 * into market statistics is a network-level concern and does not belong to a
 * single edge: one node's journal holds only its own deals, so a "market rate"
 * computed locally would be a rate of one participant.
 */
export function selectPublishableSettlements(state: NetworkState): PublishableSettlements {
  const settlements = Object.values(state.tasks)
    .map((task) => task.settlement)
    .filter((settlement) => settlement !== undefined)

  const publishable = settlements
    .filter((settlement) => settlement.visibility !== 'private')
    .map((settlement) => ({
      settlement,
      // The capability is what makes two prices comparable. A settlement whose
      // quote named none is labelled rather than dropped: an unclassified
      // price is still market information.
      capability: settlement.quoteId
        ? (state.quotes[settlement.quoteId]?.capability ?? UNCLASSIFIED_CAPABILITY)
        : UNCLASSIFIED_CAPABILITY,
    }))

  return {
    publishable,
    // Counted, not silently dropped: an omission a reader cannot see is
    // indistinguishable from an absence of activity.
    withheld: settlements.length - publishable.length,
  }
}

export const UNCLASSIFIED_CAPABILITY = 'iflow.cap:*'

export interface PublishableSettlement {
  settlement: Settlement
  capability: string
}

export interface PublishableSettlements {
  publishable: PublishableSettlement[]
  withheld: number
}

/**
 * A single node's own view of its prices.
 *
 * Deliberately NOT a market: it summarizes only what this edge itself
 * settled. Cross-node aggregation, price bands over many participants, and
 * the heuristics that make such an aggregate trustworthy belong to a
 * Community service, which sees more than one journal.
 */
export function projectMarket(state: NetworkState, options: ProjectOptions): ViewEnvelope<MarketView> {
  const { publishable, withheld } = selectPublishableSettlements(state)

  const grouped = new Map<string, { amounts: number[]; pairs: Set<string> }>()
  for (const { settlement, capability } of publishable) {
    const key = `${capability}|${settlement.currency}`
    const bucket = grouped.get(key) ?? { amounts: [], pairs: new Set<string>() }
    bucket.amounts.push(settlement.amountMicros)
    // Order-independent, so A->B and B->A are one relationship.
    bucket.pairs.add([settlement.payerAgentId, settlement.payeeAgentId].sort().join('<->'))
    grouped.set(key, bucket)
  }

  const bands: PriceBand[] = [...grouped.entries()]
    .map(([key, bucket]) => {
      const [capability = UNCLASSIFIED_CAPABILITY, currency = 'USD'] = key.split('|')
      const amounts = [...bucket.amounts].sort((a, b) => a - b)
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
      published: publishable
        .filter(({ settlement }) => settlement.visibility === 'public')
        .map(({ settlement }) => settlement),
      withheld,
    },
  }
}

/** Median of a pre-sorted list; integer in, integer out. */
function median(sorted: number[]): number {
  if (sorted.length === 0) return 0
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] as number
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
    conversations: projectConversations(state, options),
    requests: projectRequests(state, options),
    discovery: projectDiscoveryFeed(state, options),
  }
}
