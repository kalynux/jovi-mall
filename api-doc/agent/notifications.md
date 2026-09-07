# Agent Notifications

**Verified against source on 2026-09-08** — all **eighteen** situations, the five preference keys,
the channel-priority rule, both device-token schemas and the list `limit` ceiling, against
`src/modules/notifications/{models/agent-notification.model.ts,
catalog/agent-notification-catalog.ts, services/agent-notification-event-handler.service.ts,
validators/device-token.validator.ts}` and
`src/modules/delivery/validators/agent-notification.validator.ts`.

Full multi-channel parity with vendor and agency notifications — in-app, push, and one
preference-gated secondary channel (email/Telegram/WhatsApp), catalog-driven and localized.
Architecture mirrors [Agency Notifications](../agency/notifications.md) exactly; this doc follows the
same structure.

> 📱 **Building the Flutter agent app? Start with
> [Push Notifications — Flutter Integration Guide](./push-notifications.md).** It is the complete
> client-side contract: the exact message shape the backend sends, the **Android channel ids the app
> must create**, token lifecycle, per-app-state handling, and a verification checklist. Push is what
> lets the agent be notified without refreshing — it is the only transport that reaches a
> backgrounded or killed app. (The vendor doc's
> [FCM section](../vendor/notifications.md#push-notifications-fcm) covers the *web* equivalent.)

> **Why agents have notifications at all.** Every situation here is the agent's **own cash liability
> moving** — a deposit being confirmed or rejected. For a cash-on-delivery agent that is money they
> are personally accountable for, and until this stack existed an agency could record (or mis-record)
> a hand-over and the agent would never be told. The `cod.deposit.recorded` notification in particular
> is the agent's only automatic signal that an agency recorded **less than they handed over** — so
> treat these as financial records, not marketing pings.

## Base Path

```
/api/agent
```

## Authentication

**Authorization**: Agent access required. Bearer token with `agent` role.

---

## Notification Settings

Same three parts as vendor/agency:

1. **Event subscriptions** (`preferences.*`) — per-event on/off.
2. **Delivery channel** (`*Enabled` + `*Verified`) — which secondary channel receives messages.
3. **Language** (`preferred_language`) — lives on the agent profile.

### How delivery is decided

Identical to [agency](../agency/notifications.md#how-delivery-is-decided): in-app always on; at most
one secondary channel; a channel delivers only if enabled **and** verified; priority
**telegram → email → whatsapp**; rendered in the agent's `preferred_language`.

> **`codDepositUpdates` defaults on, and you should think twice before offering an off switch in the
> UI.** It is the only signal an agent gets that their cash balance moved. An agent who disables it
> and is then under-recorded loses both the money and the warning.

---

## The situations (what actually notifies an agent)

| `type` | When | Why it matters |
|---|---|---|
| `cod.deposit.recorded` | An agency recorded a cash deposit from you that you **did not declare** yourself. | Your balance just dropped on the agency's say-so. **If the amount is wrong, this message is how you catch it** — report it via [`POST /api/agent/cod/discrepancies`](./cod-cash.md). |
| `cod.deposit.confirmed` | The agency (or the platform, for a direct payment) **confirmed a deposit you declared**. | Your claim landed: balance reduced, COD headroom freed. |
| `cod.deposit.rejected` | The receiving party **rejected a deposit you declared**. | No money moved, the cash is still on your balance, and **your deposit deadline is running again** — the message carries the reason. |
| `plan.expiring` | Your subscription plan is nearing expiry (within your notice window). | Renew/upgrade before it lapses to keep your higher delivery limit. Gated by `planUpdates`; `aggregateType: plan`, `action` → `plans`. See [Billing](./billing.md). |
| `plan.expired` | Your plan expired — handed over to a queued plan, or **downgraded to `agent_free`**. | A downgrade **lowers your concurrent-delivery cap** (back to 20). Gated by `planUpdates`; `aggregateType: plan`, `action` → `plans`. |
| `storage.alert` | Your **own media storage** crossed 80 / 90 / 100% of your plan cap (highest crossed band only, ≤ once per month per band). | Free space or upgrade. Gated by `storageAlert`; `aggregateType: storage`, `action` → `settings/storage`. **Delivery proofs are charged to the agency, not counted here.** See [Storage](./storage.md). |
| `shipment.offer.received` | An agency (or auto-assignment) offered you a delivery. | Time-critical — accept before another agent does. Gated by `assignmentOffers`; `aggregateType: offer`, `action` → `offers/{id}`. Delivered on the dedicated `jovi_agent_offers` push channel. See [Offers](./offers.md). |
| `shipment.offer.reminder` | Auto-assignment round 2: an offer you haven't answered is **still open**. | Still acceptable — auto offers don't expire on the timeout. Same gate, channel and deep-link as `.received`. |
| `shipment.offer.expired` | A **manual** offer lapsed because you didn't answer in time. | Informational, so a missed job doesn't vanish silently. Same gate; default push channel. |
| `shipment.reassigned_away` | The agency moved a delivery you were handling to another agent. | You are off it: customer PII and live tracking are already revoked; it stays in your activity history. Gated by `assignmentOffers`; `aggregateType: shipment`, **no `action`**. |
| `agent_contract.request_received` | An agency asked **you** to deliver for them. | **The only signal that a request is waiting** — there is no invite inbox to poll any more. Accept or reject it from `memberships/{id}`. Gated by `contractUpdated`; `aggregateType: contract`. See [Agency membership](./agency-membership.md). |
| `agent_contract.approved` | An agency approved an application you sent. | You can now receive their delivery offers. Same gate, `aggregateType: contract`. |
| `agent_contract.rejected` | An agency declined an application you sent. | You may apply again later, or browse other agencies. Same gate. |
| `agent_contract.status_request_raised` | An agency proposed a change to a contract you already hold — a pause, a reactivation, or **ending it**. | It does not take effect until you answer. Answer from your [status-request inbox](./agency-membership.md#get-apiagentmembershipsstatus-requests). Same gate, `aggregateType: contract`. |
| `agent_contract.status_request_resolved` | A pending contract change was approved, declined, or cancelled. | Covers both "the agency answered what you raised" and "the agency withdrew what you were waiting on" — the copy names the change, not whose it was. Same gate. |
| `agent_contract.terms_countered` | An agency changed the terms of a **pending** contract — your cut, your coverage, the settlement cadence. | **The right to accept is now yours.** Without this an agent who thinks their own offer is still standing never goes back to look. Same gate, `aggregateType: contract`. Idempotent on the contract id **plus emission time**, so each round of a negotiation notifies. |
| `agent_contract.terms_proposed` | An agency wants to change a **live** contract's terms. | The copy states that **your current terms stay in force until you answer** — that is a fact, not reassurance: you keep being paid the agreed rate while it sits. Same gate; idempotent on the **proposal** id. |
| `agent_contract.terms_resolved` | A terms proposal was accepted, declined, withdrawn or superseded. | Neutral about whose it was — it covers both "the agency answered yours" and "the agency withdrew the one you were waiting on". Same gate; idempotent on the proposal id. |

The three COD-deposit rows carry an `action` deep-linking to the deposit (`cod/deposits/{id}`), and an
`aggregateType` of `deposit` with the deposit id as `aggregateId`. The `plan.*` rows deep-link to
`plans` with `aggregateType: plan` and the agent id as `aggregateId`.

All eight `agent_contract.*` rows deep-link to `memberships/{contractId}` with
`aggregateType: contract` and the contract id as `aggregateId`. They are gated by
`contractUpdated`, which defaults **on** — an agency's request now reaches you only through the
platform, so silencing it means never seeing one. That is doubly true of the three `terms_*` rows:
they are how you learn what you are being asked to work for.

> **WhatsApp is dark for the three `terms_*` situations** until `agent_contract_terms_countered`,
> `agent_contract_terms_proposed` and `agent_contract_terms_resolved` are created and approved in
> Meta Business Manager. In-app, email, Telegram and push deliver today. See
> [whatsapp-templates.md](../notifications/whatsapp-templates.md).

The first three are the handshake that **forms** a contract; the two `status_request_*` rows are
changes to one that already exists. The latter used to be silent on the reasoning that they have
their own inbox, which meant a proposed termination went unseen until someone happened to open the
tab. Note the idempotency key is the **request** id, not the contract id: one contract can be
paused, reactivated and later terminated, and each proposal is its own thing to answer.

There is deliberately **no notification when you declare a deposit** — you did that, so it would be
noise. The declaration notifies your *agency*, who has to answer it. For the same reason there is
none when you accept or reject an offer, when you withdraw your own application, or for the
`pause` / `reactivate` / `terminate` transitions — those land in your status-request inbox
(`GET /api/agent/memberships/status-requests`) rather than as a push.

Full `type` → `aggregateType` → deep-link mapping, in a form you can code against:
[Flutter guide → Route](./push-notifications.md#route).

---

## Endpoints

- [`GET /api/agent/notification-preferences`](#get-preferences)
- [`PATCH /api/agent/notification-preferences`](#update-preferences)
- [`GET /api/agent/notifications`](#list)
- [`PATCH /api/agent/notifications/:id/read`](#mark-read)
- [`POST /api/agent/notifications/read-all`](#mark-all-read)
- [`POST /api/agent/devices`](#register-device)
- [`DELETE /api/agent/devices`](#unregister-device)

> ⚠️ **`/api/agent/devices` is for FCM push tokens.** Do not confuse it with the agent domain's
> `/api/agent/device` (singular) — that is your device **capabilities and location permission**, an
> input to whether you can be assigned work. Different endpoint, different meaning.
>
> Likewise, `/api/agent/notification-preferences` is **not** `/api/agent/preferences` — the latter is
> your profile-level preferences in the agent domain ([profile.md](./profile.md)), and it now carries
> only `navigation_app`. **Everything that decides whether you are notified is on this page.** Two
> `notify_*` flags used to sit on `/api/agent/preferences` and gated nothing; they were removed
> rather than left to look as if switching them off worked.

---

<a name="get-preferences"></a>
### GET /api/agent/notification-preferences

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": {
    "inAppEnabled": true,
    "emailEnabled": false,
    "telegramEnabled": true,
    "whatsappEnabled": false,
    "emailVerified": true,
    "telegramVerified": true,
    "whatsappVerified": false,
    "preferences": {
      "codDepositUpdates": true,
      "assignmentOffers": true,
      "contractUpdated": true,
      "planUpdates": true,
      "storageAlert": true
    }
  }
}
```

The `*Verified` flags are **computed live** from the agent's account (email verification, Telegram
link, WhatsApp link) — not stored toggles, ignored on write.

---

<a name="update-preferences"></a>
### PATCH /api/agent/notification-preferences

**Request Body** (all optional):
```json
{
  "emailEnabled": false,
  "telegramEnabled": true,
  "whatsappEnabled": false,
  "preferences": {
    "codDepositUpdates": true,
    "assignmentOffers": true,
    "contractUpdated": true,
    "planUpdates": true,
    "storageAlert": true
  }
}
```

**Behaviour**: identical to [agency](../agency/notifications.md#update-preferences) — enabling one
secondary channel auto-disables the others; enabling an unverified channel is rejected with
`400 DELIVERY_AGENT_NOTIFICATION_CHANNEL_NOT_VERIFIED` (`details.channel`).

**Success Response** — `200 OK`: same shape as `GET`, plus `"message": "Preferences updated successfully"`.

---

<a name="list"></a>
### GET /api/agent/notifications

**Description**: List notifications (newest first), paginated. Query: `page?`, `limit?` (max 50).

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": [
    {
      "id": "665f1f77bcf86cd799439700",
      "type": "cod.deposit.recorded",
      "title": "Deposit recorded by Douala Express",
      "message": "Douala Express recorded a cash deposit of XAF 78,000 from you. Your balance has been reduced by that amount. If this is not what you handed over, report it now.",
      "aggregateType": "deposit",
      "aggregateId": "665f1f77bcf86cd799439400",
      "action": { "label": "View deposit", "path": "cod/deposits/665f1f77bcf86cd799439400", "url": null },
      "isRead": false,
      "deliveredVia": ["in-app", "push"],
      "createdAt": "2026-07-16T09:00:00.000Z"
    }
  ],
  "unreadCount": 1,
  "meta": { "total": 1, "page": 1, "limit": 20, "pages": 1 }
}
```

---

<a name="mark-read"></a>
### PATCH /api/agent/notifications/:id/read

Marks one notification read. `404 DELIVERY_AGENT_NOTIFICATION_NOT_FOUND` if it isn't this agent's.

---

<a name="mark-all-read"></a>
### POST /api/agent/notifications/read-all

Marks all this agent's notifications read. Returns `{ "count": <n> }`.

---

<a name="register-device"></a>
### POST /api/agent/devices

Register (or refresh) an FCM token for push. Upserts on `token`, so repeating it is idempotent.

**Request Body**:
```json
{ "token": "fcm-registration-token", "platform": "android", "userAgent": "Pixel 8 / Android 14" }
```

`platform` is an enum — `android` | `ios` | `web`. `token` ≤ 4096 chars, `userAgent` optional ≤ 512.

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": { "id": "665f1f77bcf86cd799439900", "platform": "android", "lastUsedAt": "2026-07-28T09:00:00.000Z" },
  "message": "Device registered for push notifications"
}
```

<a name="unregister-device"></a>
### DELETE /api/agent/devices

Unregister an FCM token. Body: `{ "token": "…" }`. **Call this before clearing the session on
logout** — it needs agent auth, and a device left registered keeps receiving the previous agent's
notifications.

**When and how to call both**, plus token-refresh handling:
[Flutter guide → Register the token](./push-notifications.md#register-the-token).
