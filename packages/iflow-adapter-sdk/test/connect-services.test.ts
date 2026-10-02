import { describe, expect, it } from 'vitest'
import type { AgentRuntimeDescriptor, AgentRuntimePort, AgentRuntimePolicyPort } from '../src/agent-runtime.js'
import type { ConversationEntry } from '../src/conversation-service.js'
import type { DiscoveryPublicationContext, DiscoveryRuntimePorts } from '../src/discovery-runtime.js'
import { createEdge } from '../src/create-edge.js'
import { createMemoryHost, createFakeKeypair } from '../src/testing.js'

// A disposable mutation may replace one module; normal runs import the real SDK.
const { createAgentRuntimeService } = await import(process.env.IFLOW_TEST_AGENT_RUNTIME || '../src/agent-runtime.js') as typeof import('../src/agent-runtime.js')
const { createConversationService, assertAgentSigner } = await import(process.env.IFLOW_TEST_CONVERSATION_SERVICE || '../src/conversation-service.js') as typeof import('../src/conversation-service.js')
const { createDiscoveryRuntime } = await import(process.env.IFLOW_TEST_DISCOVERY_SERVICE || '../src/discovery-runtime.js') as typeof import('../src/discovery-runtime.js')

const agent: AgentRuntimeDescriptor = { agentId: 'coder', did: 'did:key:coder', label: 'Coder', capabilities: ['iflow.cap:code'] }
const request = { requestId: 'req-one', agentId: agent.agentId, agentDid: agent.did, input: { text: 'Review this code' } }
const attempt = { agentId: agent.agentId, agentDid: agent.did, attemptId: 'attempt-one' }
const publish = { action: 'publish' as const, fromAgentId: agent.agentId, confirmPublic: true, description: 'Review code', representativeQueries: ['Review TypeScript code', 'Explain TypeScript errors'], tags: ['code'] }

function runtimeFixture() {
  const state = { agent: { ...agent } as AgentRuntimeDescriptor | undefined, calls: [] as string[] }
  const runtime: AgentRuntimePort = {
    async enumerate() { return state.agent ? [state.agent] : [] },
    async describe(id) { return id === state.agent?.agentId ? state.agent : undefined },
    async execute() { state.calls.push('execute'); return { accepted: true, attemptId: attempt.attemptId } },
    async getStatus() { state.calls.push('status'); return { available: true, state: 'completed', output: 'review' } },
    async cancel() { state.calls.push('cancel'); return { accepted: true } },
  }
  const policy: AgentRuntimePolicyPort = { async authorize() { return { allowed: true } } }
  return { state, runtime, policy, service: createAgentRuntimeService(runtime, policy) }
}

function discoveryFixture(overrides: Partial<DiscoveryRuntimePorts> = {}) {
  const records: unknown[] = []
  const context: DiscoveryPublicationContext = {
    enabled: true, nodeId: 'bridge-node', runtimeKind: 'a2a-bridge', version: '1.0', evidenceSource: 'a2a',
    agentInterface: { url: 'https://bridge.example/routes/coder', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
  }
  const service = createDiscoveryRuntime({
    selectedAgent: async (id) => { if (id !== agent.agentId) throw new Error('unavailable'); return agent },
    publicationContext: async () => context,
    record: async (input) => { records.push(input); return { id: 'registered', evidence: { signature: 'selected-agent-signature' } } },
    requestSearch: async () => ({ registry: 'https://community.example/v1/ard', response: { results: [{ identifier: 'urn:air:example.com:agents:other', score: 1 }] } }),
    ...overrides,
  })
  return { service, records, context }
}

describe('Connect runtime authority', () => {
  it('requires exact current Agent identity and refuses missing, foreign and stale targets', async () => {
    const { state, service } = runtimeFixture()
    for (const [invalid, code] of [
      [{ ...request, agentId: '' }, 'agent_identity_required'],
      [{ ...request, agentId: 'other' }, 'agent_unavailable'],
      [{ ...request, agentDid: '' }, 'agent_identity_required'],
      [{ ...request, agentDid: 'did:key:other' }, 'agent_authority_changed'],
    ] as const) await expect(service.execute(invalid)).rejects.toMatchObject({ code })
    state.agent = { ...agent, did: '' }
    await expect(service.execute(request)).rejects.toThrow(/signing identity/)
    state.agent = undefined
    await expect(service.execute(request)).rejects.toThrow(/not locally available/)
    expect(state.calls).toEqual([])
  })
  it('rejects a host returning a different Agent for the requested id', async () => {
    const { state, runtime, policy } = runtimeFixture()
    runtime.describe = async () => ({ ...agent, agentId: 'other' })
    await expect(createAgentRuntimeService(runtime, policy).execute(request)).rejects.toThrow(/not locally available/)
    expect(state.calls).toEqual([])
  })
  it('applies local policy to execution, status and cancellation, without host side effects', async () => {
    const { state, runtime } = runtimeFixture()
    const policy: AgentRuntimePolicyPort = { async authorize() { return { allowed: false, reason: 'Principal has not granted this' } } }
    const service = createAgentRuntimeService(runtime, policy)
    for (const call of [() => service.execute(request), () => service.getStatus(attempt), () => service.cancel(attempt)]) await expect(call()).rejects.toThrow(/not granted/)
    expect(state.calls).toEqual([])
  })
  it('rechecks identity after an asynchronous local approval', async () => {
    const { state, runtime } = runtimeFixture()
    const service = createAgentRuntimeService(runtime, { async authorize() { await Promise.resolve(); state.agent = { ...agent, did: 'did:key:replacement' }; return { allowed: true } } })
    await expect(service.execute(request)).rejects.toThrow(/identity has changed/)
    expect(state.calls).toEqual([])
  })
  it('requires request and attempt identifiers before asking the host', async () => {
    const { state, service } = runtimeFixture()
    await expect(service.execute({ ...request, requestId: '' })).rejects.toThrow(/requestId/)
    await expect(service.getStatus({ ...attempt, attemptId: '' })).rejects.toThrow(/attemptId/)
    await expect(service.cancel({ ...attempt, attemptId: '' })).rejects.toThrow(/attemptId/)
    expect(state.calls).toEqual([])
  })
  it('reports unsupported host capabilities and preserves host refusals', async () => {
    const { state, runtime, policy } = runtimeFixture()
    delete runtime.getStatus; delete runtime.cancel
    runtime.execute = async () => ({ accepted: false, reason: 'host permission refused' })
    const service = createAgentRuntimeService(runtime, policy)
    await expect(service.getStatus(attempt)).resolves.toMatchObject({ available: false, reason: expect.stringContaining('does not support') })
    await expect(service.cancel(attempt)).resolves.toMatchObject({ accepted: false, reason: expect.stringContaining('does not support') })
    await expect(service.execute(request)).resolves.toEqual({ accepted: false, reason: 'host permission refused' })
    expect(state.calls).toEqual([])
  })
})

describe('Connect discovery publication', () => {
  it('records the structural publication contract through the real signed OriginJournal', async () => {
    const host = createMemoryHost({ nodeId: 'bridge-node', selfAgentId: agent.agentId, did: agent.did, runtimeKind: 'a2a-bridge' })
    const { signer, verifier } = createFakeKeypair(agent.did)
    const edge = await createEdge({ ports: host.ports, descriptor: host.descriptor, signer, verifier, registerSelf: false })
    const { service } = discoveryFixture({ record: (input) => edge.journal.record(input) })
    await service.publish(publish)
    expect(edge.journal.all()).toHaveLength(1)
    expect(edge.outbox.pending()).toHaveLength(1)
    await expect(edge.verifyJournal()).resolves.toMatchObject({ unsigned: 0, forged: [] })
    edge.dispose()
  })
  it('uses explicit runtime and Agent route, including public relay routes', async () => {
    const { service, records, context } = discoveryFixture()
    await expect(service.publish(publish)).resolves.toMatchObject({ state: 'publication_queued', agentId: agent.agentId })
    expect(records[0]).toMatchObject({ visibility: 'public', issuer: { did: agent.did }, evidence: { source: 'a2a' }, payload: { runtimeKind: 'a2a-bridge', discovery: { card: { supportedInterfaces: [context.agentInterface], identity: { agentId: agent.agentId, did: agent.did } } } } })
    await service.publish({ ...publish, action: 'withdraw' })
    expect(records[1]).toMatchObject({ payload: { discovery: null } })
  })
  it('requires publication consent, enabled community, valid profile and public route', async () => {
    const { service, records, context } = discoveryFixture()
    await expect(service.publish({ ...publish, confirmPublic: false })).rejects.toThrow(/Confirm/)
    context.enabled = false
    await expect(service.publish(publish)).rejects.toThrow(/Enable/)
    context.enabled = true; context.agentInterface.url = 'https://192.168.1.2/route'
    await expect(service.publish(publish)).rejects.toThrow(/public HTTPS/)
    context.agentInterface.url = 'https://bridge.example/routes/coder'
    await expect(service.publish({ ...publish, representativeQueries: [] })).rejects.toThrow(/query examples/)
    expect(records).toEqual([])
  })
  it('refuses unsigned publication and malformed search results without executing anything', async () => {
    await expect(discoveryFixture({ record: async () => ({ id: 'unsigned', evidence: {} }) }).service.publish(publish)).rejects.toThrow(/could not be signed/)
    await expect(discoveryFixture({ requestSearch: async () => ({ registry: 'https://community.example', response: { results: [{}] } }) }).service.search(agent.agentId, { query: { text: 'review' } })).rejects.toThrow(/invalid ARD/)
    const { service, records } = discoveryFixture()
    await expect(service.search(agent.agentId, { query: { text: 'review' } })).resolves.toMatchObject({ kind: 'discovery.results', ownAgentId: agent.agentId })
    expect(records).toEqual([])
  })
})

describe('Connect conversation compatibility', () => {
  it('selects exact identity pairs from current host state and rechecks permission', () => {
    const thread: ConversationEntry & { binding: { sessionId: string } } = { conversationId: 'thread', localAgentId: agent.agentId, localAgentAuthorityDid: agent.did, peerAgentId: 'peer', peerAgentAuthorityDid: 'did:key:peer', state: 'accepted', active: true, binding: { sessionId: 'host-owned' } }
    let permission = 'allowed'
    let threads: Record<string, typeof thread> = { thread }
    const service = createConversationService({ conversations: () => threads, pairState: () => permission })
    const target = { fromAgent: agent, toAgentId: 'peer', toAgentDid: 'did:key:peer' }
    expect(service.select(target)?.binding.sessionId).toBe('host-owned')
    permission = 'revoked'
    expect(() => service.assertCanSend(target)).toThrow(/reauthorization/)
    permission = 'allowed'; threads = { thread: { ...thread, peerAgentAuthorityDid: 'did:key:replacement' } }
    expect(() => service.assertCanSend({ ...target, conversationId: 'thread' })).toThrow(/mismatch/)
    expect(() => assertAgentSigner({ signer: 'did:key:node' }, agent)).toThrow(/signing_failed/)
  })
})

// Only host translations differ. No discovery/conversation/execution policy is
// copied into either host, and no DSH or network package is imported by Connect.
for (const kind of ['session-runtime', 'a2a-bridge'] as const) describe(`Connect host conformance: ${kind}`, () => {
  it('runs the same discover, publish, communicate and execute flow through host ports', async () => {
    const { runtime, policy, state } = runtimeFixture()
    const wireCalls: unknown[] = []
    runtime.execute = async (input) => {
      state.calls.push('execute')
      wireCalls.push(kind === 'session-runtime' ? { sessionAgent: input.agentId, content: input.input } : { jsonrpc: '2.0', method: 'SendMessage', params: { message: input.input } })
      return { accepted: true, attemptId: attempt.attemptId }
    }
    const service = createAgentRuntimeService(runtime, policy)
    const discovery = discoveryFixture({ selectedAgent: (id) => service.selectedAgent(id), publicationContext: async () => ({ enabled: true, nodeId: `${kind}-node`, runtimeKind: kind, version: '1.0', agentInterface: { url: `https://${kind}.example/agent/coder`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' } }) })
    expect((await service.enumerate())[0]?.agentId).toBe(agent.agentId)
    await discovery.service.publish(publish)
    await discovery.service.search(agent.agentId, { query: { text: 'review' } })
    expect(state.calls).toEqual([])
    await expect(service.execute(request)).resolves.toMatchObject({ accepted: true })
    await expect(service.getStatus(attempt)).resolves.toMatchObject({ available: true, state: 'completed' })
    await expect(service.cancel(attempt)).resolves.toMatchObject({ accepted: true })
    expect(wireCalls).toHaveLength(1)
    expect(state.calls).toEqual(['execute', 'status', 'cancel'])
    expect(discovery.records[0]).toMatchObject({ payload: { runtimeKind: kind } })
  })
})
