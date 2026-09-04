# Handoff

Three repositories, one system. This is what a new maintainer — human or agent —
needs before touching any of them: what the parts are, what is already true,
what is still owed, and which mistakes have already been paid for once.

Written 2026-09-05, against `iflow-domain@0.7.0`.

---

## 1. The three repositories

```
iFlowOne            (this repo)  the contracts        published to npm
  iflow-domain                   facts, reducers, projectors
  iflow-protocol                 wire schemas
  iflow-adapter-sdk              what an adapter implements

iflow-dsh-plugin                 an adapter            runs on a person's machine
                                 A2A bridge, identity, conversations, panel UI

iFlowOne-iFO                     the public plane      Cloudflare Worker + web
  iflowone-community             Worker: journal, relay, private accounts
  iflowone-web                   the browser client
  iflowone-www                   marketing
```

The direction of dependency is one way and must stay that way: the contracts
know nothing about DSH, and the Worker knows nothing about either party's
private state. `iflow-dsh-plugin` is *one reference implementation* of an
adapter, not the definition of one.

Remotes:

| repo | GitHub |
|---|---|
| iFlowOne | `Neo-Pz/iFlowOne` |
| iflow-dsh-plugin | `Neo-Pz/dsh` |
| iFlowOne-iFO | `Neo-Pz/iFlowOne-iFO` |

---

## 2. Verified baseline

The outgoing maintainer reports the following runs on 2026-09-05. The receiving
agent reviewed the documents and source but did not rerun these suites during
the handoff review. Counts are a dated baseline, not a new test result:

| suite | command | result |
|---|---|---|
| contracts | `pnpm test` in `iFlowOne` | 173 passed |
| plugin | successful `npm run build` and `npm run build:client`, then `npm test` in `iflow-dsh-plugin` | 357 passed |
| plugin (Rust) | `cargo test` in `iflow-dsh-plugin/rust` | 37 passed |
| Worker | `npm test` in `apps/iflowone-community` | 92 passed |
| web | `npm test` in `apps/iflowone-web` | 25 passed |

Plus `pnpm typecheck` in both workspaces and `pnpm build` for the web app.

**On a fresh checkout, verify dependencies before diagnosing a strip-only
TypeScript error.** Use `pnpm install` in the Core/iFO workspaces and `npm ci`
in the plugin repository. A missing dependency used to surface as
`TypeScript parameter property is not supported in strip-only mode` pointing at
a file with nothing wrong with it. On the still-unmerged loader-fix branch,
`apps/iflowone-community/test/loader.mjs` reports the missing dependency,
with the original `ERR_MODULE_NOT_FOUND` kept
as `cause`.

The Core 0.7.0 release, consumer adaptation and published dependency lockfiles
have been merged. At the initial handoff review on 2026-09-05, the three
`AGENTS.md` files and this document were untracked. The reviewed documents are
prepared on separate `docs/maintainer-handoff` branches based on each repo's
`origin/main`; use `git status` to determine the current working-tree state.
Two branch loose ends:

- `iflow-dsh-plugin` → `fix/identity-node-home-capability` is an orphan; its
  content already landed on `main` through a rewrite. Safe to delete.
- `iFlowOne-iFO` → `fix/test-loader-missing-deps` (`238f525`) is pushed and not
  yet merged (remote checked 2026-09-05). It is the loader fix above.

### Completed release and deployment

- Core `iflow-protocol`, `iflow-domain` and `iflow-adapter-sdk` 0.7.0 were
  published on 2026-08-31 (Asia/Shanghai) by tag `v0.7.0` at `6984804`.
  [Release workflow](https://github.com/Neo-Pz/iFlowOne/actions/runs/33321433758)
  succeeded, and all three versions were verified in npm.
- Consumer lockfiles resolve npm tarballs. Plugin PR #23 merged as `15e818a`;
  Community/Web PR #15 merged as `6cee503`. The plugin's installed Core packages
  were verified as ordinary directories, no longer links to the local Core repo.
- The authorized Community Worker deployment from `6cee503` completed with
  version `1078d32f-cfef-4308-8542-03f38346873b` at `api.iflowone.com/*`.
  The immediate health check returned `accepting`, with empty
  `unknownEventTypes` and `unfoldableEventTypes`.
- These are historical results. Recheck live state before claiming a current
  deployment. Web deployment, both Nodes' installed builds, relay configuration
  and the two-machine acceptance have not been verified by this handoff review.

---

## 3. Rules that are not the agent's to break

These actions require the user's authorization for their specific scope.
An agent may execute an explicitly authorized action; authorization already
given in the session remains valid. A release, deployment, migration and relay
configuration change are separate scopes:

| action | authorization boundary |
|---|---|
| `wrangler deploy` | User authorization for the production deployment. |
| D1 migrations against production | Separate authorization for the migration; deployment does not imply it. |
| `pnpm publish` or a publishing tag | User authorization for the release; use the repository's release workflow and do not assume a published version can be withdrawn. |
| turning on the relay | `RELAY_ENABLED` defaults off. Shipping the code and enabling the feature are two decisions — keep them separate. |
| committing or pushing unasked | and branch first if on `main`. |

`src/repair/session-source.ts` writes into DSH's own session store. It is
dry-run by default, takes a `.backup` before every write, and DSH must be
closed before it runs.

Supply chain: `pnpm-workspace.yaml` in iFO carries `minimumReleaseAgeExclude`,
which must name every consumed Core version explicitly. Publish a Core contract
first, then bump the consumer and the lockfile together. Forgetting this fails
later and far away, as an install that cannot find a version that demonstrably
exists.

---

## 4. The constraints the design is actually made of

Read [`principles.md`](principles.md) before changing a type. Nine numbered
constraints; each one exists because violating it produces a system that still
compiles, still passes its feature tests, and is expensive to reverse. The two
that catch people first:

**Principle 0 — the Human is a Principal, not a network Actor.** Every network
fact is issued by an Agent. A person originates intent and authority and never
originates a fact. There is no path from a person to the network that skips
their own Agent.

**Principle 1 — Discovery does not imply Authority.**

```
Discovery  =/=>  Authority
Trust      =/=>  Authority

ValidGrant  and  Policy  and  Context   ==>   Permitted
```

Finding an Agent tells you it exists. It never tells you what you may do to it.

And principle 6, which is the whole reason the Worker is shaped the way it is:
**the Community may relay authority, but may not originate it.**

### The P3 non-implication algebra

[`p3-acceptance.md`](p3-acceptance.md) turns the collaboration layer into
sixteen numbered acceptances. The spine is a list of things that must *not*
follow from each other:

```
Conversation =/=> Relationship =/=> Grant =/=> Task =/=> Delivery =/=> Acceptance
Trust        =/=> Grant
Acceptance   is not a Reputation score
```

Each arrow is a place where a convenient shortcut would compile and quietly
move authority. `Delivery =/=> Acceptance` is the one that was already broken
and had to be repaired in the contract: `task.completed` carried
`{ summary, outputs }` — that is a delivery — and the reducer moved the task
straight to `completed`, so the executor could end a cross-boundary task on its
own say-so. `TaskState` now has `delivered`, and `delivered` is the only state
from which `completed` is reachable.

Naming decisions that carry weight and should not be "tidied up":

- `GrantRecord`, never `Grant`. The journal records *that* a grant exists — a
  `grantRef` content hash — and never the authority itself. Authority comes
  from a signing key, not from a projection.
- `trust_evidence.recorded`, never `reputation.updated`. Facts are evidence;
  scores are projections, and a different weighting is a different score.
- `MatchEvidence`, never `Match`.
- `selfDeclared`, never `legacy`. The flag means "no second party ruled",
  which covers both pre-split facts and legitimate same-Principal completions.

---

## 5. What is still owed

Ranked. Nothing here is blocked on a decision — items 1 and 3 are blocked on
things an agent cannot do alone.

**1 · P3-06 — the last pending acceptance.** "A remote Agent accepts a Task:
the local policy checks it again, on the remote machine." It is tracked in
`packages/iflow-domain/test/collaboration-boundary.test.ts` in the `PENDING`
map, with the reason recorded there. It is not a fold, so it cannot be proved
in the domain layer; it needs the plugin re-checking policy on the accepting
machine and a real two-machine run. The completeness test will fail if it is
quietly dropped from the document or from the map.

**2 · Merge `fix/test-loader-missing-deps` and delete the orphan branch.**

**3 · End-to-end on two machines.** Confirm the actual Agent DID on both
Nodes before testing. The earlier local Agent ID was `rrt`, with `wwee` on the
other Node; `GenOnA` is a historical UI label and must not select the pair.
Use the restricted `reset_pair` action with exact DIDs and its explicit
confirmation value if a first-contact reset is needed. Preserve identities,
peer configuration, unrelated conversations and the Accepted Journal; do not
clear D1 for this test. The sequence to verify:

1. first contact appears exactly once in 待处理
2. accept it
3. both machines get a session named after the other party
4. subsequent messages skip 待处理 entirely
5. a web refresh restores the session without a new login
6. the Chats tab shows one row per counterparty, not one per thread
7. revoking the pair permission pauses the thread rather than ending it
8. another inbound message creates one reauthorization request; acceptance
   restores the same Conversation and Session with history retained

Revocation pauses sending and execution at the revoking Node. Verify behavior
at both ends; do not infer that one Node's local permission change synchronizes
the other Node's permission record.

**4 · Remove the `sideOf` type widening** in
`apps/iflowone-web/src/private/AccountUI.tsx`. It is documented in place and
disappears on its own once `side` lands in `iflow-protocol`'s
`ConversationViewMessage`.

### Known and deliberate limits

Two things were investigated and found to be *not implementable where they were
asked for*. They are not bugs and should not be re-opened as such:

- **A peer's message will always appear on the right in DSH's own session
  view.** DSH renders by role, and a peer's message has to arrive as a user
  turn — that is what prompts the local Agent. The plugin's own Chats tab
  exists precisely to show the conversation the way it actually happened:
  left is the other party, right is this machine's Agent, and the person/agent
  badge is a separate question about authorship.
- **A malformed legacy `source` cannot be tolerated from inside the plugin.**
  The validation lives in DSH's loader and throws before iFlow sees anything.
  Repairing the stored file is the only available remedy — hence
  `src/repair/session-source.ts`.

---

## 6. Traps already paid for

Each of these cost real time once. They are recorded so they cost nothing the
second time.

**A guard that does not fail when you revert the behaviour is decoration.**
Mutation-test every new guard and write the result into the commit message.
The first authority guard watched *projector output* and passed happily with an
`endpoint` injected — the reducer's field whitelist stopped it before it ever
reached a view. It only bit once it read the *declared interface fields*.

**Commit before mutating.** `git checkout` destroyed uncommitted work twice.
Checkpoint first, then mutate.

**Verify a failure message by causing it.** A diagnostic that has never been
seen to fire is a wish, not a diagnostic. The loader fix above was confirmed by
hiding `iflow-domain` and reading the output.

**Do not chain verification behind a `grep` whose success means "found the
failure line".** That is how eleven failing tests got committed.

**Node, regex and platform gotchas:**

- DSH session storage is *concatenated zstd frames*. `zstdDecompressSync`
  returns only the first one. A whole-store scan that finds zero message events
  is reporting a bug in the scan.
- JS `.` does not match `\r`. On a CRLF checkout, comment-stripping with
  `//.*` followed by an end-of-line anchor silently does nothing. Split on
  `/\r?\n/`.
- `esbuild` tree-shakes unused exports. An export missing from a bundle is not
  necessarily missing from the source.

**Caches keyed on the wrong thing.** `foldCache` was keyed on the journal head
alone, so two databases at the same head collided. It is now a `WeakMap` keyed
on the D1 binding.

**Clones that share sub-objects.** `cloneState` shared `deliveries` by
reference. The regression test written for it did not bite, because it used two
independent `reduceEvents` calls, which share nothing by construction. Continue
one fold from another with `applyEvent` if you want to catch this class.

**A test that reimplements the thing it tests proves nothing.** Import the real
function.

**Nothing private goes into a publishable fact.** `previewOf` leaked
`task.created.title` (the request) and `delivery.submitted.summary` (the
answer). `task.*` and `delivery.*` are *not* excluded by `isPublishable`.
Evidence is a digest.

**One malformed fact can break a whole projection.** An undefined `toAgentId`
put an Agent with no id into the fold, and `projectAgentState` sorts by id.

**A stale warning comment is worse than none.** A comment claiming a gap that a
later release closed teaches the reader to distrust the next warning too.

---

## 7. Where the sharp edges live

| concern | file |
|---|---|
| what a fact is, and what it may not carry | `packages/iflow-domain/src/objects.ts` |
| the state machine and the anomaly reasons | `packages/iflow-domain/src/reducers/network-state.ts` |
| the guards that bite | `packages/iflow-domain/test/authority-separation.test.ts` |
| the P3 acceptance registry | `packages/iflow-domain/test/collaboration-boundary.test.ts` |
| the plugin's whole surface | `iflow-dsh-plugin/src/index.ts` |
| pair permissions, keyed on verified DIDs | `iflow-dsh-plugin/src/conversation/permissions.ts` |
| conversation storage and counterparty collapse | `iflow-dsh-plugin/src/conversation/store.ts` |
| the Worker's routes and the relay gate | `apps/iflowone-community/src/index.ts` |
| browser session lifetime and sliding renewal | `apps/iflowone-community/src/private-account.ts` |

One rule that is easy to violate by accident, in both the plugin and the web
app: **pair permissions are keyed on verified DIDs, never on labels.** A label
is whatever the far side chose to put in its metadata.
