import { expect, it } from 'vitest'
import { applyEvent, emptyNetworkState } from '../src/reducers/network-state.js'
import type { AnyIFlowEvent } from '../src/event-types.js'

it('preserves an explicit discovery profile across folds without sharing mutable card fields', () => {
  const profile = { description: 'Public profile', representativeQueries: ['Review code', 'Explain errors'], tags: ['code'], card: { name: 'Reviewer', description: 'Public profile', version: '1', supportedInterfaces: [], capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false }, defaultInputModes: [], defaultOutputModes: [], skills: [], identity: { did: 'did:key:test', agentId: 'agent-a' } } }
  const event = { id: 'registration', schemaVersion: 2, origin: { nodeId: 'node-a', streamId: 'edge', seq: 1 }, occurredAt: '2026-10-02T00:00:00.000Z', correlationId: 'correlation', visibility: 'public', type: 'agent.registered', issuer: { kind: 'agent', id: 'agent-a', did: 'did:key:test' }, subject: { kind: 'agent', id: 'agent-a' }, payload: { label: 'Reviewer', nodeId: 'node-a', runtimeKind: 'test', capabilities: [], did: 'did:key:test', discovery: profile } } as AnyIFlowEvent
  const first = applyEvent(emptyNetworkState(), event)
  profile.tags.push('input mutation')
  expect(first.agents['agent-a']?.discovery?.tags).toEqual(['code'])
  const second = applyEvent(first, { ...event, id: 'next', payload: { ...event.payload, discovery: undefined } } as AnyIFlowEvent)
  second.agents['agent-a']!.discovery!.representativeQueries.push('fold mutation')
  expect(first.agents['agent-a']?.discovery?.representativeQueries).toHaveLength(2)
  const replacement = applyEvent(first, { ...event, id: 'replacement', issuer: { kind: 'agent', id: 'agent-a', did: 'did:key:replacement' }, payload: { ...event.payload, did: 'did:key:replacement', discovery: undefined } } as AnyIFlowEvent)
  expect(replacement.agents['agent-a']?.discovery).toBeNull()
  expect(replacement.agents['agent-a']?.did).toBe('did:key:replacement')
  const withdrawn = applyEvent(second, { ...event, id: 'withdraw', payload: { ...event.payload, discovery: null } } as AnyIFlowEvent)
  expect(withdrawn.agents['agent-a']?.discovery).toBeNull()
})
