/**
 * The command ledger — at-most-once execution, across restarts.
 *
 * `CommandRequested -> CommandAccepted | CommandRejected -> ExecutionAttempt
 * -> Domain Events` is the required chain. This file owns the first arrow: it
 * decides whether a command is new, and it records the decision durably BEFORE
 * the executor runs, so a crash mid-execution can never be replayed as a fresh
 * command.
 *
 * Repeated delivery of one command — including redelivery after an
 * acknowledgement timeout — must never produce more than one real side effect.
 */

import type { IFlowCommand } from 'iflow-protocol'
import { validateCommand } from 'iflow-protocol'

import type { EdgePaths } from './paths.js'
import type {
  ClockPort,
  CommandExecutionOutcome,
  LoggerPort,
  RuntimeExecutorPort,
  StoragePort,
} from './ports.js'

export type CommandStatus = 'in_flight' | 'accepted' | 'rejected'

export interface CommandRecord {
  commandId: string
  idempotencyKey: string
  requestedAction: string
  status: CommandStatus
  receivedAt: string
  settledAt?: string
  attemptId?: string
  reason?: string
}

export interface CommandDispatchResult {
  outcome: CommandExecutionOutcome
  /** True when this delivery was a duplicate and no executor ran. */
  duplicate: boolean
  record: CommandRecord
}

export class CommandLedger {
  private byCommandId = new Map<string, CommandRecord>()
  private byIdempotencyKey = new Map<string, CommandRecord>()

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
  ): Promise<CommandLedger> {
    const ledger = new CommandLedger(storage, clock, logger, paths)
    await ledger.load()
    return ledger
  }

  private async load(): Promise<void> {
    const raw = await this.storage.read(this.paths.commands)
    if (!raw) return
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const record = JSON.parse(trimmed) as CommandRecord
        if (typeof record.commandId !== 'string') continue
        this.remember(record)
      } catch {
        this.logger.warn('iflow: skipped an unreadable command ledger line')
      }
    }

    // A command left `in_flight` by a crash is NOT retried automatically: we
    // cannot know whether its side effect landed, and guessing wrong is
    // exactly the duplicate-execution failure this ledger exists to prevent.
    for (const record of this.byCommandId.values()) {
      if (record.status !== 'in_flight') continue
      this.logger.warn(
        `iflow: command ${record.commandId} was interrupted mid-execution; it will not be retried automatically`,
      )
    }
  }

  private remember(record: CommandRecord): void {
    this.byCommandId.set(record.commandId, record)
    this.byIdempotencyKey.set(record.idempotencyKey, record)
  }

  private async persist(record: CommandRecord): Promise<void> {
    await this.storage.append(this.paths.commands, `${JSON.stringify(record)}\n`)
  }

  /** A previously seen command, by either dedup key. */
  lookup(command: Pick<IFlowCommand, 'commandId' | 'idempotencyKey'>): CommandRecord | undefined {
    return this.byCommandId.get(command.commandId) ?? this.byIdempotencyKey.get(command.idempotencyKey)
  }

  size(): number {
    return this.byCommandId.size
  }

  /**
   * Run a command exactly once.
   *
   * The executor is the host's local enforcement point: it verifies identity,
   * grant, budget and its own runtime policy, and it may refuse. Nothing here
   * can override that decision — this layer only guarantees the executor is
   * asked at most once per command.
   */
  async dispatch(command: IFlowCommand, executor: RuntimeExecutorPort): Promise<CommandDispatchResult> {
    const validation = validateCommand(command)
    if (!validation.valid) {
      const record: CommandRecord = {
        commandId: typeof command.commandId === 'string' ? command.commandId : 'malformed',
        idempotencyKey: typeof command.idempotencyKey === 'string' ? command.idempotencyKey : 'malformed',
        requestedAction: String(command.requestedAction ?? ''),
        status: 'rejected',
        receivedAt: this.clock.nowIso(),
        settledAt: this.clock.nowIso(),
        reason: `malformed command: ${validation.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`,
      }
      return { outcome: { accepted: false, reason: record.reason }, duplicate: false, record }
    }

    const existing = this.lookup(command)
    if (existing) {
      return {
        duplicate: true,
        record: existing,
        outcome:
          existing.status === 'accepted'
            ? { accepted: true, attemptId: existing.attemptId }
            : {
                accepted: false,
                reason:
                  existing.status === 'in_flight'
                    ? 'a previous delivery of this command was interrupted and will not be retried'
                    : (existing.reason ?? 'rejected'),
              },
      }
    }

    if (Date.parse(command.expiresAt) <= this.clock.now()) {
      const record: CommandRecord = {
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        requestedAction: command.requestedAction,
        status: 'rejected',
        receivedAt: this.clock.nowIso(),
        settledAt: this.clock.nowIso(),
        reason: 'command expired',
      }
      this.remember(record)
      await this.persist(record)
      return { outcome: { accepted: false, reason: record.reason }, duplicate: false, record }
    }

    // Claim the command durably before any side effect can happen.
    const record: CommandRecord = {
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      requestedAction: command.requestedAction,
      status: 'in_flight',
      receivedAt: this.clock.nowIso(),
    }
    this.remember(record)
    await this.persist(record)

    let outcome: CommandExecutionOutcome
    try {
      outcome = await executor.execute(command)
    } catch (error) {
      outcome = { accepted: false, reason: error instanceof Error ? error.message : String(error) }
    }

    record.status = outcome.accepted ? 'accepted' : 'rejected'
    record.settledAt = this.clock.nowIso()
    record.attemptId = outcome.attemptId
    record.reason = outcome.reason
    this.remember(record)
    await this.persist(record)

    return { outcome, duplicate: false, record }
  }
}
