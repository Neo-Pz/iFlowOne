/**
 * iFlowOne Web — the standalone deployment of the shared Hub UI.
 *
 * The routes here are the ones the architecture fixes for both deployments.
 * Embedded in a runtime the same components read Local Projections; here they
 * read whatever `ProjectionSource` was selected. Nothing in this shell knows
 * which one it got, beyond saying so honestly in the header.
 */

import { useCallback, useMemo } from 'react'
import { NavLink, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom'

import {
  ActivityTimeline,
  AgentDetail,
  AgentDirectory,
  NetworkGraph,
  ProjectionSourceProvider,
  Replay,
  TaskDetail,
  TaskGraph,
  TaskRoom,
} from 'iflow-hub-ui'

import { createProjectionSource } from './sources/index.js'

const NAV = [
  { to: '/agents', label: 'Agents' },
  { to: '/network', label: 'Network' },
  { to: '/activity', label: 'Activity' },
  { to: '/tasks', label: 'Tasks' },
  { to: '/replay', label: 'Replay' },
]

export default function App() {
  const source = useMemo(() => createProjectionSource(), [])

  return (
    <ProjectionSourceProvider value={source}>
      <div className="app">
        <header className="app__header">
          <div className="app__brand">
            <span className="app__mark">iF</span>
            <div>
              <strong>iFlowOne</strong>
              <span className="app__tagline">Agent Network Domain &amp; Event System</span>
            </div>
          </div>

          <nav className="app__nav">
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? 'is-active' : undefined)}>
                {item.label}
              </NavLink>
            ))}
          </nav>

          <SourceBadge label={source.label} live={source.live} />
        </header>

        <main className="app__main">
          <Routes>
            <Route path="/" element={<Navigate to="/agents" replace />} />
            <Route path="/agents" element={<AgentsRoute />} />
            <Route path="/agents/:agentId" element={<AgentRoute />} />
            <Route path="/network" element={<NetworkRoute />} />
            <Route path="/activity" element={<ActivityTimeline />} />
            <Route path="/tasks" element={<TaskGraph />} />
            <Route path="/tasks/:taskId" element={<TaskRoute />} />
            <Route path="/replay" element={<Replay />} />
            <Route path="/rooms/:roomId" element={<RoomRoute />} />
            <Route path="/goals/:goalId" element={<GoalRoute />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
      </div>
    </ProjectionSourceProvider>
  )
}

/**
 * States plainly whether these screens show observed facts from a live edge or
 * a replayed fixture. A Hub that cannot tell you which it is showing is not
 * trustworthy for an audit question.
 */
function SourceBadge({ label, live }: { label: string; live: boolean }) {
  return (
    <span className={`app__source ${live ? 'app__source--live' : 'app__source--mock'}`} title={label}>
      <i />
      {live ? 'live edge' : 'mock feed'}
    </span>
  )
}

function AgentsRoute() {
  const navigate = useNavigate()
  return <AgentDirectory onSelect={(agentId) => navigate(`/agents/${encodeURIComponent(agentId)}`)} />
}

function AgentRoute() {
  const { agentId } = useParams()
  return agentId ? <AgentDetail agentId={agentId} /> : <NotFound />
}

function NetworkRoute() {
  const navigate = useNavigate()
  // The graph reports a node id and its kind; the shell decides where that
  // lands, so the UI package stays free of this app's route table.
  const openNode = useCallback(
    (id: string, kind: string) => {
      const route = { task: 'tasks', room: 'rooms', agent: 'agents', goal: 'goals' }[kind]
      if (route) navigate(`/${route}/${encodeURIComponent(id)}`)
    },
    [navigate],
  )

  return (
    <>
      <NetworkGraph onSelect={openNode} />
      <ActivityTimeline limit={30} />
    </>
  )
}

function TaskRoute() {
  const { taskId } = useParams()
  return taskId ? <TaskDetail taskId={taskId} /> : <NotFound />
}

function RoomRoute() {
  const { roomId } = useParams()
  return roomId ? <TaskRoom roomId={roomId} /> : <NotFound />
}

function GoalRoute() {
  const { goalId } = useParams()
  if (!goalId) return <NotFound />
  return (
    <>
      <TaskGraph query={{ goalId }} />
      <ActivityTimeline />
    </>
  )
}

function NotFound() {
  return (
    <div className="app__notfound">
      <h2>Nothing here</h2>
      <p>
        Try <NavLink to="/agents">the agent directory</NavLink>.
      </p>
    </div>
  )
}
