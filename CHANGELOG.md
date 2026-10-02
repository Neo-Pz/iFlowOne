# Changelog

Pre-1.0. Breaking changes ship in minor versions and are listed here.

## Unreleased — Connect boundaries and ARD discovery

- Shared conversation policy, explicit-host discovery services, A2A RPC/text
  helpers and node-scoped Agent address helpers now live in Connect.
- `AgentRuntimePort` exposes enumerate/describe/execute/status/cancel with
  explicit local authorization and identity rechecks; host-specific execution
  remains in each connector.
- ARD v0.91 profiles and private search Intent/View contracts are additive.
  Public profiles require explicit consent and the selected Agent's signature.
- Private conversation sync and list metadata may carry an exact peer DID.
  Community public indexes use node-scoped references; consumers must retain
  local IDs and DIDs for transport rather than send a public reference as a
  host-local ID.
- Local repository directories are `iflow-connect`, `iflowone-community` and
  `iflow-dsh-plugin`. Published packages, GitHub remotes and production
  deployments have not been renamed or released.

## 0.7.0 — principle 0: only an Agent acts on the network

**Every network action is performed by an Agent.** A person originates intent
and authority and never a network fact. See
[`docs/principles.md`](docs/principles.md) §0.

This is the first release where that reaches the wire contract, so it breaks
three things at once. All three break loudly at the type level except the last
one, which is called out below because it does not.

### Breaking: a fact may only be issued by an Agent

```diff
-IFlowIssuer.kind: 'agent' | 'human' | 'system'
+IFlowIssuer.kind: 'agent'
```

`system` goes for the same reason as `human`: an issuer named the Community or
the runtime is an action with no accountable Agent behind it. The default
issuer in `OriginJournal.appendNow` was `system` while already carrying the
edge's own agent id and DID — it was an Agent in every field but the label,
and it is now labelled correctly.

- A person belongs in `principalId`, which is the authority the Agent acted
  under. `RuntimeObserver.goalCreated`'s `issuer` is now optional and defaults
  to the edge's own Agent; both existing callers were handing it a person.
- `IFlowEvent.issuer` is typed `IFlowStoredIssuer`, which still admits the
  legacy kinds. See "reading is looser than writing" below.
- `validateEvent(event, { emitting: true })` enforces the narrow rule.
  `IFLOW_EMITTED_EVENT_SCHEMA` says the same thing to any service that speaks
  JSON Schema; `IFLOW_EVENT_SCHEMA` remains the read-side document.

### Breaking: acceptance splits the actor from the decision

One field was answering two questions, and got both wrong when a person
clicked Accept — the actor field held a person's id, so the reducer's
self-acceptance check compared it against an Agent id, could never match, and
never fired on exactly that path.

```diff
 'delivery.accepted': {
-  decidedBy: string
-  decidedByKind: 'agent' | 'human'
+  acceptedByAgentId: string
+  decidedBy: 'human' | 'policy'
 }
 'delivery.rejected': {
-  decidedBy: string
-  decidedByKind: 'agent' | 'human'
+  rejectedByAgentId: string
+  decidedBy: 'human' | 'policy'
 }
-'conversation.accepted': { acceptedBy, decidedBy }
+'conversation.accepted': { acceptedByAgentId, decidedBy }
-'conversation.rejected': { rejectedBy, decidedBy }
+'conversation.rejected': { rejectedByAgentId, decidedBy }
 'approval.resolved': {
+  decidedBy: 'human' | 'policy'   // new, required
 }
-Acceptance { decidedBy: string; decidedByKind }
+Acceptance { ruledByAgentId: string; decidedBy: 'human' | 'policy' }
+Approval  { decidedBy?: 'human' | 'policy' }
```

`approval.resolved` gains a required field because the previous release
recorded "a person allowed this tool call" by naming them as the event's
issuer. That is exactly what is no longer allowed, and the information is
worth keeping — it just was never a fact about the actor.

`quote.accepted.acceptedBy` is deliberately unchanged: its payload is
countersigned, and it carries no decision origin to conflate.

`AcceptanceDecider` moved from `event-types.ts` to `objects.ts`. It is
re-exported from the package root, so only deep imports are affected.

### Breaking, and silent: `ActivityEntry.actorKind`

```diff
-actorKind: 'agent' | 'human' | 'system'
+actorKind: 'agent' | 'legacy'
+legacyActorKind?: 'human' | 'system'
+principalId?: string
+contentOrigin?: 'human' | 'agent'
```

**Grep your consumer for `actorKind === 'human'` before upgrading.** Those
comparisons become permanently false rather than failing to compile, so a
human-authored message stops being recognized as human-authored and nothing
reports it.

The replacement is three fields, because they are three different questions:

| | |
| --- | --- |
| `actorId` / `actorKind` | who acted on the network. An Agent. |
| `principalId` | whose authority it acted under. |
| `contentOrigin` | who produced the words, where there are words. |

Those three are what a UI renders as `👤 You · via GenOnA`. Dropping the
person from the view would be the opposite error from the one principle 0
fixes: a person is not the network actor, and a person still leaves a trace.

### Reading is looser than writing

`validateEvent(event)` still accepts `human` and `system` issuers, and
`isLegacyIssuer` marks them. This is not a promise to keep old journals — see
the upgrade note below — it is a safety net, so a journal that nobody
remembered to clear opens and is marked rather than having its lines silently
dropped as corrupt.

## Upgrading from 0.6.0

The recommended path at pre-1.0 is **discard, not migrate**. There is no
translation for a 0.6.0 fact whose only record of the acting party is a
`human` issuer, and inventing an Agent for it would be forging the thing a
journal exists to preserve.

1. Upgrade every reader first, then every writer. A 0.6.0 reader fed a 0.7.0
   `delivery.accepted` finds the string `'human'` where it expects an agent
   id, records it as the actor, and reports nothing. Readers must understand
   the new shape before writers begin producing it.
2. Clear the Origin Journal on every node (`.iflow/edge/`), and clear the
   Accepted Journal on the Community. Both, or neither: an edge that restarts
   from seq 0 while the Community still holds its old rows will collide on
   `origin.seq`.
3. Restart each node and confirm it has selected a workspace before checking
   anything else.

Nothing in this repository stores product data. `fixtures/slice-events.*` is
generated — run `pnpm fixtures` to rebuild it.
