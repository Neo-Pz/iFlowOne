/**
 * Canonicalization, including a real cross-language check.
 *
 * If the TypeScript and Rust canonical forms ever diverge by a single byte,
 * every signature made on one side fails on the other. That failure would show
 * up as a mysterious network-wide trust error, so it is pinned here against the
 * actual `iflow-id` binary rather than against a copy of its rules.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { CanonicalizationError, base64url, base64urlDecode, canonicalJson, canonicalize } from '../src/canonical.js'
import type { IFlowEvent, Signer, Verifier } from '../src/index.js'
import {
  EVENT_SCHEMA_VERSION,
  countersignPayloadFor,
  signEvent,
  signableBytes,
  verifyCountersignedPair,
  verifyEvent,
} from '../src/index.js'

describe('canonicalJson', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  })

  it('preserves array order', () => {
    expect(canonicalJson({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}')
  })

  it('drops undefined properties', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it('keeps non-ASCII raw, exactly as serde_json does', () => {
    expect(canonicalJson({ label: '中文' })).toBe('{"label":"中文"}')
  })

  it('rejects floats, which serde_json and JSON.stringify write differently', () => {
    expect(() => canonicalJson({ cost: 1.5 })).toThrow(CanonicalizationError)
    // 1.0 is the dangerous case: Rust writes "1.0", JS writes "1".
    expect(canonicalJson({ cost: 1.0 })).toBe('{"cost":1}')
  })

  it('rejects values JSON cannot represent', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(CanonicalizationError)
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(CanonicalizationError)
    expect(() => canonicalJson({ n: 1n })).toThrow(CanonicalizationError)
  })

  it('names the offending path so a rejection is actionable', () => {
    expect(() => canonicalJson({ a: { b: [{ c: 0.5 }] } })).toThrow(/a\.b\[0\]\.c/)
  })

  it('canonicalize returns the same shape the bytes describe', () => {
    expect(JSON.stringify(canonicalize({ b: 1, a: 2 }))).toBe(canonicalJson({ b: 1, a: 2 }))
  })
})

describe('base64url', () => {
  it('round-trips and never pads', () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255])
    const encoded = base64url(bytes)
    expect(encoded).not.toContain('=')
    expect([...base64urlDecode(encoded)]).toEqual([...bytes])
  })
})

/**
 * The binary is built by CI and fetched on install, so it is not guaranteed to
 * exist on every machine. When it is missing we skip rather than fail: a
 * missing toolchain is not a broken contract.
 */
const IFLOW_ID = join(
  import.meta.dirname,
  '../../../../iflow-dsh-plugin/rust/target/release',
  process.platform === 'win32' ? 'iflow-id.exe' : 'iflow-id',
)
const hasBinary = existsSync(IFLOW_ID)

/**
 * A Signer/Verifier pair backed by the real Rust binary.
 *
 * This is the same shape the DSH adapter implements, so exercising it here
 * checks the contract end to end: TypeScript decides what bytes mean, Rust
 * holds the key, and neither side reimplements the other's rules.
 */
function iflowIdKeypair(home: string): { signer: Signer; verifier: Verifier } {
  const run = (args: string[]): string => execFileSync(IFLOW_ID, ['--home', home, ...args], { encoding: 'utf8' })
  const blobPath = join(home, 'signable.bin')

  return {
    signer: {
      async did() {
        return (JSON.parse(run(['show', '--json'])) as { did: string }).did
      },
      async sign(bytes) {
        writeFileSync(blobPath, bytes)
        const out = JSON.parse(run(['sign-blob', blobPath])) as { signature: string }
        return base64urlDecode(out.signature)
      },
    },
    verifier: {
      async verify(bytes, signature, signerDid) {
        writeFileSync(blobPath, bytes)
        try {
          run(['verify-blob', blobPath, base64url(signature), signerDid])
          return true
        } catch {
          // A non-zero exit is the binary's verdict, not a transport failure.
          return false
        }
      },
    },
  }
}

describe.skipIf(!hasBinary)('event signing against the real identity binary', () => {
  function newHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'iflow-sign-'))
    execFileSync(IFLOW_ID, ['--home', home, 'create', 'sign-test'], { encoding: 'utf8' })
    return home
  }

  function sampleEvent(overrides: Partial<IFlowEvent> = {}): IFlowEvent {
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
      payload: { title: '写一份季度总结' },
      evidence: { source: 'dsh' },
      ...overrides,
    }
  }

  it('signs and verifies a real event', async () => {
    const home = newHome()
    const { signer, verifier } = iflowIdKeypair(home)

    const signed = await signEvent(sampleEvent(), signer)
    expect(signed.signature.alg).toBe('EdDSA')
    expect(await verifyEvent(signed, verifier)).toBe(true)
  })

  it('rejects an event whose payload changed after signing', async () => {
    const home = newHome()
    const { signer, verifier } = iflowIdKeypair(home)

    const signed = await signEvent(sampleEvent(), signer)
    const tampered = {
      ...signed,
      event: { ...signed.event, payload: { title: 'something else' } },
    }
    expect(await verifyEvent(tampered, verifier)).toBe(false)
  })

  it('rejects an event whose visibility changed after signing', async () => {
    const home = newHome()
    const { signer, verifier } = iflowIdKeypair(home)

    const signed = await signEvent(sampleEvent({ visibility: 'local' }), signer)
    const tampered = {
      ...signed,
      event: { ...signed.event, visibility: 'public' as const },
    }
    expect(await verifyEvent(tampered, verifier)).toBe(false)
  })

  it('still verifies after a receiver stamps journalOffset and observedAt', async () => {
    const home = newHome()
    const { signer, verifier } = iflowIdKeypair(home)

    const signed = await signEvent(sampleEvent(), signer)
    // These are exactly the fields an accepting node is allowed to add.
    const accepted = {
      ...signed,
      event: { ...signed.event, journalOffset: 42, observedAt: '2026-01-02T00:00:00.000Z' },
    }
    expect(await verifyEvent(accepted, verifier)).toBe(true)
  })

  it('signs the same bytes whether or not a signature is already attached', async () => {
    const home = newHome()
    const { signer, verifier } = iflowIdKeypair(home)

    const event = sampleEvent()
    const before = signableBytes(event)
    const signed = await signEvent(event, signer)

    // The journal writes the signature INTO evidence, so the bytes a verifier
    // hashes must not change when it does.
    const withSignature = {
      ...event,
      evidence: { source: 'dsh' as const, signature: signed.signature.value },
    }
    expect([...signableBytes(withSignature)]).toEqual([...before])
    expect(
      await verifier.verify(signableBytes(withSignature), base64urlDecode(signed.signature.value), await signer.did()),
    ).toBe(true)
  })
})

describe.skipIf(!hasBinary)('countersigned agreements', () => {
  function twoParties(): { seller: ReturnType<typeof iflowIdKeypair>; buyer: ReturnType<typeof iflowIdKeypair> } {
    const make = (label: string) => {
      const home = mkdtempSync(join(tmpdir(), `iflow-${label}-`))
      execFileSync(IFLOW_ID, ['--home', home, 'create', label], { encoding: 'utf8' })
      return iflowIdKeypair(home)
    }
    return { seller: make('seller'), buyer: make('buyer') }
  }

  function base(overrides: Partial<IFlowEvent> = {}): IFlowEvent {
    return {
      id: 'evt-offer',
      schemaVersion: EVENT_SCHEMA_VERSION,
      origin: { nodeId: 'node-1', streamId: 'edge', seq: 1 },
      occurredAt: '2026-01-01T00:00:00.000Z',
      correlationId: 'corr-1',
      visibility: 'local',
      type: 'quote.offered',
      issuer: { id: 'agent-seller', kind: 'agent' },
      subject: { kind: 'task', id: 'task-1' },
      taskId: 'task-1',
      payload: {},
      evidence: { source: 'a2a' },
      ...overrides,
    }
  }

  /** Sign an event the way the journal does: signature written into evidence. */
  async function selfSign(event: IFlowEvent, party: ReturnType<typeof iflowIdKeypair>): Promise<IFlowEvent> {
    const did = await party.signer.did()
    const withIssuer = { ...event, issuer: { ...event.issuer, did } }
    const signed = await signEvent(withIssuer, party.signer)
    return {
      ...withIssuer,
      evidence: { ...(withIssuer.evidence ?? { source: 'a2a' }), signature: signed.signature.value },
    }
  }

  async function agreedPair() {
    const { seller, buyer } = twoParties()
    const offer = await selfSign(
      base({
        payload: {
          quoteId: 'q1',
          offeredBy: 'agent-seller',
          offeredTo: 'agent-buyer',
          amountMicros: 2_500_000,
          currency: 'USD',
          expiresAt: '2026-12-31T00:00:00.000Z',
        },
      }),
      seller,
    )
    const acceptance = await selfSign(
      base({
        id: 'evt-accept',
        origin: { nodeId: 'node-2', streamId: 'edge', seq: 1 },
        type: 'quote.accepted',
        issuer: { id: 'agent-buyer', kind: 'agent' },
        payload: { quoteId: 'q1', acceptedBy: 'agent-buyer', ...countersignPayloadFor(offer) },
      }),
      buyer,
    )
    return { seller, buyer, offer, acceptance }
  }

  it('verifies a genuine two-party agreement', async () => {
    const { seller, offer, acceptance } = await agreedPair()
    const result = await verifyCountersignedPair(offer, acceptance as never, seller.verifier)
    expect(result.failures).toEqual([])
    expect(result.valid).toBe(true)
  })

  it('rejects an acceptance pointing at a different offer', async () => {
    const { seller, offer, acceptance } = await agreedPair()
    const other = { ...offer, id: 'evt-some-other-offer' }
    const result = await verifyCountersignedPair(other, acceptance as never, seller.verifier)
    expect(result.valid).toBe(false)
    expect(result.failures).toContain('offer-id-mismatch')
  })

  it('rejects an acceptance that quotes the wrong offer signature', async () => {
    const { seller, offer, acceptance } = await agreedPair()
    const tampered = {
      ...acceptance,
      payload: { ...(acceptance.payload as object), offerSignature: 'AAAA' },
    }
    const result = await verifyCountersignedPair(offer, tampered as never, seller.verifier)
    expect(result.valid).toBe(false)
    expect(result.failures).toContain('offer-signature-mismatch')
  })

  it('rejects a price edited after the offer was signed', async () => {
    const { seller, offer, acceptance } = await agreedPair()
    const cheaper = {
      ...offer,
      payload: { ...(offer.payload as object), amountMicros: 1 },
    }
    const result = await verifyCountersignedPair(cheaper, acceptance as never, seller.verifier)
    expect(result.valid).toBe(false)
    expect(result.failures).toContain('offer-signature-invalid')
  })

  it('rejects a party countersigning itself', async () => {
    const { seller, offer } = await agreedPair()
    const selfAccept = await selfSign(
      base({
        id: 'evt-self',
        type: 'quote.accepted',
        issuer: { id: 'agent-seller', kind: 'agent' },
        payload: { quoteId: 'q1', acceptedBy: 'agent-seller', ...countersignPayloadFor(offer) },
      }),
      seller,
    )
    const result = await verifyCountersignedPair(offer, selfAccept as never, seller.verifier)
    expect(result.valid).toBe(false)
    expect(result.failures).toContain('same-party')
  })

  it('refuses to build a countersignature for an unsigned offer', () => {
    expect(() => countersignPayloadFor(base())).toThrow(/carries no signature/)
  })
})

describe.skipIf(!hasBinary)('cross-language canonical form', () => {
  it('produces the exact bytes the Rust signer signs', () => {
    const home = mkdtempSync(join(tmpdir(), 'iflow-canon-'))
    execFileSync(IFLOW_ID, ['--home', home, 'create', 'canon-test'], { encoding: 'utf8' })

    // Deliberately unsorted, nested, and non-ASCII: all three are places the
    // two serializers could disagree.
    const card = {
      version: '1.0.0',
      name: 'if-canon',
      skills: [
        { id: 'b', description: '第二' },
        { id: 'a', description: 'first' },
      ],
      interface: { transport: 'JSONRPC', url: 'http://127.0.0.1:3080/a2a' },
      capabilities: { streaming: false },
    }

    const cardPath = join(home, 'card.json')
    writeFileSync(cardPath, JSON.stringify(card), 'utf8')

    const signed = JSON.parse(
      execFileSync(IFLOW_ID, ['--home', home, 'agentcard-sign', cardPath], { encoding: 'utf8' }),
    ) as { payload: string }

    const rustCanonical = new TextDecoder().decode(base64urlDecode(signed.payload))
    expect(rustCanonical).toBe(canonicalJson(card))
  })
})
