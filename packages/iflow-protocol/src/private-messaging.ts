/**
 * Private Web interaction contracts.
 *
 * These three envelopes deliberately represent different authority steps:
 * a Human asks its own Agent, that Agent may make a signed network statement,
 * and the local Agent may project a human-readable view back to one browser.
 */

import type { IFlowSignature } from './envelope.js'

export const PRIVATE_MESSAGE_ENVELOPE_VERSION = 1 as const

/** Metadata bound as AEAD additional data when a browser seals an Intent. */
export interface EncryptedIntentRouting {
  intentId: string
  principalId: string
  toAgentDid: string
  conversationId?: string
  browserSessionId: string
  viewPublicKey: string
  issuedAt: string
  expiresAt: string
}

/** A Human request to its own Agent. It is not an Agent statement. */
export interface EncryptedIntentEnvelope {
  version: typeof PRIVATE_MESSAGE_ENVELOPE_VERSION
  kind: 'human.intent'
  routing: EncryptedIntentRouting
  /** Opaque base64url ciphertext. Community must never parse the plaintext. */
  sealed: string
}

/** The signed bytes for an Agent-to-Agent conversation message. */
export interface ConversationMessage {
  messageId: string
  conversationId: string
  fromAgentDid: string
  toAgentDid: string
  issuedAt: string
  expiresAt?: string
  /** Digest only; plaintext travels inside the encrypted transport payload. */
  contentDigest: string
  payload: unknown
}

/** An Agent has assumed responsibility for this network message. */
export interface ConversationMessageEnvelope {
  version: typeof PRIVATE_MESSAGE_ENVELOPE_VERSION
  kind: 'agent.message'
  message: ConversationMessage
  signature: IFlowSignature
}

/** Metadata bound when an Agent seals a private projection to one browser. */
export interface PrivateBrowserViewRouting {
  deliveryId: string
  intentId: string
  principalId: string
  browserSessionId: string
  viewKeyId: string
  issuedAt: string
  expiresAt: string
}

/** A private, ephemeral Human view. It is not a server-side transcript. */
export interface PrivateBrowserViewEnvelope {
  version: typeof PRIVATE_MESSAGE_ENVELOPE_VERSION
  kind: 'browser.view'
  routing: PrivateBrowserViewRouting
  /** Opaque base64url ciphertext addressed to the current browser view key. */
  sealed: string
}
