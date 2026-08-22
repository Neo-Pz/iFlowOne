/**
 * The Agent directory — the first product entry, identical embedded or networked.
 *
 * Trust is presented as evidence a reader can check (a DID, a signed card, an
 * accepted grant), never as a computed score: the architecture is explicit
 * that a Community observes trust facts rather than manufacturing a rating.
 */

import type { Agent } from 'iflow-domain'

import { useProjection } from '../hooks.js'
import { AgentStateBadges, Empty, ErrorPanel, Loading, Panel, RelativeTime } from './primitives.js'

export function AgentCard({ agent, onSelect }: { agent: Agent; onSelect?: (agentId: string) => void }) {
  return (
    <article className="ifo-agent-card">
      <header>
        <button type="button" className="ifo-agent-card__name" onClick={() => onSelect?.(agent.id)}>
          {agent.label}
        </button>
        <AgentStateBadges state={agent.state} />
      </header>

      <dl className="ifo-kv">
        <dt>id</dt>
        <dd className="ifo-mono">{agent.id}</dd>
        <dt>node</dt>
        <dd className="ifo-mono">
          {agent.nodeId} · {agent.runtimeKind}
        </dd>
        <dt>did</dt>
        <dd className="ifo-mono ifo-truncate">{agent.did ?? <span className="ifo-muted">not verified</span>}</dd>
        {agent.lastSeenAt ? (
          <>
            <dt>last seen</dt>
            <dd>
              <RelativeTime iso={agent.lastSeenAt} />
            </dd>
          </>
        ) : null}
      </dl>

      {agent.capabilities.length > 0 ? (
        <ul className="ifo-taglist">
          {agent.capabilities.map((capability) => (
            <li key={capability} className="ifo-tag">
              {capability}
            </li>
          ))}
        </ul>
      ) : (
        <p className="ifo-muted">No declared capabilities.</p>
      )}

      <section className="ifo-agent-card__trust">
        <h4>Trust evidence</h4>
        {agent.trustEvidence.length === 0 ? (
          <p className="ifo-muted">None recorded. This agent is known, not vouched for.</p>
        ) : (
          <ul>
            {agent.trustEvidence.map((evidence, index) => (
              <li key={`${evidence.kind}-${index}`}>
                <span className="ifo-tag">{evidence.kind.replace(/_/g, ' ')}</span>{' '}
                <RelativeTime iso={evidence.at} />
                {evidence.detail ? <span className="ifo-muted"> — {evidence.detail}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  )
}

export function AgentDirectory({ onSelect }: { onSelect?: (agentId: string) => void }) {
  const { data, error, loading } = useProjection((source) => source.getAgents())

  if (error) return <ErrorPanel error={error} />
  if (loading) return <Loading what="agents" />

  const agents = data?.data.agents ?? []

  return (
    <Panel title={`Agents (${agents.length})`} actions={<ProjectionStamp meta={data?.meta} />}>
      {agents.length === 0 ? (
        <Empty>No agent has registered on this node yet.</Empty>
      ) : (
        <div className="ifo-grid">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} onSelect={onSelect} />
          ))}
        </div>
      )}
    </Panel>
  )
}

export function AgentDetail({ agentId }: { agentId: string }) {
  const { data, error, loading } = useProjection((source) => source.getAgents(), [agentId])

  if (error) return <ErrorPanel error={error} />
  if (loading) return <Loading what="agent" />

  const agent = data?.data.agents.find((candidate) => candidate.id === agentId)
  if (!agent) return <Empty>No agent with id {agentId} in this projection.</Empty>

  return (
    <Panel title={agent.label}>
      <AgentCard agent={agent} />
    </Panel>
  )
}

/** Shows which projection version and cursor produced what is on screen. */
export function ProjectionStamp({ meta }: { meta?: { projectionVersion: number; eventCount: number; cursor?: string } }) {
  if (!meta) return null
  return (
    <span className="ifo-stamp ifo-mono" title={meta.cursor ? `cursor ${meta.cursor}` : 'no events yet'}>
      v{meta.projectionVersion} · {meta.eventCount} events
    </span>
  )
}
