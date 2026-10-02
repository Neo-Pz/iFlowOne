/**
 * Private Web interaction contracts.
 *
 * These three envelopes deliberately represent different authority steps:
 * a Human asks its own Agent, that Agent may make a signed network statement,
 * and the local Agent may project a human-readable view back to one browser.
 */

import type { IFlowSignature } from './envelope.js'
import type { DiscoverySearchIntent, DiscoverySearchView, DiscoveryErrorView } from './ard.js'

export type AgentIntent = ConversationIntent | DiscoverySearchIntent
export type AgentPrivateView = ConversationPrivateView | DiscoverySearchView | DiscoveryErrorView

export const PRIVATE_MESSAGE_ENVELOPE_VERSION = 1 as const

export type ConversationMode = 'direct' | 'assisted'
export type ConversationContentOrigin = 'human' | 'agent'

/** Plaintext that exists only inside a Human -> own Agent sealed Intent. */
export type ConversationIntent =
  | {
      version: 1
      kind: 'conversation.send'
      mode: ConversationMode
      targetAgentId: string
      targetAgentAuthorityDid: string
      text: string
      conversationId?: string
    }
  | {
      version: 1
      kind: 'conversation.sync'
      ownAgentId: string
      peerAgentId?: string
      /** Distinguishes peers using the same local name on different platforms. */
      peerAgentAuthorityDid?: string
      conversationId?: string
      cursor?: string
      limit?: number
    }
  | {
      version: 1
      kind: 'conversation.draft.decide'
      conversationId: string
      draftId: string
      decision: 'confirm' | 'cancel'
    }

export interface ConversationViewMessage {
  messageId: string
  conversationId: string
  authorAgentId?: string
  authorLabel: string
  contentOrigin: ConversationContentOrigin
  role: 'human' | 'agent' | 'system'
  text: string
  createdAt: string
  state?: ConversationUiState
}

/** Private metadata only; message text remains in the local DSH Session. */
export interface ConversationListItem {
  conversationId: string
  peerAgentId: string
  peerAgentAuthorityDid?: string
  peerLabel: string
  mode: ConversationMode
  state: string
  updatedAt: string
}

/** Plaintext projection sealed to one browser view key. */
export type ConversationPrivateView =
  | {
      version: 1
      kind: 'conversation.list'
      ownAgentId: string
      conversations: ConversationListItem[]
      nextCursor?: string
    }
  | { version: 1; kind: 'conversation.bound'; conversationId: string; peerAgentId: string }
  | { version: 1; kind: 'conversation.message'; conversationId: string; message: ConversationViewMessage }
  | {
      version: 1
      kind: 'conversation.snapshot'
      conversationId: string
      messages: ConversationViewMessage[]
      previousCursor?: string
      nextCursor?: string
    }
  | { version: 1; kind: 'conversation.draft'; conversationId: string; draftId: string; text: string }
  | {
      version: 1
      kind: 'conversation.status'
      conversationId: string
      messageId?: string
      state: ConversationUiState
      code?: string
    }

export type ConversationDeliveryState =
  | 'intent.sealed'
  | 'intent.relay_queued'
  | 'intent.node_claimed'
  | 'intent.policy_accepted'
  | 'message.draft_pending'
  | 'message.signed'
  | 'message.relay_queued'
  | 'message.remote_delivered'
  | 'conversation.pending_approval'
  | 'conversation.accepted'
  | 'message.processed'
  | 'reply.signed'
  | 'reply.delivered'
  | 'policy.denied'
  | 'delivery.failed'

/** Small state vocabulary rendered by Web and DSH; protocol keeps the detailed state above. */
export type ConversationUiState =
  | 'waiting_for_own_agent'
  | 'draft_pending'
  | 'sending'
  | 'delivered'
  | 'waiting_for_peer_approval'
  | 'accepted'
  | 'cancelled'
  | 'failed'

/** Metadata bound as AEAD additional data when a browser seals an Intent. */
export interface EncryptedIntentRouting {
  intentId: string
  principalId: string
  /** Stable logical Agent identity selected by the authenticated Principal. */
  toAgentId: string
  /** Current key authority used to seal the Intent; it may rotate without changing toAgentId. */
  toAgentAuthorityDid: string
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
  fromAgentId: string
  fromAgentAuthorityDid: string
  fromLabel: string
  toAgentId: string
  toAgentAuthorityDid: string
  contentOrigin: ConversationContentOrigin
  originIntentId?: string
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
  /** Present for conversation-specific views; keeps simultaneous tabs isolated. */
  conversationId?: string
  ownAgentId?: string
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
