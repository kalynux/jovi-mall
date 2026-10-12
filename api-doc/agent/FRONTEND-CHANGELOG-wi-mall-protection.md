# Agent app: Wi-Mall Protection, 3 days (2026-10-10)

**Backend built and tested, not deployed yet. The Delivery Partner Agreement 1.2 is already live.**
Shared rule: [../FRONTEND-CHANGELOG-wi-mall-protection.md](../FRONTEND-CHANGELOG-wi-mall-protection.md).

## What changed for the agent

1. **A parcel left at `agent_delivered` is now closed after 3 days, not 7.**
   - Online-paid parcel: it is confirmed for the customer.
   - Cash on delivery parcel with no code entered: the cash is recorded as **collected without a
     code**. The amount lands on the agent's cash balance and **the agent owes it**.
   So an agent who was not paid has 3 days to report a failed delivery.
2. **A customer's problem report pauses the earnings of that order**, the agent's delivery fee
   included, when it is made before the earnings are released (3 days after delivery).
3. **The agent cannot lift that pause.** It ends when the customer or Wi-Mall resolves or closes
   the request.

No request or response shape changed, except one new field.

## New: `holds_earnings` on a ticket

Present on every ticket read (`GET /api/agent/tickets`, `GET /api/agent/tickets/:id`).
`true`: this request keeps the earnings of its order paused.

The agent sees these tickets because every agent on an order follows the requests about it.

⛔ The agent API does **not** return a pause reason. The ticket flag is the signal.

## What to build

1. **Delivery screen, COD parcel at `agent_delivered`:** change "7 days" to "3 days" in the
   warning about the missing code. This is the important one: it is the agent's money.
2. **Delivery screen, online-paid parcel at `agent_delivered`:** "confirmed automatically after
   3 days".
3. **Cash screen and help text:** same change wherever auto-collection is explained.
4. **Ticket list and detail:** an "Earnings on hold" badge and a banner while `holds_earnings`
   is `true`.
5. **Earnings help text:** add the new pause case.

## Copy

| Where | EN | FR |
|---|---|---|
| COD parcel, no code | No code yet. After 3 days this cash counts as collected and you owe it. If the customer did not pay, report a failed delivery now. | Pas encore de code. Après 3 jours, ces espèces comptent comme encaissées et vous en êtes redevable. Si le client n'a pas payé, signalez dès maintenant un échec de livraison. |
| Online parcel | Waiting for the customer to confirm. Confirmed automatically after 3 days. | En attente de la confirmation du client. Confirmation automatique après 3 jours. |
| Badge | Earnings on hold | Revenus suspendus |
| Ticket banner | The customer reported a problem with this order. Your delivery fee for it is on hold until the customer or Wi-Mall closes this request. | Le client a signalé un problème concernant cette commande. Vos frais de livraison correspondants sont suspendus jusqu'à ce que le client ou Wi-Mall clôture cette demande. |
| Earnings help | Earnings can also be paused when a customer reports a problem within 3 days of delivery. Paused time does not count. | Les revenus peuvent aussi être suspendus lorsqu'un client signale un problème dans les 3 jours suivant la livraison. La durée de la suspension n'est pas décomptée. |

## Docs to read

- [cod-cash.md](./cod-cash.md): the auto-collection notes (updated to 3 days)
- [shipments.md](./shipments.md): who sets `delivered` (updated to 3 days)
- [earnings.md](./earnings.md): paused earnings (updated)

## Done when

- No screen says "7 days" about a parcel at `agent_delivered` or about auto-collected cash.
- A ticket with `holds_earnings: true` shows the badge and the banner.
