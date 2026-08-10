# WhatsApp Templates

This is the source-of-truth for the WhatsApp Business templates used by the
platform — vendor notifications (§1–7), the customer-facing COD delivery
code (§8), the cross-role **billing / plan-lifecycle** templates (§9), and the
**agency** (§10) and **agent** (§11) notification templates. Create each template
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

## Required env

| Var | Purpose |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | Meta Cloud API permanent token |
| `WHATSAPP_PHONE_NUMBER_ID` | Sender phone number ID |
| `WHATSAPP_API_URL` | Optional; defaults to `https://graph.facebook.com/v18.0` |
| `VENDOR_APP_URL` | Deep-link base for the vendor URL buttons (must match the URL base configured in each vendor template) |
| `AGENCY_APP_URL` | Deep-link base for agency notification buttons (agency templates) |
| `AGENT_APP_URL` | Deep-link base for agent notification buttons (agent templates) |
