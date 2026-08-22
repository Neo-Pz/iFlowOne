/**
 * The local-edge projection source.
 *
 * Reads the same view contracts straight off a running iFlow edge (today the
 * DSH plugin at 127.0.0.1:3080), and tails `/iflow/stream` for live updates.
 * When the stream is unavailable it degrades to polling rather than going
 * silent: a Hub that stops updating without saying so is worse than a slow one.
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
import type {
  CommandRequest,
  CommandResult,
  EdgeStatus,
  JournalPage,
  ProjectionSource,
  TaskQuery,
} from 'iflow-hub-ui'

export interface EdgeSourceOptions {
  baseUrl: string
  token?: string
  /** Poll interval used only when the live stream could not be opened. */
  pollMs?: number
}

export class EdgeProjectionSource implements ProjectionSource {
  readonly live = true
  readonly label: string

  private listeners = new Set<(event?: AnyIFlowEvent) => void>()
  private stream: EventSource | undefined
  private poller: ReturnType<typeof setInterval> | undefined

  constructor(private readonly options: EdgeSourceOptions) {
    this.label = `edge ${options.baseUrl}`
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {}
    if (this.options.token) headers['Authorization'] = `Bearer ${this.options.token}`

    const response = await fetch(`${this.options.baseUrl}${path}`, { headers })
    if (response.status === 401) {
      throw new Error('The edge refused this read. Set VITE_IFLOW_EDGE_TOKEN to its bearer token.')
    }
    if (!response.ok) {
      throw new Error(`edge returned ${response.status} for ${path}`)
    }
    return (await response.json()) as T
  }

  getAgents(): Promise<ViewEnvelope<AgentStateView>> {
    return this.fetchJson('/iflow/projection/agents')
  }

  getNetwork(): Promise<ViewEnvelope<NetworkGraphView>> {
    return this.fetchJson('/iflow/projection/network')
  }

  getActivity(): Promise<ViewEnvelope<ActivityFeedView>> {
    return this.fetchJson('/iflow/projection/activity')
  }

  getTasks(query: TaskQuery = {}): Promise<ViewEnvelope<TaskGraphView>> {
    const search = new URLSearchParams()
    if (query.roomId) search.set('roomId', query.roomId)
    if (query.goalId) search.set('goalId', query.goalId)
    const suffix = search.size > 0 ? `?${search.toString()}` : ''
    return this.fetchJson(`/iflow/projection/tasks${suffix}`)
  }

  async getRoom(roomId: string): Promise<ViewEnvelope<RoomView> | undefined> {
    try {
      return await this.fetchJson(`/iflow/projection/room?roomId=${encodeURIComponent(roomId)}`)
    } catch {
      return undefined
    }
  }

  getJournal(fromSeq: number, limit = 500): Promise<JournalPage> {
    return this.fetchJson(`/iflow/journal?fromSeq=${fromSeq}&limit=${limit}`)
  }

  getEdgeStatus(): Promise<EdgeStatus> {
    return this.fetchJson('/iflow/edge/status')
  }

  /**
   * Send one command to the edge.
   *
   * The idempotency key is derived from the intent rather than randomised, so
   * a double-click or a retry after a dropped response is the SAME request —
   * the edge's ledger then makes the second delivery a no-op instead of a
   * second side effect.
   */
  async sendCommand(request: CommandRequest): Promise<CommandResult> {
    const status = await this.getEdgeStatus()
    const target = request.target.taskId ?? request.target.agentId ?? 'node'
    const idempotencyKey = `hub:${request.requestedAction}:${target}`

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.options.token) headers['Authorization'] = `Bearer ${this.options.token}`

    const response = await fetch(`${this.options.baseUrl}/iflow/command`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        commandId: `cmd-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
        idempotencyKey,
        issuer: { id: 'iflowone-web' },
        target: { nodeId: status.nodeId, ...request.target },
        requestedAction: request.requestedAction,
        // Short-lived on purpose: a stale approval must not be answerable an
        // hour later by a retry nobody remembers sending.
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        correlationId: request.correlationId ?? idempotencyKey,
      }),
    })

    if (!response.ok) {
      return { accepted: false, reason: `edge returned ${response.status}` }
    }
    return (await response.json()) as CommandResult
  }

  subscribe(handler: (event?: AnyIFlowEvent) => void): () => void {
    this.listeners.add(handler)
    this.ensureUpdates()
    return () => {
      this.listeners.delete(handler)
      if (this.listeners.size === 0) this.stopUpdates()
    }
  }

  private notify(event?: AnyIFlowEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private ensureUpdates(): void {
    if (this.stream || this.poller) return

    // EventSource cannot carry an Authorization header, so a token-protected
    // edge is polled instead. The token still travels only to the edge.
    if (!this.options.token && typeof EventSource !== 'undefined') {
      try {
        const stream = new EventSource(`${this.options.baseUrl}/iflow/stream`)
        stream.addEventListener('iflow-event', (messageEvent) => {
          try {
            this.notify(JSON.parse((messageEvent as MessageEvent<string>).data) as AnyIFlowEvent)
          } catch {
            this.notify()
          }
        })
        stream.onerror = () => {
          stream.close()
          this.stream = undefined
          this.startPolling()
        }
        this.stream = stream
        return
      } catch {
        // fall through to polling
      }
    }

    this.startPolling()
  }

  private startPolling(): void {
    if (this.poller) return
    this.poller = setInterval(() => this.notify(), this.options.pollMs ?? 3000)
  }

  private stopUpdates(): void {
    this.stream?.close()
    this.stream = undefined
    if (this.poller) clearInterval(this.poller)
    this.poller = undefined
  }
}
