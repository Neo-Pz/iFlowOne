# iFlowOne

The iFlow core: **Agent Network Ontology + Event Semantics + Event Journal + Projection Model.**

iFlow is not a deployment, a plugin, or a transport. It is a domain and event
system whose facts can be produced on any runtime, kept locally, synchronized
between nodes, and read through the same projections wherever they are hosted.

```
Runtime -> Adapter -> iFlow Domain Core -> Origin Journal -> Local Projection -> Embedded Hub
                                     |
                                     +-> Sync -> Global Accepted Journal -> Global Projection -> Web
```

> **Pre-1.0. The contract is not frozen.**
> Event types, payload shapes and view contracts will change without notice
> until 1.0, and changes may be breaking. Licensed under Apache-2.0 so you can
> build against it today — pin an exact version if you do.

The full design baseline is
[`IFLOWONE-ARCHITECTURE.md`](https://github.com/Neo-Pz/dsh/blob/main/IFLOWONE-ARCHITECTURE.md)
in the reference adapter's repository.

## Packages

| Package | Owns | Never owns |
| --- | --- | --- |
| [`iflow-domain`](https://www.npmjs.com/package/iflow-domain) | Agent, Goal, Task, Room, Event; state machines, reducers, projectors, read-model contracts | transport, runtime code, deployment |
| [`iflow-protocol`](https://www.npmjs.com/package/iflow-protocol) | envelopes, canonical serialization, signature ports, JSON Schema, version negotiation | domain state rules |
| [`iflow-adapter-sdk`](https://www.npmjs.com/package/iflow-adapter-sdk) | Origin Journal, outbox, command ledger, local projection, and the `RuntimePorts` contract every host implements | global acceptance, UI |
Dependencies run one way: `protocol <- domain <- adapter-sdk`. Nothing here
depends on a runtime, a deployment, or a network service.

## What is deliberately not here

The Hub UI, the Web app, and the future Community service — global journal,
cross-node projections, reputation, market aggregation — are product surfaces
and live in a separate, private repository.

The line is drawn by what a participant needs in order to *join and verify*,
versus what iFlowOne offers as a *service*:

- **Here, open**: everything an Agent runtime needs to speak the protocol,
  emit facts, and audit exactly what an adapter observes, transmits and will
  execute on its behalf. No vendor should install an adapter into their
  runtime on trust, so the code that decides what leaves a machine — the
  outbox, the read API, the command executor, the settlement visibility
  filter — is readable by the party relying on it.
- **Not here, closed**: aggregation across nodes, and the data itself.

## Integrating iFlow into an application

```bash
npm i iflow-adapter-sdk
```

The whole contract is `iflow-adapter-sdk/src/ports.ts`. A host provides
storage, subprocess, HTTP, clock, logger and id ports; iFlow provides
everything above them.

```ts
import { createEdge } from 'iflow-adapter-sdk'

const edge = await createEdge({
  ports,        // your application's implementations
  descriptor,   // who this node is
})

edge.observer.taskStarted({ taskId, agentId })   // report what your runtime did
edge.views.network()                             // read the projection
```

The host never touches the journal format, the envelope, or the projection
algebra. A new host proves itself by passing
`packages/iflow-adapter-sdk/test/conformance.test.ts` against its own ports —
the in-memory reference host in `iflow-adapter-sdk/testing` shows the shape.

**→ [Writing an iFlow adapter](docs/writing-an-adapter.md)** — the six ports,
how to decide what in your runtime is a Task, the rules that are not
negotiable, and a minimal adapter you can run.

`../iflow-dsh-plugin` is the first such adapter (DeepSeek Harness). Its entire
runtime coupling lives in four files:

| File | Answers |
| --- | --- |
| `src/runtime/dsh-ports.ts` | how this host does storage, subprocess, HTTP, time |
| `src/runtime/dsh-instrumentation.ts` | which runtime events mean which domain facts |
| `src/runtime/dsh-command-executor.ts` | how an inbound command is enforced, or refused |
| `src/identity/iflow-id.ts` | who holds the key and signs |

Nothing else in the core knows DSH exists.

## Building

```bash
pnpm install
pnpm build          # protocol, domain and adapter-sdk
pnpm fixtures       # regenerate the golden event stream
```

`fixtures/slice-events.json` is a complete, schema-valid event stream produced
by driving the real SDK — never hand-written — so anything built against it
keeps working when real facts arrive.

## Tests

```bash
pnpm test
```

Covers the domain state machine and projectors, canonical serialization and
event signing (checked byte-for-byte against the real Rust `iflow-id` signer
when that binary is present), and the adapter conformance suite — which encodes
the architecture's five failure tests:

- a Community outage never stops local work
- a lost acknowledgement after a successful upload creates no second fact
- repeated delivery of one command produces at most one side effect
- deleting every projection and rebuilding reproduces the same state
- a malformed or expired request is refused at the origin edge

Origin signing is part of the contract: `OriginJournal` signs each fact over
`signableBytes(event)` — the envelope minus the fields a receiver may add, and
minus the signature itself — so an event verifies exactly as it was written,
and still verifies after a Community stamps `journalOffset` and `observedAt`.

## Status

First vertical slice: real runtime facts -> Origin Journal -> Local Projection
-> Hub, with a command path back and a Replay view over the journal. There is deliberately **no Community service yet**; the Web app reads a
local edge or a fixture feed, and the global journal, directory, federation and
economic layers come after the slice is real.
