# Customer app — what Phase 2 and Phase 3 changed

Your slice of Phases **2** (Deployability) and **3** (Cross-service correctness) of
[`PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md`](../../../PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md).

- **Written:** 2026-08-21 · **Phase 2:** 2026-08-18 → 08-19 · **Phase 3:** 2026-08-19
- **Read first, then this:** [../FRONTEND-CHANGELOG-phase-2-3.md](../FRONTEND-CHANGELOG-phase-2-3.md)
- **Also read:** [`geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-2-3.md`](../../../geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-2-3.md)
  — the order-tracking screen is where these phases land hardest
- **Building the storefront/shop too?** [../public/FRONTEND-CHANGELOG-phase-2-3.md](../public/FRONTEND-CHANGELOG-phase-2-3.md)

---

## The change list, ranked

| # | Change | Your work |
|---|---|---|
| 1 | 🔴 The tracking screen can currently say **"delivered"** when a token expired | **Required** — branch on `reason` |
| 2 | ETA now resolves **without** you supplying a destination | Optional — you may be able to delete code |
| 3 | Auto-confirmed prepaid deliveries now **end** their tracking session | None — a stuck-map bug disappears |
| 4 | Passwordless (bot) sign-in now needs the n8n side to send a **secret header** | **Watch for a 401 wall** |
| 5 | Every legacy order/shipment now has a **tracking number** | Small |
| 6 | Order/verification emails were broken in built environments — **fixed** | Retry what you wrote off |
| 7 | Restart, keep-alive, probes, token rotation | Small |

**No customer endpoint changed.** Cart, checkout, orders, confirm-delivery, bookings, payment
methods, profile and notifications all answer exactly as their documents describe.

---

## 1 · 🔴 The order-tracking screen may be telling users their parcel arrived when it did not

Your live map holds a WebSocket to **geo-tracker**. When your subscription is dropped, it sends:

```json
{ "type": "permission_revoked",
  "payload": { "agentId": "agent-1", "reason": "authorization_expired" } }
```

Until 2026-08-19 `reason` was the single literal `shipment_completed` — for **every** outcome,
including *"your access token expired"* and *"jovi-mall was unreachable"*. A client that reads
"delivered" off that frame has been telling customers their delivery finished because a token
aged out. That is the defect this fixes.

| `reason` | What happened | What to show |
|---|---|---|
| `shipment_completed` | jovi-mall was asked and answered: you are no longer entitled to watch this agent. The delivery ended, or the entitlement did. | Stop watching. **The only value from which you may report a delivery outcome.** |
| `authorization_expired` | jovi-mall **rejected your access token** (401/403). Nothing is known about the shipment. | Refresh the session, reconnect, re-subscribe. **Show the delivery as still in progress.** Say nothing about arrival. |
| `authorization_unavailable` | jovi-mall **could not be asked** — unreachable, 5xx, timeout. Nothing is known about the shipment *or* your entitlement. | Retry with backoff. Report no outcome. Keep the last position, marked stale. |

**Treat any unrecognised value as `authorization_expired`** — re-authorize and tell the user
nothing. That rule is what makes a fourth value safe to add later.

**Where "delivered" should come from instead:** the order/shipment record on jovi-mall
(`GET /api/customer/orders/:id`, the `status` / `orderFulfillmentStatus` fields), not from the
tracking socket. The socket tells you where the courier is; the order tells you whether it
arrived.

### The reconnect rule

The WS token is validated **at handshake only** — nothing re-checks it on a timer. But when a
revocation check fires, geo-tracker re-asks jovi-mall with the token you handed over at the
handshake. Past the **15-minute** access TTL that token is expired and the subscription dies.

**Reconnect with a fresh access token on a cadence shorter than 15 minutes.** A customer
watching a courier approach for twenty minutes is precisely this case. There is no refresh path
over the socket and deliberately never will be, and there is **no handshake ack frame** telling
you when to refresh — one was proposed during Phase 3 and rejected, because it would have meant
a fifth outbound frame type that exhaustive clients reject.

---

## 2 · You may no longer need to send a `destination`

Before Phase 3, an ETA required **your** client to put a `destination` on its `subscribe` frame
— which meant your app had to know and send the delivery coordinates. The customer app was in
practice the only client that did it.

geo-tracker now pulls the parcel's geocoded drop-off from jovi-mall when the tracking session
opens, so **an ETA arrives whether or not you send one.**

Resolution, first hit wins:

| | Rule | Result |
|---|---|---|
| ① | you sent `destination` | that point, always — an override nothing replaces for the life of the subscription |
| ② | you sent `shipmentId` | that shipment's drop-off, and **nothing** if that shipment has no open session |
| ③ | neither, and the agent has **exactly one** open session | that delivery's drop-off |
| ④ | otherwise | no ETA |

**Your existing `destination` keeps working, unchanged and still winning** — it was the only path
that existed and removing it would break every shipped client. Two things to weigh:

- If your `destination` is derived from the customer's own address, you can now **drop it** and
  let the server resolve the drop-off the order was actually geocoded to. That is strictly more
  correct: it is the same address the agency board and the courier's route use.
- If you keep it, be aware you are overriding the shipment's real drop-off, and no server-side
  correction can reach you.
- Where the courier is running several deliveries, prefer **`shipmentId`** — you know which
  shipment your screen is about. Without it, rule ③ **declines to guess** for a multi-drop
  courier, because an ETA to the wrong address is worse than none.

### Rendering rules that are easy to get wrong

- **The ETA can arrive late** and appears **without a reconnect** on a later broadcast. Do not
  build a terminal "no ETA" state.
- **It lags the marker by up to 30 s** — recomputed at most once per `ETA_MIN_INTERVAL`
  (default 30 s) per agent+destination, shared across every viewer of that delivery. Do not run
  a live countdown off it.
- **It can be absent entirely** and always could: a legacy order with no geocoded address, or a
  briefly unreachable routing provider. **Render the position regardless.**

---

## 3 · Auto-confirmed prepaid deliveries now end their tracking session

A real defect found during Phase 3, whose symptom would have looked like a bug in your map.

`autoConfirmStaleDeliveries` — the sweep that confirms a **prepaid** delivery the customer never
confirmed — **never emitted a lifecycle event, ever**. The shipment went to `delivered`, a
terminal status, and geo-tracker was never told: the tracking session stayed open and the
courier stayed watchable until its TTL expired.

Invisible in testing, routine in production, because it is the path taken by exactly the
customers who never press the confirm button. **Fixed.** COD was never affected — that path
always emitted.

Nothing to build. If you added a workaround (a client-side timeout that hides the map after N
minutes, say), it can go — but check it against § 1 first, since a *stale* map and a *revoked*
subscription are now distinguishable.

Your confirm flow itself is unchanged:
`POST /api/customer/orders/:orderId/shipments/:shipmentId/confirm-delivery` for prepaid,
and the delivery code for COD (there is no confirm-delivery action for COD — show the code).
See [orders.md](./orders.md).

---

## 4 · Passwordless sign-in: the bot webhook now requires a secret header

Customer authentication is **bot-first** — customers register on first bot contact and sign in
passwordlessly through a code the bot mints. That path runs through n8n, which calls jovi-mall's
messaging webhooks.

`BOT_WEBHOOK_SECRET` was **unset**, which meant those webhooks were **open in development** and
fail-closed in production only. It is now generated and set, so they require an
`X-Webhook-Secret` header **in development too**.

**Consequence: the n8n side must send the same value or `/connect` answers 401 and mints no
codes** — which presents to a customer as *"I asked for a login code and nothing arrived"*, with
nothing visible in your app to explain it.

Two things to know:

- The n8n workflow is already non-functional for an **unrelated** reason (it maps `/link`, not
  `/connect`, and must relay the `message` field), so nothing regressed — but it does mean
  passwordless login is inert until the n8n work is done. That work is outside these
  repositories.
- **Design against a login that can be silently unavailable.** A "code sent" screen with no
  timeout and no alternative route strands the user. Surface a retry, and a fallback contact
  path.

See [../auth/customer-auth.md](../auth/customer-auth.md) and
[../auth/magic-login.md](../auth/magic-login.md).

---

## 5 · Every legacy shipment now has a tracking number

`backfill:shipment-tracking-numbers` gave **25** legacy shipments a `tracking_number` they did
not have, generated from their own agency and creation timestamp so a backfilled number is
indistinguishable from a natively generated one. Hand-typed carrier numbers were left alone —
whatever a customer was told still resolves.

`trackingNumber` appears on the order and shipment payloads exactly as
[orders.md](./orders.md) documents. It is read-only.

⚠ This ran against the **dev** database only. Keep your null-safe rendering.

---

## 6 · Order and verification emails were broken in built environments — fixed

`tsc` emits no `.hbs` files, so the compiled `dist/` shipped **without any mail template**: every
templated email was broken under `npm start`, i.e. in any deployed or container-built
environment. It worked in `npm run dev` only, which is why it survived so long. Found while
building the container image; the build now copies non-TS assets from a manifest a test enforces.

If order confirmations or verification emails were written off as unreliable, retry them.

`nodemailer` also moved 7 → 9.0.5 in the same phase, and `firebase-admin` 13 → 14 — **push
notifications are migrated but an actual FCM send is unverified**. Test push end to end.

---

## 7 · Restart, probes and tokens

- **A deploy no longer truncates a request.** jovi-mall had *no* shutdown handling and now
  drains: an accepted request completes (budget `SHUTDOWN_TIMEOUT_MS`, default **10 s**). A
  checkout submitted the instant a deploy starts now finishes rather than dying mid-transaction.
- **Idle keep-alive sockets close after 65 s.** For a native client with a connection pool, keep
  the idle timeout below that or a reused socket eventually hits `ECONNRESET`. Retry
  connection-level failures rather than surfacing them.
- **Probes:** `GET /api/health` is frozen — unconditional 200, body `{status, timestamp}`, **no
  `{success, data}` envelope**. It answers 200 with the database down, so it is a reachability
  check only. `GET /api/health/ready` is the readiness one. See [../health.md](../health.md).
- **A mid-session 401 is normal.** Rotating `JWT_SECRET` invalidates every live access token at
  once and drops every tracking subscription (now honestly reported as `authorization_expired`).
  Refresh and retry; browser clients renew inside an ordinary request, bearer clients call
  `POST /api/auth/mobile/refresh` — which stays available even during a `readonly` maintenance
  window, precisely so a maintenance window does not sign every native client out.
- **Rate limits are unchanged** — [../rate-limits.md](../rate-limits.md).
