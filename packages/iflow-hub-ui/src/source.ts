/**
 * ProjectionSource — the only thing the Hub UI knows about where data comes from.
 *
 * Three implementations are expected over the project's life and all three
 * satisfy this one interface, which is why the same screens work embedded in a
 * runtime, standalone on the web, and against a fixture feed:
 *
 *   - a mock feed replaying a golden event stream (development)
 *   - a local edge's read API (embedded Hub, local-first)
 *   - a Community's global projections (networked Hub)
 */

import type {
  ActivityFeedView,
  AgentStateView,
  AnyIFlowEvent,
  NetworkGraphView,
  RoomView,
  TaskGraphView,
  ViewEnvelope,
} from 'iflow-domain'

export interface TaskQuery {
  roomId?: string
  goalId?: string
}

export interface JournalPage {
  events: AnyIFlowEvent[]
  lastSeq: number
  hasMore: boolean
}

/** What an edge says about itself, including the id a command must name. */
export interface EdgeStatus {
  nodeId: string
  lastSeq: number
  syncedSeq: number
}

/**
 * A request for an edge to do something.
 *
 * The Hub fills in intent and target; the source completes the envelope (ids,
 * expiry) because only it knows which node it is talking to. An edge may still
 * refuse — a refusal is a normal answer, not an error.
 */
export interface CommandRequest {
  requestedAction: string
  target: { agentId?: string; taskId?: string }
  correlationId?: string
}

export interface CommandResult {
  accepted: boolean
  reason?: string
  attemptId?: string
}

export interface ProjectionSource {
  /** Human-readable name of where this data comes from, shown in the UI. */
  readonly label: string
  /** False while the source is a mock, so the UI can say so honestly. */
  readonly live: boolean

  getAgents(): Promise<ViewEnvelope<AgentStateView>>
  getNetwork(): Promise<ViewEnvelope<NetworkGraphView>>
  getActivity(): Promise<ViewEnvelope<ActivityFeedView>>
  getTasks(query?: TaskQuery): Promise<ViewEnvelope<TaskGraphView>>
  getRoom(roomId: string): Promise<ViewEnvelope<RoomView> | undefined>

  /** Page the raw journal, for replay. Optional: not every source can serve it. */
  getJournal?(fromSeq: number, limit?: number): Promise<JournalPage>

  /**
   * Ask the edge to act. Absent on a read-only source such as a fixture feed —
   * the UI checks for it and disables the controls rather than pretending an
   * action is available.
   */
  sendCommand?(request: CommandRequest): Promise<CommandResult>

  /** Identity and cursor of the edge behind this source, when it has one. */
  getEdgeStatus?(): Promise<EdgeStatus>

  /**
   * Notify when the underlying projections moved. The handler receives the new
   * event when the source knows it, and nothing when it only knows that
   * something changed.
   */
  subscribe(handler: (event?: AnyIFlowEvent) => void): () => void
}
