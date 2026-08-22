/**
 * RuntimePorts — the entire contract between iFlow and a host application.
 *
 * This file is the answer to "can the iflow plugin be integrated into any
 * application?". Everything above it (journal, outbox, ledger, projection) is
 * pure logic; everything below it is the host's business. A host that
 * implements these ports and passes the conformance suite in
 * `test/conformance.test.ts` is a valid iFlow edge, whether it is DeepSeek
 * Harness, another agent runtime, or a plain Node service.
 *
 * Hard rule for this package: no `node:*` imports, no `@deepseek-ai/*`
 * imports, no ambient globals beyond the ECMAScript standard library. It gets
 * bundled into the DSH plugin by esbuild and must stay portable.
 */

/** Something to undo. Named to match the `Symbol.dispose`-free environments too. */
export interface Disposable {
  dispose(): void
}

/**
 * Durable text storage, addressed by opaque path strings the host resolves.
 *
 * `append` is a first-class operation rather than read+write because the Origin
 * Journal is append-only and rewriting it on every fact would be both slow and
 * a correctness hazard under concurrent writers.
 */
export interface StoragePort {
  /** Full contents, or undefined when the path does not exist. */
  read(path: string): Promise<string | undefined>
  /** Replace the whole file, creating parent directories as needed. */
  write(path: string, text: string): Promise<void>
  /** Append exactly this text; the caller supplies any newline. */
  append(path: string, text: string): Promise<void>
}

export interface SpawnResult {
  code: number
  stdout: string
  stderr: string
}

export interface SpawnOptions {
  cwd?: string
  /** Path to a file whose contents become the child's stdin. */
  stdinFile?: string
  timeoutMs?: number
}

/**
 * Child-process execution. iFlow needs it for exactly two things: the Rust
 * `iflow-id` identity binary, and outbound HTTP where the host has no fetch
 * (the DSH plugin sandbox has none, so it shells out to curl).
 */
export interface SpawnPort {
  run(argv: string[], options?: SpawnOptions): Promise<SpawnResult>
  /** Absolute path if the executable exists and is runnable, else undefined. */
  resolveExecutable(path: string): Promise<string | undefined>
}

export interface HttpRequest {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  body?: string
}

export interface HttpResponse {
  status: number
  headers?: Record<string, string>
  body?: string
}

/** A long-lived response the edge pushes to over time (SSE). */
export interface HttpStream {
  send(chunk: string): void
  close(): void
  /** Fires when the client goes away, so the edge can drop its subscription. */
  onClose(handler: () => void): void
}

export interface RouteSpec {
  method: 'GET' | 'POST'
  /** Exact path, e.g. `/iflow/projection/agents`. */
  path: string
  handler(request: HttpRequest): Promise<HttpResponse>
}

export interface StreamRouteSpec {
  path: string
  handler(request: HttpRequest, stream: HttpStream): void
}

/** Inbound HTTP, mounted on whatever server the host already runs. */
export interface HttpServerPort {
  route(spec: RouteSpec): Disposable
  /** Optional: a host with no streaming support simply omits this. */
  stream?(spec: StreamRouteSpec): Disposable
  baseUrl(): string
}

export interface ClockPort {
  /** Milliseconds since the Unix epoch. */
  now(): number
  /** ISO-8601 with an explicit offset, as every envelope timestamp requires. */
  nowIso(): string
  timeout(handler: () => void, ms: number): Disposable
}

export interface LoggerPort {
  info(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

/** Non-cryptographic identifiers for events, attempts and correlations. */
export interface IdPort {
  newId(prefix: string): string
}

/** Who this edge is, in the network's terms. */
export interface RuntimeDescriptor {
  /** Stable per machine+workspace; the `origin.nodeId` of every event it emits. */
  nodeId: string
  /** e.g. `dsh`, `codex`, `claude-code`. Recorded, never branched on by the SDK. */
  runtimeKind: string
  runtimeVersion: string
  /** Absolute path the host considers its workspace root. */
  workspaceRoot: string
  capabilities: string[]
  /** The Agent id this edge speaks for. */
  selfAgentId: string
  selfAgentLabel: string
  did?: string
}

export interface RuntimePorts {
  storage: StoragePort
  spawn: SpawnPort
  http?: HttpServerPort
  clock: ClockPort
  logger: LoggerPort
  ids: IdPort
}

export interface CommandExecutionOutcome {
  accepted: boolean
  /** Why it was refused. Present exactly when `accepted` is false. */
  reason?: string
  /** The host's handle on the real work it started. */
  attemptId?: string
}

/**
 * The only way a Hub or Community can cause work on this edge.
 *
 * The host implementation MUST apply its own permission policy before doing
 * anything: no Hub, Community, or transport may bypass a local runtime's
 * enforcement. The SDK guarantees only that a duplicate command never reaches
 * this port twice.
 */
export interface RuntimeExecutorPort {
  execute(command: import('iflow-protocol').IFlowCommand): Promise<CommandExecutionOutcome>
}

/** Default id factory: unique enough for correlation, never used as a secret. */
export function createIdPort(clock: ClockPort): IdPort {
  let counter = 0
  return {
    newId(prefix: string): string {
      counter += 1
      const random = Math.floor(Math.random() * 0xffffff)
        .toString(16)
        .padStart(6, '0')
      return `${prefix}-${clock.now().toString(36)}-${counter.toString(36)}-${random}`
    },
  }
}

/** A clock backed by the ambient environment; hosts with a test clock override it. */
export function createSystemClock(): ClockPort {
  return {
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    timeout(handler, ms) {
      const handle = setTimeout(handler, ms)
      return { dispose: () => clearTimeout(handle) }
    },
  }
}

/** A logger that discards everything — the default when a host supplies none. */
export const silentLogger: LoggerPort = {
  info() {},
  warn() {},
  error() {},
}
