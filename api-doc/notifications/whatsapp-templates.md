# WhatsApp Templates

> ✅ **The WABA holds 190 templates** — the 94 notification names in `en` and `fr` (submitted
> 2026-09-14) plus the phone-verification pair (submitted and **approved** 2026-09-15). This
> replaces the "holds ZERO templates" measurement that stood here on 2026-09-14.
> Submit with `npm run whatsapp:templates:submit -- --submit`
> ([submit-whatsapp-templates.ts](../../scripts/submit-whatsapp-templates.ts)): it reads the WABA
> first and sends only the difference, so a re-run resumes rather than duplicating.
>
> ✅ **ALL 190 ARE APPROVED** — measured 2026-09-15. The 188 catalog templates cleared review
> roughly a day after submission.
>
> ✅ **THE 131037 DISPLAY-NAME BLOCKER IS CLOSED — 2026-09-16 — and it closed by REPLACING THE
> NUMBER, not by approving a name on the old one.** The sending number is now
> **`1263609603508344` (+237 652 705 926)**, `verified_name: "Wi-Mall"`,
> **`name_status: "APPROVED"`**. The block below stood here until that swap and described the
> real state at the time; it is kept only as the diagnostic order, because the gate it names
> still sits above every other WhatsApp precondition and a future number would meet it again.
>
> <details><summary>What the old number looked like (superseded 2026-09-16)</summary>
>
> `614443908428263` (+1 555-784-5447) reported `name_status: "NON_EXISTS"`,
> `new_name_status: "NONE"` and a leftover `verified_name` of `"Mrzenn"`, so a live send of the
> approved OTP template returned `(#131037) WhatsApp provided number needs display name approval
> before message can be sent.` — and a plain free-form text returned the identical error, *before*
> the 24-hour window was evaluated. Setting the name was impossible too: `POST
> /{phone_number_id}` with `new_display_name` answered **403, code 4, subcode 2593011**, the ten
> monthly display-name changes already spent with nothing pending. The recorded options were to
> wait for the rollover or to onboard a different number — **the second is what happened**, and a
> new number does take its display name at registration rather than out of that quota.
>
> </details>
>
> ⛔ **THE OLD PHONE ID IS GONE, NOT MERELY STALE.** `614443908428263` was removed from the WABA
> outright: `GET /614443908428263` now answers Graph **code 100, subcode 33**, *"object does not
> exist"*. So any deployment still holding it has a **dead** send path, not a degraded one —
> including the n8n automation layer, which reads `$env.WHATSAPP_PHONE_NUMBER_ID` with **no
> fallback** in `UP-wi-mall-core` → `send whatsapp` and `UP-wi-mall-wa-adapter` → `typing
> (first)`. Two places hold this value and nothing compares them.
>
> ✅ **THE 190 TEMPLATES SURVIVED THE SWAP UNTOUCHED**, and that is the structural point worth
> keeping: **templates are WABA-scoped, sending is phone-scoped.** The WABA
> (`3361724037302135`, now named "Wi-Mall") did not change, so all 190 are still `APPROVED`,
> including both `wi_mall_phone_verification` rows — re-measured 2026-09-16. Changing the number
> costs no resubmission. ⚠ The converse is the trap: an approved **display name** *is*
> phone-scoped and does not move with the WABA, which is why the blocker above could not be
> carried over and had to be earned again on the new number.
>
> ✅ **THE SECOND PHONE-SCOPED GATE IS ALSO CLOSED — registered 2026-09-16.** A number can be
> verified and named and still send nothing: for a few hours this one read `status: "PENDING"`,
> `platform_type: "NOT_APPLICABLE"`, meaning **not registered on the Cloud API**. `POST
> /1263609603508344/register` (`messaging_product: whatsapp` + the six-digit two-step PIN)
> returned `{"success":true}`, and it now measures `status: "CONNECTED"`,
> `platform_type: "CLOUD_API"`, `quality_rating: "GREEN"`, `throughput.level: "STANDARD"`.
>
> ⚠ **Keep this gate in the diagnostic list even though it is closed.** It is invisible in every
> symptom a developer sees — the templates were approved, the token was valid, the display name
> was approved, and sending still failed — and it is **re-created by every future number change**,
> because registration is phone-scoped like the display name. It is an account action, not a code
> change; nothing in these three repositories can detect or report it.
>
> ⚠ **Check BOTH of these before diagnosing a delivery failure as a template problem** — one
> call, no side effects:
>
> ```
> GET /{phone_number_id}?fields=verified_name,name_status,new_name_status,status,platform_type
> ```
>
> `name_status: APPROVED` **and** `status: CONNECTED` are both required. Either one short means
> nothing sends, whatever else is fixed — and the errors point at the message, not at the number.
>
> ⛔ **PENDING is not APPROVED, and that distinction still matters for anything NEW.** ⚠ This is
> a TEMPLATE `status`, a different field from the phone-number `status` discussed directly above —
> same word, same value, different object, and only one of them is about review. A freshly
> submitted template is unsendable until Meta clears it, and this page cannot tell you the
> current state — poll `GET /{waba}/message_templates?fields=name,language,status`. ⚠ **A
> template's `category` while PENDING is not its final category either**; see the MARKETING note
> below, which this page got wrong by reading a mid-review value as a verdict.
>
> ## Phone verification — RESOLVED 2026-09-15, and the reason matters
>
> ✅ **`wi_mall_phone_verification` (AUTHENTICATION) is APPROVED in `en` and `fr`**
> (`4426347317613316`, `1393590468966788`). Out-of-window phone verification works. Meta
> approved both within seconds of submission, so there was no PENDING window to wait out.
>
> ⚠ **This page said the opposite one day earlier, and the earlier text was correct when
> written.** On 2026-09-14 the template could not be created at all — code 10, subcode 2388185 —
> because Meta gates the AUTHENTICATION category behind business verification and this WABA's
> owning business was `business_verification_status: "rejected"`. It reached **`verified`** on
> 2026-09-15, and the template created on the first attempt with **no code change**: the send
> path had always tried AUTHENTICATION first. The old diagnosis is kept below because it is what
> made the recovery a one-command operation.
>
> | Template | Category | Outcome |
> |---|---|---|
> | `wi_mall_phone_verification` | AUTHENTICATION | ✅ **APPROVED 2026-09-15**, `en` + `fr`. Uncreatable the previous day (code 10 / 2388185) purely because the owning business was unverified — **not the token**, since UTILITY created fine on the same credential, which is what isolated it. |
> | `wi_mall_phone_verification_utility` | UTILITY | ⛔ **REJECTED, permanently.** Created 2026-09-14 and refused at review within minutes, `INCORRECT_CATEGORY`, both languages. Both rows have since vanished from the WABA. |
>
> ⛔ **DO NOT RESUBMIT THE UTILITY ONE, and note that the verification did NOT revive it.** Its
> rejection is about OTP **content**, not about the business: resubmitting with
> `allow_category_change: true` — which lets Meta assign whatever category it judges correct
> rather than refusing — came back `REJECTED` **synchronously**. Meta classifies OTP content as
> AUTHENTICATION and accepts it nowhere else. Now that AUTHENTICATION is open, that is no longer
> a problem to solve; it is simply a name that must stay unsubmitted. **Do not reword the copy
> until the classifier stops recognising it** — that is evading enforcement rather than
> satisfying it, and the WABA carrying the other 189 templates is what would be at risk.
>
> Scope a submission with `--only=`, which matches the name exactly:
> `npm run whatsapp:templates:submit -- --only=wi_mall_phone_verification --submit` excludes the
> `_utility` name.
>
> ⚠ **What Meta froze into the approved template, and cannot be changed at send time:** the body
> (Meta writes and localises it), the footer *"Expires in 10 minutes."*, and a copy-code button
> compiled down to a **URL** button carrying
> `…/otp/code/?otp_type=COPY_CODE&code_expiration_minutes=10&code=otp{{1}}`. The send passes only
> the code, twice — body parameter and button parameter at `sub_type: 'url'`, `index: 0`. So
> **lowering `PHONE_VERIFY_TTL_SECONDS` does not change what the message promises**; the
> generator derives `code_expiration_minutes` from that variable and `test:phone-verification`
> § 6c fails if the two disagree, but an already-approved template can only be corrected by
> resubmitting under a new name — exactly like the button host.
>
> ⚠ **Meta OVERRIDES `UTILITY` → `MARKETING` on review, and the price is the smaller half of
> it.** **MARKETING is subject to marketing opt-out**, so a recipient who has opted out receives
> *nothing* for that situation — silently, with the notification recorded as sent.
>
> ⛔ **DO NOT TRUST A COUNT HERE, AND DO NOT TRUST A LIST — this page has now been wrong about
> this set twice.** It grew from 10 names to 12 during the first review window. **On 2026-09-15,
> with review COMPLETE, it settled at TWO — and not the same two.** The final set is
> `agency_agent_contract_rejected [fr]` and `vendor_storage_product_unsuspended [fr]`. Measure it
> instead — it is one command:
>
> ```bash
> curl -s "https://graph.facebook.com/v26.0/$WABA/message_templates?limit=200&fields=name,category" \
>   -H "Authorization: Bearer $TOKEN" | tr ',' '\n' | grep -B1 MARKETING
> ```
>
> ✅ **The operationally alarming case did NOT survive review.**
> `agent_shipment_offer_received` and `agent_shipment_offer_reminder` — delivery **job offers**,
> where a marketing opt-out would have silently stopped an agent being offered work — came out
> **UTILITY**. This page asserted the opposite until 2026-09-15, having recorded a *mid-review*
> classification as the outcome. ⚠ **A category seen while `status` is `PENDING` is not a
> verdict**; Meta moves it during review. Re-read it once the template is `APPROVED`.
>
> The *shape* of the risk is the durable part: **anything that reads as a nudge rather than as a
> record of something that already happened** is a candidate for reclassification — plan-expiry
> warnings, the agency soft-cap warning, contract outcomes. Check any newly submitted name of
> that kind after it clears.
>
> The generator submits `UTILITY` for all of them — its own comment warns that MARKETING
> "makes the send subject to marketing opt-out" — and Meta reclassified them on review
> anyway. Changing that means rewording the **catalog** copy to read as strictly transactional
> and resubmitting under a NEW name: a name, once bound to a category, keeps it.
> `agency_agent_contract_rejected [fr]` had to be submitted as MARKETING for exactly that
> reason, after Meta reclassified its `en` twin.
>
> ⚠ **21 names carry a padded body, and the pad is load-bearing.** Meta refuses a body whose
> first or last element is a variable, and **counts neither the `*` bold markers nor a trailing
> full stop as content** — so `… for {{2}} {{3}}.` is refused, which its own error message does
> not say. 38 of the first 190 submissions died on this. The generator now appends a static
> closing line (or prefixes the heading), leaving the catalog-derived sentence untouched; the
> same pad fixes the sibling refusal, "too many variables relative to its length".
>
> 📌 **The submittable payloads are GENERATED, not transcribed from this page.**
> `npx ts-node scripts/generate-whatsapp-templates.ts` derives every body from the catalogs
> themselves — real localised copy, with `{{n}}` placed by index in the array
> `render*WhatsAppTemplateParams` actually returns. Output:
> [`whatsapp-template-payloads.json`](./whatsapp-template-payloads.json) (94 templates ×
> en/fr = 188 submissions).
>
> **Use the generator, not this page, when creating templates.** Meta substitutes
> positionally, so a hand-typed body whose `{{2}}` sits where the code puts `{{1}}` is not
> rejected — it silently sends the wrong value in that slot on every message. This page stays
> as the human-readable reference for copy and approval status; the JSON is what gets
> submitted.
>
> Two things the generator enforces and this page cannot: it **fails** if a body quotes a real
> value the send does not pass (that defect existed in six situations and is now fixed in the
> catalogs), and it strips the ten optional clauses — `codLine`, `refundLine`, `reasonSuffix`
> and friends — which cannot be template parameters because they are frequently empty and
> **Meta rejects an empty parameter value**.

**Verified against source on 2026-09-08** — the registry census (**65** registered names), the
five language codes, and `vendor_booking_created`'s five body params, against
`jovi-mall/src/modules/whatsapp/handlers/template/template-registry.ts`,
`src/core/constants/languages.ts` and the four catalogs under
`src/modules/notifications/catalog/` (**94** distinct template names referenced, **30** of them
never registered). Approval status is a Meta-side fact this page cannot verify.

This is the source-of-truth for the WhatsApp Business templates used by the
platform — vendor notifications (§1–7), the customer-facing COD delivery
code (§8), the cross-role **billing / plan-lifecycle** templates (§9), the
**agency** (§10) and **agent** (§11) notification templates, agency-warehoused
stock (§12), and the **customer** notification stack (§13). Create each template
in **WhatsApp Business Manager → Message Templates** exactly as
specified, in **all 5 languages**. Until a template is approved, out-of-24h-window
sends for that event will fail — for role notifications the failure is recorded on
the notification's `deliveryErrors` (never breaking the flow: in-app, push, email
and Telegram still deliver); for the COD code it is logged and the code simply
stays available in the customer's own order view (see
[customer/orders.md](../customer/orders.md#cod)).

Every template listed here is registered in
[template-registry.ts](../../src/modules/whatsapp/handlers/template/template-registry.ts)
with its name, the 5 language codes, and its expected body-param count — that
registry is the code-side checklist for this page, not an approval status. A
template registered here but not yet approved in Business Manager still fails on
send; approval is a Meta-side step.

> The button URL base is `VENDOR_APP_URL` for vendor templates. Agency and agent
> templates use `AGENCY_APP_URL` / `AGENT_APP_URL` respectively as their button
> base — configure each template's URL base to match the app it points at.

## Conventions

- **Category:** `UTILITY` for all (transactional, non-promotional).
- **Languages (Meta codes):** `en`, `fr`, `pt_PT`, `es`, `ar`.
- **Body placeholders** are positional: `{{1}}`, `{{2}}`, … mapped to the event
  context below.
- **Header:** static `TEXT` (no variables).
- **Button:** a single dynamic **URL** button. Configure the button URL base as
  your `VENDOR_APP_URL` value with a trailing `{{1}}`, e.g.
  `https://app.jovimall.com/{{1}}`. The backend sends the path suffix (e.g.
  `orders/ORDER_ID`) as the button parameter.
- In-window sends use the same copy as **free-form text / interactive CTA** (no
  approval needed); the localized strings live in
  [notification-catalog.ts](../../src/modules/notifications/catalog/notification-catalog.ts).
- **Field limits:** Meta caps button labels at 20 chars, header/footer at 60,
  body at 1024. The backend also hard-caps every field to these limits
  ([whatsapp-limits.ts](../../src/modules/whatsapp/constants/whatsapp-limits.ts)),
  but keep the template copy within them so nothing is truncated.

Languages are kept in sync with `SUPPORTED_LANGUAGES`
([core/constants/languages.ts](../../src/core/constants/languages.ts)).

---

## 1. `vendor_order_created`

- **Body params:** `{{1}}`=order number, `{{2}}`=currency, `{{3}}`=amount
- **Button:** URL → `orders/{{orderId}}` · label per language below

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | New order received | You received a new order #{{1}} for {{2}} {{3}}. | View order |
| fr | Nouvelle commande reçue | Vous avez reçu une nouvelle commande n°{{1}} pour {{2}} {{3}}. | Voir la commande |
| pt_PT | Novo pedido recebido | Você recebeu um novo pedido nº{{1}} no valor de {{2}} {{3}}. | Ver pedido |
| es | Nuevo pedido recibido | Has recibido un nuevo pedido n.º{{1}} por {{2}} {{3}}. | Ver pedido |
| ar | تم استلام طلب جديد | لقد استلمت طلبًا جديدًا رقم {{1}} بقيمة {{2}} {{3}}. | عرض الطلب |

## 2. `vendor_order_cancelled`

- **Body params:** `{{1}}`=order number
- **Button:** URL → `orders/{{orderId}}`

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Order cancelled | Order #{{1}} has been cancelled. | View order |
| fr | Commande annulée | La commande n°{{1}} a été annulée. | Voir la commande |
| pt_PT | Pedido cancelado | O pedido nº{{1}} foi cancelado. | Ver pedido |
| es | Pedido cancelado | El pedido n.º{{1}} ha sido cancelado. | Ver pedido |
| ar | تم إلغاء الطلب | تم إلغاء الطلب رقم {{1}}. | عرض الطلب |

## 3. `vendor_booking_created`

- **Body params:** `{{1}}`=booking number, `{{2}}`=service name, `{{3}}`=customer name, `{{4}}`=start date/time, `{{5}}`=action line
- **Button:** URL → `bookings/{{bookingId}}`

> [!CAUTION]
> **CHANGED 2026-09-06 — 3 params → 5. This template must be EDITED AND RE-APPROVED in Business
> Manager, in all five languages, before the change deploys.** Until it is, Meta rejects every
> out-of-window send for this situation on a parameter-count mismatch and the failure is recorded
> on the notification's `deliveryErrors` — in-app, push, email and Telegram carry the new copy
> regardless, so the symptom is "WhatsApp specifically went quiet", one vendor at a time, in a log.
> `template-registry.ts` already says 5.

> [!NOTE]
> **What was wrong, and why the copy grew.** All three of the old parameters rendered EMPTY on
> every booking — the event never carried `bookingNumber`, `serviceName` or `startTime` under
> those names, so vendors received *"New booking # for scheduled on Invalid Date."* over every
> channel, and this template failed outright (Meta rejects an empty parameter). Fixing the three
> made the message correct; `{{3}}` and `{{5}}` make it **useful**, which was the other half of
> the ask. A vendor's first question is who booked, and their second is whether they have to do
> anything — a `manual`-mode booking is sitting waiting for them to accept it and the old copy
> never said so.

> [!NOTE]
> **`{{5}}` is a whole sentence, composed by the backend in the recipient's language.** It is one
> of exactly two values: *"It is waiting for you to confirm or decline it."* (the booking landed
> `pending`, i.e. the vendor's booking mode is `manual`) or *"It is already confirmed — nothing to
> do."*. It cannot be static template copy because which one applies is per-booking. The full
> wording for all five languages is in `vendor-notification-event-handler.service.ts`
> (`handleBookingCreated`) — keep the approved body's sentence spacing so the two read as one
> paragraph.

> [!NOTE]
> **Unlike five of the `customer_*` templates below, this body is DERIVED, not rewritten** — every
> placeholder in the in-window copy is a body param, so the approved template says exactly what the
> free-form message says. Keep it that way when editing: the moment a placeholder is added to the
> copy without being added to `bodyParams`, this template needs a hand-written substitute body and
> a ⚠ note like theirs. `npm run test:booking-notification` § 3 fails if that happens.

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | New booking | New booking #{{1}} — {{2}} for {{3}} on {{4}}. {{5}} | View booking |
| fr | Nouvelle réservation | Nouvelle réservation n°{{1}} — {{2}} pour {{3}} le {{4}}. {{5}} | Voir la réservation |
| pt_PT | Nova reserva | Nova reserva nº{{1}} — {{2}} para {{3}} em {{4}}. {{5}} | Ver reserva |
| es | Nueva reserva | Nueva reserva n.º{{1}} — {{2}} para {{3}} el {{4}}. {{5}} | Ver reserva |
| ar | حجز جديد | حجز جديد رقم {{1}} — {{2}} لصالح {{3}} في {{4}}. {{5}} | عرض الحجز |

**Example `{{5}}` values, for the approval submission** (Meta asks for sample parameter values):

| Lang | pending | confirmed |
|---|---|---|
| en | It is waiting for you to confirm or decline it. | It is already confirmed — nothing to do. |
| fr | Elle attend que vous la confirmiez ou la refusiez. | Elle est déjà confirmée — rien à faire. |
| pt_PT | Está à espera de que a confirme ou recuse. | Já está confirmada — não é preciso fazer nada. |
| es | Está esperando a que la confirmes o la rechaces. | Ya está confirmada — no hace falta hacer nada. |
| ar | في انتظار تأكيدك لها أو رفضها. | تم تأكيده بالفعل — لا حاجة لأي إجراء. |

## 4. `vendor_booking_cancelled`

- **Body params:** `{{1}}`=booking number
- **Button:** URL → `bookings/{{bookingId}}`

> [!NOTE]
> **Unchanged in Business Manager — no re-approval needed**, but it had the same defect as §3 and
> is fixed by the same change. `{{1}}` is the only specific detail in this one sentence and the
> event never carried it, so every vendor read *"Booking # has been cancelled."* — naming no
> booking at all, which for a vendor holding several is indistinguishable from noise. The producer
> carries `bookingNumber` now; the template's shape and param count did not move.

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Booking cancelled | Booking #{{1}} has been cancelled. | View booking |
| fr | Réservation annulée | La réservation n°{{1}} a été annulée. | Voir la réservation |
| pt_PT | Reserva cancelada | A reserva nº{{1}} foi cancelada. | Ver reserva |
| es | Reserva cancelada | La reserva n.º{{1}} ha sido cancelada. | Ver reserva |
| ar | تم إلغاء الحجز | تم إلغاء الحجز رقم {{1}}. | عرض الحجز |

## 5. `vendor_payment_partial`

- **Body params:** `{{1}}`=currency, `{{2}}`=amount
- **Button:** URL → `orders/{{orderId}}`

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Partial payment received | You received a partial payment of {{1}} {{2}}. | View order |
| fr | Paiement partiel reçu | Vous avez reçu un paiement partiel de {{1}} {{2}}. | Voir la commande |
| pt_PT | Pagamento parcial recebido | Você recebeu um pagamento parcial de {{1}} {{2}}. | Ver pedido |
| es | Pago parcial recibido | Has recibido un pago parcial de {{1}} {{2}}. | Ver pedido |
| ar | تم استلام دفعة جزئية | لقد استلمت دفعة جزئية بقيمة {{1}} {{2}}. | عرض الطلب |

## 6. `vendor_payment_full`

- **Body params:** `{{1}}`=currency, `{{2}}`=amount
- **Button:** URL → `orders/{{orderId}}`

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Payment received | You received a full payment of {{1}} {{2}}. | View order |
| fr | Paiement reçu | Vous avez reçu un paiement complet de {{1}} {{2}}. | Voir la commande |
| pt_PT | Pagamento recebido | Você recebeu o pagamento total de {{1}} {{2}}. | Ver pedido |
| es | Pago recibido | Has recibido el pago completo de {{1}} {{2}}. | Ver pedido |
| ar | تم استلام الدفعة | لقد استلمت دفعة كاملة بقيمة {{1}} {{2}}. | عرض الطلب |

## 7. `vendor_storage_alert`

- **Body params:** `{{1}}`=percent used, `{{2}}`=usage, `{{3}}`=limit
- **Button:** URL → `settings/storage` (static suffix)

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Storage almost full | Your media storage is at {{1}}% ({{2}} of {{3}}). Free up space or upgrade your plan. | Manage storage |
| fr | Stockage presque plein | Votre stockage multimédia est à {{1}}% ({{2}} sur {{3}}). Libérez de l'espace ou améliorez votre forfait. | Gérer le stockage |
| pt_PT | Armazenamento quase cheio | Seu armazenamento de mídia está em {{1}}% ({{2}} de {{3}}). Libere espaço ou atualize seu plano. | Gerir armazenamento |
| es | Almacenamiento casi lleno | Tu almacenamiento multimedia está al {{1}}% ({{2}} de {{3}}). Libera espacio o mejora tu plan. | Almacenamiento |
| ar | مساحة التخزين ممتلئة تقريبًا | مساحة تخزين الوسائط لديك عند {{1}}% ({{2}} من {{3}}). حرّر مساحة أو قم بترقية باقتك. | إدارة التخزين |

## 8. `cod_delivery_code` (customer-facing, no button)

Sent by [`DeliveryCodeService`](../../src/modules/cod/services/delivery-code.service.ts)
**only as a fallback**: it always tries a free-form text message first (free,
same copy as below); this template is used only when that specific send fails
because the customer is outside Meta's 24h customer-service window. Cost is
minimized by design — the paid template is never the first attempt.

- **Body params:** `{{1}}`=order number, `{{2}}`=delivery code, `{{3}}`=amount, `{{4}}`=currency
- **Button:** none

| Lang | Header | Body |
|---|---|---|
| en | Your delivery code | Your delivery code for order {{1}} is {{2}}. Amount to pay in cash on delivery: {{3}} {{4}}. Only give this code to the delivery agent AFTER you have received your package and paid. |
| fr | Votre code de livraison | Votre code de livraison pour la commande {{1}} est {{2}}. Montant à payer en espèces à la livraison : {{3}} {{4}}. Ne donnez ce code à l'agent qu'APRÈS avoir reçu votre colis et payé. |
| pt_PT | O seu código de entrega | O seu código de entrega para o pedido {{1}} é {{2}}. Valor a pagar em dinheiro na entrega: {{3}} {{4}}. Só entregue este código ao agente DEPOIS de receber a sua encomenda e pagar. |
| es | Tu código de entrega | Tu código de entrega para el pedido {{1}} es {{2}}. Monto a pagar en efectivo contra entrega: {{3}} {{4}}. Entrega este código al agente SOLO después de recibir tu paquete y pagar. |
| ar | رمز التسليم الخاص بك | رمز التسليم لطلبك {{1}} هو {{2}}. المبلغ المطلوب دفعه نقدًا عند التسليم: {{3}} {{4}}. لا تُعطِ هذا الرمز للمندوب إلا بعد استلام طردك والدفع. |

---

## 9. Billing / plan-lifecycle templates (all roles)

New with the cross-role billing engine. **Same copy across roles** for the plan
situations (only the template *name* differs per role, so each app can carry its
own button base). All use a single dynamic **URL** button → static suffix `plans`,
label **"Manage plan"** (fr *Gérer le forfait* · pt_PT *Gerir plano* · es *Gestionar
plan* · ar *إدارة الباقة*). Category `UTILITY`. The full 5-language body copy is the
source-of-truth in the catalogs — copy it verbatim when creating the templates:
[notification-catalog.ts](../../src/modules/notifications/catalog/notification-catalog.ts)
(vendor), [agency-notification-catalog.ts](../../src/modules/notifications/catalog/agency-notification-catalog.ts),
[agent-notification-catalog.ts](../../src/modules/notifications/catalog/agent-notification-catalog.ts).

| Template name | Role | Body params | English body (en) |
|---|---|---|---|
| `vendor_plan_expiring` | vendor | `{{1}}`=plan code, `{{2}}`=days left, `{{3}}`=expiry date | Your {{1}} plan expires in {{2}} day(s), on {{3}}. Renew or upgrade to avoid interruption. |
| `vendor_plan_expired` | vendor | `{{1}}`=expired plan code, `{{2}}`=new plan code | Your {{1}} plan has expired. You are now on the {{2}} plan. Renew or upgrade anytime from your plan settings. |
| `agency_plan_expiring` | agency | `{{1}}`, `{{2}}`, `{{3}}` (as above) | *(same as `vendor_plan_expiring`)* |
| `agency_plan_expired` | agency | `{{1}}`, `{{2}}` | *(same as `vendor_plan_expired`)* |
| `agent_plan_expiring` | agent | `{{1}}`, `{{2}}`, `{{3}}` | Your {{1}} plan expires in {{2}} day(s), on {{3}}. Renew or upgrade to keep your higher delivery limit. |
| `agent_plan_expired` | agent | `{{1}}`, `{{2}}` | Your {{1}} plan has expired. You are now on the {{2}} plan, which may lower how many deliveries you can hold at once. Upgrade anytime from your plan settings. |

### `agency_shipment_cap_exceeded` (agency only)

Soft-cap monitoring alert (deliveries are never blocked). Header **"Shipment limit reached"**, button → `plans` ("Manage plan").

- **Body params:** `{{1}}`=current active shipments, `{{2}}`=plan code, `{{3}}`=cap

| Lang | Body |
|---|---|
| en | You have {{1}} active shipments, at or above your {{2}} plan limit of {{3}}. Deliveries keep flowing — upgrade for more headroom. |
| fr | Vous avez {{1}} expéditions actives, au niveau ou au-dessus de la limite de {{3}} de votre forfait {{2}}. Les livraisons continuent — améliorez votre forfait pour plus de marge. |
| pt_PT | Tem {{1}} remessas ativas, no limite ou acima do limite de {{3}} do seu plano {{2}}. As entregas continuam — faça upgrade para mais margem. |
| es | Tienes {{1}} envíos activos, en o por encima del límite de {{3}} de tu plan {{2}}. Las entregas continúan — mejora tu plan para más margen. |
| ar | لديك {{1}} شحنة نشطة، عند حد باقة {{2}} البالغ {{3}} أو أعلى منه. تستمر عمليات التوصيل — قم بالترقية لمزيد من السعة. |

> Until these are approved, plan/cap notifications still reach the recipient via **in-app + push + email/Telegram** — only the WhatsApp channel (outside the 24h window) waits on approval.

---

## 10. Agency templates

Button base: **`AGENCY_APP_URL`**. Category `UTILITY`, 5 languages, single dynamic
URL button unless stated. The **full 5-language body + button copy is the
source-of-truth in
[agency-notification-catalog.ts](../../src/modules/notifications/catalog/agency-notification-catalog.ts)** —
copy it verbatim when creating each template; the English body below is the
reference for what the params mean. Plan templates (`agency_plan_expiring`,
`agency_plan_expired`) and `agency_shipment_cap_exceeded` are specified in §9.

| Template name | Body params | Button suffix · label (en) | English body |
|---|---|---|---|
| `agency_connection_request_received` | `{{1}}`=vendor name | `vendor-connections/{{connectionId}}` · View connection | {{1}} wants to connect with you as their delivery partner. |
| `agency_connection_approved` | `{{1}}`=vendor name | `vendor-connections/{{connectionId}}` · View connection | {{1}} approved your connection request. You can now deliver for them. |
| `agency_connection_rejected` | `{{1}}`=vendor name | `vendor-connections/{{connectionId}}` · View connection | {{1}} declined your connection request. |
| `agency_connection_reapproval_needed` | `{{1}}`=vendor name | `vendor-connections/{{connectionId}}` · View connection | {{1}} updated their policies. Reapprove your connection to keep delivering for them. |
| `agency_shipment_assigned` | `{{1}}`=order number, `{{2}}`=item count | `shipments/{{shipmentId}}` · View shipment | Order #{{1}} was dispatched to you — {{2}} item(s) to fulfill. |
| `agency_shipment_offer_accepted` | `{{1}}`=agent name, `{{2}}`=order number | `shipments/{{shipmentId}}` · View shipment | {{1}} accepted the delivery for order #{{2}}. They are on the way. |
| `agency_shipment_assignment_unfilled` | `{{1}}`=order number | `shipments/{{shipmentId}}` · View shipment | No agent took the delivery for order #{{1}}. Assign an agent manually to keep it moving. |
| `agency_payout_requested` | `{{1}}`=currency, `{{2}}`=amount | `tickets/{{ticketId}}` · View ticket | Your request to withdraw {{1}} {{2}} was created. Track its progress under Tickets. |
| `agency_payout_paid` | `{{1}}`=currency, `{{2}}`=amount | `tickets/{{ticketId}}` · View ticket | Your payout of {{1}} {{2}} has been paid. |
| `agency_payout_rejected` | `{{1}}`=currency, `{{2}}`=amount | `tickets/{{ticketId}}` · View ticket | Your request to withdraw {{1}} {{2}} was rejected. See Tickets for the reason. |
| ⭐ `agency_payout_transfer_failed` | `{{1}}`=currency, `{{2}}`=amount | `tickets/{{ticketId}}` · View ticket | We hit a problem sending your {{1}} {{2}}. The money is safe and still reserved for this payout — our team is on it and will retry. Nothing is needed from you; see Tickets for progress. |
| `agency_cod_deposit_declared` | `{{1}}`=agent name, `{{2}}`=currency, `{{3}}`=amount, `{{4}}`=deadline days | `cod/deposits/{{depositId}}` · Review deposit | {{1}} declared a cash deposit of {{2}} {{3}}. Confirm or reject it within {{4}} days — unanswered declarations freeze your reserve releases. |
| `agency_cod_deposit_direct_to_platform` | `{{1}}`=agent name, `{{2}}`=currency, `{{3}}`=amount | `cod/deposits/{{depositId}}` · Review deposit | {{1}} paid {{2}} {{3}} of collected cash straight to the platform. Your liability has been reduced by the same amount and the collections it covers are settled — nothing is owed to you for it. |
| `agency_storage_alert` | `{{1}}`=percent used, `{{2}}`=usage, `{{3}}`=limit | `settings/storage` (static) · Manage storage | *(same copy as `vendor_storage_alert`, §7)* |

### 10a. Agent-contract templates (agency side)

The agency's half of the agent↔agency contract. Button suffix is `agents/{{contractId}}` · **View
contract** for all eight. See [Agent roster](../agency/agent-roster.md#notifications).

| Template name | Body params | English body |
|---|---|---|
| `agency_agent_contract_request_received` | `{{1}}`=agent name | {{1}} applied to deliver for you. |
| `agency_agent_contract_approved` | `{{1}}`=agent name | {{1}} accepted your request. |
| `agency_agent_contract_rejected` | `{{1}}`=agent name | {{1}} declined your request. |
| `agency_agent_contract_status_request_raised` | `{{1}}`=agent name, `{{2}}`=transition label | {{1}} wants to {{2}}. It does not take effect until you answer — open the request to approve or decline it. |
| `agency_agent_contract_status_request_resolved` | `{{1}}`=agent name, `{{2}}`=transition label, `{{3}}`=resolution label | The request for {{1}} to {{2}} was {{3}}. |
| `agency_agent_contract_terms_countered` | `{{1}}`=agent name | {{1}} has countered the terms of your pending contract. Review what they are asking, then accept it, decline it, or counter again. |
| `agency_agent_contract_terms_proposed` | `{{1}}`=agent name | {{1}} has proposed a change to their contract. **The current terms stay in force until you answer** — nothing changes unless you accept. Open it to review, accept, decline or counter. |
| `agency_agent_contract_terms_resolved` | `{{1}}`=agent name, `{{2}}`=resolution label | The proposed change to the contract with {{1}} was {{2}}. Open the contract to see the terms now in force. |

**Label params are pre-localized by the server**, not enum values — `{{2}}` on
`status_request_raised` arrives as "end your contract" / "mettre fin à votre contrat" in the
recipient's language, and the resolution label as "accepted" / "declined" / "withdrawn" / "replaced
by a counter-offer". Do not translate them inside the template; the body around them is what varies
per language.

Headers are static `TEXT` — use the situation's `subject` from the catalog
(e.g. *New connection request*, *Deposit awaiting your confirmation*).

## 11. Agent templates

Button base: **`AGENT_APP_URL`**. Same conventions as §10; source-of-truth copy in
[agent-notification-catalog.ts](../../src/modules/notifications/catalog/agent-notification-catalog.ts).
Plan templates (`agent_plan_expiring`, `agent_plan_expired`) are in §9.

| Template name | Body params | Button suffix · label (en) | English body |
|---|---|---|---|
| `agent_cod_deposit_recorded` | `{{1}}`=agency name, `{{2}}`=currency, `{{3}}`=amount | `cod/deposits/{{depositId}}` · View deposit | {{1}} recorded a cash deposit of {{2}} {{3}} from you. Your balance has been reduced by that amount. If this is not what you handed over, report it now. |
| `agent_cod_deposit_confirmed` | `{{1}}`=currency, `{{2}}`=amount, `{{3}}`=confirmed-by name | `cod/deposits/{{depositId}}` · View deposit | Your deposit of {{1}} {{2}} was confirmed by {{3}}. Your balance has been reduced and your COD limit freed up. |
| `agent_cod_deposit_rejected` | `{{1}}`=confirmed-by name, `{{2}}`=currency, `{{3}}`=amount, `{{4}}`=rejection reason | `cod/deposits/{{depositId}}` · View deposit | {{1}} rejected your declared deposit of {{2}} {{3}}. Reason: {{4}}. The cash is still on your balance and your deposit deadline is running again — sort this out with them, or report it. |
| `agent_shipment_offer_received` | `{{1}}`=agency name, `{{2}}`=order number | `offers/{{offerId}}` · Review offer | {{1}} is offering you a delivery for order {{2}}. Review and accept it before it expires. |
| `agent_shipment_offer_reminder` | `{{1}}`=agency name, `{{2}}`=order number | `offers/{{offerId}}` · Review offer | Your delivery offer from {{1}} for order {{2}} is still open. Accept it now before another agent takes it. |
| `agent_shipment_offer_expired` | `{{1}}`=agency name, `{{2}}`=order number | `offers/{{offerId}}` · Review offer | The delivery offer from {{1}} for order {{2}} expired because it wasn't accepted in time. |
| `agent_shipment_reassigned_away` | `{{1}}`=order number, `{{2}}`=agency name | **none** | The delivery for order {{1}} has been reassigned to another agent by {{2}}. You are no longer responsible for it, and its customer and tracking details are no longer available to you. It stays in your activity history. |
| `agent_storage_alert` | `{{1}}`=percent used, `{{2}}`=usage, `{{3}}`=limit | `settings/storage` (static) · Manage storage | *(same copy as `vendor_storage_alert`, §7)* |
| ⭐ `agent_payout_requested` | `{{1}}`=currency, `{{2}}`=amount | `earnings` (static) · View earnings | Your request to withdraw {{1}} {{2}} was created. You will hear from us when it is paid. |
| ⭐ `agent_payout_paid` | `{{1}}`=currency, `{{2}}`=amount | `earnings` (static) · View earnings | Your payout of {{1}} {{2}} has been paid. |
| ⭐ `agent_payout_rejected` | `{{1}}`=currency, `{{2}}`=amount | `earnings` (static) · View earnings | Your request to withdraw {{1}} {{2}} was rejected. The money is back in your available balance — open your earnings to see why, and you can request again. |
| ⭐ `agent_payout_transfer_failed` | `{{1}}`=currency, `{{2}}`=amount | `earnings` (static) · View earnings | We hit a problem sending your {{1}} {{2}}. Your money is safe and still reserved for this payout — our team is on it and will retry. There is nothing you need to do. |

⭐ **The four `agent_payout_*` templates are NEW and not yet submitted.** They close a total
gap: `agent-notification-event-consumer.ts` subscribed to **no** `payout.*` event, so an agent
requested their money and heard nothing in any channel. `agent_payout_transfer_failed` is new
for all three roles — the event was published and consumed by nobody.

⚠ **`agent_payout_rejected` and `agent_payout_transfer_failed` must not be confused when
reviewing copy.** Rejected **returns** the money and invites another request. Failed leaves it
**held**, is not terminal, and must **not** invite a retry — the owner would get a `409`. The
two read similarly in a list and mean opposite things to the person waiting.

⚠ `earnings` carries **no** placeholder, unlike the vendor and agency payout buttons which use
`tickets/{{ticketId}}`. The agent app has no tickets screen, and an agent has at most one open
payout request, so the summary is unambiguous. It is a **new** entry in the agent app's
deep-link vocabulary — see [deep-links.md](./deep-links.md#agent--agent_app-flutter).

### 11a. Agent-contract templates (agent side)

The agent's half — the mirror of §10a with the agency named instead. Button suffix is
`memberships/{{contractId}}` · **View contract** for all eight. See
[Agency membership](../agent/agency-membership.md#notifications).

| Template name | Body params | English body |
|---|---|---|
| `agent_contract_request_received` | `{{1}}`=agency name | {{1}} wants you to deliver for them. |
| `agent_contract_approved` | `{{1}}`=agency name | {{1}} approved your application. |
| `agent_contract_rejected` | `{{1}}`=agency name | {{1}} declined your application. |
| `agent_contract_status_request_raised` | `{{1}}`=agency name, `{{2}}`=transition label | {{1}} wants to {{2}}. It does not take effect until you answer — open the request to approve or decline it. |
| `agent_contract_status_request_resolved` | `{{1}}`=transition label, `{{2}}`=agency name, `{{3}}`=resolution label | The request to {{1}} with {{2}} was {{3}}. |
| `agent_contract_terms_countered` | `{{1}}`=agency name | {{1}} has changed the terms of your pending contract. Review what they are offering, then accept it, decline it, or counter again. |
| `agent_contract_terms_proposed` | `{{1}}`=agency name | {{1}} has proposed a change to your contract. **Your current terms stay in force until you answer** — nothing changes unless you accept. Open it to review, accept, decline or counter. |
| `agent_contract_terms_resolved` | `{{1}}`=agency name, `{{2}}`=resolution label | The proposed change to your contract with {{1}} was {{2}}. Open the contract to see the terms now in force. |

> **Param order differs between the two sides** — `agent_contract_status_request_resolved` takes the
> transition label first, its agency twin takes the name first. Copy each from its catalog rather
> than assuming symmetry.
>
> The "stays in force until you answer" clause in `terms_proposed` is **load-bearing copy**, not
> padding. A live terms proposal changes nothing on its own; a recipient who assumes it already
> applied will act on the wrong rate. Keep it in every language.

> **Static-header caveat:** the in-app subject for `cod.deposit.recorded` is
> *"Deposit recorded by {{agencyName}}"*, but a template header must be static —
> create that template's header as **"Deposit recorded"**. The agency name is
> already the first body param, so nothing is lost.

---

## 12. Agency-warehoused stock templates

> **"Storage" here means a WAREHOUSE**, not the media-file quota. `vendor_storage_alert`
> (§7) and `agency_storage_alert` (§10) are the quota ones. These nine are about physical
> goods on an agency's shelves. Do not merge the two families.

All nine carry a URL button. Base URL is `VENDOR_APP_URL` for the `vendor_*` templates
and `AGENCY_APP_URL` for the `agency_*` ones.

### 12a. Stock adjustment requests (both sides)

Neither the vendor nor the agency may change `variant.stock` on a warehoused SKU alone;
one proposes and the other approves. Each side gets the same three situations from its own
point of view.

| Template | Body params | Button suffix |
|---|---|---|
| `agency_storage_stock_request_received` | `vendorName`, `productTitle`, `sku`, `quantityBefore`, `requestedQuantity` | `stock-requests/{{requestId}}` |
| `agency_storage_stock_request_approved` | `vendorName`, `productTitle`, `sku`, `requestedQuantity` | `stock-requests/{{requestId}}` |
| `agency_storage_stock_request_rejected` | `vendorName`, `productTitle`, `sku`, `quantityBefore` | `stock-requests/{{requestId}}` |
| `vendor_storage_stock_request_received` | `agencyName`, `requestedQuantity`, `productTitle`, `sku`, `quantityBefore` | `stock-requests/{{requestId}}` |
| `vendor_storage_stock_request_approved` | `agencyName`, `productTitle`, `sku`, `requestedQuantity` | `stock-requests/{{requestId}}` |
| `vendor_storage_stock_request_rejected` | `agencyName`, `productTitle`, `sku`, `quantityBefore` | `stock-requests/{{requestId}}` |

> **Every `received` body carries BOTH quantities, and the order differs between the two
> sides.** Note `vendor_storage_stock_request_received` puts `requestedQuantity` second
> (the agency *counted* n) while the agency's puts `quantityBefore` fourth (the vendor
> wants to go *from* n *to* m). Copy the param order from the table, not from the other
> side's template.
>
> Both numbers are **load-bearing copy**: the decision the recipient has to make is "is 90
> right, or is 120?", and a body naming only the new figure forces them to go and look up
> the old one before they can answer.

### 12b. Things the agency did alone (vendor only)

No vendor decision to make — where the goods sit and whether the rent was paid are the
agency's own business — but a suspension takes the product off the storefront, and the
vendor must not discover that from their sales figures.

| Template | Body params | Button suffix |
|---|---|---|
| `vendor_storage_depot_changed` | `agencyName`, `productTitle`, `locationSuffix` | `products/{{productId}}` |
| `vendor_storage_product_suspended` | `agencyName`, `productTitle`, `noteSuffix` | `products/{{productId}}` |
| `vendor_storage_product_unsuspended` | `agencyName`, `productTitle` | `products/{{productId}}` |

> **`locationSuffix` and `noteSuffix` are pre-composed, including their own leading
> separator.** The backend sends `" (Bonabéri branch)"` or `""`, and
> `" Their note: “Storage unpaid since June”."` or `""`. That is deliberate: an unnamed
> depot or an absent note would otherwise render dangling punctuation ("…to a different
> warehouse ."). When creating these templates, place the placeholder **immediately
> after** the preceding word with no space or bracket of your own.

### Copy, all five languages

`en` / `fr` / `pt_PT` / `es` / `ar`, as with every other family here. Take the exact
strings from `NOTIFICATION_CATALOG` (`notification-catalog.ts`) and
`AGENCY_NOTIFICATION_CATALOG` (`agency-notification-catalog.ts`) — those are the source
of truth, and the in-app bodies and the template bodies must read the same.

> **Suspension copy must state the consequence plainly.** `storage.product_suspended`
> says "so customers can no longer buy it" in every language. A vendor who reads it as an
> administrative note will not act, and the product stays unsellable.

---


---

## 13. Customer templates (the fourth notification stack)

⚠ **These twenty-two were registered in code and documented NOWHERE until 2026-08-26**, which
is the same thing as not existing: an unapproved template fails on send, and a template nobody
wrote down never gets approved. GAP-012's own warning is exactly this — *"a template registered
in code but not approved in Business Manager still fails on send"* — so the customer stack had
the machinery and no approved templates to use it with. Create all twenty-two, in all five
languages, before relying on any proactive customer message.

> **Button URL base:** `STOREFRONT_URL`, not `VENDOR_APP_URL` — these point a *customer* at
> their own order, booking or support request. Configure each template's URL base as your
> `STOREFRONT_URL` with a trailing `{{1}}`; the backend sends the path suffix shown under
> **Button** as the button parameter.

**Which of these actually matter.** Payments settle in minutes and stay inside the 24-hour
service window, so their free-form copy usually does the work. The ones that *cannot* be
delivered any other way are the ones whose event lands days later:
`customer_order_shipped`, `customer_order_out_for_delivery`, `customer_order_delivered`,
`customer_order_delivery_failed`, `customer_booking_reminder`, and the three
`customer_ticket_*` templates. Approve those first.

⚠ **The body below is the TEMPLATE body, and for eleven situations it is shorter than the
in-window copy.** Those carry a handler-substituted clause — `{{confirmationLine}}`,
`{{codLine}}`, `{{reasonLine}}`, `{{refundLine}}` and friends — that is **not** in
`bodyParams` and therefore cannot travel in a template at all; Meta rejects a body containing
an unbound placeholder. Out-of-window those customers get the shorter sentence, which is the
accepted cost of the template mechanism rather than a defect.

> ### ⚠ Five of those eleven had to be REWRITTEN rather than shortened, and it is a finding
>
> On six of the eleven the missing clause is trailing, so dropping it leaves a correct
> sentence. On **five it sits mid-sentence**, and simply removing it produces copy that is
> ungrammatical — *"We received your XAF 24000 payment for order ORD-1. is preparing it
> now."* — or, on `booking.balance.due`, actively **wrong**: two different amounts collapse
> onto one parameter and the sentence claims something untrue about the money.
>
> Those five carry a **⚠ Rewritten, not derived** note and a hand-written body that says as
> much as its declared parameters allow. They are the five whose `bodyParams` do not cover
> their own copy: `booking.reminder`, `booking.payment.received`, `booking.balance.due`,
> `order.created`, `order.payment.received`.
>
> **The honest fix is to widen `bodyParams` on those five** so a template can say what the
> in-window copy says. It was NOT done here, deliberately: changing an approved template's
> parameter count is a Business Manager operation, and doing it blind — from a repository
> that cannot see what is approved — risks breaking a template that already works. Raise it
> as its own change, with the approval state in front of you.

⚠ **`customer_order_payment_link` is the only one here that is not raised by a platform
event.** The automation layer raises it through `messaging_notify_customer`, and its button
points at a **payment page**, not at a record the customer already owns. See
[n8n/bot-surface.md § 13](../n8n/bot-surface.md).

⚠ **`{{2}}` on `customer_ticket_resolved` is a whole sentence, not a value** — whether the
customer may still reply depends on resolved-vs-closed, so it travels as a parameter rather
than being baked into the approved body, which would make one of the two outcomes a lie.

The tables below are rendered from
[customer-notification-catalog.ts](../../src/modules/notifications/catalog/customer-notification-catalog.ts).
`npm run test:customer-notifications` asserts that every registered `customer_*` template
name appears on this page, so a situation added without its approval copy fails the suite.

### `customer_booking_created`

- **Situation:** `booking.created`
- **Body params:** `{{1}}`=serviceName, `{{2}}`=vendorName, `{{3}}`=startAt
- **Button:** URL → `bookings/{{bookingId}}`

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Booking requested: {{1}} | You booked {{1}} with {{2}} for {{3}}. | View booking |
| fr | Réservation demandée : {{1}} | Vous avez réservé {{1}} chez {{2}} pour le {{3}}. | Voir la réservation |
| pt_PT | Reserva solicitada: {{1}} | Reservou {{1}} com {{2}} para {{3}}. | Ver reserva |
| es | Reserva solicitada: {{1}} | Reservaste {{1}} con {{2}} para el {{3}}. | Ver reserva |
| ar | تم طلب الحجز: {{1}} | لقد حجزت {{1}} مع {{2}} في {{3}}. | عرض الحجز |

### `customer_booking_confirmed`

- **Situation:** `booking.confirmed`
- **Body params:** `{{1}}`=vendorName, `{{2}}`=serviceName, `{{3}}`=startAt
- **Button:** URL → `bookings/{{bookingId}}`

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Booking confirmed: {{2}} | {{1}} accepted your booking for {{2}} on {{3}}. It is now confirmed — see you then. | View booking |
| fr | Réservation confirmée : {{2}} | {{1}} a accepté votre réservation pour {{2}} le {{3}}. Elle est confirmée — à bientôt. | Voir la réservation |
| pt_PT | Reserva confirmada: {{2}} | {{1}} aceitou a sua reserva de {{2}} em {{3}}. Está confirmada — até lá. | Ver reserva |
| es | Reserva confirmada: {{2}} | {{1}} aceptó tu reserva de {{2}} el {{3}}. Está confirmada — nos vemos. | Ver reserva |
| ar | تم تأكيد الحجز: {{2}} | قبلت {{1}} حجزك لـ {{2}} في {{3}}. تم التأكيد — نراك حينها. | عرض الحجز |

### `customer_booking_rescheduled`

- **Situation:** `booking.rescheduled`
- **Body params:** `{{1}}`=serviceName, `{{2}}`=previousStartAt, `{{3}}`=startAt
- **Button:** URL → `bookings/{{bookingId}}`

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Booking moved: {{1}} | Your {{1}} booking has moved from {{2}} to {{3}}. If that does not work for you, you can cancel or move it again. | View booking |
| fr | Réservation déplacée : {{1}} | Votre réservation {{1}} est passée du {{2}} au {{3}}. Si cela ne vous convient pas, vous pouvez l'annuler ou la déplacer. | Voir la réservation |
| pt_PT | Reserva alterada: {{1}} | A sua reserva de {{1}} passou de {{2}} para {{3}}. Se não lhe der jeito, pode cancelar ou alterar de novo. | Ver reserva |
| es | Reserva movida: {{1}} | Tu reserva de {{1}} pasó del {{2}} al {{3}}. Si no te viene bien, puedes cancelarla o moverla otra vez. | Ver reserva |
| ar | تم نقل الحجز: {{1}} | تم نقل حجزك لـ {{1}} من {{2}} إلى {{3}}. إذا لم يناسبك ذلك، يمكنك الإلغاء أو النقل مرة أخرى. | عرض الحجز |

### `customer_booking_cancelled`

- **Situation:** `booking.cancelled`
- **Body params:** `{{1}}`=serviceName, `{{2}}`=startAt, `{{3}}`=cancelledBy
- **Button:** URL → `bookings/{{bookingId}}`

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Booking cancelled: {{1}} | Your {{1}} booking on {{2}} was cancelled by {{3}}. | View booking |
| fr | Réservation annulée : {{1}} | Votre réservation {{1}} du {{2}} a été annulée par {{3}}. | Voir la réservation |
| pt_PT | Reserva cancelada: {{1}} | A sua reserva de {{1}} em {{2}} foi cancelada por {{3}}. | Ver reserva |
| es | Reserva cancelada: {{1}} | Tu reserva de {{1}} del {{2}} fue cancelada por {{3}}. | Ver reserva |
| ar | تم إلغاء الحجز: {{1}} | تم إلغاء حجزك لـ {{1}} في {{2}} بواسطة {{3}}. | عرض الحجز |

### `customer_booking_completed`

- **Situation:** `booking.completed`
- **Body params:** `{{1}}`=serviceName, `{{2}}`=currency, `{{3}}`=finalPriceFormatted
- **Button:** URL → `bookings/{{bookingId}}`

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Thanks for visiting | Your {{1}} booking is complete. Final price: {{2}} {{3}}. | View booking |
| fr | Merci de votre visite chez | Votre réservation {{1}} est terminée. Prix final : {{2}} {{3}}. | Voir la réservation |
| pt_PT | Obrigado por visitar | A sua reserva de {{1}} está concluída. Preço final: {{2}} {{3}}. | Ver reserva |
| es | Gracias por visitar | Tu reserva de {{1}} está completa. Precio final: {{2}} {{3}}. | Ver reserva |
| ar | شكرًا لزيارتك | اكتمل حجزك لـ {{1}}. السعر النهائي: {{2}} {{3}}. | عرض الحجز |

### `customer_booking_reminder`

- **Situation:** `booking.reminder`
- **Body params:** `{{1}}`=serviceName, `{{2}}`=vendorName, `{{3}}`=startAt
- **Button:** URL → `bookings/{{bookingId}}`

⚠ **Rewritten, not derived.** The in-window copy carries `{{whenPhrase}}` ("tomorrow" / "later today"), which is not a body param — the template says the time plainly instead.

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Reminder: {{1}} | Your {{1}} booking with {{2}} is at {{3}}. If you cannot make it, please cancel so the slot can go to someone else. | View booking |
| fr | Rappel : {{1}} | Votre réservation {{1}} chez {{2}} est prévue le {{3}}. Si vous ne pouvez pas venir, annulez pour libérer le créneau. | Voir la réservation |
| pt_PT | Lembrete: {{1}} | A sua reserva de {{1}} com {{2}} é às {{3}}. Se não puder comparecer, cancele para libertar o horário. | Ver reserva |
| es | Recordatorio: {{1}} | Tu reserva de {{1}} con {{2}} es el {{3}}. Si no puedes asistir, cancélala para liberar el horario. | Ver reserva |
| ar | تذكير: {{1}} | حجزك لـ {{1}} مع {{2}} في {{3}}. إذا لم تتمكن من الحضور، يرجى الإلغاء ليستفيد شخص آخر من الموعد. | عرض الحجز |

### `customer_booking_payment_received`

- **Situation:** `booking.payment.received`
- **Body params:** `{{1}}`=currency, `{{2}}`=amountFormatted, `{{3}}`=serviceName
- **Button:** URL → `bookings/{{bookingId}}`

⚠ **Rewritten, not derived.** The in-window copy names `{{startAt}}`, which is not a body param.

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Payment received: {{1}} {{2}} | We received your {{1}} {{2}} payment for {{3}}. Nothing else to do — see you then. | View booking |
| fr | Paiement reçu : {{1}} {{2}} | Nous avons reçu votre paiement de {{1}} {{2}} pour {{3}}. Rien d'autre à faire — à bientôt. | Voir la réservation |
| pt_PT | Pagamento recebido: {{1}} {{2}} | Recebemos o seu pagamento de {{1}} {{2}} para {{3}}. Nada mais a fazer — até lá. | Ver reserva |
| es | Pago recibido: {{1}} {{2}} | Recibimos tu pago de {{1}} {{2}} por {{3}}. Nada más que hacer — nos vemos. | Ver reserva |
| ar | تم استلام الدفعة: {{1}} {{2}} | استلمنا دفعتك بقيمة {{1}} {{2}} مقابل {{3}}. لا يوجد شيء آخر مطلوب — نراك حينها. | عرض الحجز |

### `customer_booking_balance_due`

- **Situation:** `booking.balance.due`
- **Body params:** `{{1}}`=vendorName, `{{2}}`=serviceName, `{{3}}`=currency, `{{4}}`=balanceFormatted
- **Button:** URL → `bookings/{{bookingId}}/pay-balance`

⚠ **Rewritten, not derived, and this one was WRONG rather than merely incomplete.** The in-window copy names `{{finalPriceFormatted}}` and `{{reasonLine}}`, neither of which is a body param, and stripping them left `{{3}}` reading as two different amounts in one sentence. The template states only the balance, which is what the four parameters can actually say.

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Balance due: {{3}} {{4}} | {{1}} has settled your {{2}} booking, and {{3}} {{4}} is still owed. You can pay the balance here, or settle it directly with {{1}}. | Pay balance |
| fr | Solde à payer : {{3}} {{4}} | {{1}} a clôturé votre réservation {{2}}, et il reste {{3}} {{4}} à régler. Vous pouvez payer le solde ici, ou directement auprès de {{1}}. | Payer le solde |
| pt_PT | Saldo em dívida: {{3}} {{4}} | {{1}} concluiu a sua reserva de {{2}} e ainda faltam {{3}} {{4}}. Pode pagar o saldo aqui, ou diretamente a {{1}}. | Pagar saldo |
| es | Saldo pendiente: {{3}} {{4}} | {{1}} ha cerrado tu reserva de {{2}} y aún faltan {{3}} {{4}}. Puedes pagar el saldo aquí, o directamente con {{1}}. | Pagar saldo |
| ar | رصيد مستحق: {{3}} {{4}} | أنهت {{1}} حجزك لـ {{2}}، وما زال مستحقًا {{3}} {{4}}. يمكنك دفع الرصيد هنا، أو تسويته مباشرة مع {{1}}. | دفع الرصيد |

### `customer_booking_refunded`

- **Situation:** `booking.refunded`
- **Body params:** `{{1}}`=currency, `{{2}}`=amountFormatted, `{{3}}`=serviceName
- **Button:** URL → `bookings/{{bookingId}}`

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Refunded: {{1}} {{2}} | We have refunded {{1}} {{2}} for your cancelled {{3}} booking. It goes back to the way you paid, and usually appears within a few working days. | View booking |
| fr | Remboursé : {{1}} {{2}} | Nous avons remboursé {{1}} {{2}} pour votre réservation {{3}} annulée. Le montant retourne par votre moyen de paiement et apparaît généralement sous quelques jours ouvrés. | Voir la réservation |
| pt_PT | Reembolsado: {{1}} {{2}} | Reembolsámos {{1}} {{2}} pela sua reserva cancelada de {{3}}. Volta pelo mesmo meio de pagamento e costuma aparecer em poucos dias úteis. | Ver reserva |
| es | Reembolsado: {{1}} {{2}} | Hemos reembolsado {{1}} {{2}} por tu reserva cancelada de {{3}}. Vuelve por tu medio de pago y suele aparecer en unos días hábiles. | Ver reserva |
| ar | تم الاسترداد: {{1}} {{2}} | قمنا برد {{1}} {{2}} مقابل حجزك الملغى لـ {{3}}. يعود المبلغ بنفس طريقة الدفع وعادة ما يظهر خلال أيام عمل قليلة. | عرض الحجز |

### `customer_booking_refund_pending`

- **Situation:** `booking.refund.pending`
- **Body params:** `{{1}}`=currency, `{{2}}`=amountFormatted, `{{3}}`=serviceName
- **Button:** URL → `bookings/{{bookingId}}`

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Refund on the way: {{1}} {{2}} | We owe you {{1}} {{2}} for your cancelled {{3}} booking. This one needs to be sent by hand, so our team is processing it — you do not need to do anything, and we will confirm when it is done. | View booking |
| fr | Remboursement en cours : {{1}} {{2}} | Nous vous devons {{1}} {{2}} pour votre réservation {{3}} annulée. Ce remboursement doit être envoyé manuellement : notre équipe s'en occupe. Vous n'avez rien à faire, nous confirmerons dès que c'est fait. | Voir la réservation |
| pt_PT | Reembolso a caminho: {{1}} {{2}} | Devemos-lhe {{1}} {{2}} pela sua reserva cancelada de {{3}}. Este reembolso tem de ser enviado manualmente e a nossa equipa está a tratar disso — não precisa de fazer nada e confirmaremos quando estiver concluído. | Ver reserva |
| es | Reembolso en camino: {{1}} {{2}} | Te debemos {{1}} {{2}} por tu reserva cancelada de {{3}}. Este reembolso debe enviarse a mano y nuestro equipo lo está gestionando — no tienes que hacer nada y te confirmaremos cuando esté listo. | Ver reserva |
| ar | الاسترداد في الطريق: {{1}} {{2}} | ندين لك بمبلغ {{1}} {{2}} مقابل حجزك الملغى لـ {{3}}. يجب إرسال هذا المبلغ يدويًا وفريقنا يعمل عليه — لا داعي لفعل أي شيء وسنؤكد لك عند الانتهاء. | عرض الحجز |

### `customer_order_created`

- **Situation:** `order.created`
- **Body params:** `{{1}}`=orderNumber, `{{2}}`=vendorName, `{{3}}`=currency, `{{4}}`=amountFormatted
- **Button:** URL → `orders/{{orderId}}`

⚠ **Rewritten, not derived.** The in-window copy names `{{itemCount}}` and a trailing `{{paymentLine}}`, neither of which is a body param.

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Order {{1}} placed | Your order {{1}} with {{2}} is placed, for {{3}} {{4}}. | View order |
| fr | Commande {{1}} passée | Votre commande {{1}} chez {{2}} est enregistrée, pour {{3}} {{4}}. | Voir la commande |
| pt_PT | Encomenda {{1}} efetuada | A sua encomenda {{1}} em {{2}} foi registada, no valor de {{3}} {{4}}. | Ver encomenda |
| es | Pedido {{1}} realizado | Tu pedido {{1}} con {{2}} está registrado, por {{3}} {{4}}. | Ver pedido |
| ar | تم تسجيل الطلب {{1}} | تم تسجيل طلبك {{1}} لدى {{2}} بقيمة {{3}} {{4}}. | عرض الطلب |

### `customer_order_payment_received`

- **Situation:** `order.payment.received`
- **Body params:** `{{1}}`=currency, `{{2}}`=amountFormatted, `{{3}}`=orderNumber
- **Button:** URL → `orders/{{orderId}}`

⚠ **Rewritten, not derived.** The in-window copy names `{{vendorName}}`, which is not a body param — stripping it left "…{{3}}. is preparing it now."

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Payment received for {{3}} | We received your {{1}} {{2}} payment for order {{3}}. The seller is preparing it now. | View order |
| fr | Paiement reçu pour {{3}} | Nous avons reçu votre paiement de {{1}} {{2}} pour la commande {{3}}. Le vendeur la prépare. | Voir la commande |
| pt_PT | Pagamento recebido para {{3}} | Recebemos o seu pagamento de {{1}} {{2}} pela encomenda {{3}}. O vendedor está a prepará-la. | Ver encomenda |
| es | Pago recibido para {{3}} | Recibimos tu pago de {{1}} {{2}} por el pedido {{3}}. El vendedor lo está preparando. | Ver pedido |
| ar | تم استلام الدفعة للطلب {{3}} | استلمنا دفعتك بقيمة {{1}} {{2}} للطلب {{3}}. البائع يقوم بتجهيزه الآن. | عرض الطلب |

### `customer_order_payment_link`

- **Situation:** `order.payment_link`
- **Body params:** `{{1}}`=currency, `{{2}}`=amountFormatted, `{{3}}`=orderNumber, `{{4}}`=expiresInMinutes
- **Button:** URL → `pay/{{payToken}}`

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Finish paying {{1}} {{2}} | Open this page to pay {{1}} {{2}} for {{3}} by card. The link works for {{4}} minutes — ask me for a new one if it runs out. | Pay now |
| fr | Terminez le paiement de {{1}} {{2}} | Ouvrez cette page pour payer {{1}} {{2}} pour {{3}} par carte. Le lien est valable {{4}} minutes — demandez-m'en un nouveau s'il expire. | Payer maintenant |
| pt_PT | Conclua o pagamento de {{1}} {{2}} | Abra esta página para pagar {{1}} {{2}} de {{3}} com cartão. O link é válido durante {{4}} minutos — peça-me um novo se expirar. | Pagar agora |
| es | Termina el pago de {{1}} {{2}} | Abre esta página para pagar {{1}} {{2}} de {{3}} con tarjeta. El enlace dura {{4}} minutos — pídeme otro si caduca. | Pagar ahora |
| ar | أكمل دفع {{1}} {{2}} | افتح هذه الصفحة لدفع {{1}} {{2}} مقابل {{3}} بالبطاقة. الرابط صالح لمدة {{4}} دقيقة — اطلب مني رابطًا جديدًا إذا انتهت صلاحيته. | ادفع الآن |

### `customer_order_payment_failed`

⚠ **NEW — submitted separately from the 188, and not yet approved.** Added 2026-09-16 to close
a silence rather than to add a feature: a declined or unapproved charge previously told the
customer *nothing*, so a failed payment was indistinguishable from a successful one that had
gone quiet. Submit it with the same command as the rest; it reads the WABA first and sends only
the difference.

⚠ **The copy must not say the order is cancelled, because it is not.** The basket survives and
the charge is retryable. It also blames nobody — the usual causes here are an unapproved push
prompt and a timeout, neither of which is a judgement on the customer's money.

- **Situation:** `order.payment_failed`
- **Body params:** `{{1}}`=currency, `{{2}}`=amountFormatted, `{{3}}`=orderNumber
- **Button:** URL → `shop/account/orders/detail/{{orderId}}` — the order page, where the retry
  lives. Deliberately **not** a fresh pay link: at failure time there may be no valid token to
  mint one from, and a button opening a dead payment page is worse than one opening the order.

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Payment did not go through for {{3}} | We could not take the {{1}} {{2}} for {{3}}. Nothing has been charged and your items are still waiting — open the order to try again. | View order |
| fr | Paiement non abouti pour {{3}} | Nous n'avons pas pu encaisser les {{1}} {{2}} pour {{3}}. Rien n'a été débité et vos articles vous attendent toujours — ouvrez la commande pour réessayer. | Voir la commande |
| pt_PT | O pagamento não foi concluído para {{3}} | Não conseguimos cobrar os {{1}} {{2}} de {{3}}. Nada foi debitado e os seus artigos continuam à espera — abra a encomenda para tentar de novo. | Ver encomenda |
| es | El pago no se completó para {{3}} | No pudimos cobrar los {{1}} {{2}} de {{3}}. No se ha cobrado nada y tus artículos siguen esperando — abre el pedido para intentarlo otra vez. | Ver pedido |
| ar | لم يتم الدفع للطلب {{3}} | لم نتمكن من تحصيل {{1}} {{2}} للطلب {{3}}. لم يُخصم أي مبلغ ولا تزال منتجاتك في انتظارك — افتح الطلب لإعادة المحاولة. | عرض الطلب |

### `customer_order_shipped`

- **Situation:** `order.shipped`
- **Body params:** `{{1}}`=orderNumber, `{{2}}`=vendorName, `{{3}}`=trackingNumber
- **Button:** URL → `orders/{{orderId}}/tracking`

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Order {{1}} is on its way | Your order {{1}} has left {{2}} and is on its way to you. Track it any time with {{3}}. | Track delivery |
| fr | Commande {{1}} en route | Votre commande {{1}} a quitté {{2}} et est en route. Suivez-la à tout moment avec {{3}}. | Suivre la livraison |
| pt_PT | Encomenda {{1}} a caminho | A sua encomenda {{1}} saiu de {{2}} e está a caminho. Acompanhe a qualquer momento com {{3}}. | Acompanhar entrega |
| es | Pedido {{1}} en camino | Tu pedido {{1}} salió de {{2}} y está en camino. Síguelo cuando quieras con {{3}}. | Seguir la entrega |
| ar | الطلب {{1}} في الطريق | غادر طلبك {{1}} من {{2}} وهو في طريقه إليك. تتبعه في أي وقت باستخدام {{3}}. | تتبع التوصيل |

### `customer_order_out_for_delivery`

- **Situation:** `order.out_for_delivery`
- **Body params:** `{{1}}`=orderNumber
- **Button:** URL → `orders/{{orderId}}/tracking`

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Out for delivery: {{1}} | Your order {{1}} is out for delivery today. Please make sure someone can receive it. | Track delivery |
| fr | En cours de livraison : {{1}} | Votre commande {{1}} est en cours de livraison aujourd'hui. Assurez-vous que quelqu'un puisse la réceptionner. | Suivre la livraison |
| pt_PT | Em entrega: {{1}} | A sua encomenda {{1}} está em entrega hoje. Garanta que alguém a pode receber. | Acompanhar entrega |
| es | En reparto: {{1}} | Tu pedido {{1}} está en reparto hoy. Asegúrate de que alguien pueda recibirlo. | Seguir la entrega |
| ar | قيد التوصيل: {{1}} | طلبك {{1}} قيد التوصيل اليوم. يرجى التأكد من وجود شخص لاستلامه. | تتبع التوصيل |

### `customer_order_delivered`

- **Situation:** `order.delivered`
- **Body params:** `{{1}}`=orderNumber
- **Button:** URL → `orders/{{orderId}}`

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Delivered: {{1}} | Your order {{1}} has been delivered. If anything is wrong with it, open the order and tell us within the vendor's return window. | View order |
| fr | Livrée : {{1}} | Votre commande {{1}} a été livrée. En cas de problème, ouvrez la commande et signalez-le pendant le délai de retour du vendeur. | Voir la commande |
| pt_PT | Entregue: {{1}} | A sua encomenda {{1}} foi entregue. Se algo estiver errado, abra a encomenda e avise-nos dentro do prazo de devolução do vendedor. | Ver encomenda |
| es | Entregado: {{1}} | Tu pedido {{1}} ha sido entregado. Si algo va mal, abre el pedido y avísanos dentro del plazo de devolución del vendedor. | Ver pedido |
| ar | تم التسليم: {{1}} | تم تسليم طلبك {{1}}. إذا كان هناك أي خطأ، افتح الطلب وأخبرنا خلال فترة الإرجاع الخاصة بالبائع. | عرض الطلب |

### `customer_order_delivery_failed`

- **Situation:** `order.delivery_failed`
- **Body params:** `{{1}}`=orderNumber
- **Button:** URL → `orders/{{orderId}}/tracking`

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Delivery attempt failed: {{1}} | We could not deliver order {{1}} today. We will try again — check the order for the next attempt, or contact us to arrange a better time. | Track delivery |
| fr | Échec de livraison : {{1}} | Nous n'avons pas pu livrer la commande {{1}} aujourd'hui. Nous réessaierons — consultez la commande pour la prochaine tentative ou contactez-nous pour convenir d'un meilleur moment. | Suivre la livraison |
| pt_PT | Tentativa de entrega falhou: {{1}} | Não conseguimos entregar a encomenda {{1}} hoje. Vamos tentar de novo — veja a encomenda para a próxima tentativa ou contacte-nos para combinar melhor horário. | Acompanhar entrega |
| es | Entrega fallida: {{1}} | No pudimos entregar el pedido {{1}} hoy. Lo intentaremos otra vez — revisa el pedido para el próximo intento o contáctanos para acordar mejor hora. | Seguir la entrega |
| ar | فشلت محاولة التوصيل: {{1}} | لم نتمكن من توصيل الطلب {{1}} اليوم. سنحاول مرة أخرى — راجع الطلب لمعرفة المحاولة التالية أو تواصل معنا لتحديد وقت أنسب. | تتبع التوصيل |

### `customer_order_cancelled`

- **Situation:** `order.cancelled`
- **Body params:** `{{1}}`=orderNumber
- **Button:** URL → `orders/{{orderId}}`

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Order {{1}} cancelled | Your order {{1}} has been cancelled. | View order |
| fr | Commande {{1}} annulée | Votre commande {{1}} a été annulée. | Voir la commande |
| pt_PT | Encomenda {{1}} cancelada | A sua encomenda {{1}} foi cancelada. | Ver encomenda |
| es | Pedido {{1}} cancelado | Tu pedido {{1}} ha sido cancelado. | Ver pedido |
| ar | تم إلغاء الطلب {{1}} | تم إلغاء طلبك {{1}}. | عرض الطلب |

### `customer_order_refunded`

- **Situation:** `order.refunded`
- **Body params:** `{{1}}`=currency, `{{2}}`=amountFormatted, `{{3}}`=orderNumber
- **Button:** URL → `orders/{{orderId}}`

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Refunded: {{1}} {{2}} | We have refunded {{1}} {{2}} for order {{3}}. It goes back to the way you paid, and usually appears within a few working days. | View order |
| fr | Remboursé : {{1}} {{2}} | Nous avons remboursé {{1}} {{2}} pour la commande {{3}}. Le montant retourne par votre moyen de paiement et apparaît généralement sous quelques jours ouvrés. | Voir la commande |
| pt_PT | Reembolsado: {{1}} {{2}} | Reembolsámos {{1}} {{2}} pela encomenda {{3}}. Volta pelo mesmo meio de pagamento e costuma aparecer em poucos dias úteis. | Ver encomenda |
| es | Reembolsado: {{1}} {{2}} | Hemos reembolsado {{1}} {{2}} por el pedido {{3}}. Vuelve por tu medio de pago y suele aparecer en unos días hábiles. | Ver pedido |
| ar | تم الاسترداد: {{1}} {{2}} | قمنا برد {{1}} {{2}} مقابل الطلب {{3}}. يعود المبلغ بنفس طريقة الدفع وعادة ما يظهر خلال أيام عمل قليلة. | عرض الطلب |

### `customer_ticket_replied`

- **Situation:** `ticket.replied`
- **Body params:** `{{1}}`=subject
- **Button:** URL → `support/{{ticketId}}`

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | We replied about "{{1}}" | There is a new reply on your support request about "{{1}}". Open it to read the answer. | View request |
| fr | Nous avons répondu à « {{1}} » | Il y a une nouvelle réponse à votre demande d'assistance concernant « {{1}} ». Ouvrez-la pour lire la réponse. | Voir la demande |
| pt_PT | Respondemos sobre "{{1}}" | Há uma nova resposta ao seu pedido de apoio sobre "{{1}}". Abra-o para ler a resposta. | Ver pedido de apoio |
| es | Respondimos sobre "{{1}}" | Hay una nueva respuesta en tu solicitud de soporte sobre "{{1}}". Ábrela para leer la respuesta. | Ver solicitud |
| ar | لقد رددنا بخصوص "{{1}}" | هناك رد جديد على طلب الدعم الخاص بك بخصوص "{{1}}". افتحه لقراءة الرد. | عرض الطلب |

### `customer_ticket_awaiting_customer`

- **Situation:** `ticket.awaiting_customer`
- **Body params:** `{{1}}`=subject
- **Button:** URL → `support/{{ticketId}}`

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | We need something from you: "{{1}}" | We cannot go further with your request about "{{1}}" until you reply. Open it and let us know. | View request |
| fr | Nous avons besoin de vous : « {{1}} » | Nous ne pouvons pas avancer sur votre demande concernant « {{1}} » tant que vous n'avez pas répondu. Ouvrez-la pour nous répondre. | Voir la demande |
| pt_PT | Precisamos de algo de si: "{{1}}" | Não conseguimos avançar com o seu pedido sobre "{{1}}" enquanto não responder. Abra-o e diga-nos. | Ver pedido de apoio |
| es | Necesitamos algo de tu parte: "{{1}}" | No podemos avanzar con tu solicitud sobre "{{1}}" hasta que respondas. Ábrela y cuéntanos. | Ver solicitud |
| ar | نحتاج منك شيئًا: "{{1}}" | لا يمكننا المتابعة في طلبك بخصوص "{{1}}" حتى ترد علينا. افتحه وأخبرنا. | عرض الطلب |

### `customer_ticket_resolved`

- **Situation:** `ticket.resolved`
- **Body params:** `{{1}}`=subject, `{{2}}`=reopenLine
- **Button:** URL → `support/{{ticketId}}`

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | Sorted: "{{1}}" | We have marked your request about "{{1}}" as done. {{2}} | View request |
| fr | Résolu : « {{1}} » | Nous avons marqué votre demande concernant « {{1}} » comme terminée. {{2}} | Voir la demande |
| pt_PT | Resolvido: "{{1}}" | Marcámos o seu pedido sobre "{{1}}" como concluído. {{2}} | Ver pedido de apoio |
| es | Resuelto: "{{1}}" | Hemos marcado tu solicitud sobre "{{1}}" como terminada. {{2}} | Ver solicitud |
| ar | تم الحل: "{{1}}" | لقد وضعنا علامة على طلبك بخصوص "{{1}}" بأنه منتهٍ. {{2}} | عرض الطلب |

---

## Required env

| Var | Purpose |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | Meta Cloud API permanent token |
| `WHATSAPP_PHONE_NUMBER_ID` | Sender phone number ID |
| `WHATSAPP_API_URL` | Optional; defaults to `https://graph.facebook.com/v18.0` |
| `VENDOR_APP_URL` | Deep-link base for the vendor URL buttons (must match the URL base configured in each vendor template) |
| `AGENCY_APP_URL` | Deep-link base for agency notification buttons (agency templates) |
| `AGENT_APP_URL` | Deep-link base for agent notification buttons (agent templates) |
