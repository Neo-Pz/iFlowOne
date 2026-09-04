# Working in this repository

This is **iFlowOne Core** — the contracts. Three packages, published to npm,
consumed by every adapter and by the public Worker:

| package | what it is |
|---|---|
| `iflow-domain` | facts, reducers, projectors — the model |
| `iflow-protocol` | wire schemas, read *and* emit |
| `iflow-adapter-sdk` | what an adapter has to implement |

Currently `0.7.0`. Nothing here may know about DSH, about Cloudflare, or about
any particular runtime. If a change needs to, it belongs in an adapter.

**Start with [`docs/handoff.md`](docs/handoff.md)** — the cross-repo picture,
the verified baseline, what is still owed, and the traps that have already cost
someone a day.

## Commands

```bash
pnpm install       # do this first; a missing dep surfaces as a bogus TS error
pnpm test          # 173 tests
pnpm typecheck
pnpm build
```

## Before you change a type

Read [`docs/principles.md`](docs/principles.md). Nine numbered constraints, each
with the failure it prevents and the test that enforces it. They are constraints
and not preferences: violating one produces a system that compiles, passes its
feature tests, and is expensive to reverse.

The two that catch people first:

- **Principle 0.** Every network fact is issued by an Agent. A person
  originates intent and authority; a person never originates a fact.
- **Principle 1.** Discovery does not imply authority, and neither does trust.
  An action is permitted only when a valid grant, the policy, and the context
  all agree.

[`docs/p3-acceptance.md`](docs/p3-acceptance.md) is the collaboration layer as
sixteen numbered, executable acceptances. Its spine is a set of
non-implications:

```
Conversation =/=> Relationship =/=> Grant =/=> Task =/=> Delivery =/=> Acceptance
Trust        =/=> Grant
```

`P3-06` is the only one still pending, and the reason is recorded in the
`PENDING` map in `packages/iflow-domain/test/collaboration-boundary.test.ts`.
A completeness test asserts every scenario in the document is either enforced by
a real test or explicitly listed as pending — so the document and the suite
cannot drift apart silently. Do not add `it.todo`.

## Names that are load-bearing

Do not "tidy" these:

- `GrantRecord`, not `Grant` — the journal records that a grant exists, never
  the authority itself.
- `trust_evidence.recorded`, not `reputation.updated` — facts are evidence,
  scores are projections.
- `MatchEvidence`, not `Match`.
- `selfDeclared`, not `legacy` — it means "no second party ruled".

## House rules for tests

- **Mutation-test every new guard**, and put the result in the commit message:
  "injected X, failure message was Y". A guard that still passes when you revert
  the behaviour is decoration. This has already happened once — a guard that
  read projector output instead of declared interface fields.
- **Commit before mutating.** `git checkout` has destroyed uncommitted work here
  twice.
- **Never let a test reimplement the function it is testing.** Import the real
  one.
- A regression test for shared-reference bugs must continue one fold from
  another with `applyEvent`; two independent `reduceEvents` calls share nothing
  by construction and will pass against the bug.

## Release authorization

Publishing requires user authorization for the release. Existing explicit
authorization in the session remains valid; an agent may execute that authorized
release using the repository's release workflow. Do not assume an npm version
can be withdrawn. Core 0.7.0 was published through the `v0.7.0` GitHub Actions
workflow on 2026-08-31 (Asia/Shanghai). When a new version does go out,
`minimumReleaseAgeExclude` in the iFO repo's `pnpm-workspace.yaml` must name it
explicitly, or the next install there fails far from the change.
