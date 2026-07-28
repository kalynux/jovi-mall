# Agent Notifications

Full multi-channel parity with vendor and agency notifications — in-app, push, and one
preference-gated secondary channel (email/Telegram/WhatsApp), catalog-driven and localized.
Architecture mirrors [Agency Notifications](../agency/notifications.md) exactly; this doc follows the
same structure. Read the vendor doc's
[Push notifications (FCM)](../vendor/notifications.md#push-notifications-fcm) section for the full
client-side integration guide (Firebase config, service worker, foreground/background handling),
which applies unchanged against `/api/agent/devices`.

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

The three COD-deposit rows carry an `action` deep-linking to the deposit (`cod/deposits/{id}`), and an
`aggregateType` of `deposit` with the deposit id as `aggregateId`. The `plan.*` rows deep-link to
`plans` with `aggregateType: plan` and the agent id as `aggregateId`.

There is deliberately **no notification when you declare a deposit** — you did that, so it would be
noise. The declaration notifies your *agency*, who has to answer it. (Assignment-offer situations —
`shipment.offer.received` / `.expired` / `shipment.reassigned_away` — are gated by `assignmentOffers`;
see [Offers](./offers.md).)

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
> your profile-level preferences in the agent domain.

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

Register an FCM token for push. Same body and behaviour as
[`POST /api/agency/devices`](../agency/notifications.md#register-device).

<a name="unregister-device"></a>
### DELETE /api/agent/devices

Unregister an FCM token. Same as the agency equivalent.
