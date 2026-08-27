# n8n customer agent — design

The WhatsApp and Telegram customer bot: what it can do, how a customer asks for it, and what the backend must grow to support it.

**Status: design, 2026-08-24. GAP-001 and GAP-005 are BUILT (2026-08-25)** — the bot surface is live at `/api/internal/bot/*` and the 42 tools it carries are now `status: "available"` in the catalogue. Everything else here is still design: no n8n workflow was built, and no endpoint was invented — every `status: "available"` tool was verified against the route table and the api-doc page it cites. What remains is marked `gap` and specified.

---

## The documents

| File | What it is | Read it when |
|---|---|---|
| **[ARCHITECTURE.md](./ARCHITECTURE.md)** | The pipeline, the identity model, context, flows, security, and what is deliberately not built | **Start here.** Everything else assumes it |
| **[COMMAND-SPECIFICATION.md](./COMMAND-SPECIFICATION.md)** | All 34 commands: syntax, arguments, tools, errors, confirmation, per-platform behaviour, examples | Building the parser, or writing customer-facing copy |
| **[BACKEND-GAPS.md](./BACKEND-GAPS.md)** | The 12 gaps, specified — routes, bodies, error codes, build order | Planning the backend work |
| **[bot-surface.md](./bot-surface.md)** | **The built contract** for `/api/internal/bot/*` — authentication, the identity envelope, all 44 routes, idempotency, the address flow, registration and onboarding (§ 11), **the channel-ready `reply` body you POST unmodified (§ 14)**, and every deviation from the catalogue | Calling the surface, or extending it |
| **[TELEGRAM-ONBOARDING-WALKTHROUGH.md](./TELEGRAM-ONBOARDING-WALKTHROUGH.md)** | ⭐ **Start here when wiring n8n.** One new Telegram customer, turn by turn: the inbound update, the exact request, the **real** response captured from a live server, and the `sendMessage` that follows. Plus the complete error decision table. ⚠ **Read its 2026-08-26 update box first** — the backend now composes those `sendMessage` bodies, and three instructions on the page are obsolete | Building the workflow |
| **[RECOMMENDATIONS.md](./RECOMMENDATIONS.md)** | What changed from the original proposal, the risks, and the 7 decisions still owed | Deciding whether to proceed, and in what order |

## The machine-readable set

| File | Purpose |
|---|---|
| **[tools/catalog.json](./tools/catalog.json)** | **60 tools.** The foundation for the MCP configuration. Every tool carries its parameters as one JSON Schema, its wire mapping, its errors, its risk, its confirmation rule and its context policy |
| **[tools/tool.schema.json](./tools/tool.schema.json)** | The JSON Schema the catalogue validates against. `ajv validate -s tool.schema.json -d catalog.json` |
| **[tools/commands.json](./tools/commands.json)** | The parser table: canonical names, aliases, arguments, and which tools each command reaches |
| **[tools/errors.json](./tools/errors.json)** | Every backend failure mapped to one of nine customer actions, plus the copy rules |

Four files rather than one because they have different owners and different change rates. The catalogue moves when the backend does; the command registry moves when the product does; the error map moves when either does; the schema barely moves at all. One file would make every change touch everything.

---

## The five things worth knowing before reading anything else

**1 · The bot bridge exists, and the customer surface exists now too.** `POST /api/webhooks/{whatsapp,telegram}` dispatches four CommandBus commands — `connect`, `login`, `login_contact`, `reset_password` — and every one of them mints a credential for a **human to redeem in a browser**. **GAP-001 closed the gap beside them**: `/api/internal/bot/*` carries 42 named operations the automation layer performs on a customer's behalf. See [bot-surface.md](./bot-surface.md). ✅ **GAP-002 closed 2026-08-26** — a new customer now has a route in: `POST /identity/sync` on every message creates the account, and `POST /identity/onboarding` collects the profile. Turn-by-turn wire trace: [TELEGRAM-ONBOARDING-WALKTHROUGH.md](./TELEGRAM-ONBOARDING-WALKTHROUGH.md). ✅ **GAP-004 closed 2026-08-26** — `POST /support/context` walks the support-routing ladder server-side, so the flow no longer composes it from three calls (see [bot-surface.md § 12](./bot-surface.md#12--support-routing-gap-004)). ✅ **GAP-003 closed the same day** — `GET /api/public/variants/by-sku/:sku` resolves a printed product code, which `?q=` structurally could not (see [../public/catalog.md](../public/catalog.md#get-apipublicvariantsby-skusku)). **Every tool in the catalogue is now `status: available`.**

**2 · No customer token ever leaves the backend.** The bot surface carries the *messaging identity* and the backend resolves the customer from it, by the same ladder `/login` already uses. A compromised automation layer cannot mint or hold a customer session. `customerId` is never a tool parameter, anywhere — the same rule `/connect` already enforces, and the reason the old `link` command was deleted.

**3 · Money and destructive actions are not in the model's tool list.** 23 of 60 tools are `flow_only`: called by deterministic flow steps, never registered with the model. Prompt injection through a product title cannot reach a tool that does not exist for it.

**4 · Registration is not built, and nothing else works without it.** The docs say customers are created on first bot contact "landing with the n8n integration". Nothing implements it, and the storefront deliberately has no registration form — so a new customer currently has no route in from either direction. **GAP-002**.

**5 · Checkout completes in chat for mobile money.** `POST /api/payments/initiate` and `/verify` take no authentication, deliberately, because a payment reference is shareable. Cards need a browser and hand off.

---

## The three live commands

`/login`, `/reset-password` and `/connect` are **in production** and mapped in n8n. Nothing in this design changes their behaviour, their payloads or their mappings.

Their existing contract is [`../auth/N8N-HANDOFF.md`](../auth/N8N-HANDOFF.md) — seven items, still current, still the operative document for them. This design extends that handoff; it does not replace it.

⚠ **If `/connect` stops working after a change here, something shared broke.** It is the canary for the webhook secret and the CommandBus registration.

---

## Related

- [../auth/N8N-HANDOFF.md](../auth/N8N-HANDOFF.md) — the live seven-item handoff
- [../auth/customer-auth.md](../auth/customer-auth.md) — how customers register and sign in
- [../auth/magic-login.md](../auth/magic-login.md) — `/login` and `/reset-password`, endpoint level
- [../connections/README.md](../connections/README.md) — `/connect`
- [../whatsapp/README.md](../whatsapp/README.md) · [../telegram/README.md](../telegram/README.md) — the bot bridges
- [../README.md](../README.md) — the API index
