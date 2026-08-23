/**
 * RuntimeObserver — the surface a host adapter actually calls.
 *
 * A host integrating iFlow should not have to learn the event envelope, the
 * correlation rules, or the journal's sequencing. It reports what its runtime
 * did in its own vocabulary ("this subagent started", "this tool finished")
 * and this class turns that into signed-able, ordered domain facts.
 *
 * Everything here is additive: an observer call never blocks, cancels or
 * alters the host's work. Observation must not become a control path.
 */

import type {
  AgentCoordination,
  AgentExecution,
  AgentPresence,
  AnyIFlowEvent,
  SettlementVisibility,
  TrustEvidence,
} from 'iflow-domain'
import type { IFlowIssuer } from 'iflow-protocol'

import type { OriginJournal } from './origin-journal.js'
import type { IdPort, LoggerPort, RuntimeDescriptor } from './ports.js'

export interface ObserverContext {
  /** Ties every fact in one flow together. Auto-derived from the task when omitted. */
  correlationId?: string
  causationId?: string
  goalId?: string
  roomId?: string
  occurredAt?: string
  issuer?: IFlowIssuer
}

export class RuntimeObserver {
  /** taskId -> correlationId, so a whole flow shares one id without the host tracking it. */
  private correlations = new Map<string, string>()

  constructor(
    private readonly journal: OriginJournal,
    private readonly descriptor: RuntimeDescriptor,
    private readonly ids: IdPort,
    private readonly logger: LoggerPort,
  ) {}

  /**
   * The correlation id for a task, minted on first sight.
   *
   * Exposed so a host can stamp the same id onto its own traces: one Task
   * execution maps to one trace, and a shared correlation is what makes the
   * journal and the trace store line up later.
   */
  correlationFor(taskId: string): string {
    const existing = this.correlations.get(taskId)
    if (existing) return existing
    const created = this.ids.newId('corr')
    this.correlations.set(taskId, created)
    return created
  }

  /** Forget a finished flow so a long-lived edge does not grow without bound. */
  releaseCorrelation(taskId: string): void {
    this.correlations.delete(taskId)
  }

  /**
   * The issuer stamp for an event an Agent produced.
   *
   * The DID matters: a verifier checks the signature against it, and an event
   * that carries none can be recorded but never proven off-node. A declared
   * Agent has its own key, so its own DID is attached; `selfAgentId` keeps the
   * edge's DID; anything else — a session, a peer label — has no key and is
   * honestly left without one.
   */
  private agentIssuer(agentId: string): IFlowIssuer {
    const declared = this.descriptor.agentDids?.[agentId]
    const did = declared ?? (agentId === this.descriptor.selfAgentId ? this.descriptor.did : undefined)
    return { id: agentId, did, kind: 'agent' }
  }

  /** Record, but never let an observation failure break the host's work. */
  private async safely(what: string, run: () => Promise<AnyIFlowEvent>): Promise<AnyIFlowEvent | undefined> {
    try {
      return await run()
    } catch (error) {
      this.logger.error(`iflow: failed to journal ${what}`, error)
      return undefined
    }
  }

  agentRegistered(input: {
    agentId: string
    label: string
    capabilities?: string[]
    did?: string
    trustEvidence?: TrustEvidence[]
    context?: ObserverContext
  }): Promise<AnyIFlowEvent | undefined> {
    return this.safely('agent.registered', () =>
      this.journal.record({
        type: 'agent.registered',
        subject: { kind: 'agent', id: input.agentId },
        issuer: input.context?.issuer ?? this.agentIssuer(input.agentId),
        payload: {
          label: input.label,
          did: input.did,
          nodeId: this.descriptor.nodeId,
          runtimeKind: this.descriptor.runtimeKind,
          capabilities: input.capabilities ?? [],
          trustEvidence: input.trustEvidence,
        },
        ...spread(input.context),
      }),
    )
  }

  agentPresenceChanged(input: {
    agentId: string
    presence?: AgentPresence
    execution?: AgentExecution
    coordination?: AgentCoordination
    context?: ObserverContext
  }): Promise<AnyIFlowEvent | undefined> {
    return this.safely('agent.presence_changed', () =>
      this.journal.record({
        type: 'agent.presence_changed',
        subject: { kind: 'agent', id: input.agentId },
        issuer: input.context?.issuer ?? this.agentIssuer(input.agentId),
        payload: {
          presence: input.presence,
          execution: input.execution,
          coordination: input.coordination,
        },
        ...spread(input.context),
      }),
    )
  }

  goalCreated(input: {
    goalId: string
    title: string
    issuer: IFlowIssuer
    constraints?: string[]
    budget?: { currency: string; limit: number }
    roomId?: string
    context?: ObserverContext
  }): Promise<AnyIFlowEvent | undefined> {
    return this.safely('goal.created', () =>
      this.journal.record({
        type: 'goal.created',
        subject: { kind: 'goal', id: input.goalId },
        issuer: input.issuer,
        goalId: input.goalId,
        payload: {
          title: input.title,
          constraints: input.constraints,
          budget: input.budget,
          roomId: input.roomId,
        },
        ...spread(input.context),
      }),
    )
  }

  taskCreated(input: {
    taskId: string
    title: string
    parentTaskId?: string
    dependsOn?: string[]
    ownerAgentId?: string
    goalId?: string
    roomId?: string
    context?: ObserverContext
  }): Promise<AnyIFlowEvent | undefined> {
    return this.taskEvent('task.created', input.taskId, input.context, {
      title: input.title,
      parentTaskId: input.parentTaskId,
      dependsOn: input.dependsOn,
      ownerAgentId: input.ownerAgentId,
    }, { goalId: input.goalId, roomId: input.roomId })
  }

  taskDelegated(input: {
    taskId: string
    toAgentId: string
    fromAgentId?: string
    reason?: string
    context?: ObserverContext
  }): Promise<AnyIFlowEvent | undefined> {
    return this.taskEvent('task.delegated', input.taskId, input.context, {
      toAgentId: input.toAgentId,
      fromAgentId: input.fromAgentId,
      reason: input.reason,
    })
  }

  taskStarted(input: {
    taskId: string
    agentId: string
    attemptId?: string
    context?: ObserverContext
  }): Promise<AnyIFlowEvent | undefined> {
    return this.taskEvent('task.started', input.taskId, input.context, {
      agentId: input.agentId,
      attemptId: input.attemptId ?? this.ids.newId('attempt'),
    })
  }

  taskWaiting(input: { taskId: string; reason: string; context?: ObserverContext }): Promise<AnyIFlowEvent | undefined> {
    return this.taskEvent('task.waiting', input.taskId, input.context, { reason: input.reason })
  }

  taskBlocked(input: {
    taskId: string
    reason: string
    blockedOnTaskId?: string
    context?: ObserverContext
  }): Promise<AnyIFlowEvent | undefined> {
    return this.taskEvent('task.blocked', input.taskId, input.context, {
      reason: input.reason,
      blockedOnTaskId: input.blockedOnTaskId,
    })
  }

  taskAwaitingApproval(input: {
    taskId: string
    approvalId: string
    reason: string
    context?: ObserverContext
  }): Promise<AnyIFlowEvent | undefined> {
    return this.taskEvent('task.awaiting_approval', input.taskId, input.context, {
      approvalId: input.approvalId,
      reason: input.reason,
    })
  }

  taskCompleted(input: {
    taskId: string
    summary?: string
    outputs?: { kind: 'artifact' | 'message'; id: string; summary: string }[]
    context?: ObserverContext
  }): Promise<AnyIFlowEvent | undefined> {
    return this.taskEvent('task.completed', input.taskId, input.context, {
      summary: input.summary,
      outputs: input.outputs,
    })
  }

  taskFailed(input: { taskId: string; reason: string; context?: ObserverContext }): Promise<AnyIFlowEvent | undefined> {
    return this.taskEvent('task.failed', input.taskId, input.context, { reason: input.reason })
  }

  roomCreated(input: {
    roomId: string
    title: string
    goalId?: string
    rootTaskId?: string
    context?: ObserverContext
  }): Promise<AnyIFlowEvent | undefined> {
    return this.safely('room.created', () =>
      this.journal.record({
        type: 'room.created',
        subject: { kind: 'room', id: input.roomId },
        roomId: input.roomId,
        goalId: input.goalId,
        payload: { title: input.title, goalId: input.goalId, rootTaskId: input.rootTaskId },
        ...spread(input.context),
      }),
    )
  }

  roomParticipantJoined(input: {
    roomId: string
    agentId: string
    context?: ObserverContext
  }): Promise<AnyIFlowEvent | undefined> {
    return this.safely('room.participant_joined', () =>
      this.journal.record({
        type: 'room.participant_joined',
        subject: { kind: 'room', id: input.roomId },
        roomId: input.roomId,
        payload: { agentId: input.agentId },
        ...spread(input.context),
      }),
    )
  }

  toolCallStarted(input: {
    callId: string
    toolName: string
    agentId: string
    taskId?: string
    argumentsDigest?: string
    context?: ObserverContext
  }): Promise<AnyIFlowEvent | undefined> {
    return this.safely('tool.call_started', () =>
      this.journal.record({
        type: 'tool.call_started',
        subject: input.taskId ? { kind: 'task', id: input.taskId } : { kind: 'agent', id: input.agentId },
        issuer: input.context?.issuer ?? this.agentIssuer(input.agentId),
        taskId: input.taskId,
        correlationId: input.context?.correlationId ?? (input.taskId ? this.correlationFor(input.taskId) : undefined),
        payload: {
          callId: input.callId,
          toolName: input.toolName,
          agentId: input.agentId,
          argumentsDigest: input.argumentsDigest,
        },
        ...spreadWithoutCorrelation(input.context),
      }),
    )
  }

  toolCallCompleted(input: {
    callId: string
    toolName: string
    outcome: 'ok' | 'error' | 'denied'
    agentId: string
    taskId?: string
    errorMessage?: string
    context?: ObserverContext
  }): Promise<AnyIFlowEvent | undefined> {
    return this.safely('tool.call_completed', () =>
      this.journal.record({
        type: 'tool.call_completed',
        subject: input.taskId ? { kind: 'task', id: input.taskId } : { kind: 'agent', id: input.agentId },
        issuer: input.context?.issuer ?? this.agentIssuer(input.agentId),
        taskId: input.taskId,
        correlationId: input.context?.correlationId ?? (input.taskId ? this.correlationFor(input.taskId) : undefined),
        payload: {
          callId: input.callId,
          toolName: input.toolName,
          outcome: input.outcome,
          errorMessage: input.errorMessage,
        },
        ...spreadWithoutCorrelation(input.context),
      }),
    )
  }

  approvalRequested(input: {
    approvalId: string
    agentId: string
    reason: string
    toolName?: string
    taskId?: string
    context?: ObserverContext
  }): Promise<AnyIFlowEvent | undefined> {
    return this.safely('approval.requested', () =>
      this.journal.record({
        type: 'approval.requested',
        subject: input.taskId ? { kind: 'task', id: input.taskId } : { kind: 'agent', id: input.agentId },
        issuer: input.context?.issuer ?? this.agentIssuer(input.agentId),
        taskId: input.taskId,
        correlationId: input.context?.correlationId ?? (input.taskId ? this.correlationFor(input.taskId) : undefined),
        payload: {
          approvalId: input.approvalId,
          toolName: input.toolName,
          reason: input.reason,
          agentId: input.agentId,
        },
        ...spreadWithoutCorrelation(input.context),
      }),
    )
  }

  approvalResolved(input: {
    approvalId: string
    decision: 'allowed' | 'rejected' | 'cancelled' | 'unavailable'
    agentId: string
    taskId?: string
    context?: ObserverContext
  }): Promise<AnyIFlowEvent | undefined> {
    return this.safely('approval.resolved', () =>
      this.journal.record({
        type: 'approval.resolved',
        subject: input.taskId ? { kind: 'task', id: input.taskId } : { kind: 'agent', id: input.agentId },
        taskId: input.taskId,
        correlationId: input.context?.correlationId ?? (input.taskId ? this.correlationFor(input.taskId) : undefined),
        payload: { approvalId: input.approvalId, decision: input.decision },
        ...spreadWithoutCorrelation(input.context),
      }),
    )
  }

  a2aRequestReceived(input: {
    remoteTaskId: string
    fromDid?: string
    fromLabel?: string
    grantRef?: string
    context?: ObserverContext
  }): Promise<AnyIFlowEvent | undefined> {
    return this.safely('a2a.request_received', () =>
      this.journal.record({
        type: 'a2a.request_received',
        subject: { kind: 'task', id: input.remoteTaskId },
        taskId: input.remoteTaskId,
        correlationId: input.context?.correlationId ?? this.correlationFor(input.remoteTaskId),
        payload: {
          remoteTaskId: input.remoteTaskId,
          fromDid: input.fromDid,
          fromLabel: input.fromLabel,
          grantRef: input.grantRef,
        },
        evidence: { source: 'a2a' },
        ...spreadWithoutCorrelation(input.context),
      }),
    )
  }

  attemptStarted(input: {
    taskId: string
    attemptId: string
    agentId: string
    traceId?: string
    context?: ObserverContext
  }): Promise<AnyIFlowEvent | undefined> {
    return this.taskEvent('execution.attempt_started', input.taskId, input.context, {
      attemptId: input.attemptId,
      agentId: input.agentId,
      traceId: input.traceId,
    })
  }

  attemptFinished(input: {
    taskId: string
    attemptId: string
    outcome: 'succeeded' | 'failed' | 'cancelled'
    context?: ObserverContext
  }): Promise<AnyIFlowEvent | undefined> {
    return this.taskEvent('execution.attempt_finished', input.taskId, input.context, {
      attemptId: input.attemptId,
      outcome: input.outcome,
    })
  }

  /**
   * Offer a price for a Task.
   *
   * The returned event is the one a counterparty must countersign, so callers
   * keep it: `countersignPayloadFor(offer)` turns it into the fields the
   * acceptance needs.
   */
  quoteOffered(input: {
    taskId: string
    quoteId: string
    offeredBy: string
    offeredTo: string
    /** Integer micro-units. 1_500_000 = 1.50 of the currency. */
    amountMicros: number
    currency?: string
    capability?: string
    expiresAt: string
    terms?: string
    context?: ObserverContext
  }): Promise<AnyIFlowEvent | undefined> {
    return this.taskEvent('quote.offered', input.taskId, input.context, {
      quoteId: input.quoteId,
      offeredBy: input.offeredBy,
      offeredTo: input.offeredTo,
      amountMicros: Math.round(input.amountMicros),
      currency: input.currency ?? 'USD',
      capability: input.capability,
      expiresAt: input.expiresAt,
      terms: input.terms,
    })
  }

  /**
   * Accept an offer, countersigning it.
   *
   * `offerEventId` and `offerSignature` must come from the offer event itself
   * — see `countersignPayloadFor` in iflow-protocol. An acceptance that does
   * not quote the offer's own signature is a one-sided claim.
   */
  quoteAccepted(input: {
    taskId: string
    quoteId: string
    acceptedBy: string
    offerEventId: string
    offerSignature: string
    context?: ObserverContext
  }): Promise<AnyIFlowEvent | undefined> {
    return this.taskEvent('quote.accepted', input.taskId, input.context, {
      quoteId: input.quoteId,
      acceptedBy: input.acceptedBy,
      offerEventId: input.offerEventId,
      offerSignature: input.offerSignature,
    })
  }

  /**
   * Record what actually changed hands.
   *
   * `visibility` defaults to `private`: publishing a counterparty's commercial
   * terms is a decision the parties make, not a default the protocol imposes.
   */
  taskSettled(input: {
    taskId: string
    payerAgentId: string
    payeeAgentId: string
    amountMicros: number
    currency?: string
    quoteId?: string
    visibility?: SettlementVisibility
    basis?: 'quote' | 'metered' | 'negotiated'
    settlementRef?: string
    context?: ObserverContext
  }): Promise<AnyIFlowEvent | undefined> {
    return this.taskEvent('task.settled', input.taskId, input.context, {
      quoteId: input.quoteId,
      payerAgentId: input.payerAgentId,
      payeeAgentId: input.payeeAgentId,
      amountMicros: Math.round(input.amountMicros),
      currency: input.currency ?? 'USD',
      visibility: input.visibility ?? 'private',
      basis: input.basis ?? (input.quoteId ? 'quote' : 'negotiated'),
      settlementRef: input.settlementRef,
    })
  }

  usageRecorded(input: {
    taskId: string
    model: string
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
    costMicros: number
    currency?: string
    priceSource?: string
    context?: ObserverContext
  }): Promise<AnyIFlowEvent | undefined> {
    // Integers only: the canonical form rejects floats so two languages can
    // sign the same bytes. Callers converting from a float cost must round.
    return this.taskEvent('usage.recorded', input.taskId, input.context, {
      model: input.model,
      tokens: {
        input: Math.round(input.tokens.input),
        output: Math.round(input.tokens.output),
        cacheRead: Math.round(input.tokens.cacheRead),
        cacheWrite: Math.round(input.tokens.cacheWrite),
      },
      costMicros: Math.round(input.costMicros),
      currency: input.currency ?? 'USD',
      priceSource: input.priceSource ?? 'unknown',
    })
  }

  private taskEvent<P>(
    type: Parameters<OriginJournal['record']>[0]['type'],
    taskId: string,
    context: ObserverContext | undefined,
    payload: P,
    extra: { goalId?: string; roomId?: string } = {},
  ): Promise<AnyIFlowEvent | undefined> {
    return this.safely(type, () =>
      this.journal.record({
        type,
        subject: { kind: 'task', id: taskId },
        taskId,
        goalId: context?.goalId ?? extra.goalId,
        roomId: context?.roomId ?? extra.roomId,
        correlationId: context?.correlationId ?? this.correlationFor(taskId),
        payload: payload as never,
        ...spreadWithoutCorrelation(context),
      }),
    )
  }
}

/** Copy the optional envelope fields a caller may override. */
function spread(context: ObserverContext | undefined): Record<string, unknown> {
  if (!context) return {}
  return {
    correlationId: context.correlationId,
    causationId: context.causationId,
    goalId: context.goalId,
    roomId: context.roomId,
    occurredAt: context.occurredAt,
  }
}

/** Same, minus `correlationId`, for call sites that already resolved it. */
function spreadWithoutCorrelation(context: ObserverContext | undefined): Record<string, unknown> {
  if (!context) return {}
  return {
    causationId: context.causationId,
    goalId: context.goalId,
    roomId: context.roomId,
    occurredAt: context.occurredAt,
  }
}
