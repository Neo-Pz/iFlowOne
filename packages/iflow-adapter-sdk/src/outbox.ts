/**
 * The outbox — signed facts waiting for a Community to accept them.
 *
 * This generalizes the plugin's original `mailbox.json` (which queued A2A
 * prompts only) into an event outbox backed by the Origin Journal.
 *
 * The property that matters: a successful upload whose acknowledgement is lost
 * must not create a second accepted fact when the retry lands. That is why the
 * queue is keyed by the event's own id — the retry re-sends the same identity,
 * and any correct sink deduplicates on it.
 */

import type { AnyIFlowEvent } from 'iflow-domain'

import type { EdgePaths } from './paths.js'
import type { ClockPort, LoggerPort, StoragePort } from './ports.js'

export type OutboxState = 'queued' | 'delivered'

export interface OutboxEntry {
  /** The event's own id. The dedup key end to end. */
  eventId: string
  seq: number
  state: OutboxState
  attempts: number
  queuedAt: string
  lastAttemptAt?: string
  deliveredAt?: string
  lastError?: string
}

/** Where accepted events go. Implemented by a Community client, absent while offline. */
export interface SyncSink {
  /**
   * Publish a batch. A sink MUST be idempotent on `event.id`: re-publishing an
   * already-accepted event is a normal retry, not a new fact.
   */
  publish(events: AnyIFlowEvent[]): Promise<{ acceptedEventIds: string[] }>
}

export interface FlushResult {
  attempted: number
  delivered: number
  failed: number
  error?: string
}

export class Outbox {
  private entries = new Map<string, OutboxEntry>()
  private flushing = false

  private constructor(
    private readonly storage: StoragePort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
    private readonly paths: EdgePaths,
  ) {}

  static async open(
    storage: StoragePort,
    clock: ClockPort,
    logger: LoggerPort,
    paths: EdgePaths,
  ): Promise<Outbox> {
    const outbox = new Outbox(storage, clock, logger, paths)
    await outbox.load()
    return outbox
  }

  private async load(): Promise<void> {
    const raw = await this.storage.read(this.paths.outbox)
    if (!raw) return
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const entry = JSON.parse(trimmed) as OutboxEntry
        if (typeof entry.eventId !== 'string') continue
        // Later lines supersede earlier ones: the file is a log of state
        // changes, compacted on the next write.
        this.entries.set(entry.eventId, entry)
      } catch {
        this.logger.warn('iflow: skipped an unreadable outbox line')
      }
    }
  }

  /** Queue a fact for upload. Enqueuing the same event twice is a no-op. */
  async enqueue(event: AnyIFlowEvent): Promise<void> {
    if (this.entries.has(event.id)) return
    const entry: OutboxEntry = {
      eventId: event.id,
      seq: event.origin.seq,
      state: 'queued',
      attempts: 0,
      queuedAt: this.clock.nowIso(),
    }
    this.entries.set(event.id, entry)
    await this.storage.append(this.paths.outbox, `${JSON.stringify(entry)}\n`)
  }

  pending(): OutboxEntry[] {
    return [...this.entries.values()].filter((entry) => entry.state === 'queued').sort((a, b) => a.seq - b.seq)
  }

  delivered(): OutboxEntry[] {
    return [...this.entries.values()].filter((entry) => entry.state === 'delivered')
  }

  isDelivered(eventId: string): boolean {
    return this.entries.get(eventId)?.state === 'delivered'
  }

  /**
   * Try to hand every queued event to the sink.
   *
   * `resolveEvent` reads the body out of the Journal rather than the outbox
   * holding a second copy: the Journal is the only place a fact lives.
   */
  async flush(sink: SyncSink, resolveEvent: (eventId: string) => AnyIFlowEvent | undefined): Promise<FlushResult> {
    if (this.flushing) return { attempted: 0, delivered: 0, failed: 0, error: 'flush already in progress' }
    this.flushing = true
    try {
      const queued = this.pending()
      if (queued.length === 0) return { attempted: 0, delivered: 0, failed: 0 }

      const batch: AnyIFlowEvent[] = []
      for (const entry of queued) {
        const event = resolveEvent(entry.eventId)
        if (event) batch.push(event)
        else this.logger.warn(`iflow: outbox references an event not in the journal: ${entry.eventId}`)
      }
      if (batch.length === 0) return { attempted: 0, delivered: 0, failed: 0 }

      const now = this.clock.nowIso()
      for (const event of batch) {
        const entry = this.entries.get(event.id)
        if (entry) {
          entry.attempts += 1
          entry.lastAttemptAt = now
        }
      }

      try {
        const { acceptedEventIds } = await sink.publish(batch)
        await this.markDelivered(acceptedEventIds)
        return {
          attempted: batch.length,
          delivered: acceptedEventIds.length,
          failed: batch.length - acceptedEventIds.length,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        for (const event of batch) {
          const entry = this.entries.get(event.id)
          if (entry) entry.lastError = message
        }
        await this.compact()
        // Everything stays queued: an upload we cannot confirm is an upload
        // that has not happened, and the retry is safe because the sink
        // deduplicates on event id.
        return { attempted: batch.length, delivered: 0, failed: batch.length, error: message }
      }
    } finally {
      this.flushing = false
    }
  }

  /** Idempotent: acknowledging the same event twice changes nothing. */
  async markDelivered(eventIds: readonly string[]): Promise<void> {
    let changed = false
    const now = this.clock.nowIso()
    for (const eventId of eventIds) {
      const entry = this.entries.get(eventId)
      if (!entry || entry.state === 'delivered') continue
      entry.state = 'delivered'
      entry.deliveredAt = now
      entry.lastError = undefined
      changed = true
    }
    if (changed) await this.compact()
  }

  /** Rewrite the file as one line per event, dropping superseded states. */
  private async compact(): Promise<void> {
    const lines = [...this.entries.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((entry) => JSON.stringify(entry))
      .join('\n')
    await this.storage.write(this.paths.outbox, lines.length > 0 ? `${lines}\n` : '')
  }
}
