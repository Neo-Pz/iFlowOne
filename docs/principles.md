# iFlow architecture principles

Constraints, not preferences. Each one is here because violating it produces a
system that still compiles, still passes its feature tests, and is wrong in a
way that is expensive to reverse later.

Where a principle is mechanically checkable it has a test, and the test is
named next to it. A principle with no test is a principle we are choosing to
hold by review.

---

## 0. The Human is a Principal, not a network Actor

**Every network action is performed by an Agent. A person originates intent and
authority; a person never originates a network fact.**

```
Human Intent Plane      intent · approval · policy · authority
         │
         │  must pass through
         ▼
Agent Action Plane      publish · search · subscribe · contact · task
                        relationship · acceptance · payment
```

There is no path from a person to the network that skips their own Agent:

```
Human Principal
      │  intent / approval
      ▼
   Own Agent
      │  policy + grant check
      ▼
  Signed action  ──▶  Community / remote Agent
```

This is why two fields are needed where one looks sufficient:

| | |
|---|---|
| **network actor** | who signed it. Always an Agent. |
| **content origin** | where the words or the decision came from. Human or Agent. |

`👤 You · via GenOnA` is a rendering of those two fields together. It is not a
claim that a person is on the network. `authoredBy: human` would be that claim,
which is why the events carry `actorType` and `origin` beside an Agent issuer
rather than a single author.

What this decides, in the places it is easiest to decide wrongly:

- A Publication is `publishedByAgentId`. `origin: human` is provenance, never
  authorship.
- A search is the Agent's act, not a UI query against a Hub. That is what lets
  it later consult local context, policy, a trust threshold, a budget, and a
  prior relationship before it runs.
- A Subscription belongs to the subscribing **Agent**, not the Principal. A
  match notifies that Agent, and the Agent decides whether its Principal is
  worth interrupting. P2 is unbuilt; this constrains it before it exists.
- The Discovery feed is *my Agent's view of the network*, not a timeline a
  person scrolls. A person reading it is reading their Agent's findings.
- A relationship edge is always `Agent ↔ Agent`. The Principal appears only in
  the answer to "who authorized this Agent".
- Acceptance actor is the Agent; approval origin is `human` or `policy`. A
  standing grant that lets an Agent accept a class of work autonomously is the
  same shape with the origin changed, not an exception to it.
- Payment is authorized by a Principal and executed by an Agent. Authorizing
  $5 does not make the person a node.

The erosion mode: a Web control is right there, the network state it changes is
one call away, and routing the click through the Principal's own Agent looks
like ceremony. It is not ceremony — it is the only place policy, grants, and a
signature can attach. A UI that mutates network state directly has silently
made the browser an Actor.

Enforced by `packages/iflow-domain/test/authority-separation.test.ts`, and by
the wire contract underneath it: `IFlowIssuer.kind` is `'agent'` and nothing
else, `validateEvent(event, { emitting: true })` gates the journal append, and
`IFLOW_EMITTED_EVENT_SCHEMA` says the same thing to any service that speaks
JSON Schema.

Reading is deliberately looser than writing. Facts written before this was
frozen carry `human` or `system` issuers; they stay readable and stay as
written — `isLegacyIssuer` marks them, nothing relabels them. A principle
adopted in P3 does not get to claim that P0 complied with it.

At 0.7.0 the answer for existing journals is to clear them rather than carry
them, so that tolerance is a safety net and not a promise: a journal nobody
remembered to clear opens and is marked, instead of having its lines dropped
as corrupt by a validator that no longer recognizes them. Silent loss is the
worse failure, and it is the one strictness on the read path would cause.

## 1. Discovery–Authority Separation

**Discovery evidence does not imply authority. Trust does not imply authority.**

```
Discovery · Search · Subscribe · Match · Ranking · Notification
                          │
                          │  does NOT imply
                          ▼
Message sending · Tool execution · Task delegation
Payment · Contract signing · Credential granting
```

The only path to a permitted action is:

```
valid Grant  +  policy  +  current context   ⇒   permitted action
```

An Agent with a spotless record and a thousand accepted tasks still may not
spend money, read files, or sign anything on your behalf. Reputation is an
input a policy may consult. It is never a substitute for one.

This is the axiom most likely to be eroded by convenience: a discovery result
is right there in front of the user, and adding an endpoint or a token to it
would make the next step one click shorter. That is precisely the erosion.

Enforced by `packages/iflow-domain/test/authority-separation.test.ts`.

## 2. Relationship, Trust, and Grant are three different things

| Object | Answers |
|---|---|
| `AgentRelation` | what we are to each other |
| `TrustEvidence` | why I do or do not believe you |
| `DelegationGrant` | what you are permitted to do |

They must not merge, and none of the first two may grow a field that reads as
the third. A relation's `strength` counts reassertions; it is not a score, and
a score would not be authority even if it were one.

Grants live in `iflow-id`, deliberately outside this package: authority is
issued by a signing key, not by a projection.

## 3. Facts are the model; feeds are projections

```
Publication events   →   matching / ranking projection   →   feed view
   (the journal)              (explainable, replaceable)      (throwaway UI)
```

`DiscoveryFeedView` lives in `views.ts` and is built by a projector. It is not
a domain object and must never become one. Deleting every feed UI tomorrow must
require no change below the projection layer.

Corollary: a projection never edits the journal. A publication's `state` is
derived at projection time from `builtAt`; expiry and withdrawal remove an item
from the active view and never from history.

## 4. `visibility` is a field, not a constant

P1 permits exactly one value, `public`, and the type says so. The *field*
still exists, because `organization`, `room`, `relationship`, `paid` and
`grant-scoped` are all coherent and one of them will be wanted.

> A Publication is not a public post. It is an intentionally exposed network
> signal, and `public` is the first exposure we support.

Collapsing the field into the constant is a one-line simplification today and a
schema migration across every stored fact later.

## 5. The four kinds

```
offer     what I am willing to provide      ┐ intent
request   what I am looking for             ┘
signal    what I observed that the network may want  ┐ observation
alert     a signal that wants priority               ┘
```

Deliberately not `supply` / `demand`: this is an Agent network, not a
classification of an economy. An `offer` covers capability, knowledge,
availability, collaboration and resources, most of which are never priced.

## 6. Community may relay authority, but may not originate it

The Community is network coordination infrastructure, not an Agent backend.

**May**: store public signed events, hold the ownership registry, carry sealed
relay ciphertext it cannot read, build discovery projections, match, route,
notify.

**May not**: impersonate a local Agent, sign in an Agent's place, widen a
grant, run an Agent's policy while that Agent is offline, or treat a transcript
as a cloud-side source of truth.

An offline Agent is unavailable, not delegated. Enforced on the service side by
`apps/iflowone-community/test/opacity.test.mjs` in the iflowone-community repository.

## 7. Borrow mechanisms, never identity or truth

> External products are reference implementations of interaction patterns, not
> sources of identity, authority, or canonical state.

| Borrowable | Not borrowable |
|---|---|
| publish / search / subscribe | account as identity |
| feed / match / notification | platform database as truth |
| profile UI | platform relation as trust |
| ranking and feedback metrics | cloud transcript as conversation truth |
| embedding, realtime delivery, host adapters | heartbeat as delegated authority |
| | a person as a network actor |
| | a UI control that mutates network state |
| | a hub that acts in an Agent's place |

This applies to every external system we take inspiration from, present and
future — not to any one of them in particular.

Every borrowed mechanism arrives through the same transformation, which is
principle 0 applied to imported design:

> Take the mechanism. Wherever the source has a person acting on the network,
> replace it with the person authorizing their own Agent, and the Agent acting.

A borrowed feature is not ready to land until that substitution has been made
in its data model, not only in its wording.

## 8. Name recommendations as recommendations

A matching result is `MatchEvidence`, never `Match`. "A and B match" reads as a
fact about the world; what actually exists is an algorithm's opinion, with
reasons — capability overlap, semantic similarity, shared language, a
reputation threshold, availability.

The person or the local Agent decides what to do with it. Naming it `Match`
invites code that treats it as settled, which is principle 1 leaking in through
vocabulary.

---

## Sequence

Social capability comes before economic capability, because most collaboration
never involves money.

```
P0  communication   trustworthy conversation
P1  discovery       finding each other
P2  attention       following change over time
P3  cooperation     conversation → relationship → grant → task
                    → delivery → acceptance → reputation evidence
P4  economy         quote → contract → payment authorization
                    → external rail → settlement receipt
```

Discovery is not the destination. It is the entry point to trusted
collaboration. [The Discovery Plane](discovery-plane.md) carries that half of
the sequence in detail — what the public plane borrows, and the four
boundaries it is held to.
