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

The full design baseline is `../iflow-dsh-plugin/IFLOWONE-ARCHITECTURE.md`.

## Packages

| Package | Owns | Never owns |
| --- | --- | --- |
| `iflow-domain` | Agent, Goal, Task, Room, Event; state machines, reducers, projectors, read-model contracts | transport, runtime code, deployment |
| `iflow-protocol` | envelopes, canonical serialization, signature ports, JSON Schema, version negotiation | domain state rules |
| `iflow-adapter-sdk` | Origin Journal, outbox, command ledger, local projection, and the `RuntimePorts` contract every host implements | global acceptance, UI |
| `iflow-hub-ui` | projection-driven screens: agent directory, network graph, task room, activity timeline | data fetching, routing, domain rules |
| `apps/iflowone-web` | the standalone Web deployment of that UI | anything the embedded Hub cannot also do |

Dependencies run one way: `protocol <- domain <- adapter-sdk`, and
`domain <- hub-ui <- web`. Nothing depends on a runtime.

## Integrating iFlow into an application

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

`../iflow-dsh-plugin` is the first such adapter (DeepSeek Harness). Its entire
runtime coupling lives in four files:

| File | Answers |
| --- | --- |
| `src/runtime/dsh-ports.ts` | how this host does storage, subprocess, HTTP, time |
| `src/runtime/dsh-instrumentation.ts` | which runtime events mean which domain facts |
| `src/runtime/dsh-command-executor.ts` | how an inbound command is enforced, or refused |
| `src/identity/iflow-id.ts` | who holds the key and signs |

Nothing else in the core knows DSH exists.

## Running the Web app

```bash
pnpm install
pnpm build          # protocol + domain need a build; hub-ui ships sources
pnpm fixtures       # regenerate the golden event stream
pnpm dev:web        # http://127.0.0.1:5174
```

`apps/iflowone-web/.env` selects the data source:

| `VITE_IFLOW_SOURCE` | Reads |
| --- | --- |
| `mock` (default) | `fixtures/slice-events.json`, folded through the real projectors |
| `edge` | a live iFlow edge at `VITE_IFLOW_EDGE_URL` (default `http://127.0.0.1:3080`) |

The mock feed is a development tool, not a parallel implementation: it replays
real `IFlowEvent`s through the same reducers and projectors a live edge uses,
and it validates every fixture against the published envelope schema. The
header always says which source is on screen.

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
