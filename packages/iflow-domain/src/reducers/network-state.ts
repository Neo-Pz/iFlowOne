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
import type { Agent, Approval, Goal, Room, Task, TaskState, ToolCall } from '../objects.js'
import { INITIAL_AGENT_STATE, canTransition } from '../objects.js'

/** How many recent events the activity ring keeps. Older facts stay in the Journal. */
export const ACTIVITY_WINDOW = 500

export interface StateAnomaly {
  eventId: string
  taskId: string
  from: TaskState
  to: TaskState
}

export interface NetworkState {
  agents: Record<string, Agent>
  goals: Record<string, Goal>
  tasks: Record<string, Task>
  rooms: Record<string, Room>
  toolCalls: Record<string, ToolCall>
  approvals: Record<string, Approval>
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
    if (event.payload.did !== undefined) agent.did = event.payload.did
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
    const task = ensureTask(state, event.subject.id, at)
    task.ownerAgentId = event.payload.toAgentId
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
    const task = ensureTask(state, event.subject.id, at)
    task.blockingReason = undefined
    for (const output of event.payload.outputs ?? []) {
      task.outputs.push({ kind: output.kind, id: output.id, summary: output.summary, at })
    }
    moveTask(state, task, 'completed', event)
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

  if (isEventOfType(event, 'usage.recorded')) {
    // Metering is a fact about a Task, not a state transition; a settlement
    // view reads it straight from the journal.
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
      trustEvidence: [...a.trustEvidence],
    })),
    goals: mapValues(state.goals, (g) => ({ ...g, constraints: g.constraints ? [...g.constraints] : undefined })),
    tasks: mapValues(state.tasks, (t) => ({
      ...t,
      dependsOn: [...t.dependsOn],
      attempts: t.attempts.map((a) => ({ ...a })),
      outputs: t.outputs.map((o) => ({ ...o })),
    })),
    rooms: mapValues(state.rooms, (r) => ({ ...r, participantAgentIds: [...r.participantAgentIds] })),
    toolCalls: mapValues(state.toolCalls, (c) => ({ ...c })),
    approvals: mapValues(state.approvals, (a) => ({ ...a })),
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
