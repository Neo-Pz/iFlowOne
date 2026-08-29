/**
 * Generate the golden event stream every mock feed replays.
 *
 * The fixture is produced by driving the real SDK against the in-memory host,
 * not hand-written. That is the whole point: a mock feed is a development tool
 * whose shape is governed by the same contract as a real edge, so a Web screen
 * built against it works unchanged the moment a real Origin Journal appears.
 *
 * Run: pnpm fixtures
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createEdge } from '../packages/iflow-adapter-sdk/src/create-edge.js'
import { createMemoryHost } from '../packages/iflow-adapter-sdk/src/testing.js'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

/**
 * The architecture doc's first acceptance scenario, end to end:
 * a Goal, a Lead that accepts it, two delegated children, a tool call, an
 * approval that blocks, a human resolution, completion and an artifact.
 */
async function main(): Promise<void> {
  const host = createMemoryHost({
    nodeId: 'node-fixture',
    runtimeKind: 'dsh',
    runtimeVersion: '0.0.0-fixture',
    selfAgentId: 'agent-edge',
    selfAgentLabel: 'if-lt',
    did: 'did:key:z6MkfixtureEdgeIdentityPlaceholder000000000',
    capabilities: ['iflow.cap:task.run', 'iflow.cap:tool.call'],
  })

  const edge = await createEdge({ ports: host.ports, descriptor: host.descriptor })
  const { observer } = edge

  // Wall-clock advances between facts so a timeline has something to show.
  const tick = (ms = 1500): void => host.clock.advance(ms)

  await observer.goalCreated({
    goalId: 'goal-slice',
    title: 'Produce the quarterly summary',
    // Lin wants the summary; `agent-edge` is what the network sees asking for
    // it. Principle 0 in the golden stream, not only in the doc.
    context: { principalId: 'user-lin' },
    constraints: ['stay inside the workspace', 'no network writes'],
    budget: { currency: 'USD', limit: 5 },
    roomId: 'room-slice',
  })
  tick()

  await observer.roomCreated({
    roomId: 'room-slice',
    title: 'Quarterly summary',
    goalId: 'goal-slice',
    rootTaskId: 'task-root',
  })
  tick()

  for (const [id, label, capabilities] of [
    ['agent-lead', 'lead', ['iflow.cap:task.delegate']],
    ['agent-reader', 'reader', ['iflow.cap:fs.read']],
    ['agent-writer', 'writer', ['iflow.cap:fs.write']],
  ] as const) {
    await observer.agentRegistered({ agentId: id, label, capabilities: [...capabilities] })
    await observer.roomParticipantJoined({ roomId: 'room-slice', agentId: id })
    tick(400)
  }

  await observer.taskCreated({
    taskId: 'task-root',
    title: 'Assemble the summary',
    goalId: 'goal-slice',
    roomId: 'room-slice',
  })
  await observer.taskDelegated({ taskId: 'task-root', toAgentId: 'agent-lead', reason: 'lead accepted the goal' })
  await observer.taskStarted({ taskId: 'task-root', agentId: 'agent-lead', attemptId: 'attempt-root-1' })
  await observer.agentPresenceChanged({ agentId: 'agent-lead', execution: 'running' })
  tick()

  // Child A: reads source data and finishes cleanly.
  await observer.taskCreated({
    taskId: 'task-read',
    title: 'Read the ledger',
    parentTaskId: 'task-root',
    goalId: 'goal-slice',
    roomId: 'room-slice',
  })
  await observer.taskDelegated({ taskId: 'task-read', toAgentId: 'agent-reader' })
  await observer.taskStarted({ taskId: 'task-read', agentId: 'agent-reader', attemptId: 'attempt-read-1' })
  await observer.agentPresenceChanged({ agentId: 'agent-reader', execution: 'running' })
  tick(800)
  await observer.toolCallStarted({
    callId: 'call-read-1',
    toolName: 'read_file',
    agentId: 'agent-reader',
    taskId: 'task-read',
  })
  tick(600)
  await observer.toolCallCompleted({
    callId: 'call-read-1',
    toolName: 'read_file',
    outcome: 'ok',
    agentId: 'agent-reader',
    taskId: 'task-read',
  })
  await observer.usageRecorded({
    taskId: 'task-read',
    model: 'deepseek-v4-flash',
    tokens: { input: 4210, output: 890, cacheRead: 1200, cacheWrite: 0 },
    costMicros: 3400,
    priceSource: 'pricing.json',
  })
  await observer.taskCompleted({
    taskId: 'task-read',
    summary: 'ledger rows extracted',
    outputs: [{ kind: 'message', id: 'msg-read-1', summary: '412 rows' }],
  })
  await observer.agentPresenceChanged({ agentId: 'agent-reader', execution: 'idle' })
  tick()

  // Child B: blocks on an approval, a human resolves it, then it completes.
  await observer.taskCreated({
    taskId: 'task-write',
    title: 'Write the summary file',
    parentTaskId: 'task-root',
    dependsOn: ['task-read'],
    goalId: 'goal-slice',
    roomId: 'room-slice',
  })
  await observer.taskDelegated({ taskId: 'task-write', toAgentId: 'agent-writer' })
  await observer.taskStarted({ taskId: 'task-write', agentId: 'agent-writer', attemptId: 'attempt-write-1' })
  tick(700)
  await observer.approvalRequested({
    approvalId: 'appr-write-1',
    agentId: 'agent-writer',
    toolName: 'write_file',
    reason: 'writing outside the workspace root',
    taskId: 'task-write',
  })
  await observer.taskAwaitingApproval({
    taskId: 'task-write',
    approvalId: 'appr-write-1',
    reason: 'writing outside the workspace root',
  })
  tick(9000)
  await observer.approvalResolved({
    approvalId: 'appr-write-1',
    decision: 'allowed',
    agentId: 'agent-writer',
    taskId: 'task-write',
    context: { issuer: { id: 'user-lin', kind: 'human' } },
  })
  await observer.taskStarted({ taskId: 'task-write', agentId: 'agent-writer', attemptId: 'attempt-write-2' })
  tick(600)
  await observer.toolCallStarted({
    callId: 'call-write-1',
    toolName: 'write_file',
    agentId: 'agent-writer',
    taskId: 'task-write',
  })
  await observer.toolCallCompleted({
    callId: 'call-write-1',
    toolName: 'write_file',
    outcome: 'ok',
    agentId: 'agent-writer',
    taskId: 'task-write',
  })
  await observer.taskCompleted({ taskId: 'task-write', summary: 'summary.md written' })
  await observer.agentPresenceChanged({ agentId: 'agent-writer', execution: 'idle' })
  tick()

  await observer.taskCompleted({
    taskId: 'task-root',
    summary: 'quarterly summary delivered',
    outputs: [{ kind: 'artifact', id: 'artifact-summary', summary: 'summary.md' }],
  })
  await observer.agentPresenceChanged({ agentId: 'agent-lead', execution: 'idle' })

  const events = edge.journal.all()

  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, 'slice-events.json'), `${JSON.stringify(events, null, 2)}\n`, 'utf8')
  writeFileSync(
    join(OUT_DIR, 'slice-events.ndjson'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  )

  console.log(`wrote ${events.length} events to fixtures/slice-events.{json,ndjson}`)
}

await main()
