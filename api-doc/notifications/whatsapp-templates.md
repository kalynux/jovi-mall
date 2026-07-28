# WhatsApp Templates

This is the source-of-truth for the WhatsApp Business templates used by the
platform — vendor notifications (§1–7), the customer-facing COD delivery
code (§8), and the cross-role **billing / plan-lifecycle** templates (§9). Create
each template in **WhatsApp Business Manager → Message Templates** exactly as
specified, in **all 5 languages**. Until a template is approved, out-of-24h-window
sends for that event will fail — for role notifications the failure is recorded on
the notification's `deliveryErrors` (never breaking the flow: in-app, push, email
and Telegram still deliver); for the COD code it is logged and the code simply
stays available in the customer's own order view (see
[customer/orders.md](../customer/orders.md#cod)).

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

- **Body params:** `{{1}}`=booking number, `{{2}}`=service name, `{{3}}`=start date/time
- **Button:** URL → `bookings/{{bookingId}}`

| Lang | Header | Body | Button label |
|---|---|---|---|
| en | New booking | New booking #{{1}} for {{2}} scheduled on {{3}}. | View booking |
| fr | Nouvelle réservation | Nouvelle réservation n°{{1}} pour {{2}} prévue le {{3}}. | Voir la réservation |
| pt_PT | Nova reserva | Nova reserva nº{{1}} para {{2}} agendada para {{3}}. | Ver reserva |
| es | Nueva reserva | Nueva reserva n.º{{1}} para {{2}} programada para el {{3}}. | Ver reserva |
| ar | حجز جديد | حجز جديد رقم {{1}} لـ {{2}} مقرر في {{3}}. | عرض الحجز |

## 4. `vendor_booking_cancelled`

- **Body params:** `{{1}}`=booking number
- **Button:** URL → `bookings/{{bookingId}}`

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

## Required env

| Var | Purpose |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | Meta Cloud API permanent token |
| `WHATSAPP_PHONE_NUMBER_ID` | Sender phone number ID |
| `WHATSAPP_API_URL` | Optional; defaults to `https://graph.facebook.com/v18.0` |
| `VENDOR_APP_URL` | Deep-link base for the vendor URL buttons (must match the URL base configured in each vendor template) |
| `AGENCY_APP_URL` | Deep-link base for agency notification buttons (agency templates) |
| `AGENT_APP_URL` | Deep-link base for agent notification buttons (agent templates) |
