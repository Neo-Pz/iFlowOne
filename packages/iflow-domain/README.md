# iflow-domain

The Agent Network ontology for [iFlow](https://github.com/Neo-Pz/iFlowOne):
what happened, what it means, and what the accumulated facts add up to.

> **Pre-1.0. Not frozen.** Event types and view contracts will change before
> 1.0 and changes may be breaking. Pin an exact version if you build against it.

```bash
npm i iflow-domain
```

## Five first-class objects

**Agent** (who is acting), **Goal** (why), **Task** (what work), **Room** (who
is collaborating), **Event** (what happened). Plus a typed event vocabulary
payloads, and the read-model contracts a UI consumes.

Agent state has three independent axes, on purpose:

```ts
{ presence: 'online', execution: 'running', coordination: 'awaiting_approval' }
```

All three are true at once, and collapsing them into one enum is what makes a
network view lie about who is actually stuck.

## Stable Principal, rotatable authority

`principalId` names the stable person or organization. `authorityDid` names
the current key allowed to authorize for it, and `authorityVersion` prevents a
rollback to an older key. They are deliberately separate from Node and Agent
DIDs. P0 models future recovery but does not claim that a lost `did:key` can be
recovered.

`My Agents` means owned Agents plus Agents covered by a private `send_as`
grant. Ownership itself is private account data, not a public graph edge.

## Facts, not intentions

Events describe what already happened. Anything a model merely intends must be
labelled `declared_plan`, `derived_next_step` or `suggested_action`, so a UI
can never present a guess as an observation.

## Reducers and projectors are pure

```ts
import { reduceEvents, projectNetworkGraph, projectTaskGraph } from 'iflow-domain'

const state = reduceEvents(journal)
const graph = projectNetworkGraph(state, { builtAt: new Date().toISOString() })
```

No I/O, no clock (`builtAt` is injected), so a projection is reproducible in a
test and in a replay. Deleting every projection and replaying the journal
reproduces the same state — that is what makes projections disposable.

An illegal state transition is recorded as an anomaly rather than rejected. The
journal is the authority on what happened; the state machine's job is to make a
contradiction visible, not to overrule the fact.

## The network graph is not a log

Edges exist because two objects stand in a durable relation — delegation,
dependency, participation, ownership, delivery, approval. A graph that grows an
edge per tool call stops being a map of the network and becomes a picture of
noise.

## Prices

`selectPublishableSettlements` decides which settlements may leave a node.
It is here, and open, because the promise it encodes — a price marked private
never leaves your machine — is only credible if the party relying on it can
read the code making that decision.

## License

Apache-2.0
