/**
 * Deterministic serialization, byte-compatible with the Rust `iflow-id`
 * canonical form (`rust/src/agentcard.rs::canonical_agentcard`): recursively
 * sort object keys, then emit compact JSON.
 *
 * Two writers in two languages must produce the same bytes or every signature
 * check across the network fails, so the divergences between `serde_json` and
 * `JSON.stringify` are closed here rather than left to chance:
 *
 *   - Non-integer numbers are REJECTED. serde_json writes `1.0`, JS writes `1`;
 *     rather than pick a lossy rule, the envelope simply may not carry floats.
 *   - `undefined` properties are dropped (JS-only concept, absent in Rust).
 *   - `NaN`/`Infinity` are rejected (not representable in JSON at all).
 *   - Non-ASCII stays raw UTF-8 in both implementations; no \u escaping.
 */

export class CanonicalizationError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} (at ${path || '<root>'})`)
    this.name = 'CanonicalizationError'
  }
}

type JsonPrimitive = string | number | boolean | null

function sortValue(value: unknown, path: string): unknown {
  if (value === null) return null

  const type = typeof value
  if (type === 'string' || type === 'boolean') return value as JsonPrimitive

  if (type === 'number') {
    const n = value as number
    if (!Number.isFinite(n)) {
      throw new CanonicalizationError(`non-finite number ${String(n)} is not JSON`, path)
    }
    if (!Number.isInteger(n)) {
      throw new CanonicalizationError(
        `non-integer number ${n} cannot canonicalize identically in Rust and JS; use a string`,
        path,
      )
    }
    return n
  }

  if (type === 'bigint') {
    throw new CanonicalizationError('bigint is not JSON; use a string', path)
  }
  if (type === 'function' || type === 'symbol' || type === 'undefined') {
    throw new CanonicalizationError(`${type} cannot be canonicalized`, path)
  }

  if (Array.isArray(value)) {
    return value.map((item, i) => sortValue(item, `${path}[${i}]`))
  }

  // Plain object: sort keys by UTF-16 code unit order, matching Rust's
  // `String::cmp` over UTF-8 for the ASCII key space these envelopes use.
  const source = value as Record<string, unknown>
  const keys = Object.keys(source).sort()
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const child = source[key]
    if (child === undefined) continue
    out[key] = sortValue(child, path ? `${path}.${key}` : key)
  }
  return out
}

/** Recursively key-sorted clone. Useful when the caller wants the value, not the bytes. */
export function canonicalize<T>(value: T): T {
  return sortValue(value, '') as T
}

/** Compact JSON text of the canonical form. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value, ''))
}

/** UTF-8 bytes signed by `Signer`, identical to what `iflow-id` signs. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value))
}

/** base64url without padding — the encoding every signature field uses. */
export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64urlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
