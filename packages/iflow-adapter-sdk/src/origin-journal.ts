/**
 * The Origin Journal — this edge's append-only record of what it observed.
 *
 * The origin edge is the authority for facts that happened inside its runtime
 * boundary. A Community may later accept and order those facts, but it never
 * manufactures them, and this file keeps working with no network at all.
 *
 * Ordering rule: `origin.seq` is monotonic only inside this node's stream. It
 * is never a global order and never a substitute for a Journal offset.
 */

import type { AnyIFlowEvent, EventPayloadMap, EventType } from 'iflow-domain'
import type { IFlowEvent, IFlowIssuer, IFlowSubject, Signer } from 'iflow-protocol'
import { EVENT_SCHEMA_VERSION, base64url, signableBytes, validateEvent } from 'iflow-protocol'

import { edgePaths, type EdgePaths } from './paths.js'
import type { Disposable, LoggerPort, RuntimeDescriptor, RuntimePorts } from './ports.js'

/** The single origin stream this node writes. */
export const ORIGIN_STREAM_ID = 'edge'

export interface RecordEventInput<K extends EventType = EventType> {
  type: K
  subject: IFlowSubject
  payload: EventPayloadMap[K]
  /** Defaults to the edge's own agent identity. */
  issuer?: IFlowIssuer
  /** Groups one collaboration flow. Defaults to a fresh correlation. */
  correlationId?: string
  causationId?: string
  goalId?: string
  taskId?: string
  roomId?: string
  /** When the origin asserts it happened. Defaults to now. */
  occurredAt?: string
  trace?: IFlowEvent['trace']
  evidence?: IFlowEvent['evidence']
}

export interface JournalCheckpoint {
  /** Highest `origin.seq` this node has written. */
  lastSeq: number
  lastEventId?: string
  /** Highest seq a Community has acknowledged, so retries never duplicate. */
  syncedSeq: number
  updatedAt: string
}

const EMPTY_CHECKPOINT: JournalCheckpoint = { lastSeq: 0, syncedSeq: 0, updatedAt: '1970-01-01T00:00:00.000Z' }

export interface OriginJournalOptions {
  /** Skip lines that will not parse instead of refusing to open. Default true. */
  tolerateCorruptLines?: boolean
  /**
   * Sign every fact at the origin.
   *
   * Optional because an edge with no key material must still work locally — an
   * unsigned journal is degraded, not broken. But an unsigned event cannot be
   * verified off-node, so a Community is entitled to refuse it.
   */
  signer?: Signer
}

export class OriginJournal {
  private events: AnyIFlowEvent[] = []
  private checkpoint: JournalCheckpoint = { ...EMPTY_CHECKPOINT }
  private subscribers = new Set<(event: AnyIFlowEvent) => void>()
  private writeChain: Promise<void> = Promise.resolve()
  private corruptLines = 0

  private signer: Signer | undefined
  /** Facts this process wrote with no signature on them. */
  private unsignedCount = 0

  private constructor(
    private readonly ports: RuntimePorts,
    private readonly descriptor: RuntimeDescriptor,
    readonly paths: EdgePaths,
    private readonly logger: LoggerPort,
  ) {}

  static async open(
    ports: RuntimePorts,
    descriptor: RuntimeDescriptor,
    options: OriginJournalOptions = {},
  ): Promise<OriginJournal> {
    const paths = edgePaths(descriptor.workspaceRoot)
    const journal = new OriginJournal(ports, descriptor, paths, ports.logger)
    journal.signer = options.signer
    await journal.load(options.tolerateCorruptLines ?? true)
    return journal
  }

  private async load(tolerateCorruptLines: boolean): Promise<void> {
    const raw = await this.ports.storage.read(this.paths.origin)
    if (raw) {
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          this.corruptLines += 1
          if (!tolerateCorruptLines) throw new Error(`origin journal has an unparsable line: ${trimmed.slice(0, 120)}`)
          continue
        }
        const result = validateEvent(parsed)
        if (!result.valid) {
          this.corruptLines += 1
          if (!tolerateCorruptLines) {
            throw new Error(`origin journal has an invalid event: ${result.issues.map((i) => i.path).join(',')}`)
          }
          continue
        }
        this.events.push(parsed as AnyIFlowEvent)
      }
    }

    const checkpointRaw = await this.ports.storage.read(this.paths.checkpoint)
    if (checkpointRaw) {
      try {
        this.checkpoint = { ...EMPTY_CHECKPOINT, ...(JSON.parse(checkpointRaw) as Partial<JournalCheckpoint>) }
      } catch {
        this.logger.warn('iflow: checkpoint.json unreadable, rebuilding from the journal')
      }
    }

    // The journal is the authority: a checkpoint that disagrees with it is
    // stale (a crash between append and checkpoint write), never the reverse.
    const highest = this.events.reduce((max, event) => Math.max(max, event.origin.seq), 0)
    if (highest > this.checkpoint.lastSeq) {
      this.checkpoint.lastSeq = highest
      this.checkpoint.lastEventId = this.events[this.events.length - 1]?.id
    }
    if (this.checkpoint.syncedSeq > this.checkpoint.lastSeq) this.checkpoint.syncedSeq = this.checkpoint.lastSeq

    if (this.corruptLines > 0) {
      this.logger.warn(`iflow: skipped ${this.corruptLines} unreadable origin journal line(s)`)
    }
  }

  get nodeId(): string {
    return this.descriptor.nodeId
  }

  get lastSeq(): number {
    return this.checkpoint.lastSeq
  }

  get syncedSeq(): number {
    return this.checkpoint.syncedSeq
  }

  get skippedLineCount(): number {
    return this.corruptLines
  }

  /** How many facts this process wrote without a signature. */
  get unsignedWriteCount(): number {
    return this.unsignedCount
  }

  get signing(): boolean {
    return this.signer !== undefined
  }

  /**
   * Attach a signer after opening.
   *
   * The identity binary may need fetching, so an edge often starts before it
   * can sign. Facts written before that are journaled unsigned rather than
   * dropped, and counted so the gap stays visible instead of silent.
   */
  useSigner(signer: Signer): void {
    this.signer = signer
  }

  /** Every event this node holds, in origin order. */
  all(): readonly AnyIFlowEvent[] {
    return this.events
  }

  /** Events strictly after `seq`, for paging and replay. */
  since(seq: number, limit = 500): AnyIFlowEvent[] {
    const out: AnyIFlowEvent[] = []
    for (const event of this.events) {
      if (event.origin.seq <= seq) continue
      out.push(event)
      if (out.length >= limit) break
    }
    return out
  }

  /**
   * Record a fact. The event is durable before this resolves, so a caller can
   * treat a resolved promise as "the network will eventually see this".
   *
   * Appends are serialized through one chain: two concurrent observers must
   * never both claim the same `origin.seq`.
   */
  async record<K extends EventType>(input: RecordEventInput<K>): Promise<AnyIFlowEvent> {
    const result = this.writeChain.then(() => this.appendNow(input))
    // Keep the chain alive even if this append rejected, so one failure does
    // not wedge every later fact.
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async appendNow<K extends EventType>(input: RecordEventInput<K>): Promise<AnyIFlowEvent> {
    const seq = this.checkpoint.lastSeq + 1
    const occurredAt = input.occurredAt ?? this.ports.clock.nowIso()

    const event: IFlowEvent<EventPayloadMap[K]> = {
      id: this.ports.ids.newId('evt'),
      schemaVersion: EVENT_SCHEMA_VERSION,
      origin: { nodeId: this.descriptor.nodeId, streamId: ORIGIN_STREAM_ID, seq },
      occurredAt,
      correlationId: input.correlationId ?? this.ports.ids.newId('corr'),
      causationId: input.causationId,
      type: input.type,
      issuer: input.issuer ?? {
        id: this.descriptor.selfAgentId,
        did: this.descriptor.did,
        kind: 'system',
      },
      subject: input.subject,
      goalId: input.goalId,
      taskId: input.taskId,
      roomId: input.roomId,
      trace: input.trace,
      payload: input.payload,
      evidence: input.evidence ?? { source: 'dsh' },
    }

    const validation = validateEvent(event)
    if (!validation.valid) {
      throw new Error(
        `iflow: refusing to journal a malformed ${input.type} event: ` +
          validation.issues.map((i) => `${i.path} ${i.message}`).join('; '),
      )
    }

    // Sign before writing, so what lands on disk is exactly what a verifier
    // checks. A signing failure degrades to an unsigned fact: losing the
    // observation entirely is a worse answer than recording it unverifiably.
    const signed = stripUndefined(event) as IFlowEvent<EventPayloadMap[K]>
    if (this.signer) {
      try {
        // Name the issuer, so a node holding several keys signs with the one
        // the event is attributed to rather than whichever it happens to hold.
        const raw = await this.signer.sign(signableBytes(signed), {
          did: signed.issuer.did,
          agentId: signed.issuer.id,
        })
        signed.evidence = { ...(signed.evidence ?? { source: 'dsh' }), signature: base64url(raw) }
      } catch (error) {
        this.unsignedCount += 1
        this.logger.warn('iflow: could not sign an event; journaling it unsigned', error)
      }
    } else {
      this.unsignedCount += 1
    }

    // Durable first, in-memory second: a projection may never show a fact the
    // journal does not have.
    await this.ports.storage.append(this.paths.origin, `${JSON.stringify(signed)}\n`)

    this.events.push(signed as AnyIFlowEvent)
    this.checkpoint.lastSeq = seq
    this.checkpoint.lastEventId = event.id
    this.checkpoint.updatedAt = this.ports.clock.nowIso()
    await this.persistCheckpoint()

    for (const subscriber of this.subscribers) {
      try {
        subscriber(signed as AnyIFlowEvent)
      } catch (error) {
        this.logger.error('iflow: journal subscriber threw', error)
      }
    }

    return signed as AnyIFlowEvent
  }

  /** Mark everything up to `seq` as accepted by a Community. */
  async markSynced(seq: number): Promise<void> {
    if (seq <= this.checkpoint.syncedSeq) return
    this.checkpoint.syncedSeq = Math.min(seq, this.checkpoint.lastSeq)
    this.checkpoint.updatedAt = this.ports.clock.nowIso()
    await this.persistCheckpoint()
  }

  private async persistCheckpoint(): Promise<void> {
    await this.ports.storage.write(this.paths.checkpoint, `${JSON.stringify(this.checkpoint, null, 2)}\n`)
  }

  subscribe(handler: (event: AnyIFlowEvent) => void): Disposable {
    this.subscribers.add(handler)
    return { dispose: () => this.subscribers.delete(handler) }
  }
}

/**
 * Drop undefined-valued keys before serializing.
 *
 * JSON.stringify already omits them, but doing it explicitly keeps the written
 * line identical to the object a canonicalizer would sign.
 */
function stripUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
