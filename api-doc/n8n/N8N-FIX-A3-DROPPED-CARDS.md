# n8n fix A3 — product cards dropped whenever the assistant also wrote a sentence

**Workflow:** `UP-wi-mall-core` (`vvbouV2136P5weCs`) · **Measured on:** active version
`b9c9187c-3f78-4a6a-9e7f-8b091074952f` (`versionId === activeVersionId`, 59 nodes, updated
2026-09-15T11:18:13Z).

**Status: ✅ PUBLISHED 2026-09-16 as `1997c757-ccd0-44d8-b5d6-c2f476a8fee3`** (2.1 + 2.2),
`activeVersionId` confirmed. ⏳ **The live check in 3.3 is PENDING, not skipped** — there are
no live products yet, so no real multi-card turn could be watched. Do it on the first one.

**Rollback version: `b9c9187c-3f78-4a6a-9e7f-8b091074952f`.**

---

## 1 · What is broken, in production, today

A customer asks for products. The assistant calls `Show-Products` (the `wi-mall-product-cards`
sub-workflow), which echoes the ready-made card bodies to Redis. `compose agent reply` then
emits the turn as **several items**: the assistant's sentence first, then one item per card.

`drop duplicate reply` sits between that node and the send path, and returns exactly **one**
item:

```js
for (const nm of ['compose agent reply', 'agent fallback', 'outage fallback']) {
  if ($(nm).isExecuted) { reply = ($(nm).first().json || {}).reply || null; break; }
}
return [{ json: { reply: answered ? null : reply } }];
```

So:

| The turn composed | The customer received |
|---|---|
| a sentence + 5 cards | the sentence, no products |
| 5 cards, no sentence | the first card only |
| a bargain + a sentence + cards | nothing at all |

`compose agent reply`'s own comment says *"`send guard`, `is telegram?` and both send nodes
iterate their input items in order, so emitting the array is all it takes"* — true of those
nodes, and undone by the one node between them.

⚠ **Per ADR-022 the executions of these turns report `success`.** Nothing failed; messages
were simply never sent. That is also why the proof below is about what was **sent**, never the
run status.

## 2 · The change

### 2.1 · `drop duplicate reply` — the fix (required)

Return **every** item the source node emitted, in order. Keep the bargaining suppression, but
make it suppress only the assistant's **sentence**, never the cards.

How the sentence is recognised, without guessing and without re-reading the display echo:
`compose agent reply` emits a sentence exactly when **(a)** the model wrote something — it is
then always item 0 — or **(b)** the model wrote nothing and there were no cards, in which case
the backend's stand-in sentence is the only item. So: drop item 0 when the model spoke;
otherwise drop a single item only when it **is** the stand-in, word for word. A card can never
equal the stand-in, and the two fallback nodes emit nothing but a sentence.

Replacement `jsCode`, in full:

```js
// EVERY MESSAGE THIS TURN COMPOSED GOES OUT — AND THE MAIN AGENT'S SENTENCE IS SUPPRESSED WHEN
// THE BARGAINER HAS ALREADY SPOKEN.
//
// ── Why this node now returns ALL items (fixed 2026-09-16) ─────────────────────
// `compose agent reply` emits the turn as SEVERAL items since product cards landed: the
// agent's sentence first (when there is one), then each card body the display tool echoed.
// This node used to read `$(nm).first()` and return ONE item, so every card after the first
// item was silently dropped — a customer who asked for products got the sentence and no
// products. `send guard`, `is telegram?` and both send nodes iterate their input items in
// order, so returning the items in order is the whole fix. ⚠ Never sort them: order IS the
// rendering (sentence, then cards, then "See more").
//
// ── The bargaining suppression (unchanged in purpose) ────────────────────────
// `open_negotiation` chains into a full bargaining turn, so the customer is sent the gate's
// approved sentence from INSIDE the agent's tool call. The agent still composes a final answer
// afterwards, and without this the customer gets two messages: the negotiated price, then a
// line saying the price is being looked at. The sentence stays the BARGAINER'S (D-4).
//
// ⚠ What is suppressed is the AGENT'S SENTENCE — never the cards. A turn that both bargained
// and showed products keeps its products.
//
// How the sentence is recognised, without guessing and without re-reading the display echo:
// `compose agent reply` emits a sentence exactly when (a) the model wrote something — then it
// is ALWAYS the first item — or (b) the model wrote nothing AND there were no cards, in which
// case it emits the backend's stand-in sentence as the ONLY item. So: drop item 0 when the
// model spoke; otherwise drop a single item only when it IS the stand-in, word for word. A
// card can never equal the stand-in, and the fallback nodes emit nothing but a sentence.
//
// The echo is written ONLY after wi-mall-bargain's send returned, is stamped with this turn's
// messageId, carries its own expiry (the n8n Redis node's `set` exposes no TTL) and is deleted
// on read. A stale, mismatched or malformed echo is not an answer.
//
// Fails toward an extra message, never toward silence: with Redis unreachable the customer
// keeps the counter-offer and also gets the bridging line.
const inbound = $('Inbound').first().json;

let source = null;
for (const nm of ['compose agent reply', 'agent fallback', 'outage fallback']) {
  if ($(nm).isExecuted) { source = nm; break; }
}
if (source == null) { return [{ json: { reply: null } }]; }

const replies = $(source).all()
  .map(function (item) { return (item.json || {}).reply || null; })
  .filter(function (reply) { return reply != null; });

let answered = false;
if ($('read bargain echo').isExecuted) {
  const raw = ($('read bargain echo').first().json || {}).bargainAnswered;
  try {
    const echo = raw ? JSON.parse(String(raw)) : null;
    const live = !!echo && !!echo.expiresAt && new Date(echo.expiresAt).getTime() > Date.now();
    if (live && String(echo.messageId) === String(inbound.messageId)) { answered = true; }
  } catch (e) { /* a malformed echo is not an answer */ }
}

let out = replies;

if (answered) {
  if (source !== 'compose agent reply') {
    // The fallbacks emit a sentence and nothing else.
    out = [];
  } else {
    const modelSpoke = String(($('AI Agent').first().json || {}).output ?? '').trim() !== '';
    const sync = $('sync identity').first().json;
    const standIn = String(sync && sync.data && sync.data.fallback ? sync.data.fallback.assistantUnavailable : '').trim();
    const textOf = function (reply) {
      const body = (reply && reply.body) || {};
      if (typeof body.text === 'string') return body.text;
      if (body.text && typeof body.text.body === 'string') return body.text.body;
      return null;
    };

    if (modelSpoke) {
      out = replies.slice(1);
    } else if (replies.length === 1 && standIn !== '' && textOf(replies[0]) === standIn) {
      out = [];
    }
  }
}

if (out.length === 0) { return [{ json: { reply: null } }]; }
return out.map(function (reply) { return { json: { reply: reply } }; });
```

Unchanged: the node's position, its connections (`clear bargain echo → drop duplicate reply →
send guard`), its mode (run once for all items), and every other node.

### 2.2 · ⚠ Message ORDER — a companion setting on the two send nodes (needs a decision)

Until this fix, the send path only ever carried **one** item per turn, so order never mattered.
After it, a turn is 2–7 messages, and order is the rendering.

**n8n's HTTP Request node does not send its items one after another.** In
`packages/nodes-base/nodes/HttpRequest/V3/HttpRequestV3.node.ts` (read from the n8n repository's
`master`, 2026-09-16 — the live instance's version was not checked), the item loop pushes each
request into `requestPromises` **without awaiting it** and then awaits
`Promise.allSettled(requestPromises)`. The only thing that spaces them is the node's
**Batching** option: with `batchInterval > 0` the loop sleeps before starting each new batch.

So without a setting change, a sentence and five cards are fired at Telegram or Meta
concurrently, and may **arrive shuffled** — the sentence under the cards, "See more" in the
middle.

**Proposed**, on `send telegram` and `send whatsapp`, and nothing else on those nodes:

```jsonc
"options": { "timeout": 20000, "batching": { "batch": { "batchSize": 1, "batchInterval": 300 } } }
```

- Starts each message 300 ms after the previous one. That makes order reliable in practice; it
  is **not** a hard guarantee, because a request that stalls can still land after its successor.
  A hard guarantee needs a sequential send loop, which belongs to the deploy-day change set
  (`replies`, A2), not to this fix.
- Cost: +300 ms per additional message — a five-card turn finishes ~1.5 s later. A one-message
  turn is unaffected (the sleep only runs from the second item).
- ⚠ **This does not touch `onError` / `neverError`.** ADR-022's deliberate choice — a 4xx from
  Telegram or Meta fails the run so the error workflow reports it — is unchanged.
- **A refused message no longer means a silent turn — accepted as it stands.** With several
  items, a 4xx on one card fails the run and the error workflow reports it; **the other items
  of that run are still sent**, because every request is started inside the item loop before
  `Promise.allSettled` is awaited and the error is raised only after all of them settle. To be
  confirmed on the first real multi-card execution (3.3).

**Decided (2026-09-16):** apply **2.1 and 2.2 together** — by the owner in the session applying
it, and independently by the coordinator.

## 3 · Proof

### 3.1 · Offline, before applying — done

A harness ran the **live** `compose agent reply` code from the snapshot to produce each
scenario's items, then fed them to both the live and the new `drop duplicate reply`
(`$()` stubbed; no n8n, no network). 16 scenarios, 0 failed:

| Scenario | New output | Live output today |
|---|---|---|
| sentence + 3 cards | sentence, card 1, card 2, card 3 | sentence only |
| cards only (model silent) | card 1, card 2 | card 1 |
| sentence only | sentence | *same* |
| model silent, no cards | stand-in | *same* |
| ⛔ bargained + sentence | nothing | *same* |
| ⛔ bargained + sentence + 2 cards | card 1, card 2 | nothing |
| ⛔ bargained + model silent + 1 card | card 1 | nothing |
| bargained + model silent + no cards | nothing | *same* |
| stale bargain echo + sentence + 2 cards | all three | sentence only |
| echo from another turn + sentence + card | both | sentence only |
| malformed echo + sentence | sentence | *same* |
| agent fallback | its sentence | *same* |
| agent fallback + bargained | nothing | *same* |
| outage fallback | its sentence | *same* |
| WhatsApp: bargained + sentence + 2 cards | card 1, card 2 | nothing |
| WhatsApp: sentence + 1 card | sentence, card | sentence only |

Every row marked *same* is a turn with no cards: **the bargaining suppression and the fallbacks
behave byte-identically to today.** Every row that differs is a card that is currently lost.

**Re-run against the DRAFT before publishing — done.** The `jsCode` fetched back from draft
`1997c757` was byte-identical to the tested file, `compose agent reply` was unchanged from
`b9c9187c`, both send nodes carried `{ timeout: 20000, batching: { batch: { batchSize: 1,
batchInterval: 300 } } }` with no `onError`, and the same 16 scenarios passed (16/0) with the
draft's own code as the subject.

### 3.2 · After applying, before publishing

`get_workflow_versions_diff` between `b9c9187c…` and the new version must show **exactly** one
modified node (`drop duplicate reply`, its `jsCode` only) — or three if 2.2 is taken (plus
`send telegram` and `send whatsapp`, their `options.batching` only). No added or removed nodes,
no connection changes. The coordinator runs this diff and says "publish".

**Done:** `b9c9187c → 1997c757` showed exactly those three nodes, nothing added or removed, no
connection change — checked independently by the applying session and by the coordinator.

### 3.3 · After publishing — what was SENT, not whether the run succeeded

⏳ **PENDING** — no live products existed on 2026-09-16, so there was no real product-list turn
to watch. The first one after that date is the check. Items 3 and 6 below are the two that
matter most.

For the first real product-list turns (search `UP-wi-mall-core` executions after the publish
time; open each with `get_workflow_execution`):

1. `compose agent reply` output item count = N.
2. `drop duplicate reply` output item count = N (or N−1 on a bargained turn with a sentence).
3. **`send telegram` / `send whatsapp` ran with that many input items and returned that many
   responses**, each a Telegram `ok: true` / Meta `messages[0].id`. This is the check that
   matters: it is the only one that proves the customer was sent the cards.
4. With 2.2: the responses' Telegram `message_id`s are increasing in item order.
5. On the phone: the sentence first, then the cards, then "See more".
6. If any send in that run returned a 4xx: the run is marked failed (ADR-022, by design) **and
   the other items were still sent** — confirm both.

Also watch one bargaining turn: the customer must receive the bargainer's price and **not** the
assistant's bridging sentence — exactly as before.

## 4 · Applying (procedure agreed with the coordinator)

1. Re-fetch `UP-wi-mall-core`; confirm `versionId === activeVersionId === b9c9187c…`. If they
   differ, somebody has staged a draft — **stop**; never publish another person's draft with this.
2. `update_workflow` with the node change(s) above. **Do not publish.**
3. Send the new version id to the coordinator, who diffs it (3.2) and replies "publish".
4. `publish_workflow`; confirm `activeVersionId` equals the new version.
5. Watch (3.3).

## 5 · Rollback

`restore_workflow_version` to **`b9c9187c-3f78-4a6a-9e7f-8b091074952f`**, then publish, and
confirm `activeVersionId` moved back. The fix touches no data, no Redis key and no other
workflow, so a rollback restores the previous behaviour exactly — including its defect.
