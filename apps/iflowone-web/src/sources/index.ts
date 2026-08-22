/**
 * Source selection.
 *
 * One switch decides whether this app reads a fixture stream or a live edge.
 * Both satisfy `ProjectionSource`, so nothing downstream of here changes.
 */

import type { ProjectionSource } from 'iflow-hub-ui'

import { EdgeProjectionSource } from './edge.js'
import { MockProjectionSource } from './mock.js'

export function createProjectionSource(): ProjectionSource {
  const kind = (import.meta.env.VITE_IFLOW_SOURCE ?? 'mock').trim()

  if (kind === 'edge') {
    return new EdgeProjectionSource({
      baseUrl: (import.meta.env.VITE_IFLOW_EDGE_URL ?? 'http://127.0.0.1:3080').replace(/\/+$/, ''),
      token: import.meta.env.VITE_IFLOW_EDGE_TOKEN || undefined,
    })
  }

  const replayMs = Number.parseInt(import.meta.env.VITE_IFLOW_MOCK_REPLAY_MS ?? '0', 10)
  return new MockProjectionSource({ replayMs: Number.isFinite(replayMs) ? replayMs : 0 })
}

export { EdgeProjectionSource, MockProjectionSource }
