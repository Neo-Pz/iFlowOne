# Writing an iFlow adapter

An adapter makes one Agent runtime a node in an iFlow network. It observes what
the runtime does, records those facts as a signed append-only journal, serves
them as projections, and — only if the operator opts in — carries requests back
in for the runtime to accept or refuse.

You write two things: implementations of six ports, and a mapping from your
runtime's lifecycle to iFlow's vocabulary. Everything else is in the SDK.

The reference adapter is [`Neo-Pz/dsh`](https://github.com/Neo-Pz/dsh), for
DeepSeek Harness. Its entire runtime coupling is four files; read it alongside
this.

---

## 1. The shape of it

```bash
npm i iflow-adapter-sdk
```

```ts
import { createEdge } from 'iflow-adapter-sdk'

const edge = await createEdge({ ports, descriptor })

// Report what your runtime did:
await edge.observer.taskStarted({ taskId, agentId })

// Read what those facts add up to:
edge.views.network()
```

`createEdge` returns an `IFlowEdge`: a journal, an outbox, a command ledger,
local projections, and the observer you report through. You never touch the
journal format, the envelope, or the projection algebra.

---

## 2. The six ports

`RuntimePorts` is the whole contract between iFlow and your host. Nothing in the
SDK imports `node:*` or reaches for an ambient global, so these are the only
places your environment shows through.

### `StoragePort`

```ts
read(path): Promise<string | undefined>   // undefined when absent, not a throw
write(path, text): Promise<void>          // replace whole file, create parents
append(path, text): Promise<void>         // caller supplies the newline
```

**`append` is separate on purpose.** The Origin Journal is append-only;
emulating append with read-then-write rewrites the entire history on every fact,
which is quadratic and one torn write away from losing it. If your runtime's
filesystem abstraction has no append, drop to the platform's — the DSH adapter
uses `ctx.fs` for reads and writes but `node:fs` `appendFileSync` for appends,
precisely for this.

Paths are joined with `/` and handed to you as opaque strings; you resolve them.

### `SpawnPort`

Child processes. iFlow needs this for exactly one thing in a minimal adapter:
the Rust `iflow-id` binary that holds the signing key. If outbound HTTP is
unavailable in your sandbox, the same port is how you shell out to `curl`.

**Return the handle synchronously if your runtime does.** A subtle failure mode:
if your host's `spawn` is synchronous and you write an `async` implementation,
callers awaiting `handle.done` get `undefined` and `handle.collected` explodes.
Match your host.

### `HttpServerPort` (optional)

Mounts the read API on whatever server you already run. Omit it and the edge
still journals and projects — it just is not readable over HTTP.

`route()` is required, `stream()` is optional; without streaming, a Hub polls
`/iflow/journal` instead of tailing `/iflow/stream`.

### `ClockPort`, `LoggerPort`, `IdPort`

Time (`now()` and `nowIso()`), logs, and non-cryptographic ids. Inject a fake
clock in tests and your journals become byte-reproducible.

### The descriptor

```ts
{
  nodeId,           // stable per machine+workspace — derive it, never mint it
  runtimeKind,      // 'dsh', 'codex', … recorded, never branched on by the SDK
  runtimeVersion,
  workspaceRoot,
  capabilities,     // iflow.cap:<domain>.<op> ids this node advertises
  selfAgentId,
  selfAgentLabel,
  did,              // when an identity exists
}
```

`nodeId` must survive restarts. If it changes, every restart looks like a new
node joining the network. Derive it from durable facts — the DSH adapter hashes
hostname plus workspace path.

---

## 3. The mapping — the part that is actually hard

The ports are mechanical. Deciding **what in your runtime is a Task** is the
design work, and it is easy to get wrong in a way that only shows up later.

The DSH adapter got it wrong first. It mapped one session to one Task, which
seemed obvious: a session is a unit of work. But a session is long-lived — it
never ends — so no Task ever reached `completed`, every one sat in `running`
forever, and Goals and Rooms had no source at all. The journal looked fine; the
projections were quietly meaningless.

The fix was to notice that a session is not work, it is a **place where work
happens**:

| DeepSeek Harness | iFlow |
| --- | --- |
| session | **Room** (root session only; a subagent joins its ancestor's) |
| the session's agent | **Agent**, joined to that Room |
| first human prompt in a session | **Goal** |
| one turn | **Task** + one ExecutionAttempt |
| `meta.parentSession` | the delegation edge between Tasks |
| a tool call | `tool.call_started` / `_completed` on the open turn's Task |
| an approval gate | `approval.requested` + `task.awaiting_approval` |
| the agent asking the user a question | `task.waiting` |

Questions worth answering before you write a line:

- **What ends?** Find the thing in your runtime that reliably terminates. That
  is your Task. If nothing terminates, you have not found it yet.
- **What contains?** The durable context several agents share is your Room.
- **What is the intent?** The human's request is your Goal — usually the first
  prompt, not every prompt.
- **What delegates?** Whatever records parentage gives you the delegation edge.

Note `task.waiting` versus `task.awaiting_approval`. They are different axes on
purpose: one is the agent choosing to ask, the other is a gate the runtime
imposes. Collapsing them makes "who is holding this up, and why" unanswerable —
which is the question a network view exists to answer.

---

## 4. Rules that are not negotiable

### Observation is not a control path

Your adapter runs inside someone else's runtime. It must not be able to deny a
tool call, cancel an agent, or delay a turn. If it can, an iFlow bug becomes an
outage in a product you do not own — and no vendor will install that.

Concretely: if your runtime's hooks are a waterfall, forward the decision
unchanged and journal as a side effect.

```ts
on('tools/pre-execute', async (exec, next) => {
  const decision = await next()
  enqueue(() => observer.toolCallStarted({ ... }))  // queued, not awaited
  return decision                                    // untouched
})
```

### Serialize your observations

Your runtime will not await you — correctly. But each handler needs several
awaited journal writes, and letting them interleave records a tool call before
the Task it belongs to. Chain every handler through one promise:

```ts
let queue = Promise.resolve()
const enqueue = (work) => {
  queue = queue.then(work).catch((error) => log.error('observation dropped', error))
  return queue
}
```

The DSH adapter's first version skipped this. The journal came out with tool
calls preceding their tasks, and a `drain()` on shutdown is what stops the last
few facts vanishing with the process.

### Subscribe globally if your runtime filters by scope

If your host's event dispatch is scoped, a plugin-scoped listener sees only its
own agents. An edge journaling what the whole node did must opt out, or it
loses facts silently — the worst failure mode, because everything looks fine.

### Commands fail closed

If you accept commands at all, refuse everything unless the operator explicitly
enabled it, and let your runtime's own enforcement decide each one. The SDK's
`CommandLedger` guarantees at-most-once delivery; it does not and must not
decide whether an action is allowed.

If you route approvals, **race** your runtime's own approver rather than
replacing it. A Hub becomes an additional place a human can answer from, never a
way around the local one.

### Sign at the origin, and say so when you cannot

Pass a `Signer` to `createEdge` and every fact is signed over its canonical
bytes before it is written. Key material stays wherever it lives — the DSH
adapter spawns `iflow-id sign-blob` and never sees the key.

An edge with no identity still journals: an unsigned fact is degraded, not lost.
But `journal.unsignedWriteCount` must surface, because a silently unverifiable
journal is worse than a missing one.

---

## 5. Proving it works

`packages/iflow-adapter-sdk/test/conformance.test.ts` in this repository is the
definition of a valid iFlow edge. Run it against your ports. The in-memory
reference host ships with the package so you can compare:

```ts
import { createMemoryHost } from 'iflow-adapter-sdk/testing'
```

It encodes the properties that quietly break otherwise:

- `origin.seq` is strictly increasing and never reused under concurrency
- a fact is durable before a projection can show it
- an outbox retry re-sends the same event identity, so a lost acknowledgement
  after a successful upload creates no second accepted fact
- a command is claimed durably *before* the executor runs, and one interrupted
  mid-execution is never retried — you cannot know whether its side effect
  landed, and guessing wrong is the failure the ledger exists to prevent
- deleting every projection and replaying the journal reproduces the state
- a malformed or expired request is refused at the origin edge
- a restart is a presence transition, not a new registration

Run them against a **real** filesystem too, not only the in-memory host. The DSH
adapter keeps a second suite that boots the built bundle over a temp directory
and restarts the process mid-test; both of the ordering bugs above were found
there, not in review.

---

## 6. A minimal adapter, end to end

```ts
import { createEdge, createSystemClock, createIdPort } from 'iflow-adapter-sdk'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const clock = createSystemClock()

const ports = {
  clock,
  ids: createIdPort(clock),
  logger: console,
  storage: {
    async read(path) {
      try { return readFileSync(path, 'utf8') } catch { return undefined }
    },
    async write(path, text) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text, 'utf8')
    },
    async append(path, text) {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, text, 'utf8')
    },
  },
  spawn: {
    async run() { return { code: 1, stdout: '', stderr: 'no subprocess' } },
    async resolveExecutable() { return undefined },
  },
}

const edge = await createEdge({
  ports,
  descriptor: {
    nodeId: 'my-runtime-abc123',
    runtimeKind: 'my-runtime',
    runtimeVersion: '1.0.0',
    workspaceRoot: process.cwd(),
    capabilities: ['iflow.cap:task.run'],
    selfAgentId: 'node-my-runtime',
    selfAgentLabel: 'my-runtime',
  },
})

// Then, from wherever your runtime signals work:
await edge.observer.taskCreated({ taskId: 't1', title: 'Summarise the ledger' })
await edge.observer.taskStarted({ taskId: 't1', agentId: 'agent-1' })
await edge.observer.taskCompleted({ taskId: 't1', summary: 'done' })

console.log(edge.views.network().data.edges)
```

That writes a real, replayable journal under `<workspaceRoot>/.iflow/edge/`.
Add the HTTP port and a Hub can read it; add a `Signer` and another node can
verify it.

---

## 7. The full observer surface

```
agentRegistered      agentPresenceChanged
goalCreated
roomCreated          roomParticipantJoined
taskCreated          taskDelegated        taskStarted
taskWaiting          taskBlocked          taskAwaitingApproval
taskCompleted        taskFailed
attemptStarted       attemptFinished
toolCallStarted      toolCallCompleted
approvalRequested    approvalResolved
quoteOffered         quoteAccepted        taskSettled
usageRecorded
```

Report the ones your runtime actually knows about. An adapter that emits five of
these honestly is more useful than one that emits all of them by guessing —
events describe what *happened*, and a fact you inferred is not one.

---

## 8. Publishing yours

Name it `iflow-adapter-<runtime>`. Keep it open source: an adapter runs inside
someone else's runtime with visibility into everything it does, and the people
deciding whether to install it need to read what you collect, what you transmit,
and what you will execute on their behalf. That is the reason this SDK is open,
and the same reason applies to you.
