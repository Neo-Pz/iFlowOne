/**
 * The domain fold: Journal -> NetworkState.
 *
 * Pure functions only, no I/O and no clock. Everything a projection needs is
 * derived from this one state so the four views can never disagree with each
 * other about what happened.
 *
 * Deleting all projections and replaying the governing Journal must reproduce
 * this state exactly (architecture doc, failure test 4).
 */

import type { AnyIFlowEvent, DomainEvent, EventType } from '../event-types.js'
import { isEventOfType, isKnownEventType } from '../event-types.js'
import type {
  Agent,
  AgentRelation,
  GrantRecord,
  Approval,
  Conversation,
  ConversationParticipant,
  Goal,
  Publication,
  Quote,
  Room,
  Task,
  TaskState,
  ToolCall,
} from '../objects.js'
import { INITIAL_AGENT_STATE, canTransition } from '../objects.js'

/** How many recent events the activity ring keeps. Older facts stay in the Journal. */
export const ACTIVITY_WINDOW = 500

export interface StateAnomaly {
  eventId: string
  taskId: string
  from: TaskState
  to: TaskState
  /**
   * Why the fold refused it. Absent for a plain illegal transition, which is
   * all this type used to carry.
   */
  reason?: 'self_acceptance' | 'unknown_delivery' | 'unratified_completion'
}

export interface NetworkState {
  agents: Record<string, Agent>
  goals: Record<string, Goal>
  tasks: Record<string, Task>
  rooms: Record<string, Room>
  toolCalls: Record<string, ToolCall>
  approvals: Record<string, Approval>
  /** Prices offered, keyed by quoteId. An unaccepted quote is not a price. */
  quotes: Record<string, Quote>
  /** Communication threads, keyed by conversationId. Never holds a transcript. */
  conversations: Record<string, Conversation>
  /** Agent-to-agent relationships, keyed by `source|target|type`. */
  relations: Record<string, AgentRelation>
  /** Records that grants exist, never the authority itself. */
  grants: Record<string, GrantRecord>
  /** Public discovery statements, keyed by publicationId. */
  publications: Record<string, Publication>
  /** Bounded ring of recent events, newest last. */
  recent: AnyIFlowEvent[]
  /** True once the ring has dropped at least one event. */
  recentTruncated: boolean
  /** Per-origin-stream high-water mark. */
  streamCursors: Record<string, number>
  lastEventId?: string
  eventCount: number
  /** Facts we accepted into the journal but this domain version cannot interpret. */
  unknownEventTypes: Record<string, number>
  /** Transitions the journal asserted that the state machine does not allow. */
  anomalies: StateAnomaly[]
}

export function emptyNetworkState(): NetworkState {
  return {
    agents: {},
    goals: {},
    tasks: {},
    rooms: {},
    toolCalls: {},
    approvals: {},
    quotes: {},
    conversations: {},
    relations: {},
    grants: {},
    publications: {},
    recent: [],
    recentTruncated: false,
    streamCursors: {},
    lastEventId: undefined,
    eventCount: 0,
    unknownEventTypes: {},
    anomalies: [],
  }
}

function ensureAgent(state: NetworkState, id: string, at: string): Agent {
  const existing = state.agents[id]
  if (existing) return existing
  const created: Agent = {
    id,
    label: id,
    nodeId: 'unknown',
    runtimeKind: 'unknown',
    capabilities: [],
    state: { ...INITIAL_AGENT_STATE },
    trustEvidence: [],
    registeredAt: at,
  }
  state.agents[id] = created
  return created
}

function ensureTask(state: NetworkState, id: string, at: string): Task {
  const existing = state.tasks[id]
  if (existing) return existing
  const created: Task = {
    id,
    title: id,
    state: 'created',
    dependsOn: [],
    attempts: [],
    outputs: [],
    deliveries: [],
    createdAt: at,
    updatedAt: at,
  }
  state.tasks[id] = created
  return created
}

/**
 * Move a Task, recording rather than silently accepting an illegal transition.
 * The Journal is the authority on what happened; the state machine's job is to
 * make a contradiction visible, not to overrule the fact.
 */
function moveTask(state: NetworkState, task: Task, to: TaskState, event: AnyIFlowEvent): void {
  if (task.state !== to && !canTransition(task.state, to)) {
    state.anomalies.push({ eventId: event.id, taskId: task.id, from: task.state, to })
  }
  task.state = to
  task.updatedAt = event.occurredAt
}

function taskIdOf(event: AnyIFlowEvent): string | undefined {
  return event.taskId ?? (event.subject.kind === 'task' ? event.subject.id : undefined)
}

function conversationIdOf(event: AnyIFlowEvent): string | undefined {
  return event.conversationId ?? (event.subject.kind === 'conversation' ? event.subject.id : undefined)
}

function ensureConversation(state: NetworkState, id: string, at: string): Conversation {
  const existing = state.conversations[id]
  if (existing) return existing
  // A message can legitimately arrive before this node saw the opening — a
  // journal is not guaranteed to start at the beginning of a relationship.
  const created: Conversation = {
    conversationId: id,
    participants: [],
    state: 'active',
    createdAt: at,
    updatedAt: at,
    crossesOwnershipBoundary: false,
  }
  state.conversations[id] = created
  return created
}

export function relationKeyOf(sourceAgentId: string, targetAgentId: string, type: string): string {
  return sourceAgentId + '|' + targetAgentId + '|' + type
}

/** Fold one event. Returns a NEW state; the input is never mutated. */
export function applyEvent(previous: NetworkState, event: AnyIFlowEvent): NetworkState {
  const state = cloneState(previous)

  state.eventCount += 1
  state.lastEventId = event.id
  const streamKey = streamKeyOf(event)
  const seenSeq = state.streamCursors[streamKey]
  if (seenSeq === undefined || event.origin.seq > seenSeq) {
    state.streamCursors[streamKey] = event.origin.seq
  }

  state.recent.push(event)
  if (state.recent.length > ACTIVITY_WINDOW) {
    state.recent.splice(0, state.recent.length - ACTIVITY_WINDOW)
    state.recentTruncated = true
  }

  if (!isKnownEventType(event.type)) {
    state.unknownEventTypes[event.type] = (state.unknownEventTypes[event.type] ?? 0) + 1
    return state
  }

  reduceKnown(state, event as DomainEvent)
  return state
}

export function streamKeyOf(event: AnyIFlowEvent): string {
  return event.origin.nodeId + '/' + event.origin.streamId
}

export function applyEvents(previous: NetworkState, events: Iterable<AnyIFlowEvent>): NetworkState {
  let state = previous
  for (const event of events) state = applyEvent(state, event)
  return state
}

export function reduceEvents(events: Iterable<AnyIFlowEvent>): NetworkState {
  return applyEvents(emptyNetworkState(), events)
}

function reduceKnown(state: NetworkState, event: DomainEvent): void {
  const at = event.occurredAt

  if (isEventOfType(event, 'agent.registered')) {
    const agent = ensureAgent(state, event.subject.id, at)
    agent.label = event.payload.label
    agent.nodeId = event.payload.nodeId
    agent.runtimeKind = event.payload.runtimeKind
    agent.capabilities = [...event.payload.capabilities]
    // A restarted Agent may retain its profile; a replacement identity must
    // explicitly publish its own card instead of inheriting the old DID's.
    if (event.payload.did !== undefined && event.payload.did !== agent.did) agent.discovery = null
    if (event.payload.discovery !== undefined) agent.discovery = event.payload.discovery === null ? null : JSON.parse(JSON.stringify(event.payload.discovery))
    if (event.payload.did !== undefined) agent.did = event.payload.did
    // A claim is only ever added, never cleared by a later registration: an
    // Agent that re-registers without naming its Principal has not been
    // disowned, it has been restarted.
    if (event.payload.principal) agent.principal = { ...event.payload.principal }
    if (event.payload.trustEvidence) agent.trustEvidence = [...event.payload.trustEvidence]
    agent.state = { ...agent.state, presence: 'online' }
    agent.lastSeenAt = at
    return
  }

  if (isEventOfType(event, 'agent.presence_changed')) {
    const agent = ensureAgent(state, event.subject.id, at)
    const { presence, execution, coordination } = event.payload
    // Each axis moves independently; an unmentioned axis keeps its value.
    agent.state = {
      presence: presence ?? agent.state.presence,
      execution: execution ?? agent.state.execution,
      coordination: coordination ?? agent.state.coordination,
    }
    agent.lastSeenAt = at
    return
  }

  if (isEventOfType(event, 'goal.created')) {
    state.goals[event.subject.id] = {
      id: event.subject.id,
      title: event.payload.title,
      issuerId: event.issuer.id,
      constraints: event.payload.constraints ? [...event.payload.constraints] : undefined,
      budget: event.payload.budget,
      createdAt: at,
      roomId: event.payload.roomId ?? event.roomId,
    }
    return
  }

  if (isEventOfType(event, 'task.created')) {
    const task = ensureTask(state, event.subject.id, at)
    task.title = event.payload.title
    task.goalId = event.goalId
    task.roomId = event.roomId
    task.parentTaskId = event.payload.parentTaskId
    task.dependsOn = event.payload.dependsOn ? [...event.payload.dependsOn] : []
    if (event.payload.ownerAgentId) task.ownerAgentId = event.payload.ownerAgentId
    task.updatedAt = at
    return
  }

  if (isEventOfType(event, 'task.delegated')) {
    // A citation to audit later, not a permission granted here.
    const task = ensureTask(state, event.subject.id, at)
    task.ownerAgentId = event.payload.toAgentId
    if (event.payload.grantRef) task.authorizedBy = event.payload.grantRef
    if (event.payload.crossesOwnershipBoundary !== undefined) {
      task.crossesOwnershipBoundary = event.payload.crossesOwnershipBoundary
    }
    ensureAgent(state, event.payload.toAgentId, at)
    moveTask(state, task, 'delegated', event)
    return
  }

  if (isEventOfType(event, 'task.started')) {
    const task = ensureTask(state, event.subject.id, at)
    task.ownerAgentId = event.payload.agentId
    ensureAgent(state, event.payload.agentId, at)
    if (!task.attempts.some((a) => a.attemptId === event.payload.attemptId)) {
      task.attempts.push({ attemptId: event.payload.attemptId, agentId: event.payload.agentId, startedAt: at })
    }
    task.blockingReason = undefined
    moveTask(state, task, 'running', event)
    return
  }

  if (isEventOfType(event, 'task.waiting')) {
    const task = ensureTask(state, event.subject.id, at)
    task.blockingReason = event.payload.reason
    moveTask(state, task, 'waiting', event)
    return
  }

  if (isEventOfType(event, 'task.blocked')) {
    const task = ensureTask(state, event.subject.id, at)
    task.blockingReason = event.payload.reason
    if (event.payload.blockedOnTaskId && !task.dependsOn.includes(event.payload.blockedOnTaskId)) {
      task.dependsOn.push(event.payload.blockedOnTaskId)
    }
    moveTask(state, task, 'blocked', event)
    return
  }

  if (isEventOfType(event, 'task.awaiting_approval')) {
    const task = ensureTask(state, event.subject.id, at)
    task.blockingReason = event.payload.reason
    moveTask(state, task, 'awaiting_approval', event)
    return
  }

  if (isEventOfType(event, 'task.completed')) {
    // One event that both delivers the work and ends the Task.
    //
    // Legitimate when there is nobody else to ask: an Agent finishing work for
    // its own Principal, or a pre-split fact from an older node. Folded as what
    // it is — a Delivery plus an acceptance nobody else made, marked
    // `selfDeclared`. Reinterpreting it as delivery-only would strand every
    // historical Task in `delivered` forever, rewriting what people were
    // already shown.
    const task = ensureTask(state, event.subject.id, at)

    if (task.crossesOwnershipBoundary) {
      // Work delegated to another Principal's Agent. The executor saying it is
      // finished is a Delivery and nothing more — the other side still has to
      // rule, and letting this through would restore the exact conflation the
      // split removed, only for the case where it matters most.
      state.anomalies.push({
        eventId: event.id,
        taskId: task.id,
        from: task.state,
        to: 'completed',
        reason: 'unratified_completion',
      })
      const delivered = (event.payload.outputs ?? []).map((output) => ({
        kind: output.kind,
        id: output.id,
        summary: output.summary,
        at,
      }))
      for (const output of delivered) task.outputs.push(output)
      task.deliveries.push({
        deliveryId: `self:${event.id}`,
        taskId: task.id,
        byAgentId: task.ownerAgentId ?? event.issuer.id,
        outputs: delivered,
        evidence: [],
        summary: event.payload.summary,
        submittedAt: at,
      })
      moveTask(state, task, 'delivered', event)
      return
    }

    task.blockingReason = undefined
    const outputs = (event.payload.outputs ?? []).map((output) => ({
      kind: output.kind,
      id: output.id,
      summary: output.summary,
      at,
    }))
    for (const output of outputs) task.outputs.push(output)
    task.deliveries.push({
      deliveryId: `legacy:${event.id}`,
      taskId: task.id,
      byAgentId: task.ownerAgentId ?? event.issuer.id,
      outputs,
      evidence: [],
      summary: event.payload.summary,
      submittedAt: at,
      acceptance: {
        outcome: 'accepted',
        ruledByAgentId: event.issuer.id,
        // A pre-split `task.completed` carries no decision origin. `policy`
        // is the honest reading: nothing recorded a person looking at it.
        decidedBy: 'policy',
        at,
        selfDeclared: true,
      },
    })
    moveTask(state, task, 'delivered', event)
    moveTask(state, task, 'completed', event)
    return
  }

  if (isEventOfType(event, 'delivery.submitted')) {
    const task = ensureTask(state, event.subject.id, at)
    task.blockingReason = undefined
    const outputs = (event.payload.outputs ?? []).map((output) => ({
      kind: output.kind,
      id: output.id,
      summary: output.summary,
      at,
    }))
    for (const output of outputs) task.outputs.push(output)
    task.deliveries.push({
      deliveryId: event.payload.deliveryId,
      taskId: task.id,
      byAgentId: event.payload.byAgentId,
      outputs,
      evidence: event.payload.evidence ?? [],
      summary: event.payload.summary,
      submittedAt: at,
    })
    ensureAgent(state, event.payload.byAgentId, at)
    moveTask(state, task, 'delivered', event)
    return
  }

  if (isEventOfType(event, 'delivery.accepted') || isEventOfType(event, 'delivery.rejected')) {
    const accepted = isEventOfType(event, 'delivery.accepted')
    const task = ensureTask(state, event.subject.id, at)
    const delivery = task.deliveries.find((d) => d.deliveryId === event.payload.deliveryId)

    if (!delivery) {
      // A ruling on nothing. Recorded rather than applied: inventing the
      // Delivery it refers to would let an acceptance conjure the very fact it
      // claims to be judging.
      state.anomalies.push({
        eventId: event.id,
        taskId: task.id,
        from: task.state,
        to: accepted ? 'completed' : 'running',
        reason: 'unknown_delivery',
      })
      return
    }

    const ruledByAgentId = isEventOfType(event, 'delivery.accepted')
      ? event.payload.acceptedByAgentId
      : event.payload.rejectedByAgentId

    if (delivery.byAgentId === ruledByAgentId) {
      // The executor ruling on its own work. This is the failure the split
      // exists to prevent, so the Task stays delivered and the attempt is kept
      // where a reader can see it.
      state.anomalies.push({
        eventId: event.id,
        taskId: task.id,
        from: task.state,
        to: accepted ? 'completed' : 'running',
        reason: 'self_acceptance',
      })
      return
    }

    delivery.acceptance = {
      outcome: accepted ? 'accepted' : 'rejected',
      ruledByAgentId,
      decidedBy: event.payload.decidedBy,
      at,
      reason: event.payload.reason,
    }
    moveTask(state, task, accepted ? 'completed' : 'running', event)
    return
  }

  if (isEventOfType(event, 'task.failed')) {
    const task = ensureTask(state, event.subject.id, at)
    task.blockingReason = event.payload.reason
    task.outputs.push({ kind: 'error', id: event.id, summary: event.payload.reason, at })
    moveTask(state, task, 'failed', event)
    return
  }

  if (isEventOfType(event, 'room.created')) {
    state.rooms[event.subject.id] = {
      id: event.subject.id,
      title: event.payload.title,
      goalId: event.payload.goalId ?? event.goalId,
      rootTaskId: event.payload.rootTaskId,
      participantAgentIds: [],
      createdAt: at,
    }
    return
  }

  if (isEventOfType(event, 'room.participant_joined')) {
    const room = state.rooms[event.subject.id]
    if (room && !room.participantAgentIds.includes(event.payload.agentId)) {
      room.participantAgentIds.push(event.payload.agentId)
    }
    ensureAgent(state, event.payload.agentId, at)
    return
  }

  if (isEventOfType(event, 'tool.call_started')) {
    state.toolCalls[event.payload.callId] = {
      callId: event.payload.callId,
      taskId: taskIdOf(event),
      agentId: event.payload.agentId,
      toolName: event.payload.toolName,
      startedAt: at,
    }
    ensureAgent(state, event.payload.agentId, at)
    return
  }

  if (isEventOfType(event, 'tool.call_completed')) {
    const call = state.toolCalls[event.payload.callId]
    if (call) {
      call.finishedAt = at
      call.outcome = event.payload.outcome
      call.errorMessage = event.payload.errorMessage
      return
    }
    // A completion without its start still happened; keep the fact.
    state.toolCalls[event.payload.callId] = {
      callId: event.payload.callId,
      taskId: taskIdOf(event),
      agentId: event.issuer.id,
      toolName: event.payload.toolName,
      startedAt: at,
      finishedAt: at,
      outcome: event.payload.outcome,
      errorMessage: event.payload.errorMessage,
    }
    return
  }

  if (isEventOfType(event, 'approval.requested')) {
    state.approvals[event.payload.approvalId] = {
      approvalId: event.payload.approvalId,
      taskId: taskIdOf(event),
      agentId: event.payload.agentId,
      reason: event.payload.reason,
      requestedAt: at,
    }
    const agent = ensureAgent(state, event.payload.agentId, at)
    agent.state = { ...agent.state, coordination: 'awaiting_approval' }
    return
  }

  if (isEventOfType(event, 'approval.resolved')) {
    const approval = state.approvals[event.payload.approvalId]
    if (approval) {
      approval.resolvedAt = at
      approval.decision = event.payload.decision
      approval.decidedBy = event.payload.decidedBy
      const agent = state.agents[approval.agentId]
      if (agent && agent.state.coordination === 'awaiting_approval') {
        agent.state = { ...agent.state, coordination: 'ready' }
      }
    }
    return
  }

  if (isEventOfType(event, 'a2a.request_received')) {
    const task = ensureTask(state, event.payload.remoteTaskId, at)
    if (event.payload.fromLabel) task.title = 'A2A from ' + event.payload.fromLabel
    task.updatedAt = at
    return
  }

  if (isEventOfType(event, 'execution.attempt_started')) {
    const taskId = taskIdOf(event)
    if (!taskId) return
    const task = ensureTask(state, taskId, at)
    if (!task.attempts.some((a) => a.attemptId === event.payload.attemptId)) {
      task.attempts.push({
        attemptId: event.payload.attemptId,
        agentId: event.payload.agentId,
        startedAt: at,
        traceId: event.payload.traceId,
      })
    }
    return
  }

  if (isEventOfType(event, 'execution.attempt_finished')) {
    const taskId = taskIdOf(event)
    if (!taskId) return
    const task = state.tasks[taskId]
    const attempt = task?.attempts.find((a) => a.attemptId === event.payload.attemptId)
    if (attempt) {
      attempt.finishedAt = at
      attempt.outcome = event.payload.outcome
    }
    return
  }

  if (isEventOfType(event, 'quote.offered')) {
    const taskId = taskIdOf(event)
    if (!taskId) return
    ensureTask(state, taskId, at)
    state.quotes[event.payload.quoteId] = {
      quoteId: event.payload.quoteId,
      taskId,
      offeredBy: event.payload.offeredBy,
      offeredTo: event.payload.offeredTo,
      amountMicros: event.payload.amountMicros,
      currency: event.payload.currency,
      capability: event.payload.capability,
      expiresAt: event.payload.expiresAt,
      terms: event.payload.terms,
      offeredAt: at,
    }
    return
  }

  if (isEventOfType(event, 'quote.accepted')) {
    const quote = state.quotes[event.payload.quoteId]
    // An acceptance with no offer in this journal is not a price. The pair is
    // the unit of meaning, and half of it proves nothing.
    if (!quote) return
    quote.acceptedAt = at
    quote.acceptedBy = event.payload.acceptedBy
    return
  }

  if (isEventOfType(event, 'task.settled')) {
    const taskId = taskIdOf(event)
    if (!taskId) return
    const task = ensureTask(state, taskId, at)
    task.settlement = {
      taskId,
      quoteId: event.payload.quoteId,
      payerAgentId: event.payload.payerAgentId,
      payeeAgentId: event.payload.payeeAgentId,
      amountMicros: event.payload.amountMicros,
      currency: event.payload.currency,
      visibility: event.payload.visibility,
      basis: event.payload.basis,
      settlementRef: event.payload.settlementRef,
      settledAt: at,
    }
    task.updatedAt = at
    return
  }

  if (isEventOfType(event, 'usage.recorded')) {
    // Metering is a fact about a Task, not a state transition; a settlement
    // view reads it straight from the journal.
    return
  }

  if (isEventOfType(event, 'conversation.opened')) {
    const id = conversationIdOf(event)
    if (!id) return
    const conversation = ensureConversation(state, id, at)
    conversation.participants = event.payload.participants.map((p: ConversationParticipant) => ({ ...p }))
    conversation.crossesOwnershipBoundary = event.payload.crossesOwnershipBoundary
    // An opening does not by itself mean the far side agreed to talk. Only
    // `conversation.accepted` moves it out of pending — that separation IS the
    // acceptance gate, expressed in the state machine rather than in a flag.
    conversation.state = 'pending'
    conversation.createdAt = at
    conversation.updatedAt = at
    for (const participant of conversation.participants) ensureAgent(state, participant.agentId, at)
    return
  }

  if (isEventOfType(event, 'conversation.accepted')) {
    const id = conversationIdOf(event)
    if (!id) return
    const conversation = ensureConversation(state, id, at)
    conversation.state = 'accepted'
    conversation.updatedAt = at
    return
  }

  if (isEventOfType(event, 'conversation.rejected')) {
    const id = conversationIdOf(event)
    if (!id) return
    const conversation = ensureConversation(state, id, at)
    conversation.state = 'rejected'
    conversation.updatedAt = at
    return
  }

  if (isEventOfType(event, 'conversation.closed')) {
    const id = conversationIdOf(event)
    if (!id) return
    const conversation = ensureConversation(state, id, at)
    conversation.state = 'closed'
    conversation.updatedAt = at
    return
  }

  if (isEventOfType(event, 'conversation.message_sent') || isEventOfType(event, 'conversation.message_received')) {
    const id = conversationIdOf(event)
    if (!id) return
    const conversation = ensureConversation(state, id, at)
    conversation.lastMessageId = event.payload.messageId
    conversation.updatedAt = at
    // Traffic on a rejected or closed thread does not silently revive it; only
    // an explicit acceptance does. Anything else would let a peer talk its way
    // back in past a decision someone already made.
    if (conversation.state === 'accepted') conversation.state = 'active'
    return
  }

  if (isEventOfType(event, 'grant.issued')) {
    const { grantRef, issuerDid, subjectDid, scope, constraints, level, expiresAt } = event.payload
    // First writing wins. A second `grant.issued` for the same ref would be a
    // different document claiming the same content hash, which cannot be true.
    if (!state.grants[grantRef]) {
      state.grants[grantRef] = {
        grantRef,
        issuerDid,
        subjectDid,
        scope: [...scope],
        constraints: constraints ? [...constraints] : [],
        level,
        issuedAt: at,
        expiresAt,
      }
    }
    return
  }

  if (isEventOfType(event, 'grant.revoked')) {
    const record = state.grants[event.payload.grantRef]
    // Recorded, not erased. Everything authorized while it held stays exactly
    // as it was; `grantStateAt` is what answers "does it still hold".
    if (record && !record.revokedAt) {
      record.revokedAt = at
      record.revocationReason = event.payload.reason
    }
    return
  }

  if (isEventOfType(event, 'trust_evidence.recorded')) {
    const agent = ensureAgent(state, event.payload.subjectAgentId, at)
    agent.trustEvidence.push({ kind: event.payload.kind, at, detail: event.payload.detail })
    return
  }

  if (isEventOfType(event, 'relation.recorded')) {
    const { sourceAgentId, targetAgentId, type } = event.payload
    const key = relationKeyOf(sourceAgentId, targetAgentId, type)
    const existing = state.relations[key]
    if (existing) {
      // Strength counts reassertions. It is a frequency, not a judgement — a
      // reputation score is a different object with different rules.
      existing.strength += 1
      existing.updatedAt = at
      if (event.payload.visibility) existing.visibility = event.payload.visibility
    } else {
      state.relations[key] = {
        sourceAgentId,
        targetAgentId,
        type,
        createdAt: at,
        updatedAt: at,
        strength: 1,
        visibility: event.payload.visibility ?? 'private',
      }
    }
    ensureAgent(state, sourceAgentId, at)
    ensureAgent(state, targetAgentId, at)
    return
  }

  if (isEventOfType(event, 'workspace.bound')) {
    // The binding itself is local state; what belongs in the shared model is
    // only that this Agent runs on that runtime and node.
    const agent = ensureAgent(state, event.payload.agentId, at)
    agent.nodeId = event.payload.nodeId
    agent.runtimeKind = event.payload.runtime
    return
  }

  if (isEventOfType(event, 'publication.created')) {
    const payload = event.payload
    // The issuer has to be the publicly named Agent. A transport should reject
    // this before it reaches the Journal, but the reducer keeps a bad fact out
    // of every read model if an untrusted importer bypassed that boundary.
    if (event.issuer.kind !== 'agent' || event.issuer.id !== payload.publishedByAgentId) return
    if (event.subject.kind !== 'publication' || event.subject.id !== payload.publicationId) return
    // This is intentionally a narrow P1 language. Future scoped visibility is
    // a separate contract, not a convenient way to leak private data through a
    // public Discovery projection.
    if (payload.visibility !== 'public') return
    // A new publication id denotes a new signed fact. Reusing one must not let
    // even its original issuer rewrite what observers already verified.
    if (state.publications[payload.publicationId]) return

    state.publications[payload.publicationId] = {
      publicationId: payload.publicationId,
      publishedByAgentId: payload.publishedByAgentId,
      kind: payload.kind,
      visibility: payload.visibility,
      summary: payload.summary,
      domains: [...payload.domains],
      capabilities: [...(payload.capabilities ?? [])],
      tags: [...(payload.tags ?? [])],
      expectedResponses: [...(payload.expectedResponses ?? [])],
      expiresAt: payload.expiresAt,
      commitment: payload.commitment,
      commitmentScheme: payload.commitmentScheme,
      createdAt: at,
    }
    ensureAgent(state, payload.publishedByAgentId, at)
    return
  }

  if (isEventOfType(event, 'publication.withdrawn')) {
    const payload = event.payload
    const publication = state.publications[payload.publicationId]
    // Only the Agent that made the public statement may withdraw it. The old
    // event remains in the Journal, while the active projection changes state.
    if (!publication || event.issuer.kind !== 'agent' || event.issuer.id !== publication.publishedByAgentId) return
    if (event.subject.kind !== 'publication' || event.subject.id !== payload.publicationId) return
    if (payload.publishedByAgentId !== publication.publishedByAgentId) return
    publication.withdrawnAt = at
    publication.withdrawalReason = payload.reason
    return
  }

  if (
    isEventOfType(event, 'principal.declared') ||
    isEventOfType(event, 'authority.rotated') ||
    isEventOfType(event, 'authority.revoked')
  ) {
    // P0 freezes these facts before adding a private Principal projection or
    // a public publication index. The shared network state must not infer
    // ownership from them in the meantime.
    return
  }

  // Exhaustiveness: a new EventType must be handled above or explicitly ignored.
  const unreachable: never = event
  void unreachable
}

/** Structural clone deep enough that callers can hold onto previous states. */
function cloneState(state: NetworkState): NetworkState {
  return {
    agents: mapValues(state.agents, (a) => ({
      ...a,
      state: { ...a.state },
      capabilities: [...a.capabilities],
      ...(a.discovery !== undefined ? { discovery: a.discovery === null ? null : JSON.parse(JSON.stringify(a.discovery)) } : {}),
      trustEvidence: [...a.trustEvidence],
    })),
    goals: mapValues(state.goals, (g) => ({ ...g, constraints: g.constraints ? [...g.constraints] : undefined })),
    tasks: mapValues(state.tasks, (t) => ({
      ...t,
      dependsOn: [...t.dependsOn],
      attempts: t.attempts.map((a) => ({ ...a })),
      outputs: t.outputs.map((o) => ({ ...o })),
      deliveries: t.deliveries.map((d) => ({
        ...d,
        outputs: d.outputs.map((o) => ({ ...o })),
        acceptance: d.acceptance ? { ...d.acceptance } : undefined,
      })),
    })),
    rooms: mapValues(state.rooms, (r) => ({ ...r, participantAgentIds: [...r.participantAgentIds] })),
    toolCalls: mapValues(state.toolCalls, (c) => ({ ...c })),
    approvals: mapValues(state.approvals, (a) => ({ ...a })),
    quotes: mapValues(state.quotes, (q) => ({ ...q })),
    conversations: mapValues(state.conversations, (c) => ({
      ...c,
      participants: c.participants.map((p) => ({ ...p })),
    })),
    relations: mapValues(state.relations, (r) => ({ ...r })),
    grants: mapValues(state.grants, (g) => ({ ...g, scope: [...g.scope], constraints: [...g.constraints] })),
    publications: mapValues(state.publications, (p) => ({
      ...p,
      domains: [...p.domains],
      capabilities: [...p.capabilities],
      tags: [...p.tags],
      expectedResponses: [...p.expectedResponses],
    })),
    recent: [...state.recent],
    recentTruncated: state.recentTruncated,
    streamCursors: { ...state.streamCursors },
    lastEventId: state.lastEventId,
    eventCount: state.eventCount,
    unknownEventTypes: { ...state.unknownEventTypes },
    anomalies: [...state.anomalies],
  }
}

function mapValues<T>(source: Record<string, T>, fn: (value: T) => T): Record<string, T> {
  const out: Record<string, T> = {}
  for (const key of Object.keys(source)) out[key] = fn(source[key] as T)
  return out
}

export type { EventType }
