# P3 acceptance — accountable collaboration

P3 proves that two Agents on different machines can take on work, deliver it,
and be held to the result — before any money is involved. If this chain closes,
iFlowOne has a collaboration layer. If it does not, iFlowOne is a message bus
with good manners.

```
Conversation → Relationship → Grant → Task → Delivery → Acceptance → Trust Evidence
```

The chain does not require every step to happen. It requires that **no step
silently produces the next one's authority or conclusion**.

Scenario ids are stable and referenced by
`packages/iflow-domain/test/collaboration-boundary.test.ts`. A scenario that
appears here must be either enforced by a named test or listed as pending with
the object it waits on; the test suite fails otherwise, so this document and
the guards cannot drift apart.

---

## A. The non-implication algebra

```
Conversation   ⇏   Relationship
Relationship   ⇏   Grant
Trust          ⇏   Grant
Grant          ⇏   Task
Task           ⇏   Delivery
Delivery       ⇏   Acceptance
Acceptance     ≢   Reputation score
```

An action is permitted only when all three hold at once:

```
ValidGrant  ∧  PolicyAllows  ∧  ConstraintSatisfied   ⇒   ActionPermitted
```

Each arrow is a place where a convenient shortcut would compile, pass its
feature tests, and quietly move authority. That is why they are written as
prohibitions rather than as a diagram of the happy path.

---

## B. The acceptance matrix

| id | scenario | must hold | must be impossible |
|---|---|---|---|
| **P3-01** | a stranger Agent opens a Conversation | it can be received, displayed and refused | the Conversation creating a Relationship or a Grant |
| **P3-02** | two Agents establish a Relationship | a signed relation fact exists | the Relationship conferring invocation, payment or file access |
| **P3-03** | a Grant is issued | issuer, subject, scope, expiry and constraints are all explicit | high trust producing a Grant on its own |
| **P3-04** | an Agent issues a Task | the Task traces to the issuing Agent and to a valid authority | a protected action running with no Grant |
| **P3-05** | a Grant expires or is revoked | subsequent actions stop using it immediately | any already-recorded fact being edited or deleted |
| **P3-06** | a remote Agent accepts a Task | the local policy checks it again, on the remote machine | the Community accepting on the remote Agent's behalf |
| **P3-07** | a Delivery is submitted | it binds to the Task, the executing Agent, and its evidence | the Delivery counting as acceptance |
| **P3-08** | a person or Agent accepts | a separate Acceptance or Rejection fact is recorded | a projector inventing an Acceptance from "the work finished" |
| **P3-09** | Trust Evidence accrues | it derives from real Task, Delivery and Acceptance facts | a platform-authored reputation score stored as a fact |
| **P3-10** | the Community forwards while offline | a sealed message is relayed | the Community signing, authorizing or executing for an offline Agent |
| **P3-11** | discovery leads to contact | MatchEvidence may recommend someone to contact | matching or subscribing conferring a right to make contact |
| **P3-12** | a full collaboration with no economics | Task → Delivery → Acceptance closes | P3 depending on payment, a wallet, or x402 to close at all |

### P3-12 is the graduation test

Two Agents on different Nodes:

```
discovered or already in contact
    → Relationship established
    → the Principal issues a limited Grant
    → Agent A issues a Task
    → Agent B accepts it and executes
    → B submits a Delivery
    → A accepts it
    → both record Trust Evidence
```

with, throughout: **no payment, no central countersigning, no cloud transcript
as a source of truth, and no step exceeding its authority.**

Passing this is the difference between having a collaboration layer and having
an A2A message system.

---

## C. Reverse acceptance — the cases that must fail

Higher priority than the happy path. A system that does the right thing when
asked nicely is not yet trustworthy; these four are where architectural drift
actually shows up.

### P3-R-A · Relationship without Grant

A knows B and may talk to B.

```
may:      open a Conversation, send a message
may not:  run a protected task, spend, read files
```

A relation is a social fact. It carries no scope, no expiry, and no capability,
because there is nothing in it for a policy to check.

### P3-R-B · Expired Grant

```
must still hold:  a Task authorized while the Grant was valid remains verifiable
must not hold:    a new Task authorized under it
```

Expiry ends authority going forward. It never rewrites what was true. A journal
that edits history to reflect a revocation has replaced evidence with opinion.

### P3-R-C · Delivery without Acceptance

```
resulting state:  delivered
forbidden state:  completed, accepted, or anything reputation counts as success
```

**This is currently violated.** `task.completed` carries the outputs — it is a
Delivery — and the reducer moves the Task straight to a terminal `completed`.
The executor declares its own work finished and the requester has no say. The
contract change that separates the two is what makes this scenario testable.

### P3-R-D · High trust without authority

```
trustScore = 0.99   (or a thousand accepted tasks, or a decade of history)

still may not:  spend money, sign a contract, read a file, delegate onward
```

Reputation is an input a policy may consult. It is never a substitute for one.
An Agent that becomes able to act by being well regarded is an Agent whose
authority can be manufactured by behaviour, which is the whole failure mode
this layer exists to prevent.

---

## D. The facts P3 records

Evidence, not conclusions:

```
conversation.opened / accepted / rejected / closed
relation.recorded
grant.issued / grant.revoked
task.created / delegated / started
delivery.submitted
delivery.accepted / delivery.rejected
trust_evidence.recorded
```

Two naming decisions carry weight.

**`trust_evidence.recorded`, never `reputation.updated`.** A score is not a
fact about the world; it is one reading of the facts, and a different weighting
is a different score. So:

```
journal  →  trust evidence  →  reputation projection
```

the same shape as publications → projection → feed. Facts are evidence; scores
are projections.

**`grant.issued` records that a grant exists, and never contains its
authority.** The journal keeps the `grantRef` — a content hash — with the
issuer, subject, scope, expiry and constraints. Verification stays with
`iflow-id grant verify`, because authority is issued by a signing key and never
by a projection. A grant a projection could mint is a grant nobody signed.

---

See [architecture principles](principles.md), whose principle 1
(Discovery–Authority Separation) and principle 2 (relationship, trust and grant
stay separate) this document works out in detail.
