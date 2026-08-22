import type { ReactNode } from 'react'

import type { AgentState, TaskState } from 'iflow-domain'

export function Panel({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="ifo-panel">
      <header className="ifo-panel__head">
        <h2>{title}</h2>
        {actions}
      </header>
      <div className="ifo-panel__body">{children}</div>
    </section>
  )
}

export function Loading({ what }: { what: string }) {
  return <p className="ifo-muted">Loading {what}…</p>
}

export function ErrorPanel({ error }: { error: Error }) {
  return (
    <div className="ifo-error" role="alert">
      <strong>Could not read the projection.</strong>
      <p>{error.message}</p>
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="ifo-muted ifo-empty">{children}</p>
}

/**
 * The three Agent axes are rendered as three separate chips on purpose.
 * Collapsing them into one label is what makes an agent that is online,
 * running, and waiting for a human look simply "busy".
 */
export function AgentStateBadges({ state }: { state: AgentState }) {
  return (
    <span className="ifo-axes">
      <span className={`ifo-chip ifo-chip--presence-${state.presence}`}>{state.presence}</span>
      <span className={`ifo-chip ifo-chip--execution-${state.execution}`}>{state.execution}</span>
      <span className={`ifo-chip ifo-chip--coordination-${state.coordination}`}>
        {state.coordination.replace('_', ' ')}
      </span>
    </span>
  )
}

export function TaskStateBadge({ state }: { state: TaskState }) {
  return <span className={`ifo-chip ifo-chip--task-${state}`}>{state.replace('_', ' ')}</span>
}

export function RelativeTime({ iso }: { iso: string }) {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return <time>{iso}</time>
  return (
    <time dateTime={iso} title={iso}>
      {new Date(parsed).toLocaleTimeString()}
    </time>
  )
}
