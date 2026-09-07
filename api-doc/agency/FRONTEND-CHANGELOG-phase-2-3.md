# Agency dashboard — what Phase 2 and Phase 3 changed

**Verified against source on 2026-09-08** — the route claims on this page against `jovi-mall/src/modules/delivery/agency.routes.ts` and `src/api/index.ts`.

Your slice of Phases **2** (Deployability) and **3** (Cross-service correctness) of
[`PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md`](../../../PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md).

- **Written:** 2026-08-21 · **Phase 2:** 2026-08-18 → 08-19 · **Phase 3:** 2026-08-19
- **Read first, then this:** [../FRONTEND-CHANGELOG-phase-2-3.md](../FRONTEND-CHANGELOG-phase-2-3.md)
  (the cross-role half — deploy behaviour, probes, tokens, dependency upgrades)
- **You are the most affected audience of Phase 3.** The live-tracking board changed in two
  ways, one of which is a correctness fix.

---

## The change list, ranked

| # | Change | Your work |
|---|---|---|
| 1 | 🔴 A dropped tracking subscription now says **why**, truthfully | **Required** — branch on `reason` |
| 2 | The board now gets an **ETA for every agent**, with no client work | **Optional but wanted** — render it; send `shipmentId` to scope it |
| 3 | Status transitions are **atomic with their tracking event** | Small — one new retryable error path |
| 4 | Auto-confirmed deliveries now **close their tracking session** | None — a stale-agent bug disappears |
| 5 | Legacy shipments all carry a **tracking number** now | Small — you can stop apologising for blanks |
| 6 | Agent **vehicle colours** are normalised | Small — keep the unknown-token fallback |
| 7 | Deploy/restart behaviour, probes, token rotation | See the cross-role page |

Nothing was renamed, removed or re-shaped. `GET /api/agency/tracking/board`,
`GET /api/agency/shipments`, `PATCH /api/agency/shipments/:id/status`,
`POST /api/agency/shipments/:id/reject`, `PATCH /api/agency/shipments/:id/assign-agent` and
`POST /api/agency/shipments/:id/reassign` all answer exactly as
[shipments.md](./shipments.md), [assignment.md](./assignment.md) and
[live-tracking.md](./live-tracking.md) describe them.

---

## 1 · 🔴 `permission_revoked.reason` — the live board is currently lying in two cases

Your board holds a WebSocket to **geo-tracker** and subscribes to each agent. When a
subscription is dropped, the server sends:

```json
{ "type": "permission_revoked",
  "payload": { "agentId": "agent-1", "reason": "authorization_expired" } }
```

Until 2026-08-19 `reason` was the single literal `shipment_completed` for **every** outcome. If
your board removes an agent's marker and shows "delivery complete" on that frame, it is
currently telling a dispatcher a delivery finished when in fact **the viewer's access token
aged out**.

| `reason` | What happened | Board behaviour |
|---|---|---|
| `shipment_completed` | jovi-mall was asked and said this viewer is no longer entitled. The delivery ended, or the entitlement did. | Drop the marker. **The only value from which you may report a delivery outcome.** |
| `authorization_expired` | jovi-mall **rejected the token** the socket was opened with (401/403). Nothing is known about the shipment. | Refresh the session, reconnect, re-subscribe. **Show the delivery as still in progress**, ideally with a transient "reconnecting" state. |
| `authorization_unavailable` | jovi-mall **could not be asked** — unreachable, 5xx, timeout. Nothing is known. | Retry with backoff. Report no outcome. Keep the last known position visible and marked stale. |

**Treat any unrecognised value as `authorization_expired`.**

**And the operational rule behind it:** the WS token is validated **at handshake only**. Nothing
re-checks it on a timer — but when a revocation check fires (a shipment settling, a webhook),
geo-tracker re-asks jovi-mall with the token you handed over at handshake. Past the **15-minute**
access TTL that token is expired and the subscription dies. A dispatcher who leaves the board
open on a wall screen all afternoon is exactly this case.

**Reconnect the tracking socket with a fresh access token on a cadence shorter than 15 minutes.**
There is no refresh path over the socket and there deliberately never will be.

Detail: [../tracking/live-tracking.md](../tracking/live-tracking.md) ·
[`geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-2-3.md`](../../../geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-2-3.md)

---

## 2 · The board now gets an ETA — you never could before

This is the change most likely to alter a design. Before Phase 3, `etaSeconds` and
`distanceMeters` appeared only when the **viewer** supplied a `destination` on its `subscribe`
frame — and an agency board has no reason to know a customer's address, so **no agency viewer
has ever seen an ETA**.

geo-tracker now pulls the parcel's geocoded drop-off from jovi-mall when a delivery's tracking
session opens, and hands it to every watcher. **Your existing `subscribe` frame, unchanged, now
yields an ETA.**

### Send `shipmentId` when you can

```json
{ "type": "subscribe",
  "payload": { "agentId": "<agentId>", "shipmentId": "<shipmentId>" } }
```

Resolution, first hit wins:

| | Rule | Result |
|---|---|---|
| ① | you sent `destination` | that point, always |
| ② | you sent `shipmentId` | that shipment's drop-off, and **nothing** if that shipment has no open session |
| ③ | neither, and the agent has **exactly one** open session | that delivery's drop-off |
| ④ | otherwise | no ETA |

**This matters for you specifically, because agency agents run several deliveries at once.**
Rule ③ deliberately **refuses to guess**: a multi-drop agent yields **no** ETA unless you scope
with `shipmentId`. If your board is a per-shipment row, send the shipment id and every row gets
its own ETA. If it is a per-agent map pin with a multi-drop agent, you get nothing — by design,
because an ETA to the wrong drop-off looks right and is wrong.

### Three rendering rules

- **The ETA can arrive late.** The drop-off is fetched out of band when the session opens, so a
  viewer who subscribed before that landed starts with no ETA and **gains one without
  reconnecting**, on the next lifecycle event for that agent. Do not build a terminal
  "ETA unavailable" state.
- **The ETA lags the marker by up to 30 s.** It is recomputed at most once per `ETA_MIN_INTERVAL`
  (default 30 s) per agent+destination, and all viewers of one delivery share the same value from
  one routing call. Do not animate a live countdown off it.
- **No ETA is always valid.** A legacy order with no geocoded address, or a briefly unreachable
  routing provider, both produce a position with no `etaSeconds`. **Render the position anyway.**

The board endpoint itself (`GET /api/agency/tracking/board`) is unchanged — it still gives you
the agent list, the shipment context and the drop-off pin for drawing. The ETA arrives on the
socket, not on the board response.

---

## 3 · Status transitions are now atomic with their tracking event

`PATCH /api/agency/shipments/:id/status`, `POST /api/agency/shipments/:id/reject`,
`POST /api/agency/shipments/:id/reassign` and the agent-cancel release all now write the
geo-tracker lifecycle event **inside** the same database transaction as the status change.

**Why it matters:** previously the event was emitted after the transaction committed,
fire-and-forget. A crash in that window lost it permanently — leaving a delivered shipment whose
agent kept being broadcast to your board, or a released agent geo-tracker never heard about.

**What changes for you:**

- **A new failure mode, and it is the correct one.** If the event cannot be written, the
  transition **rolls back**: your call returns an error and the status did **not** change.
  Retry it. Previously the transition would have "succeeded" with the event silently lost —
  which looked like success and was worse.
- `409 SHIPMENT_STATUS_CONFLICT` is unchanged and still means what it meant: the from-status
  compare-and-set missed because the agent (or another dispatcher) moved the shipment first.
  **Re-read the shipment and re-render — do not blind-retry.** With two actors on one document
  this is a routine outcome, not an exception.
- Nothing about the request or the success response changed.

---

## 4 · Auto-confirmed deliveries now close their tracking session

A real defect, found and fixed during Phase 3, that your board would have shown as a bug in
your code.

`autoConfirmStaleDeliveries` — the sweep that confirms a **prepaid** delivery the customer never
confirmed — **never emitted a lifecycle event, ever.** So a shipment auto-confirmed to
`delivered` (a terminal status) left geo-tracker with the tracking session still open: the agent
stayed watchable, and the board went on showing a live pin for a finished delivery until the
session TTL expired or some later event reconciled it away.

Invisible in testing and routine in production — it is the path taken by exactly the customers
least likely to press a button. **Fixed.** The COD half of that sweep was never affected.

No action for you beyond removing any workaround you built for it.

---

## 5 · Every legacy shipment now has a tracking number

`backfill:shipment-tracking-numbers` ran against the dev database and gave **25** shipments a
`tracking_number` they did not have. Numbers are generated from the shipment's **own** agency
and its **own** creation timestamp, so a backfilled number is indistinguishable from a natively
generated one. Hand-typed carrier numbers from before generation were **left alone** — whatever
a customer was told still resolves.

The field remains **read-only**; there is no endpoint to set it (see
[shipments.md § Tracking number](./shipments.md#tracking-number-read-only--no-endpoint)).

⚠ Keep your null-safe rendering. This ran against **dev** only, and the ledger is
forward-looking — there is no production database yet.

---

## 6 · Agent vehicle colours are normalised (mostly)

`migrate:agent-vehicle-colors` rewrote **8** agents' `vehicle_info.color` to the lowercase
vocabulary (`"Red"` → `"red"`, `"Gray"` → `"grey"`). The roster and the dispatch screens should
now hit your colour swatch map far more often.

**One value was deliberately left verbatim** (`"bleu"`), and more will exist over time: `color`
is a **documented convention with an "another colour" escape hatch**, not an enum. The app
normalises on write; anything outside the vocabulary is preserved as the agent typed it, because
rewriting it would destroy what they reported.

**Keep your fallback for unknown tokens.** Rendering an unknown colour as text beside a neutral
swatch is the intended behaviour, not a gap.

---

## 7 · Everything else — see the cross-role page

- **Deploy and restart:** in-flight requests now complete instead of being truncated; idle
  pooled connections close after **65 s**. A long-lived dashboard should retry idempotent GETs
  once on a connection-level error.
- **Probes:** `GET /api/health` is a frozen unconditional 200 with **no** `{success, data}`
  envelope — fine for a reachability dot, useless as a readiness check. Use
  `/api/health/ready` for that.
- **`JWT_SECRET` rotation** logs everyone out and drops every tracking subscription — now
  reported honestly as `authorization_expired`.
- **`sharp` 0.35** — re-test agency logo/banner uploads.
- **`firebase-admin` 14** — push is migrated but an actual FCM send is **unverified**.
- **Capacitor origins** are now in both `.env.example` templates, so a wrapped build of this
  dashboard can reach both services (in geo-tracker that one variable gates HTTP CORS *and* the
  WebSocket origin check).
- **Maintenance mode:** `/api/tracking/*` and `/api/internal/*` stay reachable in every mode, so
  a jovi-mall maintenance window does not kill live tracking. Your own agency routes are not
  exempt and will be blocked as usual.

Full detail: [../FRONTEND-CHANGELOG-phase-2-3.md](../FRONTEND-CHANGELOG-phase-2-3.md)
