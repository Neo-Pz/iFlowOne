/**
 * In-memory host, published as part of the package.
 *
 * A new host adapter proves itself by running the conformance suite against
 * its own ports and comparing against this reference implementation. Shipping
 * the fakes (rather than hiding them in the test folder) is what makes
 * "integrate iFlow into any application" checkable from outside this repo.
 */

import type {
  ClockPort,
  Disposable,
  HttpRequest,
  HttpResponse,
  HttpServerPort,
  IdPort,
  LoggerPort,
  RouteSpec,
  RuntimeDescriptor,
  RuntimePorts,
  SpawnPort,
  SpawnResult,
  StoragePort,
  StreamRouteSpec,
} from './ports.js'

export class MemoryStorage implements StoragePort {
  readonly files = new Map<string, string>()
  /** Every write, in order — lets a test assert durability ordering. */
  readonly writeLog: { op: 'write' | 'append'; path: string }[] = []
  /** Set to make the next operation on a path throw, simulating a disk failure. */
  failOn = new Set<string>()

  async read(path: string): Promise<string | undefined> {
    return this.files.get(path)
  }

  async write(path: string, text: string): Promise<void> {
    this.guard(path)
    this.files.set(path, text)
    this.writeLog.push({ op: 'write', path })
  }

  async append(path: string, text: string): Promise<void> {
    this.guard(path)
    this.files.set(path, (this.files.get(path) ?? '') + text)
    this.writeLog.push({ op: 'append', path })
  }

  private guard(path: string): void {
    if (this.failOn.has(path)) throw new Error(`simulated storage failure on ${path}`)
  }

  /** Parsed NDJSON lines of a file, for assertions. */
  lines(path: string): unknown[] {
    return (this.files.get(path) ?? '')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as unknown)
  }
}

export class MemoryClock implements ClockPort {
  constructor(private current = Date.parse('2026-01-01T00:00:00.000Z')) {}

  now(): number {
    return this.current
  }

  nowIso(): string {
    return new Date(this.current).toISOString()
  }

  advance(ms: number): void {
    this.current += ms
  }

  timeout(handler: () => void, ms: number): Disposable {
    const handle = setTimeout(handler, ms)
    return { dispose: () => clearTimeout(handle) }
  }
}

/** Deterministic ids, so a journal written twice compares byte for byte. */
export class SequentialIds implements IdPort {
  private counters = new Map<string, number>()

  newId(prefix: string): string {
    const next = (this.counters.get(prefix) ?? 0) + 1
    this.counters.set(prefix, next)
    return `${prefix}-${String(next).padStart(4, '0')}`
  }
}

export class CollectingLogger implements LoggerPort {
  readonly entries: { level: 'info' | 'warn' | 'error'; message: string; detail?: unknown }[] = []

  info(message: string, detail?: unknown): void {
    this.entries.push({ level: 'info', message, detail })
  }

  warn(message: string, detail?: unknown): void {
    this.entries.push({ level: 'warn', message, detail })
  }

  error(message: string, detail?: unknown): void {
    this.entries.push({ level: 'error', message, detail })
  }

  messages(level: 'info' | 'warn' | 'error'): string[] {
    return this.entries.filter((entry) => entry.level === level).map((entry) => entry.message)
  }
}

export class StubSpawn implements SpawnPort {
  readonly calls: string[][] = []
  responses = new Map<string, SpawnResult>()
  executables = new Set<string>()

  async run(argv: string[]): Promise<SpawnResult> {
    this.calls.push([...argv])
    return this.responses.get(argv.join(' ')) ?? { code: 0, stdout: '', stderr: '' }
  }

  async resolveExecutable(path: string): Promise<string | undefined> {
    return this.executables.has(path) ? path : undefined
  }
}

export interface CapturedStream {
  path: string
  chunks: string[]
  closed: boolean
  fireClose(): void
}

export class MemoryHttpServer implements HttpServerPort {
  readonly routes = new Map<string, RouteSpec>()
  readonly streams = new Map<string, StreamRouteSpec>()
  readonly openStreams: CapturedStream[] = []

  route(spec: RouteSpec): Disposable {
    const key = `${spec.method} ${spec.path}`
    this.routes.set(key, spec)
    return { dispose: () => this.routes.delete(key) }
  }

  stream(spec: StreamRouteSpec): Disposable {
    this.streams.set(spec.path, spec)
    return { dispose: () => this.streams.delete(spec.path) }
  }

  baseUrl(): string {
    return 'http://127.0.0.1:3080'
  }

  /** Drive a mounted route the way a real server would. */
  async call(
    method: 'GET' | 'POST',
    path: string,
    init: { query?: Record<string, string>; headers?: Record<string, string>; body?: string } = {},
  ): Promise<HttpResponse> {
    const spec = this.routes.get(`${method} ${path}`)
    if (!spec) return { status: 404, body: JSON.stringify({ error: 'no such route' }) }
    const request: HttpRequest = {
      method,
      path,
      query: init.query ?? {},
      headers: init.headers ?? {},
      body: init.body,
    }
    return spec.handler(request)
  }

  /** Open a mounted SSE route and capture what the edge pushes to it. */
  openStream(path: string, headers: Record<string, string> = {}): CapturedStream {
    const spec = this.streams.get(path)
    if (!spec) throw new Error(`no such stream route: ${path}`)
    const closeHandlers: (() => void)[] = []
    const captured: CapturedStream = {
      path,
      chunks: [],
      closed: false,
      fireClose(): void {
        captured.closed = true
        for (const handler of closeHandlers) handler()
      },
    }
    spec.handler(
      { method: 'GET', path, query: {}, headers },
      {
        send: (chunk) => captured.chunks.push(chunk),
        close: () => captured.fireClose(),
        onClose: (handler) => closeHandlers.push(handler),
      },
    )
    this.openStreams.push(captured)
    return captured
  }
}

export interface MemoryHost {
  ports: RuntimePorts
  storage: MemoryStorage
  clock: MemoryClock
  ids: SequentialIds
  logger: CollectingLogger
  spawn: StubSpawn
  http: MemoryHttpServer
  descriptor: RuntimeDescriptor
}

/** A complete fake host, ready to hand to `createEdge`. */
export function createMemoryHost(overrides: Partial<RuntimeDescriptor> = {}): MemoryHost {
  const storage = new MemoryStorage()
  const clock = new MemoryClock()
  const ids = new SequentialIds()
  const logger = new CollectingLogger()
  const spawn = new StubSpawn()
  const http = new MemoryHttpServer()

  const descriptor: RuntimeDescriptor = {
    nodeId: 'node-test',
    runtimeKind: 'memory',
    runtimeVersion: '0.0.0-test',
    workspaceRoot: '/workspace',
    capabilities: ['iflow.cap:test.run'],
    selfAgentId: 'agent-self',
    selfAgentLabel: 'test-edge',
    ...overrides,
  }

  return {
    storage,
    clock,
    ids,
    logger,
    spawn,
    http,
    descriptor,
    ports: { storage, clock, ids, logger, spawn, http },
  }
}

/**
 * A deterministic stand-in for a real signer.
 *
 * It is NOT cryptography and must never leave a test: it proves the plumbing —
 * that the right bytes are signed, that the signature lands on the event, and
 * that tampering is detected. Real Ed25519 behavior is covered where it belongs,
 * against the actual `iflow-id` binary in `iflow-protocol`'s cross-language test.
 */
export function createFakeKeypair(did = 'did:key:zFakeTestIdentity') {
  const digest = (bytes: Uint8Array): string => {
    // FNV-1a over the exact bytes: order- and content-sensitive, which is all
    // a tamper-detection test needs.
    let hash = 0x811c9dc5
    for (const byte of bytes) {
      hash ^= byte
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, '0')
  }

  const encoder = new TextEncoder()

  return {
    did,
    signer: {
      async did() {
        return did
      },
      async sign(bytes: Uint8Array) {
        return encoder.encode(`${digest(bytes)}:${did}`)
      },
    },
    verifier: {
      async verify(bytes: Uint8Array, signature: Uint8Array, signerDid: string) {
        return new TextDecoder().decode(signature) === `${digest(bytes)}:${signerDid}`
      },
    },
  }
}
