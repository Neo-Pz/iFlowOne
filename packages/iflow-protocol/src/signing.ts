/**
 * Signature ports. The protocol says WHAT is signed; it never says HOW.
 *
 * Today the only implementation spawns the Rust `iflow-id` binary (that is the
 * DSH adapter's job). A browser build could back the same port with WebCrypto
 * without touching a line of this package.
 */

import { base64url, base64urlDecode, canonicalBytes } from './canonical.js'
import type { IFlowEvent, IFlowSignature, SignedIFlowEvent } from './envelope.js'

export interface Signer {
  /** The DID this signer speaks for, e.g. `did:key:z6Mk...`. */
  did(): Promise<string>
  /** Ed25519 signature over the exact bytes given. */
  sign(bytes: Uint8Array): Promise<Uint8Array>
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
