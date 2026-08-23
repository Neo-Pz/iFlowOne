/**
 * Signature ports. The protocol says WHAT is signed; it never says HOW.
 *
 * Today the only implementation spawns the Rust `iflow-id` binary (that is the
 * DSH adapter's job). A browser build could back the same port with WebCrypto
 * without touching a line of this package.
 */

import { base64url, base64urlDecode, canonicalBytes } from './canonical.js'
import type { IFlowEvent, IFlowSignature, SignedIFlowEvent } from './envelope.js'

/**
 * Which identity a signature is being asked for.
 *
 * A node may hold more than one key — a Principal, and one per Agent it
 * declares — so "sign these bytes" is ambiguous without saying who is
 * speaking. Optional, and safely ignored: a signer that holds exactly one key
 * answers the same way regardless.
 */
export interface SigningContext {
  /** The DID the resulting signature must verify against, when known. */
  did?: string
  /** The Agent the event is issued by, for a signer that keys on that instead. */
  agentId?: string
}

export interface Signer {
  /** The DID this signer speaks for, e.g. `did:key:z6Mk...`. */
  did(): Promise<string>
  /**
   * Ed25519 signature over the exact bytes given.
   *
   * A multi-key signer picks its key from `context` and MUST refuse rather than
   * substitute a different one: a signature by the wrong key is not a weaker
   * signature, it is a false attribution.
   */
  sign(bytes: Uint8Array, context?: SigningContext): Promise<Uint8Array>
}

export interface Verifier {
  verify(bytes: Uint8Array, signature: Uint8Array, signerDid: string): Promise<boolean>
}

/**
 * The bytes a signature covers: the event minus the fields a *receiver* may
 * legitimately add, and minus the signature itself.
 *
 *   - `journalOffset` and `observedAt` are assigned by whoever accepts the
 *     event, so including them would invalidate the origin's signature the
 *     moment the event is accepted anywhere.
 *   - `evidence.signature` is the output of this function. Including it would
 *     be circular: the signer cannot know it before producing it, and a
 *     verifier reading a signed event back off disk would hash different bytes
 *     than the signer did.
 */
export function signableBytes(event: IFlowEvent): Uint8Array {
  const { journalOffset: _offset, observedAt: _observed, evidence, ...rest } = event
  if (evidence === undefined) return canonicalBytes(rest)
  const { signature: _signature, ...evidenceWithoutSignature } = evidence
  return canonicalBytes({ ...rest, evidence: evidenceWithoutSignature })
}

export async function signEvent<T>(event: IFlowEvent<T>, signer: Signer): Promise<SignedIFlowEvent<T>> {
  const [did, raw] = await Promise.all([signer.did(), signer.sign(signableBytes(event))])
  return {
    event,
    signature: { alg: 'EdDSA', signerDid: did, value: base64url(raw) },
  }
}

export async function verifyEvent(signed: SignedIFlowEvent, verifier: Verifier): Promise<boolean> {
  if (signed.signature.alg !== 'EdDSA') return false
  return verifier.verify(
    signableBytes(signed.event),
    base64urlDecode(signed.signature.value),
    signed.signature.signerDid,
  )
}

/** A verifier that rejects everything — the safe default when no key material is wired. */
export const denyAllVerifier: Verifier = {
  async verify() {
    return false
  },
}
