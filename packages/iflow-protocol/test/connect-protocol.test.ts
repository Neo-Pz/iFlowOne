import { describe, expect, it } from 'vitest'
const { agentRef, parseAgentRef } = await import(process.env.IFLOW_TEST_AGENT_REF || '../src/agent-ref.js') as typeof import('../src/agent-ref.js')
const { messageText, partsText, taskText, rpcResult, rpcError, rpcException, errorInfo, TERMINAL_TASK_STATES } = await import(process.env.IFLOW_TEST_A2A_PROTOCOL || '../src/a2a.js') as typeof import('../src/a2a.js')

describe('portable network addressing and A2A projections', () => {
  it('distinguishes same local names on different nodes without changing signed ids', () => {
    const first = agentRef('node:alpha/one', 'coder:%/编码')
    expect(first).not.toBe(agentRef('node:beta/one', 'coder:%/编码'))
    expect(parseAgentRef(first)).toEqual({ nodeId: 'node:alpha/one', agentId: 'coder:%/编码' })
    expect(() => agentRef('', 'coder')).toThrow(/requires/)
    for (const invalid of ['coder', 'iflow:agent:one:two:three', 'iflow:agent:one:%ZZ', 'iflow:agent:one:%74wo']) expect(parseAgentRef(invalid)).toBeUndefined()
  })
  it('keeps RPC errors and artifact-first text semantics independent of a host', () => {
    expect(rpcResult(1, { task: 'one' })).toEqual({ jsonrpc: '2.0', id: 1, result: { task: 'one' } })
    expect(rpcError(undefined, -32602, 'invalid')).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32602, message: 'invalid' } })
    expect(rpcException(400, 'denied', errorInfo('DENIED'))).toMatchObject({ rpcCode: 400, rpcData: [{ reason: 'DENIED', domain: 'a2a-protocol.org' }] })
    expect(partsText([{ text: 'one' }, { data: { value: 2 } }, { url: 'https://example.com' }, null])).toBe('one\n{"value":2}\nhttps://example.com')
    expect(messageText({ parts: [{ text: 'hello' }] })).toBe('hello')
    expect(messageText(undefined)).toBe('')
    const terminal = { state: 'TASK_STATE_REJECTED', message: { parts: [{ text: 'Permission denied' }] } }
    expect(TERMINAL_TASK_STATES.has(terminal.state)).toBe(true)
    expect(taskText({ status: terminal })).toBe('Permission denied')
    expect(taskText({ artifacts: [{ parts: [{ text: 'delivery' }] }], status: terminal })).toBe('delivery')
  })
})
