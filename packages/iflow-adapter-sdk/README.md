# iflow-adapter-sdk

Make any Agent runtime part of an [iFlow](https://github.com/Neo-Pz/iFlowOne)
network. You supply six ports; this supplies everything above them.

> **Pre-1.0. Not frozen.** The port contract will change before 1.0 and changes
> may be breaking. Pin an exact version if you build against it.

```bash
npm i iflow-adapter-sdk
```

## The whole integration

```ts
import { createEdge } from 'iflow-adapter-sdk'

const edge = await createEdge({ ports, descriptor })

edge.observer.taskStarted({ taskId, agentId })   // report what your runtime did
edge.views.network()                             // read the projection
```

Every new fact is `local` unless the caller explicitly sets
`context: { visibility: 'public' }`. Only a signed public fact may enter the
outbox. Conversation and Workspace facts remain structurally local even if a
caller attempts to mark them public.

Your adapter reports facts in its own vocabulary — "this subagent started",
"this tool finished" — and never touches the journal format, the envelope, or
the projection algebra.

## What you implement

| Port | Answers |
| --- | --- |
| `StoragePort` | read, write, **append** — append is first-class because the journal is append-only and rewriting it per fact is both slow and a torn write away from losing history |
| `SpawnPort` | child processes, for the identity binary |
| `HttpServerPort` | inbound routes on whatever server you already run (optional) |
| `ClockPort`, `LoggerPort`, `IdPort` | time, logs, ids |

No `node:*` imports, no runtime imports, no ambient globals beyond the standard
library — so it bundles into a sandboxed plugin as readily as it runs on a
server.

## What you get

An append-only **Origin Journal** with monotonic per-stream sequencing and
optional origin signing; an **outbox** whose retries re-send the same event
identity, so a lost acknowledgement after a successful upload cannot create a
second accepted fact; a **command ledger** that claims a command durably
*before* the executor runs and never auto-retries one interrupted
mid-execution; **local projections** rebuildable from the journal alone; and a
read-only HTTP API plus SSE tail.

## Proving your adapter

`test/conformance.test.ts` in the repository is the definition of a valid iFlow
edge. Run it against your own ports. The in-memory reference host ships with
the package so you can:

```ts
import { createMemoryHost } from 'iflow-adapter-sdk/testing'
```

It encodes the failure modes that matter: a Community outage never stops local
work, a lost acknowledgement creates no duplicate fact, a repeated command has
at most one side effect, rebuilding from the journal reproduces the state, and
a malformed or expired request is refused at the origin edge.

## Observation is not a control path

Nothing here can deny a tool call, cancel an agent, or delay a turn. An adapter
that could would turn an iFlow bug into an outage in someone else's runtime.
Commands are the only way in, they are refused unless the host opts in, and the
host's own enforcement decides every one of them.

## Reference implementation

[`Neo-Pz/dsh`](https://github.com/Neo-Pz/dsh) — the DeepSeek Harness adapter.
Its entire runtime coupling is four files.

## License

Apache-2.0
