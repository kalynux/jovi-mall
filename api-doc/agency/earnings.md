# Agency Earnings

## Base Path

```
/api/agency
```

## Authentication

**Authorization**: Agency access required. Bearer token with `agency` role.

## Endpoints

- [`GET /api/agency/earnings`](#earnings) — this agency's held (pending) vs withdrawable (available) delivery-fee balance

---

## How the delivery-fee balance is built

Every time one of this agency's shipments is part of a customer's **paid physical order**, the
agency's share of that order is computed from its own pricing policy (`policies.pricing`, set via
`PUT /api/agency/onboarding/policies` — see [profile-schema.md](./profile-schema.md)) and held in
escrow immediately, the same way a vendor's net proceeds are held:

- If any item on the shipment is picked up from the **vendor's own address**
  (`pickupLocation.mode: "pickup_based"` in [shipment detail](./shipments.md#detail) terms), the
  agency is credited its `policies.pricing.pickup_based.base_rate_first_kg`, once per shipment.
- If any item on the shipment is already **in the agency's own storage**
  (`pickupLocation.mode: "storage_based"`), the agency is credited
  `policies.pricing.storage_based.local_delivery_fee + policies.pricing.storage_based.pick_pack_fee_per_order`,
  once per shipment.
- A shipment mixing both kinds of items (some collected from the vendor, some already warehoused)
  is credited **both** amounts — real, distinct fulfillment work happens for each.
- An order whose items are split across multiple shipments to the **same** agency has its fees
  summed into a single balance entry for that agency, not one per shipment.

> **Not yet charged (planned, in this order):** per-kg weight surcharges (`additional_per_kg`),
> out-of-region surcharges (`out_of_region_surcharge` / `out_of_region_delivery_fee`), COD handling
> (this platform is prepaid-only — card / mobile money via Stripe, NotchPay, MyCoolPay — no
> cash-on-delivery exists), peak-season surcharges, monthly per-SKU storage rent
> (`monthly_storage_fee_per_sku` — a recurring charge, not tied to a single order), and
> failed-delivery / return-to-origin fees (`failed_delivery_fee`, `rto_fee`). These will be added
> in later phases as the underlying data (item weight, region matching, a failed/returned-shipment
> hook) becomes available. Do not build UI assuming they're already reflected in the balance below.

Funds are **held** (`pending`) the moment the order is paid, and move to **available**
(withdrawable) once the order is completed by the customer and a hold window elapses — the same
escrow model already used for vendor earnings.

---

<a name="earnings"></a>
### GET /api/agency/earnings

**Description**: This agency's current pending (held) and available (withdrawable) delivery-fee
balance.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "pending": 15000,
    "available": 42000,
    "currency": "XAF"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `pending` | `number` | Sum of delivery fees from paid-but-not-yet-completed orders (or still within the hold window). Minor currency units. |
| `available` | `number` | Sum of delivery fees whose hold window has elapsed. Withdrawable — payout flow is handled in a later phase. Minor currency units. |
| `currency` | `string` | Currency code for both balances. |

**Error Responses**:
- `401` – `UNAUTHORIZED` – Missing or invalid auth token.
- `403` – `FORBIDDEN` – Valid token but not an agency.
