# The typing indicator

**Built 2026-09-07.** Keeps the channel's "typing…" alive for the *whole* time a turn is being
computed, instead of the five seconds Telegram gives you for free. It exists because a turn is
slow — an ordinary agent reply is a few seconds, a **bargaining** turn is 15–25 (see
[bargaining-agent.md](./bargaining-agent.md) § 10) — and the customer spent all of it looking at
nothing.

| Workflow | id | |
|---|---|---|
| **wi-mall-typing** | `DgCsloEFf35nxDqp` | new — the ping loop |
| **wi-mall-tg-adapter** | `siCyKSqWmgDGEmzW` | `start typing` + `stop typing` |
| **wi-mall-wa-adapter** | `01h0wDrawM1rWtxm` | `typing (first)` + `start typing` + `stop typing` |

`wi-mall-core`, `wi-mall-bargain` and `wi-mall-mcp` are **unchanged**, and that is the design:
the adapter wraps the entire turn, so everything downstream — the main agent, the bargaining
sub-agent, every MCP tool call — is covered without knowing this exists.

---

## 1 · How it runs

```
adapter
  trigger → … → normalize
    ├─ start typing   Execute Sub-workflow, waitForSubWorkflow: FALSE   ← 62 ms, measured
    │                                                                       │
    ├─ wi-mall-core   waitForSubWorkflow: TRUE   (seconds to ~25 s)         │ concurrently
    │     └─ may hand off to wi-mall-bargain, which sends its own reply     │
    │                                                                       ▼
    └─ stop typing    Redis DELETE                        wi-mall-typing
                                                            kill switch? → enabled?
                                                            → claim → ping → wait → still typing?
                                                                        ▲──────────┘
```

n8n has no concurrency inside one execution, so the loop cannot live in the adapter — it is a
**detached sub-execution**. `waitForSubWorkflow: false` starts it and returns immediately, and it
keeps running while the parent works. That was the one real unknown in the design and it is
measured, not assumed: `start typing` returned in **62 ms** having spawned a sub-execution that
then ran for the parent's full duration.

**Why the adapter and not `wi-mall-core`.** Three reasons, and the third is decisive:

- it wraps the *whole* turn, so one implementation covers every slow path including bargaining;
- `wi-mall-core` is deliberately channel-agnostic, and this is channel-specific by nature;
- **WhatsApp needs the raw inbound `wamid`**, which only the adapter has.

---

## 2 · The intervals, and why they are not round numbers

| | Platform window | Ping every |
|---|---|---|
| Telegram `sendChatAction` | **5 s**, or until a message is sent | **4 s** |
| WhatsApp typing indicator | **25 s**, or until a message is sent | **20 s** |

Ping *inside* the window, never on top of it. At 7 s on Telegram or 27 s on WhatsApp the
indicator blinks off for two seconds every cycle, which reads worse than not having it.

⚠ **WhatsApp has no standalone typing call.** The indicator rides on marking the inbound message
**read**: `POST /{phone-number-id}/messages` with `status: read`, the `message_id`, and
`typing_indicator`. So the customer also gets blue ticks — a real behaviour change, not a
side-effect to discover later. It needs a recent Graph version; v18 does not carry it, hence the
`v26.0` default.

---

## 3 · ⚠ Stopping it — measured, and one of the obvious ways does not work

The feature is a **garnish**. It must never be able to delay or break a turn, and it must be
stoppable at any time, in production. Three ways, all verified:

**1. `SET wi-mall:typing:disabled 1` — the real switch.** Instant, no workflow edit. Measured: the
pinger exits in **30 ms** without touching a messaging API, against 12.4 s and 3 pings with it
clear. `DEL` the key to resume — also measured.

**2. Disable the `start typing` node** in one adapter. Stops that channel only.

**3. Archive `wi-mall-typing`.** The adapters' call then fails, and the failure is swallowed.

### ⛔ UNPUBLISHING DOES NOT STOP IT

Measured: with `wi-mall-typing` unpublished, `start typing` still spawned it and it still pinged
for the full turn. **n8n does not gate Execute Sub-workflow on published state** — it runs the
draft. This was written into the plan as a working off-switch and it is not one. Use the kill key.

### Why none of it can hurt a turn

`start typing` is a **dead-end parallel branch** wired *before* `wi-mall-core`, with
`onError: continueRegularOutput`. Nothing downstream reads its output and the reply path does not
pass through it. Measured with the typing flow switched off: the turn completed normally.

Branch order matters — a `start typing` that ran *after* `wi-mall-core` would begin typing once
the turn was already over — and it is pinned two ways: the connection is registered first, and the
node sits above `wi-mall-core` on the canvas. Both n8n branch-ordering rules therefore agree.
Verified in the probe, where `start typing` took `executionIndex: 2` ahead of the simulated work.

---

## 4 · Four ways the loop ends

It needs **all** of these to continue, so any one of them stops it:

1. the adapter deleted the per-turn flag — the normal exit, within one cycle;
2. the flag's embedded **deadline** passed (120 s) — ⚠ needed because the n8n Redis node's `set`
   exposes no TTL, so an adapter that crashes before deleting cannot leave a pinger running;
3. the **iteration cap** — Telegram 20 × 4 s, WhatsApp 5 × 20 s;
4. the workflow's own 180 s `executionTimeout`.

Both platforms dismiss the indicator the instant a real message arrives, so a late stop is
invisible to the customer and costs at most one API call.

---

## 5 · What it costs

**One extra n8n execution per customer message**, alive for the duration of the turn. Fine in
development; at scale it is a real capacity question, because a waiting execution holds a slot.
`saveDataSuccessExecution` is currently **`all`** so the loop can be inspected — flip it to
`none` when traffic is real, and note that doing so also hides these executions from
`search_workflow_executions`.

The Redis keys live in n8n's own Redis alongside `wi-mall:bargain:*`, so **no new logical database
index is needed** — that budget is 5–15 and already tight (`infra/redis/redis.factory.ts`).

Telegram's `sendChatAction` and WhatsApp's read/typing call are both unbilled and well inside per-
conversation rate limits at one call per 4 s / 20 s.

---

## 6 · An unrelated thing this surfaced

⚠ **`wi-mall-core`'s `send whatsapp` node references credential `UXeNEmhDRboLA3H6`
(`whatsapp_auth`), which does not exist in this n8n instance** — `list_credentials` returns 26
credentials and it is not among them. The same id is on `wi-mall-wa-adapter`'s two media nodes and on
`wi-mall-bargain`'s `send whatsapp`. Sends demonstrably still work (a bargaining smoke test got a
real `wamid` back from Meta), so something resolves it at runtime, but it is worth understanding
before it stops working. The nodes added here use `kHtdfgqmg5UMAHGy` (`Whatsapp Auth Token`,
bearer), which exists and is the correct auth for the Graph API.
