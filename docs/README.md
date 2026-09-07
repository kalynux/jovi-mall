# jovi-mall — service documentation

**Written 2026-09-06 from source** (DOC-PROGRAM Phase 2 · decision E-4). Every number and claim
on these pages was read out of `src/` or `scripts/`, or produced by a runnable check named at the
point it is used — not copied from another document. Where a figure disagreed with an existing
document, the measurement won and the disagreement is filed in
[`../../DOC-PROGRAM/03-FINDINGS.md`](../../DOC-PROGRAM/03-FINDINGS.md).

This folder is the **technical** record of the service. Three other layers exist and none of them
is replaced by it:

| Layer | Where | Answers |
|---|---|---|
| **Wire contract** — what a client sends and receives | [`../api-doc/`](../api-doc/) (174 pages) | *How do I call it?* |
| **Technical record** — how it is built and what must not break | **here** | *How does it work?* |
| **Orientation** — the working guide, 2 500 lines of it | [`../CLAUDE.md`](../CLAUDE.md) | *I am about to edit this. What do I need to know?* |
| **Domain shape** — contexts, actors, lifecycles | [`../ARCHITECTURE.md`](../ARCHITECTURE.md) | *What are the moving parts of the business?* |

⚠ **`CLAUDE.md` is deliberately not absorbed into these pages, and must not be.** It is long
because almost every paragraph records *why* a decision went the way it did, usually with the
failure that forced it. These pages cite it rather than restating it — **a summary keeps the rule
and loses the reason, and the reason is what stops the rule being "tidied" away.**

The value these six pages add is the part that was nowhere: **a topic index**, and **claims
re-verified against source on one day**, with the measurement written down beside each.

---

## The fifteen topics, and where each is answered

| Topic | Here | Deeper |
|---|---|---|
| Architecture | [ARCHITECTURE.md § 1](./ARCHITECTURE.md#1--four-layers-and-the-one-rule-that-holds-them-apart) | `CLAUDE.md` § Architecture Overview |
| Module layout | [ARCHITECTURE.md § 2](./ARCHITECTURE.md#2--forty-four-modules-and-the-shape-every-one-of-them-has) | `CLAUDE.md` § Module structure |
| APIs · endpoints · request/response schemas | [ARCHITECTURE.md § 3](./ARCHITECTURE.md#3--the-route-surface--720-routes) | [`../api-doc/`](../api-doc/) |
| Authentication and authorization | [CONTRACTS.md § 1](./CONTRACTS.md#1--four-doors-and-only-one-of-them-authenticates-a-person) | [`../api-doc/auth/`](../api-doc/auth/), [ADR-A03](./ADR-A03-SESSION-CAP.md) |
| Business rules | [CONSTRAINTS.md](./CONSTRAINTS.md) | `CLAUDE.md` (per domain), [`../ARCHITECTURE.md`](../ARCHITECTURE.md) |
| Database interactions | [DATA.md § 1](./DATA.md#1--mongodb--94-collections) | [`../scripts/migrate.ts`](../scripts/migrate.ts) |
| Redis usage | [DATA.md § 2](./DATA.md#2--redis--eleven-logical-databases-and-a-hard-ceiling) | `src/infra/redis/redis.factory.ts` |
| Events | [CONTRACTS.md § 3](./CONTRACTS.md#3--domain-events--in-process-and-lossy-by-construction) | `src/core/events/event-bus.ts` |
| Webhooks | [CONTRACTS.md § 4](./CONTRACTS.md#4--webhooks--five-inbound-one-outbound) | [`../api-doc/payments/`](../api-doc/payments/), [`../api-doc/whatsapp/`](../api-doc/whatsapp/) |
| Error handling | [CONTRACTS.md § 5](./CONTRACTS.md#5--errors--623-codes-nine-categories-one-boundary) | [`../api-doc/errors/`](../api-doc/errors/), [ADR-016](../../admin/docs/ADR-016-ERROR-SYSTEM.md) |
| Validation rules | [CONTRACTS.md § 6](./CONTRACTS.md#6--validation) | `src/core/validation/` |
| External services | [OPERATIONS.md § 3](./OPERATIONS.md#3--external-services) | [ADR-A04](./ADR-A04-GEOCODING.md) |
| Background jobs | [OPERATIONS.md § 1](./OPERATIONS.md#1--background-work--18-workers) | `src/modules/dev-tools/worker-registry.ts` |
| Configuration / environment | [OPERATIONS.md § 2](./OPERATIONS.md#2--configuration--300-variables) | [`../.env.example`](../.env.example), `npm run test:env` |
| Service-to-service communication | [CONTRACTS.md § 7](./CONTRACTS.md#7--service-to-service) | [`../../CLAUDE.md`](../../CLAUDE.md) § The cross-service contract |
| Implementation constraints | [CONSTRAINTS.md](./CONSTRAINTS.md) | — |

Two topics the brief names are answered **outward** rather than here, and that is the honest
answer for a workspace that already documents them well:

- **Deployment, rollback and secret rotation** → [`../../docs/RUNBOOK.md`](../../docs/RUNBOOK.md)
  and [ADR-019](../../docs/ADR-019-RELEASE-SHAPE.md). They span all three services, so a
  per-service copy would be three copies of one procedure.
- **Cross-service defects and the shared-secret table** → [`../../CLAUDE.md`](../../CLAUDE.md).
  Both halves have to be read together or not at all.

## Decision records

Kept where they are and linked, never absorbed (E-4):

| ADR | Decides |
|---|---|
| [ADR-A01](./ADR-A01-UPLOAD-DOWNLOAD-MAP.md) | who can download whose uploads, and what gets scanned |
| [ADR-A02](./ADR-A02-ACCOUNT-CLOSURE.md) | "delete my account" means **anonymise-and-retain** |
| [ADR-A03](./ADR-A03-SESSION-CAP.md) | a bearer session gets a 90-day absolute cap |
| [ADR-A04](./ADR-A04-GEOCODING.md) | cache the geocoding, then rent it |
| [ADR-A05](./ADR-A05-BARGAIN.md) | the bargain window stays configuration-only |
| [ADR-A06](./ADR-A06-AGENT-IDENTITY-DISCLOSURE.md) | a customer may see who is carrying their parcel, **while** they are carrying it |

Four more that govern this service live in wi-admin's folder, because that is where the decision
was taken: [ADR-014](../../admin/docs/ADR-014-SYSTEM-OPERATIONS.md) (the operations surface and
the frozen `/api/health`), [ADR-016](../../admin/docs/ADR-016-ERROR-SYSTEM.md) (the shared error
system), [ADR-018](../../admin/docs/ADR-018-DASHBOARD-BACKEND-REQUESTS.md) and
[ADR-020](../../admin/docs/ADR-020-ADMIN-DATA-DOOR.md).

---

## The one-paragraph version

jovi-mall is an Express/TypeScript **modular monolith** and the platform's **source of truth for
every user, order, shipment, payment and cash movement**. Forty-four modules share one MongoDB
database (94 collections) and one Redis (eleven logical databases out of a budget of eleven). It
serves 720 HTTP routes across six audiences — customer, vendor, agency, agent, the public
storefront, and two *service* callers that hold no user row at all: **wi-admin** on
`/api/internal/admin/*` and **geo-tracker** on `/api/internal/agents/*`,
`/api/internal/shipments/*` and `/api/tracking/*`. It owns **tracking policy** and delegates
**tracking mechanics** to geo-tracker, which asks it for every authorization verdict; the reverse
channel is an outbox whose rows commit inside the transaction that produced them. Nothing here is
allowed to depend on geo-tracker being up: **deliveries work when geo-tracker is down, and they
must keep working.**
