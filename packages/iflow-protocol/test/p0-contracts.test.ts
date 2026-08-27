import { describe, expect, it } from 'vitest'

import {
  EVENT_SCHEMA_VERSION,
  PRIVATE_MESSAGE_ENVELOPE_VERSION,
  validateConversationMessageEnvelope,
  validateEncryptedIntent,
  validateEvent,
  validatePrivateBrowserView,
} from '../src/index.js'
import { IFLOW_EVENT_SCHEMA } from '../src/json-schema.js'

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'evt-1',
    schemaVersion: EVENT_SCHEMA_VERSION,
    origin: { nodeId: 'node-1', streamId: 'edge', seq: 1 },
    occurredAt: '2026-01-01T00:00:00.000Z',
    correlationId: 'corr-1',
    visibility: 'local',
    type: 'task.created',
    issuer: { id: 'agent-1', kind: 'agent' },
    subject: { kind: 'task', id: 'task-1' },
    payload: { title: 'One' },
    ...overrides,
  }
}

describe('P0 event visibility', () => {
  it('publishes a JSON Schema that requires visibility only for v2+', () => {
    expect(IFLOW_EVENT_SCHEMA.required).not.toContain('visibility')
    expect(IFLOW_EVENT_SCHEMA.allOf[0]?.then.required).toContain('visibility')
    expect(IFLOW_EVENT_SCHEMA.properties).toHaveProperty('conversationId')
  })

  it('requires visibility on schema v2 facts', () => {
    const candidate = event()
    delete candidate['visibility']
    expect(validateEvent(candidate)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([{ path: 'visibility', message: expect.any(String) }]),
    })
  })

  it('keeps schema v1 facts readable for journal migration', () => {
    const candidate = event({ schemaVersion: 1 })
    delete candidate['visibility']
    expect(validateEvent(candidate).valid).toBe(true)
  })

  it('rejects an invented visibility', () => {
    expect(validateEvent(event({ visibility: 'friends' })).valid).toBe(false)
  })
})

describe('private interaction envelopes', () => {
  it('accepts a Human-to-own-Agent encrypted Intent', () => {
    const result = validateEncryptedIntent({
      version: PRIVATE_MESSAGE_ENVELOPE_VERSION,
      kind: 'human.intent',
      routing: {
        intentId: 'intent-1',
        principalId: 'iflow:principal:alice',
        toAgentId: 'agent-a',
        toAgentAuthorityDid: 'did:key:zAgentA',
        browserSessionId: 'session-1',
        viewPublicKey: 'view-key-1',
        issuedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T00:05:00.000Z',
      },
      sealed: 'opaque-base64url',
    })
    expect(result).toEqual({ valid: true, issues: [] })
  })

  it('rejects an expired-at-creation Intent', () => {
    const result = validateEncryptedIntent({
      version: 1,
      kind: 'human.intent',
      routing: {
        intentId: 'intent-1',
        principalId: 'iflow:principal:alice',
        toAgentId: 'agent-a',
        toAgentAuthorityDid: 'did:key:zAgentA',
        browserSessionId: 'session-1',
        viewPublicKey: 'view-key-1',
        issuedAt: '2026-01-01T00:05:00.000Z',
        expiresAt: '2026-01-01T00:00:00.000Z',
      },
      sealed: 'opaque-base64url',
    })
    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual({
      path: 'routing.expiresAt',
      message: 'must be later than routing.issuedAt',
    })
  })

  it('keeps an Agent message distinct and signed', () => {
    const result = validateConversationMessageEnvelope({
      version: 1,
      kind: 'agent.message',
      message: {
        messageId: 'msg-1',
        conversationId: 'conv-1',
        fromAgentId: 'agent-a',
        fromAgentAuthorityDid: 'did:key:zAgentA',
        fromLabel: 'Agent A',
        toAgentId: 'agent-b',
        toAgentAuthorityDid: 'did:key:zAgentB',
        contentOrigin: 'human',
        originIntentId: 'intent-1',
        issuedAt: '2026-01-01T00:00:00.000Z',
        contentDigest: 'sha256:deadbeef',
        payload: { parts: [] },
      },
      signature: { alg: 'EdDSA', signerDid: 'did:key:zAgentA', value: 'signature' },
    })
    expect(result).toEqual({ valid: true, issues: [] })
  })

  it('binds a Browser View to one Principal session and view key', () => {
    const result = validatePrivateBrowserView({
      version: 1,
      kind: 'browser.view',
      routing: {
        deliveryId: 'delivery-1',
        intentId: 'intent-1',
        principalId: 'iflow:principal:alice',
        browserSessionId: 'session-1',
        viewKeyId: 'view-key-1',
        conversationId: 'conv-1',
        ownAgentId: 'agent-a',
        issuedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T00:05:00.000Z',
      },
      sealed: 'opaque-base64url',
    })
    expect(result).toEqual({ valid: true, issues: [] })
  })

  it('rejects a conversation message that conflates logical Agent identity with its authority key', () => {
    const result = validateConversationMessageEnvelope({
      version: 1,
      kind: 'agent.message',
      message: {
        messageId: 'msg-1',
        conversationId: 'conv-1',
        fromAgentDid: 'did:key:zAgentA',
        toAgentDid: 'did:key:zAgentB',
        issuedAt: '2026-01-01T00:00:00.000Z',
        contentDigest: 'sha256:deadbeef',
        payload: {},
      },
      signature: { alg: 'EdDSA', signerDid: 'did:key:zAgentA', value: 'signature' },
    })
    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual({ path: 'message.fromAgentId', message: 'is required' })
  })
})
