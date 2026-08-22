/**
 * The mock projection source.
 *
 * It replays a golden event stream through the SAME domain projectors a real
 * edge uses. That is deliberate and load-bearing: a mock feed is a development
 * tool whose shape is governed by the shared contract, so a screen built
 * against it keeps working the moment real Origin Journal facts arrive. There
 * is no second, hand-written "fake view" anywhere in this app.
 */

import type {
  ActivityFeedView,
  AgentStateView,
  AnyIFlowEvent,
  NetworkGraphView,
  NetworkState,
  RoomView,
  TaskGraphView,
  ViewEnvelope,
} from 'iflow-domain'
import {
  applyEvent,
  emptyNetworkState,
  projectActivityFeed,
  projectAgentState,
  projectNetworkGraph,
  projectRoom,
  projectTaskGraph,
  reduceEvents,
} from 'iflow-domain'
import { validateEvent } from 'iflow-protocol'
import type { JournalPage, ProjectionSource, TaskQuery } from 'iflow-hub-ui'

import fixture from '../../../../fixtures/slice-events.json'

export interface MockSourceOptions {
  /** Milliseconds between replayed events. 0 loads the whole stream at once. */
  replayMs?: number
}

export class MockProjectionSource implements ProjectionSource {
  readonly label: string
  readonly live = false

  private state: NetworkState
  private events: AnyIFlowEvent[]
  private cursor: number
  private listeners = new Set<(event?: AnyIFlowEvent) => void>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(options: MockSourceOptions = {}) {
    const all = fixture as unknown as AnyIFlowEvent[]

    // Validate the fixture against the real envelope schema. A malformed
    // fixture would otherwise let the UI drift away from what an edge emits.
    const invalid = all.filter((event) => !validateEvent(event).valid)
    if (invalid.length > 0) {
      throw new Error(`mock fixture contains ${invalid.length} event(s) that are not valid IFlowEvents`)
    }

    this.events = all
    const replayMs = options.replayMs ?? 0

    if (replayMs > 0) {
      this.state = emptyNetworkState()
      this.cursor = 0
      this.label = `mock feed (replaying ${all.length} events)`
      this.timer = setInterval(() => this.step(), replayMs)
    } else {
      this.state = reduceEvents(all)
      this.cursor = all.length
      this.label = `mock feed (${all.length} events)`
    }
  }

  private step(): void {
    const next = this.events[this.cursor]
    if (!next) {
      if (this.timer) clearInterval(this.timer)
      this.timer = undefined
      return
    }
    this.cursor += 1
    this.state = applyEvent(this.state, next)
    for (const listener of this.listeners) listener(next)
  }

  private meta(): { builtAt: string } {
    return { builtAt: new Date().toISOString() }
  }

  async getAgents(): Promise<ViewEnvelope<AgentStateView>> {
    return projectAgentState(this.state, this.meta())
  }

  async getNetwork(): Promise<ViewEnvelope<NetworkGraphView>> {
    return projectNetworkGraph(this.state, this.meta())
  }

  async getActivity(): Promise<ViewEnvelope<ActivityFeedView>> {
    return projectActivityFeed(this.state, this.meta())
  }

  async getTasks(query: TaskQuery = {}): Promise<ViewEnvelope<TaskGraphView>> {
    return projectTaskGraph(this.state, this.meta(), query)
  }

  async getRoom(roomId: string): Promise<ViewEnvelope<RoomView> | undefined> {
    return projectRoom(this.state, this.meta(), roomId)
  }

  async getJournal(fromSeq: number, limit = 500): Promise<JournalPage> {
    const events = this.events.slice(0, this.cursor).filter((event) => event.origin.seq > fromSeq)
    const page = events.slice(0, limit)
    const lastSeq = page.length > 0 ? (page[page.length - 1] as AnyIFlowEvent).origin.seq : fromSeq
    return { events: page, lastSeq, hasMore: page.length < events.length }
  }

  subscribe(handler: (event?: AnyIFlowEvent) => void): () => void {
    this.listeners.add(handler)
    return () => this.listeners.delete(handler)
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.listeners.clear()
  }
}
