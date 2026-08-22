/**
 * The Agent network graph.
 *
 * This renders the `NetworkGraphView` projection and nothing else: delegation,
 * dependency, participation, ownership, delivery and approval relationships.
 * Raw log lines are deliberately absent — a graph that grows an edge per tool
 * call stops being a map of the network and becomes a picture of noise.
 *
 * Cytoscape is driven imperatively rather than through a React wrapper so a
 * live projection update can patch the existing graph instead of remounting it
 * and losing the viewer's pan, zoom and selection.
 */

import cytoscape from 'cytoscape'
import type { Core, ElementDefinition } from 'cytoscape'
import { useEffect, useRef, useState } from 'react'

import type { NetworkGraphView } from 'iflow-domain'

import { useProjection } from '../hooks.js'
import { ProjectionStamp } from './AgentDirectory.js'
import { Empty, ErrorPanel, Loading, Panel } from './primitives.js'

const NODE_COLORS: Record<string, string> = {
  agent: '#3b82f6',
  goal: '#a855f7',
  task: '#10b981',
  room: '#f59e0b',
}

const EDGE_COLORS: Record<string, string> = {
  delegation: '#3b82f6',
  dependency: '#94a3b8',
  participation: '#f59e0b',
  ownership: '#22d3ee',
  trust: '#a855f7',
  delivery: '#10b981',
  approval: '#ef4444',
}

/**
 * A deterministic layered layout, not a force simulation.
 *
 * `cose` re-settles differently on every load and its overlap avoidance
 * ignores label boxes (`nodeDimensionsIncludeLabels` belongs to cose-bilkent,
 * not the built-in), which left names on top of each other. Breadth-first puts
 * goals and rooms above the tasks and agents they relate to, gives every load
 * the same picture, and leaves clear horizontal bands for the labels.
 */
const LAYOUT: cytoscape.LayoutOptions = {
  name: 'breadthfirst',
  directed: true,
  animate: false,
  // Generous, because labels extend past their node box and would otherwise
  // be clipped by the viewport at the leftmost and rightmost columns.
  padding: 70,
  spacingFactor: 1.5,
  avoidOverlap: true,
  grid: true,
  circle: false,
} as cytoscape.LayoutOptions

/**
 * Cytoscape paints to a canvas, where CSS custom properties do not resolve —
 * a `var(--x)` handed to it silently becomes a default colour. The theme is
 * therefore read out of the DOM once and passed in as real values.
 */
function resolveTheme(element: HTMLElement): { text: string; halo: string; selected: string } {
  const styles = getComputedStyle(element)
  const read = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback
  return {
    text: read('--ifo-graph-text', '#cbd5e1'),
    halo: read('--ifo-surface', '#111827'),
    selected: read('--ifo-text', '#e2e8f0'),
  }
}

function buildStyle(theme: { text: string; halo: string; selected: string }): cytoscape.StylesheetJson {
  return [
    {
      selector: 'node',
      style: {
        'background-color': (element: cytoscape.NodeSingular) =>
          NODE_COLORS[element.data('kind') as string] ?? '#64748b',
        label: 'data(label)',
        color: theme.text,
        'font-size': 11,
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 5,
        'text-wrap': 'ellipsis',
        'text-max-width': '130px',
        'text-background-color': theme.halo,
        'text-background-opacity': 0.72,
        'text-background-padding': '2px',
        'text-background-shape': 'roundrectangle',
        width: 24,
        height: 24,
        'border-width': 2,
        'border-color': 'rgba(148,163,184,0.35)',
      },
    },
    {
      selector: 'node[kind="goal"]',
      style: { shape: 'round-diamond', width: 30, height: 30 },
    },
    {
      selector: 'node[kind="room"]',
      style: { shape: 'round-rectangle', width: 34, height: 24 },
    },
    {
      selector: 'edge',
      style: {
        width: 1.6,
        'line-color': (element: cytoscape.EdgeSingular) => EDGE_COLORS[element.data('kind') as string] ?? '#64748b',
        'target-arrow-color': (element: cytoscape.EdgeSingular) =>
          EDGE_COLORS[element.data('kind') as string] ?? '#64748b',
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        'arrow-scale': 0.8,
        opacity: 0.85,
      },
    },
    {
      selector: 'edge[kind="dependency"]',
      style: { 'line-style': 'dashed' },
    },
    {
      selector: ':selected',
      style: { 'border-color': theme.selected, 'border-width': 3 },
    },
  ]
}

function toElements(view: NetworkGraphView): ElementDefinition[] {
  return [
    ...view.nodes.map((node) => ({
      data: { id: node.id, label: node.label, kind: node.kind, status: node.status ?? '' },
    })),
    ...view.edges.map((edge) => ({
      data: { id: edge.id, source: edge.source, target: edge.target, kind: edge.kind, label: edge.label ?? '' },
    })),
  ]
}

export function NetworkGraph({ onSelect }: { onSelect?: (id: string, kind: string) => void }) {
  const { data, error, loading } = useProjection((source) => source.getNetwork())
  const container = useRef<HTMLDivElement | null>(null)
  const graph = useRef<Core | undefined>(undefined)
  const [selected, setSelected] = useState<{ id: string; kind: string; status: string } | undefined>()

  useEffect(() => {
    if (!container.current || graph.current) return
    const instance = cytoscape({
      container: container.current,
      style: buildStyle(resolveTheme(container.current)),
      layout: LAYOUT,
      wheelSensitivity: 0.2,
    })
    instance.on('tap', 'node', (tapEvent) => {
      const node = tapEvent.target as cytoscape.NodeSingular
      const picked = {
        id: node.id(),
        kind: node.data('kind') as string,
        status: (node.data('status') as string) ?? '',
      }
      setSelected(picked)
      onSelect?.(picked.id, picked.kind)
    })
    graph.current = instance
    return () => {
      instance.destroy()
      graph.current = undefined
    }
  }, [onSelect])

  useEffect(() => {
    const instance = graph.current
    if (!instance || !data) return

    const next = toElements(data.data)
    const nextIds = new Set(next.map((element) => element.data.id as string))

    // Patch rather than replace: removing everything would reset the layout
    // and throw away the position the viewer just panned to.
    instance.batch(() => {
      instance.elements().forEach((element) => {
        if (!nextIds.has(element.id())) element.remove()
      })
      let added = false
      for (const element of next) {
        const existing = instance.getElementById(element.data.id as string)
        if (existing.nonempty()) {
          existing.data(element.data)
        } else {
          instance.add(element)
          added = true
        }
      }
      if (added) instance.layout(LAYOUT).run()
    })
  }, [data])

  if (error) return <ErrorPanel error={error} />

  const view = data?.data
  const isEmpty = !loading && (view?.nodes.length ?? 0) === 0

  return (
    <Panel
      title="Network"
      actions={
        <>
          <Legend />
          <ProjectionStamp meta={data?.meta} />
        </>
      }
    >
      <div className="ifo-graph">
        <div ref={container} className="ifo-graph__canvas" />
        {loading ? <div className="ifo-graph__overlay">{<Loading what="the network" />}</div> : null}
        {isEmpty ? (
          <div className="ifo-graph__overlay">
            <Empty>Nothing has happened on this node yet.</Empty>
          </div>
        ) : null}
        {selected ? (
          <aside className="ifo-graph__inspector">
            <h4>{selected.id}</h4>
            <p className="ifo-muted">{selected.kind}</p>
            {selected.status ? <p className="ifo-mono">{selected.status}</p> : null}
          </aside>
        ) : null}
      </div>
    </Panel>
  )
}

function Legend() {
  return (
    <span className="ifo-legend">
      {Object.entries(NODE_COLORS).map(([kind, color]) => (
        <span key={kind} className="ifo-legend__item">
          <i style={{ background: color }} />
          {kind}
        </span>
      ))}
    </span>
  )
}
