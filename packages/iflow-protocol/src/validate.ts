/**
 * Envelope validation — structure only.
 *
 * This layer answers "is this a well-formed IFlowEvent?", never "is this a
 * legal domain fact?". The `type` vocabulary and payload rules belong to
 * `iflow-domain`, which validates on top of this.
 *
 * Hand-rolled rather than schema-library-driven: this package gets bundled into
 * the DSH plugin by esbuild, so it must stay dependency-free.
 */

import type { IFlowCommand, IFlowEvent } from './envelope.js'
import type {
  ConversationMessageEnvelope,
  EncryptedIntentEnvelope,
  PrivateBrowserViewEnvelope,
} from './private-messaging.js'

export interface ValidationIssue {
  path: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  issues: ValidationIssue[]
}

const ISSUER_KINDS = new Set(['agent', 'human', 'system'])
const SUBJECT_KINDS = new Set(['agent', 'goal', 'task', 'room', 'artifact', 'conversation'])
const EVIDENCE_SOURCES = new Set(['dsh', 'a2a', 'user', 'projection'])
const VISIBILITIES = new Set(['local', 'public'])

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

class Check {
  readonly issues: ValidationIssue[] = []

  fail(path: string, message: string): void {
    this.issues.push({ path, message })
  }

  string(value: unknown, path: string, { required = true } = {}): void {
    if (value === undefined) {
      if (required) this.fail(path, 'is required')
      return
    }
    if (typeof value !== 'string' || value.length === 0) this.fail(path, 'must be a non-empty string')
  }

  timestamp(value: unknown, path: string, { required = true } = {}): void {
    if (value === undefined) {
      if (required) this.fail(path, 'is required')
      return
    }
    if (typeof value !== 'string' || !ISO_8601.test(value)) {
      this.fail(path, 'must be an ISO-8601 timestamp with an explicit offset')
    }
  }

  enum(value: unknown, path: string, allowed: Set<string>): void {
    if (typeof value !== 'string' || !allowed.has(value)) {
      this.fail(path, `must be one of ${[...allowed].join(' | ')}`)
    }
  }

  object(value: unknown, path: string): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.fail(path, 'must be an object')
      return false
    }
    return true
  }
}

export function validateEvent(candidate: unknown): ValidationResult {
  const check = new Check()
  if (!check.object(candidate, '')) return { valid: false, issues: check.issues }
  const event = candidate as Partial<IFlowEvent>

  check.string(event.id, 'id')
  check.string(event.type, 'type')
  check.string(event.correlationId, 'correlationId')
  check.string(event.causationId, 'causationId', { required: false })
  check.string(event.principalId, 'principalId', { required: false })
  check.timestamp(event.occurredAt, 'occurredAt')
  check.timestamp(event.observedAt, 'observedAt', { required: false })

  if (typeof event.schemaVersion !== 'number' || !Number.isInteger(event.schemaVersion) || event.schemaVersion < 1) {
    check.fail('schemaVersion', 'must be a positive integer')
  }

  // v1 did not carry visibility. It remains readable for migration, but every
  // v2+ fact must make the local/public decision inside the signed envelope.
  if ((event.schemaVersion ?? 0) >= 2 || event.visibility !== undefined) {
    check.enum(event.visibility, 'visibility', VISIBILITIES)
  }

  if (check.object(event.origin, 'origin')) {
    const origin = event.origin as Record<string, unknown>
    check.string(origin['nodeId'], 'origin.nodeId')
    check.string(origin['streamId'], 'origin.streamId')
    if (typeof origin['seq'] !== 'number' || !Number.isInteger(origin['seq']) || (origin['seq'] as number) < 0) {
      check.fail('origin.seq', 'must be a non-negative integer')
    }
  }

  if (event.journalOffset !== undefined) {
    if (!Number.isInteger(event.journalOffset) || event.journalOffset < 0) {
      check.fail('journalOffset', 'must be a non-negative integer when present')
    }
  }

  if (check.object(event.issuer, 'issuer')) {
    const issuer = event.issuer as Record<string, unknown>
    check.string(issuer['id'], 'issuer.id')
    check.string(issuer['did'], 'issuer.did', { required: false })
    check.enum(issuer['kind'], 'issuer.kind', ISSUER_KINDS)
  }

  if (check.object(event.subject, 'subject')) {
    const subject = event.subject as Record<string, unknown>
    check.string(subject['id'], 'subject.id')
    check.enum(subject['kind'], 'subject.kind', SUBJECT_KINDS)
  }

  for (const key of ['goalId', 'taskId', 'roomId', 'conversationId'] as const) {
    check.string(event[key], key, { required: false })
  }

  if (event.evidence !== undefined && check.object(event.evidence, 'evidence')) {
    const evidence = event.evidence as Record<string, unknown>
    check.enum(evidence['source'], 'evidence.source', EVIDENCE_SOURCES)
    check.string(evidence['signature'], 'evidence.signature', { required: false })
  }

  if (!('payload' in (event as object))) check.fail('payload', 'is required')

  return { valid: check.issues.length === 0, issues: check.issues }
}

export function validateCommand(candidate: unknown): ValidationResult {
  const check = new Check()
  if (!check.object(candidate, '')) return { valid: false, issues: check.issues }
  const command = candidate as Partial<IFlowCommand>

  check.string(command.commandId, 'commandId')
  check.string(command.idempotencyKey, 'idempotencyKey')
  check.string(command.requestedAction, 'requestedAction')
  check.string(command.correlationId, 'correlationId')
  check.string(command.causationId, 'causationId', { required: false })
  check.string(command.grantRef, 'grantRef', { required: false })
  check.timestamp(command.expiresAt, 'expiresAt')

  if (check.object(command.issuer, 'issuer')) {
    const issuer = command.issuer as Record<string, unknown>
    check.string(issuer['id'], 'issuer.id')
    check.string(issuer['did'], 'issuer.did', { required: false })
  }

  if (check.object(command.target, 'target')) {
    const target = command.target as Record<string, unknown>
    check.string(target['nodeId'], 'target.nodeId')
    check.string(target['agentId'], 'target.agentId', { required: false })
    check.string(target['taskId'], 'target.taskId', { required: false })
  }

  return { valid: check.issues.length === 0, issues: check.issues }
}

function checkPrivateRouting(
  check: Check,
  routing: unknown,
  required: readonly string[],
  timestamps: readonly string[],
): routing is Record<string, unknown> {
  if (!check.object(routing, 'routing')) return false
  for (const key of required) check.string(routing[key], `routing.${key}`)
  for (const key of timestamps) check.timestamp(routing[key], `routing.${key}`)

  const issuedAt = routing['issuedAt']
  const expiresAt = routing['expiresAt']
  if (
    typeof issuedAt === 'string' &&
    typeof expiresAt === 'string' &&
    ISO_8601.test(issuedAt) &&
    ISO_8601.test(expiresAt) &&
    Date.parse(expiresAt) <= Date.parse(issuedAt)
  ) {
    check.fail('routing.expiresAt', 'must be later than routing.issuedAt')
  }
  return true
}

export function validateEncryptedIntent(candidate: unknown): ValidationResult {
  const check = new Check()
  if (!check.object(candidate, '')) return { valid: false, issues: check.issues }
  const envelope = candidate as Partial<EncryptedIntentEnvelope>

  if (envelope.version !== 1) check.fail('version', 'must be 1')
  if (envelope.kind !== 'human.intent') check.fail('kind', 'must be human.intent')
  checkPrivateRouting(
    check,
    envelope.routing,
    ['intentId', 'principalId', 'toAgentDid', 'browserSessionId', 'viewPublicKey'],
    ['issuedAt', 'expiresAt'],
  )
  check.string(envelope.sealed, 'sealed')
  return { valid: check.issues.length === 0, issues: check.issues }
}

export function validateConversationMessageEnvelope(candidate: unknown): ValidationResult {
  const check = new Check()
  if (!check.object(candidate, '')) return { valid: false, issues: check.issues }
  const envelope = candidate as Partial<ConversationMessageEnvelope>

  if (envelope.version !== 1) check.fail('version', 'must be 1')
  if (envelope.kind !== 'agent.message') check.fail('kind', 'must be agent.message')
  if (check.object(envelope.message, 'message')) {
    const message = envelope.message as unknown as Record<string, unknown>
    for (const key of ['messageId', 'conversationId', 'fromAgentDid', 'toAgentDid', 'contentDigest']) {
      check.string(message[key], `message.${key}`)
    }
    check.timestamp(message['issuedAt'], 'message.issuedAt')
    check.timestamp(message['expiresAt'], 'message.expiresAt', { required: false })
    if (!('payload' in message)) check.fail('message.payload', 'is required')
  }
  if (check.object(envelope.signature, 'signature')) {
    const signature = envelope.signature as unknown as Record<string, unknown>
    if (signature['alg'] !== 'EdDSA') check.fail('signature.alg', 'must be EdDSA')
    check.string(signature['signerDid'], 'signature.signerDid')
    check.string(signature['value'], 'signature.value')
  }
  return { valid: check.issues.length === 0, issues: check.issues }
}

export function validatePrivateBrowserView(candidate: unknown): ValidationResult {
  const check = new Check()
  if (!check.object(candidate, '')) return { valid: false, issues: check.issues }
  const envelope = candidate as Partial<PrivateBrowserViewEnvelope>

  if (envelope.version !== 1) check.fail('version', 'must be 1')
  if (envelope.kind !== 'browser.view') check.fail('kind', 'must be browser.view')
  checkPrivateRouting(
    check,
    envelope.routing,
    ['deliveryId', 'intentId', 'principalId', 'browserSessionId', 'viewKeyId'],
    ['issuedAt', 'expiresAt'],
  )
  check.string(envelope.sealed, 'sealed')
  return { valid: check.issues.length === 0, issues: check.issues }
}

/** Throwing wrapper for call sites where an invalid envelope is a bug, not input. */
export function assertValidEvent(candidate: unknown): asserts candidate is IFlowEvent {
  const result = validateEvent(candidate)
  if (!result.valid) {
    throw new Error(`invalid IFlowEvent: ${result.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`)
  }
}
