/**
 * Data-loading hooks.
 *
 * Every screen goes through `useProjection`, so live updates, error states and
 * the "which source am I looking at" question are answered in one place rather
 * than re-invented per view.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

import type { ProjectionSource } from './source.js'

const SourceContext = createContext<ProjectionSource | undefined>(undefined)

export const ProjectionSourceProvider = SourceContext.Provider

export function useProjectionSource(): ProjectionSource {
  const source = useContext(SourceContext)
  if (!source) throw new Error('useProjectionSource must be used inside a ProjectionSourceProvider')
  return source
}

export interface ProjectionResult<T> {
  data: T | undefined
  error: Error | undefined
  /** True only before the first successful load, so refreshes do not flash. */
  loading: boolean
  refresh(): void
}

/**
 * Load a projection and keep it current.
 *
 * A refresh triggered by a live event never clears the previous data: a graph
 * that blanks on every incoming fact is unusable during real activity.
 */
export function useProjection<T>(load: (source: ProjectionSource) => Promise<T>, deps: unknown[] = []): ProjectionResult<T> {
  const source = useProjectionSource()
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<Error | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const generation = useRef(0)

  const run = useCallback(() => {
    const current = ++generation.current
    load(source)
      .then((value) => {
        if (generation.current !== current) return
        setData(value)
        setError(undefined)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (generation.current !== current) return
        setError(cause instanceof Error ? cause : new Error(String(cause)))
        setLoading(false)
      })
    // `load` is intentionally not a dependency: callers pass an inline closure,
    // and depending on its identity would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, ...deps])

  useEffect(() => {
    run()
    return source.subscribe(() => run())
  }, [run, source])

  return { data, error, loading, refresh: run }
}

/** Coalesce bursts of live events into one refresh per frame-ish window. */
export function useThrottledSubscription(handler: () => void, ms = 250): void {
  const source = useProjectionSource()
  useEffect(() => {
    let pending = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = source.subscribe(() => {
      if (pending) return
      pending = true
      timer = setTimeout(() => {
        pending = false
        handler()
      }, ms)
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [source, handler, ms])
}
