# iflow-protocol

Transport contract for [iFlow](https://github.com/Neo-Pz/iFlowOne): how a fact
travels between Agent runtimes without anyone reinterpreting it.

> **Pre-1.0. Not frozen.** Shapes will change before 1.0 and changes may be
> breaking. Pin an exact version if you build against it.

```bash
npm i iflow-protocol
```

## What it does

Carries `IFlowEvent` and `IFlowCommand` envelopes, serializes them
deterministically, and defines the ports a host implements to sign and verify
them. It has no dependencies and imports nothing from Node, so it runs wherever
your runtime does.

```ts
import { canonicalJson, signEvent, verifyEvent, validateEvent } from 'iflow-protocol'
```

Schema v2 puts `visibility: 'local' | 'public'` inside the signed Event. Local
is the default at the Edge; publishing later is a new signed fact, never a
server-side edit of history. Schema v1 remains readable for journal migration.

The package also keeps three authority steps structurally distinct:

```ts
import type {
  EncryptedIntentEnvelope,       // Human -> own Agent
  ConversationMessageEnvelope,  // signing Agent -> remote Agent
  PrivateBrowserViewEnvelope,    // own Agent -> one browser view key
} from 'iflow-protocol'
```

The service between them routes opaque ciphertext. None of these types makes
Community a conversation store or an Agent signer.

## The canonical form rejects floats

Deterministic serialization means sorting object keys and emitting compact
JSON — but `serde_json` writes `1.0` where `JSON.stringify` writes `1`. Rather
than pick a lossy rule, the envelope simply may not carry non-integer numbers:

```ts
canonicalJson({ cost: 1.5 })   // throws CanonicalizationError
canonicalJson({ costMicros: 1_500_000 })  // fine
```

Money and measurements travel as integer micro-units. A one-byte disagreement
between two implementations would surface as network-wide signature failures
nobody could localise, so it is refused at the source instead.

## What a signature covers

`signableBytes(event)` is the envelope minus the fields a *receiver* may
legitimately add — `journalOffset` and `observedAt` — and minus the signature
itself. So an event verifies exactly as it was written, and keeps verifying
after another node accepts and orders it.

## Two-party facts

A price is not observed, it is agreed, and one party's signed claim proves
nothing alone. Rather than widen the envelope to multi-signature, an agreement
is an ordered pair of ordinary signed events: the acceptance embeds the offer's
id and its exact signature.

```ts
import { countersignPayloadFor, verifyCountersignedPair } from 'iflow-protocol'
```

Neither half can be forged without the other party's key, and a third party can
check the pair with nothing but the two events and the two DIDs.

## License

Apache-2.0
