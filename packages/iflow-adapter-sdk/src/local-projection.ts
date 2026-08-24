/**
 * Local Projection — the read side of the edge.
 *
 * Projections are disposable by design: they can be deleted and rebuilt from
 * the governing Journal, and doing so must reproduce the same state. There is
 * therefore no persistence here at all, only a fold kept warm in memory and
 * re-derived on demand.
 */

import type {
  ActivityFeedView,
  AgentStateView,
  AnyIFlowEvent,
  ConversationListView,
  NetworkGraphView,
  NetworkState,
  ProjectionSet,
  RequestsView,
  RoomView,
  TaskGraphFilter,
  TaskGraphView,
  ViewEnvelope,
} from 'iflow-domain'
import {
  applyEvent,
  emptyNetworkState,
  projectActivityFeed,
  projectAgentState,
  projectAll,
  projectConversations,
  projectNetworkGraph,
  projectRequests,
  projectRoom,
  projectTaskGraph,
  reduceEvents,
} from 'iflow-domain'

import type { ClockPort, Disposable } from './ports.js'

export type ProjectionChangeHandler = (event: AnyIFlowEvent) => void

export class LocalProjection {
  private state: NetworkState = emptyNetworkState()
  private listeners = new Set<ProjectionChangeHandler>()

  constructor(private readonly clock: ClockPort) {}

  /** Discard everything and re-derive from the journal. */
  rebuild(events: Iterable<AnyIFlowEvent>): void {
    this.state = reduceEvents(events)
  }

  /** Fold one newly journaled fact. */
  ingest(event: AnyIFlowEvent): void {
    this.state = applyEvent(this.state, event)
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A view subscriber that throws must not corrupt the projection.
      }
    }
  }

  onChange(handler: ProjectionChangeHandler): Disposable {
    this.listeners.add(handler)
    return { dispose: () => this.listeners.delete(handler) }
  }

  /** The raw fold. Exposed for tests and for a rebuild-equality check. */
  snapshot(): NetworkState {
    return this.state
  }

  private options(): { builtAt: string } {
    return { builtAt: this.clock.nowIso() }
  }

  agents(): ViewEnvelope<AgentStateView> {
    return projectAgentState(this.state, this.options())
  }

  network(): ViewEnvelope<NetworkGraphView> {
    return projectNetworkGraph(this.state, this.options())
  }

  activity(): ViewEnvelope<ActivityFeedView> {
    return projectActivityFeed(this.state, this.options())
  }

  tasks(filter: TaskGraphFilter = {}): ViewEnvelope<TaskGraphView> {
    return projectTaskGraph(this.state, this.options(), filter)
  }

  room(roomId: string): ViewEnvelope<RoomView> | undefined {
    return projectRoom(this.state, this.options(), roomId)
  }

  conversations(): ViewEnvelope<ConversationListView> {
    return projectConversations(this.state, this.options())
  }

  requests(): ViewEnvelope<RequestsView> {
    return projectRequests(this.state, this.options())
  }

  all(): ProjectionSet {
    return projectAll(this.state, this.options())
  }
}
