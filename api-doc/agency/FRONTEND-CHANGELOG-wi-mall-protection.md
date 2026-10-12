# Agency dashboard: Wi-Mall Protection, 3 days (2026-10-10)

**Backend built and tested, not deployed yet. The Delivery Partner Agreement 1.2 is already live.**
Shared rule: [../FRONTEND-CHANGELOG-wi-mall-protection.md](../FRONTEND-CHANGELOG-wi-mall-protection.md).

## What changed for the agency

1. **A parcel left at `agent_delivered` is now closed after 3 days, not 7.**
   - Online-paid parcel: it is confirmed for the customer.
   - Cash on delivery parcel with no code entered: the cash is recorded as **collected without a
     code**, and the agent owes it.
   So a failed delivery must be reported within 3 days.
2. **A customer's problem report pauses the earnings of that order**, the agency's delivery fee
   included, when it is made before the earnings are released (3 days after delivery).
3. **The agency cannot lift that pause.** It ends when the customer or Wi-Mall resolves or closes
   the request.

No request or response shape changed, except one new field.

## New: `holds_earnings` on a ticket

Present on every ticket read (`GET /api/agency/tickets`, `GET /api/agency/tickets/:id`).
`true`: this request keeps the earnings of its order paused.

The agency sees these tickets because every agency on an order follows the requests about it.

⛔ The agency API does **not** return a pause reason. The ticket flag is the signal.

## What to build

1. **Shipments:** wherever the app explains what happens to a parcel left at `agent_delivered`,
   change "7 days" to "3 days". On a COD parcel at `agent_delivered` with no code, show the
   warning below.
2. **Ticket list and detail:** an "Earnings on hold" badge and a banner while `holds_earnings`
   is `true`.
3. **Earnings help text:** add the new pause case.

## Copy

| Where | EN | FR |
|---|---|---|
| COD parcel at `agent_delivered` | No delivery code yet. After 3 days the cash is recorded as collected and the agent owes it. If the customer did not pay, report a failed delivery now. | Pas encore de code de livraison. Après 3 jours, les espèces sont enregistrées comme encaissées et le livreur en est redevable. Si le client n'a pas payé, signalez dès maintenant un échec de livraison. |
| Online parcel at `agent_delivered` | Waiting for the customer to confirm. Confirmed automatically after 3 days. | En attente de la confirmation du client. Confirmation automatique après 3 jours. |
| Badge | Earnings on hold | Revenus suspendus |
| Ticket banner | The customer reported a problem with this order. The earnings for it, your delivery fee included, are on hold until the customer or Wi-Mall closes this request. | Le client a signalé un problème concernant cette commande. Les revenus correspondants, y compris vos frais de livraison, sont suspendus jusqu'à ce que le client ou Wi-Mall clôture cette demande. |
| Earnings help | Earnings can also be paused when a customer reports a problem within 3 days of delivery. Paused time does not count. | Les revenus peuvent aussi être suspendus lorsqu'un client signale un problème dans les 3 jours suivant la livraison. La durée de la suspension n'est pas décomptée. |

## Docs to read

- [shipments.md](./shipments.md): the `delivered` row of the status table and § COD (updated to 3 days)
- [earnings.md](./earnings.md): the hold and paused earnings paragraph (updated)
- [tickets.md](./tickets.md)

## Done when

- No screen says "7 days" about a parcel at `agent_delivered`.
- A ticket with `holds_earnings: true` shows the badge and the banner.
