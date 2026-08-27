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
  required: [
    'id',
    'schemaVersion',
    'origin',
    'occurredAt',
    'correlationId',
    'type',
    'issuer',
    'subject',
    'payload',
  ],
  additionalProperties: false,
  allOf: [
    {
      if: {
        required: ['schemaVersion'],
        properties: { schemaVersion: { minimum: 2 } },
      },
      then: { required: ['visibility'] },
    },
  ],
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
    principalId: { type: 'string', minLength: 1 },
    visibility: { enum: ['local', 'public'] },
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
        kind: { enum: ['agent', 'goal', 'task', 'room', 'artifact', 'conversation', 'principal', 'publication'] },
        id: { type: 'string', minLength: 1 },
      },
    },
    goalId: { type: 'string', minLength: 1 },
    taskId: { type: 'string', minLength: 1 },
    roomId: { type: 'string', minLength: 1 },
    conversationId: { type: 'string', minLength: 1 },
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

const PRIVATE_ROUTING_STRING = { type: 'string', minLength: 1 } as const

export const ENCRYPTED_INTENT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://iflowone.cn/schema/encrypted-intent.json',
  title: 'EncryptedIntentEnvelope',
  type: 'object',
  required: ['version', 'kind', 'routing', 'sealed'],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    kind: { const: 'human.intent' },
    routing: {
      type: 'object',
      required: [
        'intentId',
        'principalId',
        'toAgentId',
        'toAgentAuthorityDid',
        'browserSessionId',
        'viewPublicKey',
        'issuedAt',
        'expiresAt',
      ],
      additionalProperties: false,
      properties: {
        intentId: PRIVATE_ROUTING_STRING,
        principalId: PRIVATE_ROUTING_STRING,
        toAgentId: PRIVATE_ROUTING_STRING,
        toAgentAuthorityDid: PRIVATE_ROUTING_STRING,
        conversationId: PRIVATE_ROUTING_STRING,
        browserSessionId: PRIVATE_ROUTING_STRING,
        viewPublicKey: PRIVATE_ROUTING_STRING,
        issuedAt: { type: 'string', format: 'date-time' },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
    sealed: PRIVATE_ROUTING_STRING,
  },
} as const

export const CONVERSATION_MESSAGE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://iflowone.cn/schema/conversation-message.json',
  title: 'ConversationMessageEnvelope',
  type: 'object',
  required: ['version', 'kind', 'message', 'signature'],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    kind: { const: 'agent.message' },
    message: {
      type: 'object',
      required: [
        'messageId',
        'conversationId',
        'fromAgentId',
        'fromAgentAuthorityDid',
        'fromLabel',
        'toAgentId',
        'toAgentAuthorityDid',
        'contentOrigin',
        'issuedAt',
        'contentDigest',
        'payload',
      ],
      additionalProperties: false,
      properties: {
        messageId: PRIVATE_ROUTING_STRING,
        conversationId: PRIVATE_ROUTING_STRING,
        fromAgentId: PRIVATE_ROUTING_STRING,
        fromAgentAuthorityDid: PRIVATE_ROUTING_STRING,
        fromLabel: PRIVATE_ROUTING_STRING,
        toAgentId: PRIVATE_ROUTING_STRING,
        toAgentAuthorityDid: PRIVATE_ROUTING_STRING,
        contentOrigin: { enum: ['human', 'agent'] },
        originIntentId: PRIVATE_ROUTING_STRING,
        issuedAt: { type: 'string', format: 'date-time' },
        expiresAt: { type: 'string', format: 'date-time' },
        contentDigest: PRIVATE_ROUTING_STRING,
        payload: {},
      },
    },
    signature: {
      type: 'object',
      required: ['alg', 'signerDid', 'value'],
      additionalProperties: false,
      properties: {
        alg: { const: 'EdDSA' },
        signerDid: PRIVATE_ROUTING_STRING,
        value: PRIVATE_ROUTING_STRING,
      },
    },
  },
} as const

export const PRIVATE_BROWSER_VIEW_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://iflowone.cn/schema/private-browser-view.json',
  title: 'PrivateBrowserViewEnvelope',
  type: 'object',
  required: ['version', 'kind', 'routing', 'sealed'],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    kind: { const: 'browser.view' },
    routing: {
      type: 'object',
      required: [
        'deliveryId',
        'intentId',
        'principalId',
        'browserSessionId',
        'viewKeyId',
        'issuedAt',
        'expiresAt',
      ],
      additionalProperties: false,
      properties: {
        deliveryId: PRIVATE_ROUTING_STRING,
        intentId: PRIVATE_ROUTING_STRING,
        principalId: PRIVATE_ROUTING_STRING,
        browserSessionId: PRIVATE_ROUTING_STRING,
        viewKeyId: PRIVATE_ROUTING_STRING,
        conversationId: PRIVATE_ROUTING_STRING,
        ownAgentId: PRIVATE_ROUTING_STRING,
        issuedAt: { type: 'string', format: 'date-time' },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
    sealed: PRIVATE_ROUTING_STRING,
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
