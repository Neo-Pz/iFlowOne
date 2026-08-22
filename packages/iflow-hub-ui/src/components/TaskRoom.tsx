/**
 * Task Room — the Task DAG, its participants, and what is blocking it.
 *
 * React Flow draws the graph; the layout is a simple depth-banded placement
 * derived from the projection's own `depth`, so the picture is reproducible
 * rather than dependent on a physics simulation settling the same way twice.
 */

import { useCallback, useMemo, useState } from 'react'
import ReactFlow, { Background, Controls, MarkerType, type Edge, type Node } from 'reactflow'
import 'reactflow/dist/style.css'

import type { Task, TaskGraphView } from 'iflow-domain'

import { useProjection, useProjectionSource } from '../hooks.js'
import type { Approval } from 'iflow-domain'
import type { TaskQuery } from '../source.js'
import { ActivityTimeline } from './ActivityTimeline.js'
import { ProjectionStamp } from './AgentDirectory.js'
import { Empty, ErrorPanel, Loading, Panel, RelativeTime, TaskStateBadge } from './primitives.js'

const COLUMN = 260
const ROW = 130

const STATE_COLOR: Record<Task['state'], string> = {
  created: '#64748b',
  delegated: '#3b82f6',
  running: '#10b981',
  waiting: '#f59e0b',
  blocked: '#ef4444',
  awaiting_approval: '#f97316',
  completed: '#22c55e',
  failed: '#dc2626',
}

function layout(view: TaskGraphView): { nodes: Node[]; edges: Edge[] } {
  const perDepth = new Map<number, number>()

  const nodes: Node[] = view.nodes.map(({ task, depth }) => {
    const indexInDepth = perDepth.get(depth) ?? 0
    perDepth.set(depth, indexInDepth + 1)
    return {
      id: task.id,
      position: { x: indexInDepth * COLUMN, y: depth * ROW },
      data: { label: <TaskNodeLabel task={task} /> },
      style: {
        border: `1px solid ${STATE_COLOR[task.state]}`,
        borderLeftWidth: 4,
        borderRadius: 10,
        padding: 10,
        width: COLUMN - 40,
        background: 'var(--ifo-surface)',
        color: 'var(--ifo-text)',
        fontSize: 12,
        textAlign: 'left' as const,
      },
    }
  })

  const edges: Edge[] = view.edges.map((edge, index) => ({
    id: `${edge.kind}-${edge.source}-${edge.target}-${index}`,
    source: edge.source,
    target: edge.target,
    animated: edge.kind === 'subtask',
    style: { stroke: edge.kind === 'dependency' ? '#94a3b8' : '#3b82f6' },
    ...(edge.kind === 'dependency' ? { strokeDasharray: '4 4' } : {}),
    markerEnd: { type: MarkerType.ArrowClosed },
    label: edge.kind,
  }))

  return { nodes, edges }
}

function TaskNodeLabel({ task }: { task: Task }) {
  return (
    <div className="ifo-task-node">
      <strong>{task.title}</strong>
      <div>
        <TaskStateBadge state={task.state} />
      </div>
      {task.ownerAgentId ? <div className="ifo-muted ifo-mono">{task.ownerAgentId}</div> : null}
      {task.blockingReason ? <div className="ifo-blocking">⛔ {task.blockingReason}</div> : null}
    </div>
  )
}

export function TaskGraph({ query }: { query?: TaskQuery }) {
  const { data, error, loading } = useProjection((source) => source.getTasks(query), [query?.roomId, query?.goalId])
  const flow = useMemo(() => (data ? layout(data.data) : { nodes: [], edges: [] }), [data])

  if (error) return <ErrorPanel error={error} />
  if (loading) return <Loading what="tasks" />

  return (
    <Panel title="Task graph" actions={<ProjectionStamp meta={data?.meta} />}>
      {flow.nodes.length === 0 ? (
        <Empty>No tasks in this scope yet.</Empty>
      ) : (
        <div className="ifo-flow">
          <ReactFlow nodes={flow.nodes} edges={flow.edges} fitView proOptions={{ hideAttribution: true }}>
            <Background />
            <Controls />
          </ReactFlow>
        </div>
      )}
    </Panel>
  )
}

export function TaskDetail({ taskId }: { taskId: string }) {
  const { data, error, loading } = useProjection((source) => source.getTasks(), [taskId])

  if (error) return <ErrorPanel error={error} />
  if (loading) return <Loading what="task" />

  const task = data?.data.nodes.find((node) => node.task.id === taskId)?.task
  if (!task) return <Empty>No task with id {taskId} in this projection.</Empty>

  return (
    <Panel title={task.title} actions={<TaskStateBadge state={task.state} />}>
      <dl className="ifo-kv">
        <dt>id</dt>
        <dd className="ifo-mono">{task.id}</dd>
        <dt>owner</dt>
        <dd className="ifo-mono">{task.ownerAgentId ?? '—'}</dd>
        <dt>updated</dt>
        <dd>
          <RelativeTime iso={task.updatedAt} />
        </dd>
        {task.blockingReason ? (
          <>
            <dt>blocked by</dt>
            <dd className="ifo-blocking">{task.blockingReason}</dd>
          </>
        ) : null}
      </dl>

      <h4>Attempts</h4>
      {task.attempts.length === 0 ? (
        <p className="ifo-muted">No execution attempt recorded.</p>
      ) : (
        <ol className="ifo-attempts">
          {task.attempts.map((attempt) => (
            <li key={attempt.attemptId}>
              <span className="ifo-mono">{attempt.attemptId}</span> by{' '}
              <span className="ifo-mono">{attempt.agentId}</span> ·{' '}
              {attempt.outcome ?? <span className="ifo-muted">in flight</span>}
            </li>
          ))}
        </ol>
      )}

      <h4>Outputs</h4>
      {task.outputs.length === 0 ? (
        <p className="ifo-muted">Nothing produced yet.</p>
      ) : (
        <ul>
          {task.outputs.map((output) => (
            <li key={`${output.kind}-${output.id}`}>
              <span className="ifo-tag">{output.kind}</span> {output.summary}
            </li>
          ))}
        </ul>
      )}

      <ActivityTimeline taskId={taskId} />
    </Panel>
  )
}

export function TaskRoom({ roomId }: { roomId: string }) {
  const { data, error, loading } = useProjection((source) => source.getRoom(roomId), [roomId])

  if (error) return <ErrorPanel error={error} />
  if (loading) return <Loading what="the room" />
  if (!data) return <Empty>No room with id {roomId} in this projection.</Empty>

  const { room, goal, participants, approvals } = data.data
  const pending = approvals.filter((approval) => approval.decision === undefined)

  return (
    <div className="ifo-room">
      <Panel title={room.title} actions={<ProjectionStamp meta={data.meta} />}>
        {goal ? (
          <p>
            <span className="ifo-tag">goal</span> {goal.title}
            {goal.budget ? (
              <span className="ifo-muted">
                {' '}
                · budget {goal.budget.limit} {goal.budget.currency}
              </span>
            ) : null}
          </p>
        ) : null}

        <h4>Participants ({participants.length})</h4>
        <ul className="ifo-taglist">
          {participants.map((participant) => (
            <li key={participant.id} className="ifo-tag">
              {participant.label}
            </li>
          ))}
        </ul>

        {pending.length > 0 ? <PendingApprovals approvals={pending} /> : null}
      </Panel>

      <TaskGraph query={{ roomId }} />
    </div>
  )
}

/**
 * Answer an approval from the Room.
 *
 * This does NOT replace the prompt in the runtime: the edge races both answers
 * and takes whichever arrives first, so a human at the local terminal is never
 * locked out. A source with no `sendCommand` — a fixture feed, or an edge that
 * has not opted into commands — shows the queue read-only rather than offering
 * a button that would silently do nothing.
 */
function PendingApprovals({ approvals }: { approvals: Approval[] }) {
  const source = useProjectionSource()
  const [busy, setBusy] = useState<string | undefined>()
  const [outcomes, setOutcomes] = useState<Record<string, string>>({})

  const canAct = typeof source.sendCommand === 'function'

  const answer = useCallback(
    async (approval: Approval, decision: 'allow' | 'reject') => {
      if (!source.sendCommand) return
      setBusy(approval.approvalId)
      try {
        const result = await source.sendCommand({
          requestedAction: `approval.resolve:${decision}`,
          target: { agentId: approval.agentId, taskId: approval.taskId },
        })
        setOutcomes((previous) => ({
          ...previous,
          // A refusal is a real answer from the edge and is shown as such,
          // not swallowed into a generic failure.
          [approval.approvalId]: result.accepted ? `sent (${decision})` : `refused: ${result.reason ?? 'no reason given'}`,
        }))
      } catch (error) {
        setOutcomes((previous) => ({
          ...previous,
          [approval.approvalId]: `could not reach the edge: ${error instanceof Error ? error.message : String(error)}`,
        }))
      } finally {
        setBusy(undefined)
      }
    },
    [source],
  )

  return (
    <div className="ifo-note ifo-note--urgent">
      <strong>{approvals.length} approval(s) waiting on a human.</strong>
      {!canAct ? (
        <p className="ifo-muted">
          This source is read-only, so they can only be watched from here — answer them in the runtime.
        </p>
      ) : null}
      <ul className="ifo-approvals">
        {approvals.map((approval) => (
          <li key={approval.approvalId}>
            <span className="ifo-approvals__reason">{approval.reason}</span>{' '}
            <span className="ifo-mono ifo-muted">{approval.agentId}</span>
            {canAct ? (
              <span className="ifo-approvals__actions">
                <button
                  type="button"
                  className="ifo-button ifo-button--allow"
                  disabled={busy !== undefined}
                  onClick={() => void answer(approval, 'allow')}
                >
                  Allow once
                </button>
                <button
                  type="button"
                  className="ifo-button ifo-button--reject"
                  disabled={busy !== undefined}
                  onClick={() => void answer(approval, 'reject')}
                >
                  Reject
                </button>
              </span>
            ) : null}
            {outcomes[approval.approvalId] ? (
              <span className="ifo-approvals__outcome ifo-muted">{outcomes[approval.approvalId]}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
