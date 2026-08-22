/**
 * The activity timeline — every fact, in the order the origin asserts it.
 *
 * Two rules this view exists to keep visible:
 *   - it shows what happened, never what a model intends to do next
 *   - when the retention window has dropped older entries it says so, instead
 *     of quietly presenting a partial history as the whole story
 */

import { useMemo, useState } from 'react'

import type { ActivityEntry } from 'iflow-domain'

import { useProjection } from '../hooks.js'
import { ProjectionStamp } from './AgentDirectory.js'
import { Empty, ErrorPanel, Loading, Panel, RelativeTime } from './primitives.js'

const CATEGORY_OF = (type: string): string => type.split('.')[0] ?? 'other'

export function ActivityTimeline({
  taskId,
  roomId,
  limit = 200,
}: {
  taskId?: string
  roomId?: string
  limit?: number
}) {
  const { data, error, loading } = useProjection((source) => source.getActivity(), [taskId, roomId])
  const [category, setCategory] = useState<string>('all')

  const entries = useMemo(() => {
    const all = data?.data.entries ?? []
    const scoped = all.filter((entry) => {
      if (taskId && entry.taskId !== taskId) return false
      if (roomId && entry.roomId !== roomId) return false
      if (category !== 'all' && CATEGORY_OF(entry.type) !== category) return false
      return true
    })
    // Newest first for reading; the journal itself stays in origin order.
    return scoped.slice(-limit).reverse()
  }, [data, taskId, roomId, category, limit])

  const categories = useMemo(() => {
    const found = new Set((data?.data.entries ?? []).map((entry) => CATEGORY_OF(entry.type)))
    return ['all', ...[...found].sort()]
  }, [data])

  if (error) return <ErrorPanel error={error} />
  if (loading) return <Loading what="activity" />

  return (
    <Panel
      title="Activity"
      actions={
        <>
          <select
            className="ifo-select"
            value={category}
            onChange={(changeEvent) => setCategory(changeEvent.target.value)}
            aria-label="Filter activity by category"
          >
            {categories.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <ProjectionStamp meta={data?.meta} />
        </>
      }
    >
      {data?.data.truncated ? (
        <p className="ifo-note">
          Older entries are outside the retention window. The full history is still in the journal.
        </p>
      ) : null}

      {entries.length === 0 ? (
        <Empty>No matching activity.</Empty>
      ) : (
        <ol className="ifo-timeline">
          {entries.map((entry) => (
            <TimelineRow key={entry.eventId} entry={entry} />
          ))}
        </ol>
      )}
    </Panel>
  )
}

function TimelineRow({ entry }: { entry: ActivityEntry }) {
  return (
    <li className={`ifo-timeline__row ifo-timeline__row--${CATEGORY_OF(entry.type)}`}>
      <span className="ifo-timeline__time">
        <RelativeTime iso={entry.occurredAt} />
      </span>
      <span className="ifo-timeline__type ifo-mono">{entry.type}</span>
      <span className="ifo-timeline__summary">{entry.summary}</span>
      <span className="ifo-timeline__actor ifo-muted" title={`${entry.actorKind} ${entry.actorId}`}>
        {entry.actorId}
      </span>
    </li>
  )
}
