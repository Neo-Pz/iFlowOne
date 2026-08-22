/**
 * The edge's read API — how a Hub sees this node.
 *
 * Strictly read-only. Every write path into an edge goes through the command
 * contract and the host's own enforcement, never through these routes; that is
 * what keeps "no Hub, Community, or transport may bypass a local runtime's
 * permission policy" true by construction rather than by discipline.
 */

import type { AnyIFlowEvent } from 'iflow-domain'

import type { LocalProjection } from './local-projection.js'
import type { OriginJournal } from './origin-journal.js'
import type { Disposable, HttpRequest, HttpResponse, HttpServerPort, LoggerPort } from './ports.js'

export const EDGE_ROUTE_PREFIX = '/iflow'

export interface EdgeServerOptions {
  /**
   * Decide whether a request may read this edge's projections. Defaults to
   * allowing everything, because the host is expected to bind loopback-only;
   * a host exposing the port on a LAN MUST supply a real check.
   */
  authorize?(request: HttpRequest): boolean
  /** Origins allowed to read the projections from a browser. */
  allowedOrigins?: string[]
  /** Max events one `/iflow/journal` page returns. */
  pageLimit?: number
}

const DEFAULT_PAGE_LIMIT = 500

export function mountEdgeServer(
  http: HttpServerPort,
  journal: OriginJournal,
  projection: LocalProjection,
  logger: LoggerPort,
  options: EdgeServerOptions = {},
): Disposable {
  const authorize = options.authorize ?? (() => true)
  const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT
  const disposables: Disposable[] = []

  const corsHeaders = (request: HttpRequest): Record<string, string> => {
    const origin = request.headers['origin'] ?? request.headers['Origin']
    const allowed = options.allowedOrigins
    if (!origin) return {}
    if (allowed && !allowed.includes(origin)) return {}
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      Vary: 'Origin',
    }
  }

  const json = (request: HttpRequest, status: number, body: unknown): HttpResponse => ({
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(request) },
    body: JSON.stringify(body),
  })

  const guarded =
    (handler: (request: HttpRequest) => unknown) =>
    async (request: HttpRequest): Promise<HttpResponse> => {
      if (!authorize(request)) return json(request, 401, { error: 'unauthorized' })
      try {
        return json(request, 200, handler(request))
      } catch (error) {
        logger.error('iflow: edge read failed', error)
        return json(request, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }

  const get = (path: string, handler: (request: HttpRequest) => unknown): void => {
    disposables.push(http.route({ method: 'GET', path: `${EDGE_ROUTE_PREFIX}${path}`, handler: guarded(handler) }))
  }

  get('/projection/agents', () => projection.agents())
  get('/projection/network', () => projection.network())
  get('/projection/activity', () => projection.activity())
  get('/projection/tasks', (request) => {
    const roomId = request.query['roomId']
    const goalId = request.query['goalId']
    return projection.tasks({ roomId: roomId || undefined, goalId: goalId || undefined })
  })
  get('/projection/room', (request) => {
    const roomId = request.query['roomId'] ?? ''
    const view = projection.room(roomId)
    if (!view) throw new Error(`no such room: ${roomId}`)
    return view
  })

  get('/journal', (request) => {
    const fromSeq = Number.parseInt(request.query['fromSeq'] ?? '0', 10)
    const requested = Number.parseInt(request.query['limit'] ?? String(pageLimit), 10)
    const limit = Math.min(Number.isFinite(requested) && requested > 0 ? requested : pageLimit, pageLimit)
    const events = journal.since(Number.isFinite(fromSeq) ? fromSeq : 0, limit)
    const lastSeq = events.length > 0 ? (events[events.length - 1] as AnyIFlowEvent).origin.seq : fromSeq
    return {
      nodeId: journal.nodeId,
      fromSeq,
      lastSeq,
      // A client pages until this is false; it never has to guess.
      hasMore: lastSeq < journal.lastSeq,
      events,
    }
  })

  get('/edge/status', () => ({
    nodeId: journal.nodeId,
    lastSeq: journal.lastSeq,
    syncedSeq: journal.syncedSeq,
    skippedJournalLines: journal.skippedLineCount,
    projection: projection.agents().meta,
  }))

  // Live tail. A host with no streaming support simply omits `stream`, and the
  // Hub falls back to polling `/iflow/journal`.
  if (http.stream) {
    disposables.push(
      http.stream({
        path: `${EDGE_ROUTE_PREFIX}/stream`,
        handler: (request, stream) => {
          if (!authorize(request)) {
            stream.send('event: error\ndata: {"error":"unauthorized"}\n\n')
            stream.close()
            return
          }
          const send = (event: AnyIFlowEvent): void => {
            stream.send(`event: iflow-event\ndata: ${JSON.stringify(event)}\n\n`)
          }
          const subscription = journal.subscribe(send)
          stream.onClose(() => subscription.dispose())
          stream.send(`event: hello\ndata: ${JSON.stringify({ nodeId: journal.nodeId, lastSeq: journal.lastSeq })}\n\n`)
        },
      }),
    )
  }

  return {
    dispose(): void {
      for (const disposable of disposables.reverse()) disposable.dispose()
    },
  }
}

/** Bearer-token check for hosts that expose the edge beyond loopback. */
export function bearerAuthorizer(token: string | undefined): (request: HttpRequest) => boolean {
  return (request) => {
    if (!token) return true
    const header = request.headers['authorization'] ?? request.headers['Authorization'] ?? ''
    return header === `Bearer ${token}`
  }
}
