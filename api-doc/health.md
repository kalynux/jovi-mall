# Health probes and metrics

**Verified against source on 2026-09-08** — the three probe paths, their exact bodies, the
Redis `up`/`idle`/`down` states and all three `/metrics` gates, against
`jovi-mall/src/api/routes/health.routes.ts`, `src/app.ts:165-171` and
`src/modules/system/metrics/metrics.routes.ts`.

Unauthenticated, mounted on the bare app, and **ahead of the maintenance gate** — a probe that
fails during a maintenance window makes the orchestrator restart the fleet, and telemetry matters
most during an incident.

---

## `GET /api/health` — FROZEN

```json
{ "status": "ok", "timestamp": "2026-08-12T14:03:11.204Z" }
```

Unconditional 200. Touches nothing. **Do not turn this into a readiness check.**

Two services depend on it, and one of them turns a jovi-mall wobble into its own outage:

**1. geo-tracker.** `internal/modules/health/checker/node_checker.go` hits this path
(`NODE_API_HEALTH_PATH`, default `/api/health`) and is registered as a **readiness** checker on
geo-tracker's `/readyz`. Its client (`internal/platform/nodeclient/client.go`) treats **any** status
≥ 300 as an error and never parses the body — only the status code is load-bearing.

The cascade, if readiness moved onto this path:

```
jovi-mall Redis wobbles
  → /api/health 503s
    → geo-tracker /readyz 503s
      → orchestrator pulls geo-tracker out of rotation
        → every live WebSocket tracking session dies
```

…for a fault entirely inside a different service that is itself perfectly healthy. A coupled-failure
amplifier, from a one-line change that would look like a tidy-up in review.

**2. wi-admin.** `admin/src/infra/platform/platform.client.ts` → `pingPlatform()` surfaces the result
on wi-admin's `/health/ready` and `/api/v1/system/health`. Less severe, but a second contract on the
same path.

`npm run test:system` asserts the path and the body keys, so a future edit fails the suite rather
than the fleet.

---

## `GET /api/health/live`

```json
{ "status": "alive", "service": "jovi-mall", "uptimeSeconds": 8213, "timestamp": "…" }
```

Touches nothing, deliberately. A liveness failure means "restart me", and restarting does not fix
somebody else's database — so a dependency has no business failing a liveness probe.

---

## `GET /api/health/ready`

200 when this instance should receive traffic; 503 when it should not.

```jsonc
{ "status": "ready",
  "service": "jovi-mall",
  "degraded": false,          // true when Redis is down but not required
  "maintenance": null,        // "readonly" | "down" while a window is open
  "dependencies": {
    "mongo": { "status": "up", "readyState": "connected", "latencyMs": 3, "required": true },
    "redis": { "entries": [ { "db": 7, "constant": "SLOT_LOCK_DB", "status": "up", "latencyMs": 1 } ],
               "required": false } },
  "timestamp": "…" }
```

### Mongo is required. Redis is not — and the probe must not connect.

Two independent reasons, and the second is decisive:

1. Every Redis consumer in this codebase is feature-scoped and already degrades — email verification
   tokens, WhatsApp codes and idempotency keys, booking slot holds, download tokens, Telegram links.
   With Redis down this process still serves the catalogue, orders, payments and shipments. Failing
   readiness would pull the whole instance out of rotation for a partial capability loss.
2. **Redis connects lazily and never at boot.** A required-Redis probe would *provision* a connection
   this process never made, on DB 0 — an index nothing in this codebase uses — on every probe
   interval. A diagnostics probe that changes the connection topology it claims to measure is a
   probe that lies.

So Redis reports three honest states and contributes `degraded`, never a 503:

| status | means |
|---|---|
| `up` | pinged, latency reported |
| `idle` | no client open in this process — a truthful statement, **not** a failure |
| `down` | an open client failed its ping |

`HEALTH_READY_REQUIRE_REDIS=true` is available for an operator who wants hard coupling; the default
does not silently create a connection.

### geo-tracker is deliberately not a dependency here

Its readiness already depends on this service. Making the reverse true creates a mutual-readiness
deadlock in which a cold start of both never converges. It appears on
[`/system/integrations`](./admin/system.md#get-integrations) as reachability, and nowhere on a probe.

### 200 during maintenance, always

If readiness failed inside a maintenance window the orchestrator would restart the fleet and the
window would become an outage nobody can exit. The mode is reported in the body instead. Draining
traffic is a load-balancer action, not a maintenance-mode side effect.

---

## `GET /metrics` — Prometheus text

Mounted on the **bare app**, outside `/api`, so it carries none of what `/api` carries (no admin
action log, no maintenance gate). Intentional, and worth knowing.

### Three gates

| Gate | Default | Behaviour |
|---|---|---|
| `METRICS_ENABLED` | `true` | Parity with geo-tracker |
| `METRICS_SCRAPE_TOKEN` | unset | **Required in production**, optional otherwise. `X-Metrics-Token` or `Authorization: Bearer` |
| `METRICS_ALLOWED_IPS` | empty | Optional allowlist for a sidecar |

geo-tracker mounts its `/metrics` unauthenticated, and that is right for a service which is not
internet-facing. **This one is** — it serves `/api/public/*` with no auth and is the origin the
storefront calls. What an open `/metrics` hands over, in aggregate: request volumes per route group
(so order rate and payment rate — business intelligence), the complete internal route map, every
integration and worker name with its cadence, error rates with their timing, the Node version, and
the outbox backlog. Individually minor; together a free reconnaissance feed, and the duration
histograms are a timing oracle.

A production deploy that forgot the token serves **nothing** rather than serving openly — fails
closed, exactly like `internalAdminApiEnabled()`.

Deliberately **not** `INTERNAL_ADMIN_SERVICE_TOKEN`: a Prometheus scrape config lives in a monitoring
namespace and is read by more people than a full-privilege credential should be. Deliberately **not**
behind `requireAdminCaller`: that guard requires a valid ObjectId in `X-Actor-Id` and would 400 every
scrape.

**Every rejection returns 404** — disabled, missing token, wrong token, refused IP, all identical, so
the response is never an oracle confirming the endpoint exists or that a guess was close. The
distinction is logged server-side.

### What is exported

`jovimall_`-prefixed, on a **private registry** (never prom-client's global `register`), mirroring
geo-tracker's `internal/platform/metrics/metrics.go`. Includes Node default metrics — **event-loop
lag** is the single most useful Node-specific signal and nothing else here reports it.

The JSON projection of the same registry is at
[`GET /system/metrics`](./admin/system.md#get-metrics), where the label-cardinality rules and the
error-counter coverage caveats are documented.
