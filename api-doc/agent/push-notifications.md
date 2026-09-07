# Agent Push Notifications — Flutter Integration Guide

**Verified against source on 2026-09-08** — both message shapes, the Android channel and APNs
category ids, which situations are data-only, and all twenty rows of the deep-link table, against
`src/modules/notifications/{services/fcm-push.service.ts,
services/agent-notification-event-handler.service.ts, catalog/agent-notification-catalog.ts,
models/agent-notification.model.ts}` and `src/modules/delivery/agent.routes.ts`.

How the agent mobile app receives notifications **without polling**, and what the client must
implement to match what the backend actually sends.

Companion to [Agent Notifications](./notifications.md), which covers the in-app list, the situations,
and the preference endpoints. This document covers only the **transport**: Firebase Cloud Messaging.

> **Why FCM and not a socket.** A WebSocket or SSE connection dies the moment the app leaves the
> foreground — iOS suspends the process, Android Doze throttles it. Push through APNs/FCM is the
> only mechanism that reaches a **backgrounded or killed** app. That is not a preference; for
> `shipment.offer.received` it is the difference between the agent getting the work and not.

---

## Mental model (read this first)

- **In-app is the source of truth.** Every notification is persisted and returned by
  `GET /api/agent/notifications` **regardless of push outcome**.
- **Push is a best-effort companion**, not a replacement. It can fail to arrive: permission denied,
  device offline, no token registered yet, FCM disabled server-side, transient error. Those
  notifications are **not lost** — they are still in the list.
- Therefore the app needs **two paths**, and both are required:
  1. **On login, and on every app resume** → `GET /api/agent/notifications` to render history and the
     unread badge. This is the reconciliation path for anything push missed.
  2. **While running** → receive live pushes and prepend them to the list / bump the badge in place.

Path 1 is *not* polling — it fires on lifecycle events, not on a timer. Do not add a periodic
refresh; if you find yourself wanting one, push is misconfigured.

---

## What the backend sends

Every push is built in [`fcm-push.service.ts`](../../src/modules/notifications/services/fcm-push.service.ts),
and there are **two shapes**. Which one you get is decided by the situation, and only by the
situation:

| Shape | Situations | Who draws the Android notification |
|---|---|---|
| **Data-only** | `shipment.offer.received`, `shipment.offer.reminder` | **The app** — which is what lets it hang Accept / Decline off it |
| **Notification + data** | everything else, `shipment.offer.expired` included | The OS |

The split exists because action buttons live on the notification the *app* builds. A message
carrying a `notification` block is drawn by the operating system: when the app is backgrounded or
killed the FCM SDK renders the tray row itself and never calls into the app, so the app never gets
the chance to attach buttons. Only an actionable offer is worth that trade — see
[the tradeoff](#the-tradeoff) below.

### Shape A — actionable offer (data-only)

```jsonc
{
  // NO "notification" block. Absent, not empty — an empty object still counts,
  // and its presence is what hands the draw back to the OS.
  "data": {
    "type": "shipment.offer.received",   // or shipment.offer.reminder
    "aggregateType": "offer",
    "aggregateId": "665f1f77bcf86cd799439400",
    "path": "offers/665f1f77bcf86cd799439400",  // THE OFFER ID IS PARSED OUT OF THIS
    "title": "New delivery offer",              // present ONLY on this shape
    "body": "Douala Express is offering you a delivery for order ORD-10432. Review and accept it before it expires."
  },
  "android": {
    "priority": "high"
    // No "notification" sub-block either — it only configures a row the OS isn't drawing.
    // The channel is NOT lost: map data.type → jovi_agent_offers yourself (see below).
  },
  "apns": {
    "headers": { "apns-priority": "10" },
    "payload": { "aps": { "sound": "default", "category": "jovi_agent_offer" } }
  }
}
```

**iOS still gets its alert payload.** `dataOnly` is an Android-only lever — iOS has no
background-draw path and would show nothing at all. Its buttons come from the
`jovi_agent_offer` category instead, which the app registers as a `UNNotificationCategory` at
startup.

### Shape B — everything else

```jsonc
{
  "notification": {
    "title": "Cash deposit confirmed",
    "body": "Douala Express confirmed your deposit of 45,000 XAF."
  },
  "data": {
    "type": "cod.deposit.confirmed",     // the situation
    "aggregateType": "deposit",          // deposit | offer | shipment | contract | plan | storage
    "aggregateId": "665f1f77bcf86cd799439400",
    "path": "cod/deposits/665f1f77bcf86cd799439400"  // relative deep-link; absent when the situation has no action
    // "url" — absolute, only present when AGENT_APP_URL is configured. Web-oriented; ignore it on mobile.
    // No "title"/"body" here — read them off message.notification.
  },
  "android": {
    "priority": "high",
    "notification": { "channel_id": "jovi_default", "notification_priority": "PRIORITY_MAX", "default_sound": true }
  },
  "apns": {
    "headers": { "apns-priority": "10" },
    "payload": { "aps": { "sound": "default" } }   // no category — no buttons
  }
}
```

Shape B has one consequence you must design around:

| App state | Who draws the tray notification | What you must do |
|---|---|---|
| **Background** | The FCM SDK, automatically | Handle `onMessageOpenedApp` to deep-link on tap |
| **Terminated** | The FCM SDK, automatically | Read `getInitialMessage()` at startup to deep-link |
| **Foreground (Android)** | **Nobody** — Flutter never auto-displays | `onMessage` → update state in place, and render a banner yourself via `flutter_local_notifications` |
| **Foreground (iOS)** | iOS, *if* you opt in | Call `setForegroundNotificationPresentationOptions` (below) |

### The exact contract for Shape A

| Field | Value | Why it matters |
|---|---|---|
| `notification` | **absent** | Present ⇒ the OS draws it ⇒ no buttons |
| `android.priority` | `"high"` | Doze will otherwise hold the message and the background handler never runs |
| `data.type` | `shipment.offer.received` \| `shipment.offer.reminder` | Picks the channel, and decides that buttons apply |
| `data.title` / `data.body` | the copy | The app has no other source for it |
| `data.path` | `offers/{offerId}` | **The offer id is parsed out of this.** Without it the buttons have nothing to act on |
| `data.aggregateId` | the offer id | Unchanged; used for inbox routing |
| `apns…aps.category` | `jovi_agent_offer` | The iOS category the app registers at startup |
| APNs alert payload | **kept** | iOS has no background-draw path |

All `data` values are strings — an FCM constraint, and it applies to `title`/`body` too.

Pressing a button opens the app, which then calls the ordinary
[`POST /api/agent/offers/:id/accept`](./offers.md) or `/reject` with the agent's bearer token.
**No new endpoint, and no change to either of those.** The buttons deliberately wake the app rather
than answering in the background, because accepting fails often and for reasons the agent has to
read — `SHIPMENT_ALREADY_HAS_AGENT`, `AGENT_AT_CAPACITY`, `CONTRACT_SHIPMENT_VALUE_EXCEEDED` — and a
silent background POST has nowhere to report them.

### The tradeoff

A data-only push needs the app's background isolate to start; a notification push is drawn by the OS
whatever state the app is in. In practice the difference is small — a force-stopped app receives
neither — but aggressive OEM battery managers (Xiaomi/MIUI, Huawei/EMUI, some Oppo and Vivo builds)
kill background isolates more readily than they suppress system-drawn notifications.

The in-app inbox is unaffected either way: `GET /api/agent/notifications` still has the row, and the
app reconciles against it on every resume. A push that never draws costs the agent the interruption,
not the information. If offer delivery rates drop measurably on those devices, the fallback is to
send both — data-only for the buttons, then a notification-block message to tokens that did not
acknowledge. Measure before building that.

### What the backend deliberately does **not** send

- **No TTL / expiry.** An auto-assignment offer stays acceptable until the shipment binds to
  somebody (only *manual* offers expire), so a push that arrives late is still actionable. Do not
  discard an offer push because it looks old — check the offer.
- **No collapse key.** Two offers are two notifications; never coalesce them client-side. A
  *reminder* for an offer already in the shade is the one exception, and it is handled client-side:
  key the local notification id off the offer id so the reminder **replaces** rather than stacks.
- **No badge count.** Drive the app icon badge from `unreadCount` in `GET /api/agent/notifications`.
- **No silent messages.** Shape A is data-only but still user-visible — the app draws it. Nothing
  here is a background sync.

---

## The Android channel contract

The backend addresses two channels **by id**. These ids are a contract: if the app has not created a
channel with the matching id, Android falls back to the manifest default channel and the importance
the backend asked for is silently lost.

| Channel id | Used for | Named by | Create it with |
|---|---|---|---|
| `jovi_agent_offers` | `shipment.offer.received`, `shipment.offer.reminder` | **the app** — map it from `data.type` | `Importance.max` — heads-up banner + sound |
| `jovi_default` | Everything else (COD deposits, plan, storage, expired/reassigned) | the message (`android.notification.channel_id`) | `Importance.high` |

Note the asymmetry: those are exactly the two data-only situations, and a data-only message carries
no `android.notification` block to put a channel id in. The channel is **not** lost — the app maps
`data.type` → `jovi_agent_offers` itself when it builds the notification. That mapping is now part
of the contract, not an implementation detail.

> **On Android 8+ the channel importance you create wins over the message priority.** The backend
> asks for `PRIORITY_MAX`, but that only takes effect if `jovi_agent_offers` was created with
> `Importance.max`. Create it once at startup, before the first push can arrive — importance cannot
> be raised later in code, only by the user in system settings.

Offers get their own channel on purpose: an agent who silences notifications should have to silence
the one that costs them work **explicitly**, not as collateral damage.

---

## Setup

### 1. Firebase project — get the right one

> ⚠️ **This backend runs two separate Firebase projects.** One for file storage (`STORAGE_FIREBASE_*`)
> and a dedicated one for messaging (`FCM_*`). The `google-services.json` / `GoogleService-Info.plist`
> you bundle must come from the **messaging** project (`FCM_PROJECT_ID`). Using the storage project's
> config produces tokens that register successfully and never receive anything — the failure is
> completely silent, so verify this first when debugging.

- `android/app/google-services.json`
- `ios/Runner/GoogleService-Info.plist`

### 2. iOS — APNs

FCM cannot deliver to iOS without it. In the **messaging** Firebase project → Project Settings →
Cloud Messaging → upload the **APNs Auth Key** (`.p8`) with its Key ID and Team ID. Then in Xcode
enable the **Push Notifications** capability and **Background Modes → Remote notifications**.

### 3. Packages

```yaml
dependencies:
  firebase_core: ^3.6.0
  firebase_messaging: ^15.1.3
  flutter_local_notifications: ^18.0.1   # required for Android foreground banners
```

### 4. Android manifest

In `android/app/src/main/AndroidManifest.xml`, inside `<application>`:

```xml
<!-- Fallback channel when a message names one the app hasn't created. -->
<meta-data
    android:name="com.google.firebase.messaging.default_notification_channel_id"
    android:value="jovi_default" />
```

Android 13+ also needs the runtime permission (the plugin's manifest declares it, but you must
*request* it — `requestPermission()` below covers both platforms).

---

## Implementation

### Create the channels + request permission

```dart
const _offersChannel = AndroidNotificationChannel(
  'jovi_agent_offers',              // MUST match the backend id exactly
  'Delivery offers',
  description: 'New delivery offers waiting for your answer.',
  importance: Importance.max,       // heads-up banner
);

const _defaultChannel = AndroidNotificationChannel(
  'jovi_default',
  'Notifications',
  description: 'Cash deposits, plan and storage updates.',
  importance: Importance.high,
);

final _localNotifications = FlutterLocalNotificationsPlugin();

Future<void> initPush() async {
  await Firebase.initializeApp();

  // 1. Permission (iOS prompt + Android 13+ POST_NOTIFICATIONS).
  await FirebaseMessaging.instance.requestPermission();

  // 2. Channels — before any push can land.
  final android = _localNotifications
      .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
  await android?.createNotificationChannel(_offersChannel);
  await android?.createNotificationChannel(_defaultChannel);

  await _localNotifications.initialize(
    const InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      iOS: DarwinInitializationSettings(),
    ),
    onDidReceiveNotificationResponse: (r) {
      if (r.payload != null) routeToPath(r.payload!);
    },
  );

  // 3. iOS: let the OS draw foreground notifications natively.
  await FirebaseMessaging.instance.setForegroundNotificationPresentationOptions(
    alert: true, badge: true, sound: true,
  );
}
```

### Register the token

`POST /api/agent/devices` is behind agent auth, so it can only be called while signed in.

```dart
Future<void> registerDevice() async {
  // iOS: the FCM token is null until APNs has registered the device.
  if (Platform.isIOS && await FirebaseMessaging.instance.getAPNSToken() == null) return;

  final token = await FirebaseMessaging.instance.getToken();
  if (token == null) return;

  await api.post('/api/agent/devices', {
    'token': token,
    'platform': Platform.isIOS ? 'ios' : 'android',
    'userAgent': deviceModelString,   // optional, ≤512 chars
  });
}
```

Three call sites, and **all three are required**:

| When | Call |
|---|---|
| After a successful login | `registerDevice()` |
| `FirebaseMessaging.instance.onTokenRefresh` | `registerDevice()` — FCM rotates tokens on reinstall, restore, and periodically |
| **Before** clearing auth on logout | `DELETE /api/agent/devices` with `{ "token": … }` |

> **Unregister *before* you drop the session.** The endpoint requires the agent's bearer token, so
> clearing auth first makes the call impossible — and the device keeps receiving the previous agent's
> notifications until someone else signs in on it. On a shared phone that is a real privacy leak: COD
> deposit notifications carry amounts.

Registration is an upsert keyed on the token, so calling it repeatedly is safe and idempotent.
`platform` is a strict enum — `android` | `ios` | `web`; anything else is a `VALIDATION_ERROR`.

### Receive

```dart
// Foreground: nothing is drawn on Android — do it yourself, on the right channel.
FirebaseMessaging.onMessage.listen((message) {
  notificationStore.prepend(message.data);   // update list + unread badge in place
  if (!Platform.isAndroid) return;           // iOS already drew it

  // Shape A puts the copy in data; Shape B puts it on the notification block.
  final title = message.notification?.title ?? message.data['title'];
  final body  = message.notification?.body  ?? message.data['body'];
  if (title == null) return;

  final isOffer = message.data['type'] == 'shipment.offer.received'
      || message.data['type'] == 'shipment.offer.reminder';
  final channel = isOffer ? _offersChannel : _defaultChannel;

  _localNotifications.show(
    // Keyed off the OFFER, not the message, so a reminder replaces the original
    // notification in the shade instead of stacking a second one.
    isOffer ? offerIdFrom(message.data['path']).hashCode : message.hashCode,
    title,
    body,
    NotificationDetails(
      android: AndroidNotificationDetails(
        channel.id, channel.name,
        importance: channel.importance,
        priority: Priority.max,
        actions: isOffer ? _offerActions : null,   // Accept / Decline
      ),
    ),
    payload: message.data['path'],
  );
});

// Tapped while the app was backgrounded.
FirebaseMessaging.onMessageOpenedApp.listen((m) => routeToPath(m.data['path']));

// Tapped while the app was killed — check once at startup.
final initial = await FirebaseMessaging.instance.getInitialMessage();
if (initial != null) routeToPath(initial.data['path']);
```

**A background isolate handler is now required, not optional.** Shape A carries no `notification`
block, so the FCM SDK draws nothing — the app must, and it can only do that from a top-level
function annotated `@pragma('vm:entry-point')` and registered via
`FirebaseMessaging.onBackgroundMessage`. Return early when `message.notification != null`: that is
Shape B, already drawn by the OS, and drawing it again duplicates the row.

Both buttons **open the app** and let it call `POST /api/agent/offers/:id/{accept,reject}` on the
foreground session. Do not answer from the background isolate — it has no auth session, and the
failures that matter (`SHIPMENT_ALREADY_HAS_AGENT`, `AGENT_AT_CAPACITY`,
`CONTRACT_SHIPMENT_VALUE_EXCEEDED`) have nowhere to be shown.

### Route

`data.path` is a relative route; map it onto your navigator. `path` is absent for
`shipment.reassigned_away` (there is nothing left to act on) — fall back to the notifications list.
For the two offer situations it is also the **only** source of the offer id the buttons act on, so a
push without it must render no buttons rather than guess.

All **eighteen** situations in `AGENT_NOTIFICATION_TYPES` are listed. Five distinct `path` shapes
cover seventeen of them — the eight `agent_contract.*` situations share one — and the eighteenth
(`shipment.reassigned_away`) deliberately carries none.

| `type` | `aggregateType` | `data.path` | Screen |
|---|---|---|---|
| `shipment.offer.received` | `offer` | `offers/{offerId}` | Offer detail — accept/reject |
| `shipment.offer.reminder` | `offer` | `offers/{offerId}` | Offer detail — still open |
| `shipment.offer.expired` | `offer` | `offers/{offerId}` | Offer detail (read-only) |
| `shipment.reassigned_away` | `shipment` | *(none)* | Notifications list |
| `cod.deposit.recorded` | `deposit` | `cod/deposits/{depositId}` | Deposit detail |
| `cod.deposit.confirmed` | `deposit` | `cod/deposits/{depositId}` | Deposit detail |
| `cod.deposit.rejected` | `deposit` | `cod/deposits/{depositId}` | Deposit detail |
| `agent_contract.request_received` | `contract` | `memberships/{contractId}` | Contract detail — approve/reject |
| `agent_contract.approved` | `contract` | `memberships/{contractId}` | Contract detail |
| `agent_contract.rejected` | `contract` | `memberships/{contractId}` | Contract detail (terminal) |
| `agent_contract.status_request_raised` | `contract` | `memberships/{contractId}` | Contract detail — approve/reject the proposed change |
| `agent_contract.status_request_resolved` | `contract` | `memberships/{contractId}` | Contract detail |
| `agent_contract.terms_countered` | `contract` | `memberships/{contractId}` | Contract detail — a **pending** contract whose offer moved back to you: accept, counter or reject |
| `agent_contract.terms_proposed` | `contract` | `memberships/{contractId}` | Contract detail — a change to a **live** contract; it takes effect only if you accept |
| `agent_contract.terms_resolved` | `contract` | `memberships/{contractId}` | Contract detail — the answer to either of the two above, neutral about whose proposal it was |
| `plan.expiring` | `plan` | `plans` | Plans / billing |
| `plan.expired` | `plan` | `plans` | Plans / billing |
| `storage.alert` | `storage` | `settings/storage` | Storage usage |

Route on `path`, not on `url` — `url` is only populated when `AGENT_APP_URL` is set server-side and
is meant for the web client.

---

## Preferences and what push ignores

The `preferences.*` toggles in [`PATCH /api/agent/notification-preferences`](./notifications.md#update-preferences)
gate only the **one secondary channel** (email/Telegram/WhatsApp). In-app and push are **always**
delivered. So there is no server-side "mute push" switch — muting is the OS channel settings, which
is exactly why offers live on their own channel.

---

## Verification checklist

Before calling the integration done, confirm each of these on a **real device** (push does not work
on the iOS simulator):

- [ ] Token registers after login; `POST /api/agent/devices` returns `200` with `data.platform`.
- [ ] `google-services.json` / `GoogleService-Info.plist` come from the **`FCM_PROJECT_ID`** project.
- [ ] An offer push arrives with the app **killed**, and tapping it opens the offer.
- [ ] An offer push arrives with the app **backgrounded and the screen off** — this is what
      `priority: high` buys; if it only arrives when you wake the phone, the message is being
      Doze-batched.
- [ ] An offer push shows as a **heads-up banner** (not a silent tray row) → the `jovi_agent_offers`
      channel exists with `Importance.max`.
- [ ] A foreground push updates the badge **and** draws a banner on Android.
- [ ] **Buttons, Android:** a `shipment.offer.received` push with the app **swiped away** shows
      **Accept** and **Decline**. Pressing **Decline** opens the app, rejects the offer, and
      confirms it; pressing **Accept** on another lands on the shipment just taken.
- [ ] **Buttons, iOS:** long-pressing an offer notification shows the two buttons — they come from
      the `jovi_agent_offer` category, so this fails if the category was not registered at startup.
- [ ] **No buttons where there shouldn't be:** a `cod.deposit.confirmed` push looks exactly as it
      always did — OS-drawn, no buttons. Same for `shipment.offer.expired`; there is nothing left
      to accept.
- [ ] **No double-draw:** a Shape B push draws **one** row, not two — the background handler
      returns early on `message.notification != null`.
- [ ] **Reminder replaces:** a `shipment.offer.reminder` for an offer still in the shade replaces
      that row rather than stacking a second one.
- [ ] Logout unregisters the token, and the device stops receiving.
- [ ] Killing FCM server-side (`FCM_ENABLED=false`) still leaves every notification visible in
      `GET /api/agent/notifications` — the fallback path works.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Token registers, nothing ever arrives | Wrong Firebase project (storage instead of messaging) — the single most common cause |
| Works on Android, silent on iOS | APNs auth key not uploaded to the messaging project, or Push Notifications capability missing |
| `getToken()` returns `null` on iOS | APNs token not set yet — await `getAPNSToken()` first, then retry |
| Arrives only when the phone is woken | High priority not reaching the device — verify the message is not being sent with `urgency: 'normal'`, and that the OEM battery optimiser is not restricting the app |
| Silent tray row, no banner | `jovi_agent_offers` not created, or created with importance below `max` (importance cannot be raised in code after creation — reinstall to test) |
| Nothing in the foreground on Android | Expected — Flutter does not auto-display. Render via `flutter_local_notifications` |
| Notifications stop after a while | `onTokenRefresh` not wired; the rotated token was never re-registered |
| Previous user still gets notifications | Logout did not `DELETE /api/agent/devices` before clearing the session |
| Push works, `deliveredVia` has no `"push"` | No device token was targeted at send time — the token was registered after the notification fired |
| Offer push arrives with **no buttons**, everything else fine | The background isolate handler isn't registered, or it bailed because `data.path` was missing (no offer id ⇒ nothing to act on) |
| Offer push draws **twice** | The background handler is not returning early on `message.notification != null` — that message is Shape B and the OS already drew it |
| **Only offers** fail to arrive, on Xiaomi/Huawei/Oppo/Vivo | The OEM battery manager is killing the background isolate. Offers are the only data-only shape, so they are the only ones that need it — whitelist the app in the OEM's autostart/battery settings |
| Buttons on Android, none on iOS | The `jovi_agent_offer` `UNNotificationCategory` was not registered at startup; iOS takes its buttons from the category, never from the payload |

---

## Server-side switches (for whoever runs the deploy)

Push is **off by default**. All four must be set, in the messaging Firebase project:

| Env var | Meaning |
|---|---|
| `FCM_ENABLED` | `'true'` to enable delivery; anything else makes push a no-op |
| `FCM_PROJECT_ID` | Messaging project id — **not** the storage project |
| `FCM_CLIENT_EMAIL` | Service-account client email |
| `FCM_PRIVATE_KEY` | Service-account private key (escaped `\n` are unescaped on load) |

When incomplete, [`fcm.client.ts`](../../src/modules/notifications/providers/fcm.client.ts) logs
`[FCM] Push notifications disabled or not configured` at boot and every push silently returns 0
targeted devices. The in-app record is still written, so the app degrades to reconcile-on-resume
rather than breaking.

`AGENT_APP_URL` is unrelated to push delivery — it only populates the absolute `url` in `data` and
in email/Telegram buttons.
