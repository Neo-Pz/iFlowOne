/**
 * JSON Schema (draft 2020-12) for the two envelopes.
 *
 * Published so the Web app, the adapter, and any future Community service
 * validate against one artifact instead of three hand-written copies. The
 * runtime validator in `validate.ts` is the fast path; these documents are the
 * interoperable statement of the same contract.
 */

export const IFLOW_EVENT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://iflowone.cn/schema/iflow-event.json',
  title: 'IFlowEvent',
  type: 'object',
  required: ['id', 'schemaVersion', 'origin', 'occurredAt', 'correlationId', 'type', 'issuer', 'subject', 'payload'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    schemaVersion: { type: 'integer', minimum: 1 },
    origin: {
      type: 'object',
      required: ['nodeId', 'streamId', 'seq'],
      additionalProperties: false,
      properties: {
        nodeId: { type: 'string', minLength: 1 },
        streamId: { type: 'string', minLength: 1 },
        seq: { type: 'integer', minimum: 0 },
      },
    },
    journalOffset: { type: 'integer', minimum: 0 },
    occurredAt: { type: 'string', format: 'date-time' },
    observedAt: { type: 'string', format: 'date-time' },
    correlationId: { type: 'string', minLength: 1 },
    causationId: { type: 'string', minLength: 1 },
    type: { type: 'string', minLength: 1 },
    issuer: {
      type: 'object',
      required: ['id', 'kind'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        did: { type: 'string', minLength: 1 },
        kind: { enum: ['agent', 'human', 'system'] },
      },
    },
    subject: {
      type: 'object',
      required: ['kind', 'id'],
      additionalProperties: false,
      properties: {
        kind: { enum: ['agent', 'goal', 'task', 'room', 'artifact'] },
        id: { type: 'string', minLength: 1 },
      },
    },
    goalId: { type: 'string', minLength: 1 },
    taskId: { type: 'string', minLength: 1 },
    roomId: { type: 'string', minLength: 1 },
    trace: {
      type: 'object',
      additionalProperties: false,
      properties: {
        traceId: { type: 'string' },
        spanId: { type: 'string' },
        parentSpanId: { type: 'string' },
      },
    },
    payload: {},
    evidence: {
      type: 'object',
      required: ['source'],
      additionalProperties: false,
      properties: {
        source: { enum: ['dsh', 'a2a', 'user', 'projection'] },
        signature: { type: 'string' },
      },
    },
  },
} as const

export const IFLOW_COMMAND_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://iflowone.cn/schema/iflow-command.json',
  title: 'IFlowCommand',
  type: 'object',
  required: ['commandId', 'idempotencyKey', 'issuer', 'target', 'requestedAction', 'expiresAt', 'correlationId'],
  additionalProperties: false,
  properties: {
    commandId: { type: 'string', minLength: 1 },
    idempotencyKey: { type: 'string', minLength: 1 },
    issuer: {
      type: 'object',
      required: ['id'],
      additionalProperties: false,
      properties: { id: { type: 'string', minLength: 1 }, did: { type: 'string', minLength: 1 } },
    },
    target: {
      type: 'object',
      required: ['nodeId'],
      additionalProperties: false,
      properties: {
        nodeId: { type: 'string', minLength: 1 },
        agentId: { type: 'string', minLength: 1 },
        taskId: { type: 'string', minLength: 1 },
      },
    },
    requestedAction: { type: 'string', minLength: 1 },
    grantRef: { type: 'string', minLength: 1 },
    budgetConstraint: {},
    expiresAt: { type: 'string', format: 'date-time' },
    correlationId: { type: 'string', minLength: 1 },
    causationId: { type: 'string', minLength: 1 },
  },
} as const
