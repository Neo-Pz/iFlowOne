/**
 * Countersigned pairs — how a two-party fact becomes verifiable.
 *
 * The envelope carries exactly one signature, by design: a fact belongs to the
 * origin that observed it. But a price is not observed, it is AGREED, and one
 * party's signed claim that "we agreed on 100" proves nothing on its own.
 *
 * Rather than widen the envelope to multi-signature — which would change the
 * canonical bytes of every event to serve one use case — an agreement is
 * expressed as an ordered pair of ordinary signed events:
 *
 *   1. the offer, signed by the party proposing it
 *   2. the acceptance, signed by the other party, whose payload embeds the
 *      offer's `id` and the offer's exact `signature`
 *
 * The acceptance is therefore only meaningful alongside the offer it names, and
 * neither half can be forged without the other party's key. A third party can
 * check the pair with nothing but the two events and the two DIDs.
 *
 * What this does NOT establish: that the two parties are independent. Two
 * agents controlled by one operator can countersign each other all day. Sybil
 * resistance belongs to the trust layer, not here — and a market view should
 * publish counterparty concentration so a reader can judge for themselves.
 */

import type { IFlowEvent } from './envelope.js'
import type { Verifier } from './signing.js'
import { signableBytes } from './signing.js'
import { base64urlDecode } from './canonical.js'

/** The two payload fields an acceptance must carry to bind itself to an offer. */
export interface CountersignPayload {
  offerEventId: string
  offerSignature: string
}

export type CountersignFailure =
  | 'offer-unsigned'
  | 'acceptance-unsigned'
  | 'offer-id-mismatch'
  | 'offer-signature-mismatch'
  | 'offer-signature-invalid'
  | 'acceptance-signature-invalid'
  | 'same-party'
  | 'missing-signer'

export interface CountersignResult {
  valid: boolean
  /** Every reason the pair failed, so a caller can report all of them at once. */
  failures: CountersignFailure[]
  offerSignerDid?: string
  acceptanceSignerDid?: string
}

/**
 * Verify that `acceptance` is a genuine countersignature of `offer`.
 *
 * Both events must already carry `evidence.signature`, and their issuers must
 * carry the DIDs those signatures were made with.
 */
export async function verifyCountersignedPair(
  offer: IFlowEvent,
  acceptance: IFlowEvent<CountersignPayload>,
  verifier: Verifier,
): Promise<CountersignResult> {
  const failures: CountersignFailure[] = []

  const offerSignature = offer.evidence?.signature
  const acceptanceSignature = acceptance.evidence?.signature
  if (!offerSignature) failures.push('offer-unsigned')
  if (!acceptanceSignature) failures.push('acceptance-unsigned')

  const offerSignerDid = offer.issuer.did
  const acceptanceSignerDid = acceptance.issuer.did
  if (!offerSignerDid || !acceptanceSignerDid) failures.push('missing-signer')

  // The binding: the acceptance must name this offer, and quote its signature
  // verbatim. Without both, an acceptance could be replayed against a
  // different offer with the same id, or a cheaper one.
  if (acceptance.payload.offerEventId !== offer.id) failures.push('offer-id-mismatch')
  if (offerSignature !== undefined && acceptance.payload.offerSignature !== offerSignature) {
    failures.push('offer-signature-mismatch')
  }

  // A party countersigning itself is not an agreement.
  if (offerSignerDid !== undefined && offerSignerDid === acceptanceSignerDid) failures.push('same-party')

  if (offerSignature && offerSignerDid) {
    const ok = await verifier.verify(signableBytes(offer), base64urlDecode(offerSignature), offerSignerDid)
    if (!ok) failures.push('offer-signature-invalid')
  }
  if (acceptanceSignature && acceptanceSignerDid) {
    const ok = await verifier.verify(
      signableBytes(acceptance),
      base64urlDecode(acceptanceSignature),
      acceptanceSignerDid,
    )
    if (!ok) failures.push('acceptance-signature-invalid')
  }

  return {
    valid: failures.length === 0,
    failures,
    offerSignerDid,
    acceptanceSignerDid,
  }
}

/** The payload fields an acceptance needs, given the offer it answers. */
export function countersignPayloadFor(offer: IFlowEvent): CountersignPayload {
  const signature = offer.evidence?.signature
  if (!signature) {
    throw new Error(`cannot countersign event ${offer.id}: it carries no signature`)
  }
  return { offerEventId: offer.id, offerSignature: signature }
}
