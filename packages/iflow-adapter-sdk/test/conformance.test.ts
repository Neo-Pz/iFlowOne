/**
 * The host conformance suite.
 *
 * These assertions define what "an iFlow edge" means. They run here against
 * the in-memory reference host; a new host adapter (DSH today, another runtime
 * tomorrow) proves itself by running the same suite against its own ports.
 *
 * Four of the architecture doc's five failure tests are exercised directly:
 *   2. a lost acknowledgement after a successful upload creates no second fact
 *   3. repeated delivery of one command produces at most one side effect
 *   4. deleting every projection and rebuilding reproduces the same state
 *   5. a malformed or expired request is refused at the origin edge
 * (Test 1 — a Community outage never stops local work — is covered by the
 * offline-progress case below.)
 */

import { describe, expect, it } from 'vitest'

import type { AnyIFlowEvent } from 'iflow-domain'
import type { IFlowCommand } from 'iflow-protocol'
import { base64urlDecode, signableBytes } from 'iflow-protocol'

import { createEdge } from '../src/create-edge.js'
import type { CommandExecutionOutcome, RuntimeExecutorPort } from '../src/ports.js'
import type { SyncSink } from '../src/outbox.js'
import { createFakeKeypair, createMemoryHost, type MemoryHost } from '../src/testing.js'

async function newEdge(host: MemoryHost = createMemoryHost()) {
  const edge = await createEdge({ ports: host.ports, descriptor: host.descriptor })
  return { host, edge }
}

/** The minimal multi-agent flow the first vertical slice has to survive. */
async function runSlice(edge: Awaited<ReturnType<typeof createEdge>>): Promise<void> {
  await edge.observer.goalCreated({
    goalId: 'goal-1',
    title: 'Ship the first slice',
    context: { principalId: 'user-1' },
    roomId: 'room-1',
  })
  await edge.observer.roomCreated({ roomId: 'room-1', title: 'Slice room', goalId: 'goal-1' })
  await edge.observer.agentRegistered({ agentId: 'agent-lead', label: 'lead' })
  await edge.observer.agentRegistered({ agentId: 'agent-child-a', label: 'child-a' })
  await edge.observer.agentRegistered({ agentId: 'agent-child-b', label: 'child-b' })
  await edge.observer.roomParticipantJoined({ roomId: 'room-1', agentId: 'agent-lead' })

  await edge.observer.taskCreated({ taskId: 'task-root', title: 'Root', goalId: 'goal-1', roomId: 'room-1' })
  await edge.observer.taskDelegated({ taskId: 'task-root', toAgentId: 'agent-lead' })
  await edge.observer.taskStarted({ taskId: 'task-root', agentId: 'agent-lead', attemptId: 'attempt-root' })

  await edge.observer.taskCreated({
    taskId: 'task-a',
    title: 'Child A',
    parentTaskId: 'task-root',
    goalId: 'goal-1',
    roomId: 'room-1',
  })
  await edge.observer.taskDelegated({ taskId: 'task-a', toAgentId: 'agent-child-a' })
  await edge.observer.taskStarted({ taskId: 'task-a', agentId: 'agent-child-a', attemptId: 'attempt-a' })
  await edge.observer.toolCallStarted({
    callId: 'call-1',
    toolName: 'read_file',
    agentId: 'agent-child-a',
    taskId: 'task-a',
  })
  await edge.observer.toolCallCompleted({
    callId: 'call-1',
    toolName: 'read_file',
    outcome: 'ok',
    agentId: 'agent-child-a',
    taskId: 'task-a',
  })
  await edge.observer.taskCompleted({ taskId: 'task-a', summary: 'read the file' })

  await edge.observer.taskCreated({
    taskId: 'task-b',
    title: 'Child B',
    parentTaskId: 'task-root',
    goalId: 'goal-1',
    roomId: 'room-1',
  })
  await edge.observer.taskDelegated({ taskId: 'task-b', toAgentId: 'agent-child-b' })
  await edge.observer.taskStarted({ taskId: 'task-b', agentId: 'agent-child-b', attemptId: 'attempt-b' })
  await edge.observer.approvalRequested({
    approvalId: 'appr-1',
    agentId: 'agent-child-b',
    reason: 'wants to write outside the workspace',
    taskId: 'task-b',
  })
  await edge.observer.taskAwaitingApproval({ taskId: 'task-b', approvalId: 'appr-1', reason: 'needs a human' })
  await edge.observer.approvalResolved({
    approvalId: 'appr-1',
    decision: 'allowed',
    agentId: 'agent-child-b',
    taskId: 'task-b',
  })
  await edge.observer.taskStarted({ taskId: 'task-b', agentId: 'agent-child-b', attemptId: 'attempt-b2' })
  await edge.observer.taskCompleted({ taskId: 'task-b', summary: 'wrote the file' })

  await edge.observer.taskCompleted({
    taskId: 'task-root',
    summary: 'done',
    outputs: [{ kind: 'artifact', id: 'artifact-1', summary: 'final report' }],
  })
}

describe('origin journal', () => {
  it('assigns a strictly increasing seq inside one origin stream', async () => {
    const { edge } = await newEdge()
    await runSlice(edge)

    const seqs = edge.journal.all().map((event) => event.origin.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(seqs[0]).toBe(1)
  })

  it('serializes concurrent appends without reusing a seq', async () => {
    const { edge } = await newEdge()
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        edge.observer.taskCreated({ taskId: `task-${i}`, title: `Task ${i}` }),
      ),
    )
    const seqs = edge.journal.all().map((event) => event.origin.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('writes the fact to durable storage before the projection can show it', async () => {
    const { host, edge } = await newEdge()
    await edge.observer.taskCreated({ taskId: 'task-1', title: 'One' })

    const journalLines = host.storage.lines(edge.paths.origin)
    expect(journalLines).toHaveLength(2) // agent.registered for self, then task.created
    expect(edge.views.snapshot().tasks['task-1']).toBeDefined()
  })

  it('reopens from disk with the same state and keeps counting from the last seq', async () => {
    const host = createMemoryHost()
    const first = await createEdge({ ports: host.ports, descriptor: host.descriptor })
    await runSlice(first)
    const lastSeq = first.journal.lastSeq
    first.dispose()

    // A second edge over the same storage is exactly what a restart looks like.
    const second = await createEdge({ ports: host.ports, descriptor: host.descriptor, registerSelf: false })
    expect(second.journal.lastSeq).toBe(lastSeq)

    await second.observer.taskCreated({ taskId: 'task-after-restart', title: 'After' })
    expect(second.journal.lastSeq).toBe(lastSeq + 1)
  })

  it('treats a restart as coming back online, not as a new registration', async () => {
    const host = createMemoryHost()
    const first = await createEdge({ ports: host.ports, descriptor: host.descriptor })
    expect(first.journal.all().filter((e) => e.type === 'agent.registered')).toHaveLength(1)

    const second = await createEdge({ ports: host.ports, descriptor: host.descriptor })
    const registrations = second.journal.all().filter((e) => e.type === 'agent.registered')
    const presence = second.journal
      .all()
      .filter((e) => e.type === 'agent.presence_changed' && e.subject.id === host.descriptor.selfAgentId)

    // "When did this agent join the network?" must stay answerable.
    expect(registrations).toHaveLength(1)
    expect(presence).toHaveLength(1)
    expect((presence[0] as { payload: { presence?: string } }).payload.presence).toBe('online')
  })

  it('skips unreadable lines rather than refusing to open (failure test 5, at rest)', async () => {
    const host = createMemoryHost()
    const first = await createEdge({ ports: host.ports, descriptor: host.descriptor })
    await first.observer.taskCreated({ taskId: 'task-1', title: 'One' })

    const corrupted = `${host.storage.files.get(first.paths.origin) ?? ''}{"not":"an event"}\nnot json at all\n`
    host.storage.files.set(first.paths.origin, corrupted)

    const reopened = await createEdge({ ports: host.ports, descriptor: host.descriptor, registerSelf: false })
    expect(reopened.journal.all()).toHaveLength(2)
    expect(reopened.journal.skippedLineCount).toBe(2)
  })

  it('refuses to journal a malformed fact (failure test 5, in flight)', async () => {
    const { edge } = await newEdge()
    await expect(
      edge.journal.record({
        type: 'task.created',
        // An empty subject id is not a subject; the edge rejects it at the origin.
        subject: { kind: 'task', id: '' },
        payload: { title: 'nope' },
      }),
    ).rejects.toThrow(/malformed/)
  })
})

describe('local projection', () => {
  it('reproduces the same state after deleting and rebuilding (failure test 4)', async () => {
    const { edge } = await newEdge()
    await runSlice(edge)

    const before = structuredClone(edge.views.snapshot())
    edge.rebuildProjection()
    const after = edge.views.snapshot()

    expect(after).toEqual(before)
  })

  it('rebuilds identically in a fresh process from the journal alone', async () => {
    const host = createMemoryHost()
    const first = await createEdge({ ports: host.ports, descriptor: host.descriptor })
    await runSlice(first)
    const before = structuredClone(first.views.snapshot())

    const second = await createEdge({ ports: host.ports, descriptor: host.descriptor, registerSelf: false })
    expect(second.views.snapshot()).toEqual(before)
  })

  it('keeps the three agent state axes independent', async () => {
    const { edge } = await newEdge()
    await edge.observer.agentRegistered({ agentId: 'agent-1', label: 'one' })
    await edge.observer.agentPresenceChanged({ agentId: 'agent-1', execution: 'running' })
    await edge.observer.approvalRequested({
      approvalId: 'appr-1',
      agentId: 'agent-1',
      reason: 'needs a human',
      taskId: 'task-1',
    })

    expect(edge.views.snapshot().agents['agent-1']?.state).toEqual({
      presence: 'online',
      execution: 'running',
      coordination: 'awaiting_approval',
    })
  })

  it('builds a relationship graph, not a log', async () => {
    const { edge } = await newEdge()
    await runSlice(edge)

    const graph = edge.views.network().data
    const kinds = new Set(graph.edges.map((edge_) => edge_.kind))
    expect(kinds.has('delegation')).toBe(true)
    expect(kinds.has('ownership')).toBe(true)
    expect(kinds.has('approval')).toBe(true)
    // Tool calls are facts in the feed; they are not edges in the network.
    expect(graph.edges.some((e) => e.id.includes('call-1'))).toBe(false)
  })

  it('records an illegal transition as an anomaly instead of hiding it', async () => {
    const { edge } = await newEdge()
    await edge.observer.taskCreated({ taskId: 'task-1', title: 'One' })
    await edge.observer.taskCompleted({ taskId: 'task-1' })
    await edge.observer.taskStarted({ taskId: 'task-1', agentId: 'agent-1' })

    const state = edge.views.snapshot()
    expect(state.anomalies).toHaveLength(1)
    expect(state.anomalies[0]).toMatchObject({ taskId: 'task-1', from: 'completed', to: 'running' })
    // The fact still won: the journal, not the state machine, is the authority.
    expect(state.tasks['task-1']?.state).toBe('running')
  })

  it('carries an unknown future event type without losing it', async () => {
    const { host, edge } = await newEdge()
    const line = JSON.stringify({
      id: 'evt-future',
      schemaVersion: 99,
      origin: { nodeId: 'node-test', streamId: 'edge', seq: 900 },
      occurredAt: '2026-01-01T00:00:00.000Z',
      correlationId: 'corr-future',
      visibility: 'local',
      type: 'reputation.endorsed',
      issuer: { id: 'agent-x', kind: 'agent' },
      subject: { kind: 'agent', id: 'agent-x' },
      payload: { score: 5 },
    })
    host.storage.files.set(edge.paths.origin, `${host.storage.files.get(edge.paths.origin) ?? ''}${line}\n`)

    const reopened = await createEdge({ ports: host.ports, descriptor: host.descriptor, registerSelf: false })
    expect(reopened.views.snapshot().unknownEventTypes['reputation.endorsed']).toBe(1)
    expect(reopened.journal.all().some((e) => e.id === 'evt-future')).toBe(true)
  })
})

describe('origin signatures', () => {
  it('signs every fact it journals, and the signature verifies', async () => {
    const host = createMemoryHost({ did: 'did:key:zFakeTestIdentity' })
    const { signer, verifier } = createFakeKeypair()
    const edge = await createEdge({ ports: host.ports, descriptor: host.descriptor, signer, verifier })

    await runSlice(edge)

    const report = await edge.verifyJournal()
    expect(report.checked).toBe(edge.journal.all().length)
    expect(report.unsigned).toBe(0)
    expect(report.forged).toEqual([])
    expect(report.verified).toBe(report.checked)
  })

  it('signs as the agent the event is attributed to, not as whoever holds a key', async () => {
    // A node holds one key per Agent it declares. If the journal signed every
    // fact with the same key regardless of who issued it, a verifier checking
    // the signature against the issuer's DID would call every event by every
    // other agent a forgery — and, worse, an event could be attributed to an
    // Agent whose operator never signed anything.
    const host = createMemoryHost({ did: 'did:key:zNode' })
    host.descriptor.agentDids = {
      'agent-writer': 'did:key:zWriter',
      'agent-reviewer': 'did:key:zReviewer',
    }

    const asked: Array<string | undefined> = []
    const signer = {
      did: async () => 'did:key:zNode',
      sign: async (_bytes: Uint8Array, context?: { did?: string; agentId?: string }) => {
        asked.push(context?.did)
        return new Uint8Array([1, 2, 3])
      },
    }

    const edge = await createEdge({ ports: host.ports, descriptor: host.descriptor, signer })
    await edge.observer.toolCallStarted({ taskId: 't1', callId: 'c1', toolName: 'read', agentId: 'agent-writer' })
    await edge.observer.toolCallStarted({ taskId: 't1', callId: 'c2', toolName: 'read', agentId: 'agent-reviewer' })

    const facts = edge.journal.all()
    const byWriter = facts.find((e) => e.issuer.id === 'agent-writer')
    const byReviewer = facts.find((e) => e.issuer.id === 'agent-reviewer')

    // The event says who acted, and with which key that can be checked.
    expect(byWriter?.issuer.did).toBe('did:key:zWriter')
    expect(byReviewer?.issuer.did).toBe('did:key:zReviewer')

    // And the signer was told, so it can reach for the right key.
    expect(asked).toContain('did:key:zWriter')
    expect(asked).toContain('did:key:zReviewer')
  })

  it('leaves an unknown actor without a DID rather than borrowing one', async () => {
    // A session, or a peer known only by label, has no key. Stamping the node's
    // DID on its events would claim a proof that does not exist.
    const host = createMemoryHost({ did: 'did:key:zNode' })
    host.descriptor.agentDids = { 'agent-writer': 'did:key:zWriter' }
    const { signer, verifier } = createFakeKeypair()
    const edge = await createEdge({ ports: host.ports, descriptor: host.descriptor, signer, verifier })

    await edge.observer.toolCallStarted({ taskId: 't1', callId: 'c1', toolName: 'read', agentId: 'agent-stranger' })

    const fact = edge.journal.all().find((e) => e.issuer.id === 'agent-stranger')
    expect(fact).toBeDefined()
    expect(fact?.issuer.did).toBeUndefined()
  })

  it('detects a fact whose payload was edited after signing', async () => {
    const host = createMemoryHost({ did: 'did:key:zFakeTestIdentity' })
    const { signer, verifier } = createFakeKeypair()
    const edge = await createEdge({ ports: host.ports, descriptor: host.descriptor, signer, verifier })
    await edge.observer.taskCreated({ taskId: 'task-1', title: 'Original' })

    // Rewrite the journal the way an attacker with disk access would, keeping
    // the original signature.
    const raw = host.storage.files.get(edge.paths.origin) ?? ''
    host.storage.files.set(edge.paths.origin, raw.replace('"Original"', '"Tampered"'))

    const reopened = await createEdge({
      ports: host.ports,
      descriptor: host.descriptor,
      registerSelf: false,
      verifier,
    })
    const report = await reopened.verifyJournal()

    expect(report.forged).toHaveLength(1)
    expect(report.verified).toBe(report.checked - 1)
  })

  it('keeps working with no signer, and says how many facts are unprovable', async () => {
    const { edge } = await newEdge()
    await edge.observer.taskCreated({ taskId: 'task-1', title: 'One' })

    expect(edge.journal.signing).toBe(false)
    // Two facts: the edge's own registration and this task.
    expect(edge.journal.unsignedWriteCount).toBe(2)

    const report = await edge.verifyJournal()
    expect(report.unsigned).toBe(2)
    expect(report.forged).toEqual([])
  })

  it('does not sign over the signature field, so a signed event verifies as written', async () => {
    const host = createMemoryHost({ did: 'did:key:zFakeTestIdentity' })
    const { signer, verifier } = createFakeKeypair()
    const edge = await createEdge({ ports: host.ports, descriptor: host.descriptor, signer, verifier })
    await edge.observer.taskCreated({ taskId: 'task-1', title: 'One' })

    // The exact bytes on disk must verify — not a reconstruction of them.
    const lines = (host.storage.files.get(edge.paths.origin) ?? '').trim().split('\n')
    const onDisk = JSON.parse(lines[lines.length - 1] as string) as AnyIFlowEvent
    expect(onDisk.evidence?.signature).toBeTypeOf('string')

    const ok = await verifier.verify(
      signableBytes(onDisk),
      base64urlDecode(onDisk.evidence!.signature!),
      'did:key:zFakeTestIdentity',
    )
    expect(ok).toBe(true)
  })
})

describe('outbox', () => {
  it('keeps working while the Community is unreachable (failure test 1)', async () => {
    const { edge } = await newEdge()
    const offlineSink: SyncSink = {
      async publish() {
        throw new Error('community unreachable')
      },
    }

    await runSlice(edge)
    await edge.observer.agentRegistered({
      agentId: 'agent-public',
      label: 'public',
      context: { visibility: 'public' },
    })
    const result = await edge.outbox.flush(offlineSink, (id) => edge.journal.all().find((e) => e.id === id))

    expect(result.delivered).toBe(0)
    expect(result.error).toMatch(/unreachable/)
    // Local work carried on regardless: the journal and projection are intact.
    expect(edge.views.snapshot().tasks['task-root']?.state).toBe('completed')
    expect(edge.outbox.pending().length).toBeGreaterThan(0)
  })

  it('does not create a second fact when an acknowledgement is lost (failure test 2)', async () => {
    const { edge } = await newEdge()
    await runSlice(edge)
    await edge.observer.agentRegistered({
      agentId: 'agent-public-a',
      label: 'public-a',
      context: { visibility: 'public' },
    })
    await edge.observer.agentRegistered({
      agentId: 'agent-public-b',
      label: 'public-b',
      context: { visibility: 'public' },
    })

    const acceptedIds = new Set<string>()
    let dropNextAck = true
    const flakySink: SyncSink = {
      async publish(events: AnyIFlowEvent[]) {
        for (const event of events) acceptedIds.add(event.id)
        if (dropNextAck) {
          dropNextAck = false
          // The upload succeeded; only the acknowledgement was lost.
          throw new Error('acknowledgement lost in transit')
        }
        return { acceptedEventIds: events.map((event) => event.id) }
      },
    }

    const resolve = (id: string): AnyIFlowEvent | undefined => edge.journal.all().find((e) => e.id === id)

    // Attempt one: the sink took every event, then the ack was lost.
    await edge.outbox.flush(flakySink, resolve)
    expect(edge.outbox.pending().length).toBeGreaterThan(0)
    const acceptedAfterFirstAttempt = new Set(acceptedIds)
    expect(acceptedAfterFirstAttempt.size).toBe(edge.outbox.pending().length)

    // Attempt two: the same events go up again and this time the ack lands.
    await edge.outbox.flush(flakySink, resolve)
    expect(edge.outbox.pending()).toHaveLength(0)

    // The retry re-sent the same event identities, so a deduplicating sink
    // holds exactly one copy of each fact.
    expect(acceptedIds.size).toBe(acceptedAfterFirstAttempt.size)
    expect(acceptedIds.size).toBe(2)
  })

  it('acknowledging the same event twice changes nothing', async () => {
    const { edge } = await newEdge()
    await edge.observer.taskCreated({
      taskId: 'task-1',
      title: 'One',
      context: { visibility: 'public' },
    })
    const ids = edge.outbox.pending().map((entry) => entry.eventId)

    await edge.outbox.markDelivered(ids)
    await edge.outbox.markDelivered(ids)

    expect(edge.outbox.pending()).toHaveLength(0)
    expect(edge.outbox.delivered()).toHaveLength(ids.length)
  })

  it('survives a restart with its queue intact', async () => {
    const host = createMemoryHost()
    const first = await createEdge({ ports: host.ports, descriptor: host.descriptor })
    await first.observer.taskCreated({
      taskId: 'task-1',
      title: 'One',
      context: { visibility: 'public' },
    })
    const pendingBefore = first.outbox.pending().length

    const second = await createEdge({ ports: host.ports, descriptor: host.descriptor, registerSelf: false })
    expect(second.outbox.pending()).toHaveLength(pendingBefore)
  })
})

describe('command ledger', () => {
  const command: IFlowCommand = {
    commandId: 'cmd-1',
    idempotencyKey: 'idem-1',
    issuer: { id: 'hub-1' },
    target: { nodeId: 'node-test', taskId: 'task-b' },
    requestedAction: 'approval.resolve',
    expiresAt: '2026-01-01T01:00:00.000Z',
    correlationId: 'corr-1',
  }

  function countingExecutor(): RuntimeExecutorPort & { calls: number } {
    const executor = {
      calls: 0,
      async execute(): Promise<CommandExecutionOutcome> {
        executor.calls += 1
        return { accepted: true, attemptId: `attempt-${executor.calls}` }
      },
    }
    return executor
  }

  it('executes a repeated delivery at most once (failure test 3)', async () => {
    const { edge } = await newEdge()
    const executor = countingExecutor()

    const first = await edge.dispatchCommand(command, executor)
    const second = await edge.dispatchCommand(command, executor)
    const third = await edge.dispatchCommand({ ...command, commandId: 'cmd-1-resent' }, executor)

    expect(executor.calls).toBe(1)
    expect(first.accepted).toBe(true)
    expect(second).toEqual(first)
    // Same idempotency key under a new command id is still the same request.
    expect(third).toEqual(first)
  })

  it('still executes at most once across a restart', async () => {
    const host = createMemoryHost()
    const first = await createEdge({ ports: host.ports, descriptor: host.descriptor })
    const executor = countingExecutor()
    await first.dispatchCommand(command, executor)

    const second = await createEdge({ ports: host.ports, descriptor: host.descriptor, registerSelf: false })
    await second.dispatchCommand(command, executor)

    expect(executor.calls).toBe(1)
  })

  it('never retries a command interrupted mid-execution', async () => {
    const host = createMemoryHost()
    const first = await createEdge({ ports: host.ports, descriptor: host.descriptor })
    const crashing: RuntimeExecutorPort = {
      async execute() {
        // Simulate the process dying before the outcome could be recorded.
        return await new Promise<CommandExecutionOutcome>(() => {})
      },
    }
    void first.dispatchCommand(command, crashing)
    await Promise.resolve()

    const second = await createEdge({ ports: host.ports, descriptor: host.descriptor, registerSelf: false })
    const executor = countingExecutor()
    const outcome = await second.dispatchCommand(command, executor)

    expect(executor.calls).toBe(0)
    expect(outcome.accepted).toBe(false)
    expect(outcome.reason).toMatch(/interrupted/)
  })

  it('rejects an expired command without asking the host (failure test 5)', async () => {
    const { edge } = await newEdge()
    const executor = countingExecutor()
    const outcome = await edge.dispatchCommand({ ...command, expiresAt: '2025-01-01T00:00:00.000Z' }, executor)

    expect(executor.calls).toBe(0)
    expect(outcome).toEqual({ accepted: false, reason: 'command expired' })
  })

  it('rejects a malformed command without asking the host (failure test 5)', async () => {
    const { edge } = await newEdge()
    const executor = countingExecutor()
    const outcome = await edge.dispatchCommand({ ...command, target: undefined } as unknown as IFlowCommand, executor)

    expect(executor.calls).toBe(0)
    expect(outcome.accepted).toBe(false)
    expect(outcome.reason).toMatch(/malformed/)
  })

  it('lets the host refuse, and records the refusal', async () => {
    const { edge } = await newEdge()
    const refusing: RuntimeExecutorPort = {
      async execute() {
        return { accepted: false, reason: 'local policy forbids writing outside the workspace' }
      },
    }

    const outcome = await edge.dispatchCommand(command, refusing)
    expect(outcome.accepted).toBe(false)
    expect(edge.commands.lookup(command)?.status).toBe('rejected')
  })
})

describe('edge read API', () => {
  it('serves the four projections a Hub needs', async () => {
    const { host, edge } = await newEdge()
    await runSlice(edge)

    for (const view of ['agents', 'network', 'activity', 'tasks']) {
      const response = await host.http.call('GET', `/iflow/projection/${view}`)
      expect(response.status).toBe(200)
      const body = JSON.parse(response.body ?? '{}') as { meta: { projectionVersion: number } }
      expect(body.meta.projectionVersion).toBe(1)
    }
  })

  it('pages the journal for replay', async () => {
    const { host, edge } = await newEdge()
    await runSlice(edge)

    const first = JSON.parse(
      (await host.http.call('GET', '/iflow/journal', { query: { fromSeq: '0', limit: '5' } })).body ?? '{}',
    ) as { events: AnyIFlowEvent[]; hasMore: boolean; lastSeq: number }

    expect(first.events).toHaveLength(5)
    expect(first.hasMore).toBe(true)

    const rest = JSON.parse(
      (await host.http.call('GET', '/iflow/journal', { query: { fromSeq: String(first.lastSeq), limit: '500' } }))
        .body ?? '{}',
    ) as { events: AnyIFlowEvent[]; hasMore: boolean }

    expect(rest.hasMore).toBe(false)
    expect(first.events.length + rest.events.length).toBe(edge.journal.all().length)
  })

  it('pushes new facts to a live stream and drops the subscription on close', async () => {
    const { host, edge } = await newEdge()
    const stream = host.http.openStream('/iflow/stream')
    expect(stream.chunks[0]).toContain('event: hello')

    await edge.observer.taskCreated({ taskId: 'task-1', title: 'One' })
    expect(stream.chunks.some((chunk) => chunk.includes('task.created'))).toBe(true)

    const chunksAtClose = stream.chunks.length
    stream.fireClose()
    await edge.observer.taskCreated({ taskId: 'task-2', title: 'Two' })
    expect(stream.chunks).toHaveLength(chunksAtClose)
  })

  it('refuses an unauthorized read when the host supplies a token', async () => {
    const host = createMemoryHost()
    const edge = await createEdge({
      ports: host.ports,
      descriptor: host.descriptor,
      server: { authorize: (request) => request.headers['authorization'] === 'Bearer secret' },
    })
    void edge

    expect((await host.http.call('GET', '/iflow/projection/agents')).status).toBe(401)
    expect(
      (await host.http.call('GET', '/iflow/projection/agents', { headers: { authorization: 'Bearer secret' } })).status,
    ).toBe(200)
  })

  it('exposes no write route', async () => {
    const { host } = await newEdge()
    const methods = [...host.http.routes.keys()].map((key) => key.split(' ')[0])
    expect(new Set(methods)).toEqual(new Set(['GET']))
  })
})

describe('host isolation', () => {
  it('never lets an observation failure break the host', async () => {
    const host = createMemoryHost()
    const edge = await createEdge({ ports: host.ports, descriptor: host.descriptor })

    host.storage.failOn.add(edge.paths.origin)
    // The host called us; it must get a resolved promise, not an exception.
    await expect(edge.observer.taskCreated({ taskId: 'task-1', title: 'One' })).resolves.toBeUndefined()
    expect(host.logger.messages('error').some((m) => m.includes('task.created'))).toBe(true)
  })

  it('keeps journaling after one append failed', async () => {
    const host = createMemoryHost()
    const edge = await createEdge({ ports: host.ports, descriptor: host.descriptor })

    host.storage.failOn.add(edge.paths.origin)
    await edge.observer.taskCreated({ taskId: 'task-fails', title: 'Fails' })
    host.storage.failOn.delete(edge.paths.origin)
    await edge.observer.taskCreated({ taskId: 'task-works', title: 'Works' })

    expect(edge.views.snapshot().tasks['task-works']).toBeDefined()
    expect(edge.views.snapshot().tasks['task-fails']).toBeUndefined()
  })
})
