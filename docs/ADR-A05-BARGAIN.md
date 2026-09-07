# ADR-A05 — The bargain window stays configuration-only

**Date:** 2026-08-18 (evidence gathered 2026-08-17)
**Status:** Accepted — decided. **No implementation follows.**
**Scope:** jovi-mall
**Answers:** [Q-4](../../PRODUCTION-READINESS/11-DECISIONS-REGISTER.md#q-4--is-the-bargain-range-buyer-facing-or-a-vendor-side-floor)
of the Phase D register

---

## Context

`bargain: { minPrice, maxPrice }` is fully built, validated, tested and persisted, and is
**deliberately not published**:

- The invariant is `minPrice === price`, always — which is what makes it a *window* rather than a
  second price field. Nothing downstream reads it; cart, orders, earnings, COD and shipments all
  still read `price` alone, and `test:bargain-price` (~145 DB-free assertions) source-scans to
  prove it.
- Every write path funnels through `resolveBargainWrite`; `bargainable` is derived from
  `Product.vectorisationEnabled` and reported on the read model.
- There is no offer/counter-offer flow, and no path by which a bargained price reaches a cart or
  an order.

Q-4 asked which product the window is for: a **buyer-visible range** (a haggling UI) or a
**vendor-side floor** (an automated-acceptance rule). They are different products, and the code
for either cannot be written until it is chosen.

---

## D-1 · Decision

**Neither, for now. The window remains configuration-only and no negotiation product is planned.**

A vendor may configure a range; it is validated, persisted and never acted on. That is the state
today and it is now a decision rather than a gap.

**Why this is a legitimate answer rather than a deferral.** The window costs nothing to keep: it
is inert by construction — the source scan proving no money path mentions it is the guarantee —
and its ~145 assertions keep it that way. What it buys is that the *data* is already being
collected, correctly and with a validated shape, for the day a negotiation product is designed.
Deleting it would throw away that shape and the vendor configuration behind it; building a
product to justify it would be the tail wagging the dog.

**What it costs, stated plainly:** ~145 assertions and one Zod fragment on four schemas continue
to guard a feature nothing uses, and every author touching variant pricing has to understand a
rule that never fires. That is the accepted price.

## D-2 · The two doors that must stay shut

Both are one-way, and neither may be opened incidentally by a change that thinks it is doing
something else.

1. **`bargain` stays out of every public DTO.** The public catalog DTOs are the storefront's
   security boundary and are asserted leak-free by `test:public-catalog`. Publishing a floor is
   not reversible in the way a code change is: a buyer who has seen a minimum will not offer
   above it, ever again.
2. **No path carries a bargained price into a cart, an order, an earnings split or a COD
   collection.** The source scan in `test:bargain-price` enforces this; treat a failure there as a
   product decision being made by accident.

✅ **Resolved 2026-08-19 (Phase 4.A.6.2, [D-1](../../PRODUCTION-READINESS/PHASE-4-HARDENING-PLAN.md#d-1)):
`VariantPricingService` is deleted.** It was dead (barrel-only) and wrote `price` with no
`minPrice` sync; its own header said it must call `resolveBargainWrite` before it was ever wired
up. A dead service that documents the invariant it would break is a loaded gun — the header's
warning does not survive a copy-paste. The barrel now carries a comment naming
`resolveBargainWrite` and the three live write paths in its place, so the next author who needs
variant pricing writes it correctly from the start. Git history is the archive.

---

## Consequences

- **Phase 6.F closes as "not planned"** rather than remaining a gated backlog item. It should
  come off the backlog, not sit on it waiting for a decision that has now been taken.
- If the question is reopened, the vendor-side floor is the cheaper of the two by an order of
  magnitude — one endpoint that accepts inside `[minPrice, maxPrice]` and rejects outside, with
  no chat, no counters, no notifications and no change to the public DTO — and a haggling UI
  built later still needs that rule underneath it. That is the sequence to use; it is recorded
  here so it does not have to be re-derived.
- `api-doc/vendor/variants.md#bargainable-pricing` should state that the window is configuration
  only and that no negotiation surface is planned, so a dashboard author does not build a
  haggling screen against a field that will never be honoured.
