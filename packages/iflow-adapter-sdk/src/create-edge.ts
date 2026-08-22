/**
 * `createEdge` — one call that turns a set of host ports into a live iFlow edge.
 *
 * This is the whole integration story for a new host:
 *
 *   const edge = await createEdge({ ports, descriptor })
 *   edge.observer.taskStarted({ taskId, agentId })   // report facts
 *   edge.views.network()                             // read projections
 *
 * The host supplies ports and calls the observer. It never touches the journal
 * format, the envelope, or the projection algebra.
 */

import type { AnyIFlowEvent } from 'iflow-domain'

import { CommandLedger } from './command-ledger.js'
import { mountEdgeServer, type EdgeServerOptions } from './edge-server.js'
import { LocalProjection } from './local-projection.js'
import { OriginJournal } from './origin-journal.js'
import { Outbox } from './outbox.js'
import { edgePaths, type EdgePaths } from './paths.js'
import { RuntimeObserver } from './observer.js'
import type {
  CommandExecutionOutcome,
  Disposable,
  RuntimeDescriptor,
  RuntimeExecutorPort,
  RuntimePorts,
} from './ports.js'
import type { IFlowCommand, Signer, Verifier } from 'iflow-protocol'
import { signableBytes, base64urlDecode } from 'iflow-protocol'

export interface CreateEdgeOptions {
  ports: RuntimePorts
  descriptor: RuntimeDescriptor
  /** Mount the read API on the host's HTTP server. Default true when a port exists. */
  serve?: boolean
  server?: EdgeServerOptions
  /**
   * Queue every recorded fact for a future Community. Default true: the outbox
   * is what makes an offline edge catch up later rather than lose history.
   */
  queueForSync?: boolean
  /** Announce this edge's own Agent on startup. Default true. */
  registerSelf?: boolean
  /** Sign every journaled fact at the origin. */
  signer?: Signer
  /** Check signatures on facts read back from the journal. */
  verifier?: Verifier
}

export interface IFlowEdge extends Disposable {
  readonly journal: OriginJournal
  readonly outbox: Outbox
  readonly commands: CommandLedger
  readonly views: LocalProjection
  readonly observer: RuntimeObserver
  readonly paths: EdgePaths
  readonly descriptor: RuntimeDescriptor
  /**
   * Run a command at most once, behind the host's own enforcement.
   * Returns the recorded outcome unchanged when the command was seen before.
   */
  dispatchCommand(command: IFlowCommand, executor: RuntimeExecutorPort): Promise<CommandExecutionOutcome>
  /** Rebuild the projection from the journal — the recovery path, and a test hook. */
  rebuildProjection(): void
  /**
   * Check the origin signatures on facts this node holds.
   *
   * An unsigned fact is reported as `unsigned`, not as a failure: it was
   * observed, it just cannot be proven off-node. Only a present-but-wrong
   * signature is a forgery.
   */
  verifyJournal(limit?: number): Promise<JournalVerification>
}

export interface JournalVerification {
  checked: number
  verified: number
  unsigned: number
  /** Facts whose signature is present and does not check out. */
  forged: { eventId: string; seq: number }[]
}

export async function createEdge(options: CreateEdgeOptions): Promise<IFlowEdge> {
  const { ports, descriptor } = options
  const paths = edgePaths(descriptor.workspaceRoot)

  const journal = await OriginJournal.open(ports, descriptor, { signer: options.signer })
  const outbox = await Outbox.open(ports.storage, ports.clock, ports.logger, paths)
  const commands = await CommandLedger.open(ports.storage, ports.clock, ports.logger, paths)

  const views = new LocalProjection(ports.clock)
  views.rebuild(journal.all())

  const observer = new RuntimeObserver(journal, descriptor, ports.ids, ports.logger)

  const disposables: Disposable[] = []
  const queueForSync = options.queueForSync ?? true

  disposables.push(
    journal.subscribe((event: AnyIFlowEvent) => {
      views.ingest(event)
      if (queueForSync) {
        // Fire and forget: a failed enqueue must not undo a durable fact. The
        // event is already in the journal, so a later flush can recover it.
        void outbox.enqueue(event).catch((error: unknown) => {
          ports.logger.warn('iflow: could not queue an event for sync', error)
        })
      }
    }),
  )

  if (ports.http && (options.serve ?? true)) {
    disposables.push(mountEdgeServer(ports.http, journal, views, ports.logger, options.server))
  }

  if (options.registerSelf ?? true) {
    // A restart is not a new registration. Re-announcing identical capabilities
    // on every boot would fill the journal with facts that assert nothing new
    // and make "when did this agent actually join the network?" unanswerable.
    // Coming back is a presence transition, which is exactly what the doc says
    // should be durable.
    const alreadyRegistered = journal
      .all()
      .some((event) => event.type === 'agent.registered' && event.subject.id === descriptor.selfAgentId)

    if (alreadyRegistered) {
      await observer.agentPresenceChanged({ agentId: descriptor.selfAgentId, presence: 'online', execution: 'idle' })
    } else {
      await observer.agentRegistered({
        agentId: descriptor.selfAgentId,
        label: descriptor.selfAgentLabel,
        capabilities: descriptor.capabilities,
        did: descriptor.did,
      })
    }
  }

  return {
    journal,
    outbox,
    commands,
    views,
    observer,
    paths,
    descriptor,
    async dispatchCommand(command, executor) {
      const result = await commands.dispatch(command, executor)
      if (result.duplicate) {
        ports.logger.warn(`iflow: ignored a duplicate delivery of command ${command.commandId}`)
      }
      return result.outcome
    },
    rebuildProjection() {
      views.rebuild(journal.all())
    },
    async verifyJournal(limit?: number) {
      const events = limit === undefined ? journal.all() : journal.all().slice(-limit)
      const result: JournalVerification = { checked: 0, verified: 0, unsigned: 0, forged: [] }
      const verifier = options.verifier
      for (const event of events) {
        result.checked += 1
        const signature = event.evidence?.signature
        if (!signature) {
          result.unsigned += 1
          continue
        }
        if (!verifier) continue
        const signerDid = event.issuer.did ?? descriptor.did
        const ok = signerDid
          ? await verifier.verify(signableBytes(event), base64urlDecode(signature), signerDid)
          : false
        if (ok) result.verified += 1
        else result.forged.push({ eventId: event.id, seq: event.origin.seq })
      }
      return result
    },
    dispose() {
      for (const disposable of disposables.reverse()) disposable.dispose()
    },
  }
}
