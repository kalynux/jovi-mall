# Offer quick actions — what the backend has to change

**Verified against source on 2026-09-08** — the "DONE" claim is true and the five proposed changes
are all present as described: `sendToUser` omits the `notification` block entirely when `dataOnly`,
`androidConfig` drops its sub-block, `apnsConfig` adds the category, and
`ACTIONABLE_OFFER_SITUATIONS` is exactly `{shipment.offer.received, shipment.offer.reminder}` —
`shipment.offer.expired` is correctly excluded. Read from
`src/modules/notifications/services/{fcm-push.service.ts,
agent-notification-event-handler.service.ts}`. **Note the composing site is
`agent-notification-event-handler.service.ts`, not `agent-notification.service.ts` as § 5 guesses.**

> **Status: DONE.** Implemented in `fcm-push.service.ts` (`dataOnly` + `category`,
> `APNS_CATEGORIES`) and `agent-notification-event-handler.service.ts`
> (`ACTIONABLE_OFFER_SITUATIONS`, previously `OFFER_CHANNEL_SITUATIONS`). The live
> wire contract now lives in [push-notifications.md](./push-notifications.md) —
> read that, not this. This file is kept as the rationale record for *why* offer
> pushes are the one data-only shape.

**Original brief:** the agent app side is done and shipped. This is the one change on the
jovi-mall (backend) side needed for the Accept / Decline buttons to appear on an offer
notification when the agent's phone is in their pocket.

Everything here is scoped to **agent offer pushes only** — `shipment.offer.received`
and `shipment.offer.reminder`. No other notification type, and no other role,
changes in any way.

---

## The problem in one paragraph

FCM has two kinds of message. A message with a `notification` block is drawn by
the **operating system**: on Android, when the app is backgrounded or killed, the
FCM SDK renders the tray notification itself and never calls into the app. A
message with **only** a `data` block is handed to the app, which draws it.

Action buttons live on the notification the app builds. So a message that carries
a `notification` block can never have buttons on Android outside the foreground —
not because of anything in the app, but because the app is never asked. Today
`FcmPushService.sendToUser` puts a `notification` block on every message, which is
why offers arrive as plain notifications an agent has to open the app to answer.

The agent app already registers a background handler that draws the actionable
notification. It is inert until the payload changes, by design — it returns
immediately when `message.notification != null`, so nothing is drawn twice while
this change is pending.

---

## The change

In `src/modules/notifications/services/fcm-push.service.ts`, send agent offer
pushes **data-only**, and carry the title and body inside `data`.

### 1. Add a flag to `PushPayload`

```ts
export interface PushPayload {
    title: string;
    body: string;
    channelId?: string;
    urgency?: PushUrgency;
    /**
     * Deliver as a data-only message, so the client draws the notification
     * itself and can hang action buttons off it.
     *
     * Android only in effect: iOS still needs the alert payload, and gets its
     * buttons from `apns.payload.aps.category` instead.
     */
    dataOnly?: boolean;
    data: { /* unchanged */ };
}
```

### 2. In `sendToUser`, move title/body into `data` and drop the notification block

```ts
const data: Record<string, string> = {
    type: payload.data.type,
    aggregateType: payload.data.aggregateType,
    aggregateId: payload.data.aggregateId
};
if (payload.data.path) data.path = payload.data.path;
if (payload.data.url) data.url = payload.data.url;

// A data-only message has nowhere else to put the copy: the client renders
// the notification, so it needs the words.
if (payload.dataOnly) {
    data.title = payload.title;
    data.body = payload.body;
}

const response = await messaging.sendEachForMulticast({
    tokens,
    // Omitted entirely for a data-only push. Present and it is the OS, not the
    // app, that draws the Android notification — and the buttons are lost.
    ...(payload.dataOnly ? {} : {
        notification: { title: payload.title, body: payload.body }
    }),
    data,
    android: this.androidConfig(payload),
    apns: this.apnsConfig(payload)
});
```

**`notification` must be absent, not empty.** An empty object still counts.

### 3. `androidConfig` — drop the notification sub-block when data-only

```ts
private androidConfig(payload: PushPayload): messaging.AndroidConfig {
    const high = (payload.urgency ?? 'high') === 'high';

    return {
        priority: high ? 'high' : 'normal',
        ...(payload.dataOnly ? {} : {
            notification: {
                channelId: payload.channelId ?? ANDROID_CHANNELS.DEFAULT,
                priority: high ? 'max' : 'default',
                defaultSound: true
            }
        })
    };
}
```

The channel is not lost: the app reads `data.type`, maps it to
`jovi_agent_offers` itself, and creates the channel with `Importance.max`. That
mapping is already the client contract documented in `push-notifications.md`.

`priority: 'high'` is **load-bearing and must stay**. A data-only message at
normal priority will not start the app's background handler under Doze.

### 4. `apnsConfig` — add the category

```ts
private apnsConfig(payload: PushPayload): messaging.ApnsConfig {
    const high = (payload.urgency ?? 'high') === 'high';

    return {
        headers: { 'apns-priority': high ? '10' : '5' },
        payload: {
            aps: {
                sound: 'default',
                // Names the UNNotificationCategory the app registers at startup.
                // iOS draws that category's buttons on the system notification.
                ...(payload.category ? { category: payload.category } : {})
            }
        }
    };
}
```

with `category?: string` added to `PushPayload`. **iOS keeps its alert payload** —
`dataOnly` must not strip it, because iOS has no equivalent of the Android
background-draw path and would show nothing at all. If the two flags are
inconvenient to keep straight, treat `dataOnly` as *Android-only* and always send
the APNs alert.

### 5. Set both flags where the offer notification is composed

In `agent-notification.service.ts` (or wherever `shipment.offer.received` and
`shipment.offer.reminder` build their `PushPayload`):

```ts
{
    title, body,
    channelId: ANDROID_CHANNELS.AGENT_OFFERS,
    urgency: 'high',
    dataOnly: true,                  // Android draws nothing; the app does
    category: 'jovi_agent_offer',    // iOS draws the two buttons
    data: { type, aggregateType: 'offer', aggregateId, path: `offers/${id}` }
}
```

**Only those two types.** Everything else — COD, contracts, plan, storage,
`shipment.offer.expired`, `shipment.reassigned_away` — keeps the notification
block exactly as it is today. An expired offer has nothing to accept, so it must
not get the buttons.

---

## The exact contract the app expects

| Field | Value | Why |
|---|---|---|
| `notification` | **absent** (Android) | Present ⇒ the OS draws it ⇒ no buttons |
| `android.priority` | `"high"` | Doze will otherwise hold the message and the handler never runs |
| `data.type` | `shipment.offer.received` \| `shipment.offer.reminder` | Picks the channel and decides that buttons apply |
| `data.title` | the notification title | The app has no other source for it |
| `data.body` | the notification body | Same |
| `data.path` | `offers/{offerId}` | **The offer id is parsed out of this.** Without it the buttons do not render — there is nothing for them to act on |
| `data.aggregateId` | the offer id | Unchanged; used for inbox routing |
| `apns.payload.aps.category` | `jovi_agent_offer` | The iOS category the app registers at startup |
| `apns` alert payload | **kept** | iOS has no background-draw path |

All `data` values must be strings — an existing FCM constraint, unchanged.

Pressing a button opens the app, which then calls the ordinary
`POST /api/agent/offers/:id/accept` or `/reject` with the agent's bearer token.
**No new endpoint, and no change to either of those.** The buttons deliberately
wake the app rather than answering in the background, because accepting fails
often and for reasons the agent has to read — `SHIPMENT_ALREADY_HAS_AGENT`,
`AGENT_AT_CAPACITY`, `CONTRACT_SHIPMENT_VALUE_EXCEEDED` — and a silent background
POST has nowhere to report them.

---

## The tradeoff to be aware of

A data-only push needs the app's background isolate to start. A notification push
is drawn by the OS whatever state the app is in. In practice the difference is
small — a force-stopped app receives neither — but aggressive OEM battery
managers (Xiaomi/MIUI, Huawei/EMUI, some Oppo and Vivo builds) do kill background
isolates more readily than they suppress system-drawn notifications.

The in-app inbox is unaffected either way: `GET /agent/notifications` still has
the row, and the app reconciles against it on every resume. A push that never
draws costs the agent the interruption, not the information.

If offer delivery rates drop measurably on those devices after this ships, the
fallback is to send **both**: a data-only message for the buttons and, after a
short delay, a notification-block message only to tokens that did not acknowledge.
That is more machinery than it is likely to be worth — measure first.

---

## How to verify

1. Send a `shipment.offer.received` push to an Android device with the app
   **swiped away**. The notification must show **Accept** and **Decline**.
2. Press **Decline**. The app opens, the offer is rejected, and a confirmation
   line appears.
3. Press **Accept** on another. The app opens on the shipment detail for the job
   just taken.
4. Send a `cod.deposit.confirmed` push. It must look exactly as it does today —
   no buttons, drawn by the OS.
5. Send a reminder for an offer whose original notification is still in the
   shade. It must **replace** it, not stack — the app keys the notification id
   off the offer id for this.
6. On iOS, long-press an offer notification. The two buttons come from the
   `jovi_agent_offer` category.
