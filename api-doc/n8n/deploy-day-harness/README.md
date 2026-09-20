# Deploy-day harness

Offline proofs for `../N8N-DEPLOY-DAY-CHANGES.md`. **No n8n, no network, no database.**

```bash
node run.js          # exit code = number of failures
```

It executes the **live** node code — the bodies actually running on the instance — and the new
bodies built from them, then compares what a customer would receive.

| File | |
|---|---|
| `live-core-nodes.json` | live parameters of the core nodes this set touches · `UP-wi-mall-core` `1997c757` |
| `live-wa-normalize.json` | live `normalize` · `UP-wi-mall-wa-adapter` `218fc514` |
| `live-bargain-nodes.json` | live `decide send` and its send path · `UP-wi-mall-bargain` `e2c94ead` |
| `n8n-sim.js` | a stand-in for the n8n runtime: `$()`, `$input`, `$json`, `$now`, both Code-node modes, expressions |
| `build-new.js` | every new node body, built from the live one by **anchored replacement** |
| `test-s*.js` | the proofs, one file per section of the document |

Each snapshot records its provenance in `_source`. **Re-fetch and diff them before applying
anything** — if a workflow has been published since, these are a record of the past, not of
production.

## Three rules this harness is built on

**1 · A patch must fail loudly when its anchor misses.** `build-new.js` throws unless each
anchor matches *exactly once*. A patch that silently matched nothing would leave the "new" body
equal to the live one and every proof would pass against the wrong subject — green, and
meaningless.

**2 · Prove a guard BITES.** Several checks run a deliberately broken copy and require it to
fail: suppressing the agent's sentence by position instead of role, relaying a refused tool's
reply, sending the gate's body on a `revise` verdict. A guard nobody has seen fail is a guard
nobody has tested.

**3 · Feed one system's output to the other system's live code.** `set bargain flag (tap)` and
`read bargain flag` live in different nodes and nothing compares them, so the harness writes the
flag the way n8n would and hands it to the **live reader**. That is what turns "these two agree"
from a claim into a result — and it is why two of the document's rules are stated as
consequences: a flag without `variantId` is *refused by the reader*, and a lock left after a
button close is *still offered to the model as spendable*.

## Two fidelity notes

⚠ **`$now` is Luxon, not a `Date`, and `toISO()` emits a zone OFFSET** — `toUTC().toISO()` is
what emits `Z`. The stub keeps that difference rather than smoothing it away: it is exactly the
difference that made every automation failure report refuse with `400
AUTOMATION_REPORT_MALFORMED` for eight days against a validator that accepted only `Z`. A
simulator that papered over it would hide the next one.

⚠ **`$('X')` throws when node X did not run**, as n8n does — so a new node that forgets its
`isExecuted` guard fails here rather than in front of a customer.

## What it cannot prove

n8n's own graph semantics (that `send loop` hands items over one at a time), and the
`intermediateSteps` shape on the instance's n8n version — read from n8n's source, not guessed,
but not confirmed against this deployment. Both are live checks in the document's § 12.4.

⚠ **The total is a measurement, not a property.** § 1's corpus is derived from
`BOT_ACTION_VERBS` at run time, so the count rises whenever a stream lands a button. A count
that moves is this harness working; a failure count above zero is not.
