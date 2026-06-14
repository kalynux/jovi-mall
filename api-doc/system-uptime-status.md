## Overview

The dashboard displays **three colored dots** representing the health of each system layer. This provides instant visibility into where an issue is occurring.

| Position | Layer | Responsibility |
|----------|-------|----------------|
| **Left dot** | Frontend | Browser app, UI rendering, user's device |
| **Middle dot** | Backend API | REST/GraphQL endpoints, authentication, business logic |
| **Right dot** | Infrastructure | Database, cache, external services, CDN, storage |

---

## Color Legend

### 🟢 Green — Operational

**Meaning:** The component is fully functional with normal performance.

**Frontend (Left dot):**
- JavaScript is executing correctly
- No client-side errors
- Local storage/indexedDB accessible
- Browser is online
- All assets (CSS, JS, images) loaded successfully

**Backend API (Middle dot):**
- All endpoints return HTTP 200-299
- Average response time < 500ms
- Authentication service working
- No 5xx errors in the last 5 minutes
- Rate limits not exceeded

**Infrastructure (Right dot):**
- Database connections healthy
- Cache (Redis/Memcached) operational
- External API integrations responsive
- File storage accessible
- CDN delivering content
- Queue workers processing jobs

**User action required:** None. Continue using the system normally.

---

### 🟡 Yellow — Degraded

**Meaning:** The component is working but with reduced performance or partial availability.

**Frontend (Left dot):**
- UI loads slowly (> 3s)
- Some features work, others don't
- WebSocket connection unstable (reconnecting)
- Local storage nearly full (> 80%)
- Browser memory usage high
- Third-party scripts failing (analytics, chat)

**Backend API (Middle dot):**
- Response times between 500ms - 3000ms
- Occasional 429 (rate limit) or 503 responses
- 1-5% of requests failing
- Endpoints timing out intermittently
- Authentication service slow

**Infrastructure (Right dot):**
- Database connection pool near capacity (> 80%)
- Replication lag (> 5 seconds)
- Cache hit rate below 70%
- Disk space below 15% free
- Background jobs queued (high backlog)
- External API rate limit approaching

**User action required:** Expect slowness. Try again in a few seconds if an action fails. Avoid bulk operations.

---

### 🔴 Red — Down / Offline

**Meaning:** The component is completely unavailable or critically failing.

**Frontend (Left dot):**
- Browser is offline (no internet connection)
- JavaScript crashed (unhandled exception)
- Critical assets (main.js, vendor.js) failed to load
- Application failed to initialize
- CORS policy blocking all requests
- Browser version unsupported

**Backend API (Middle dot):**
- 100% of requests failing
- Service returning 500, 502, 503, or 504 errors
- Deployment rollback in progress
- Load balancer reporting service down
- Authentication service completely offline
- Certificate expired

**Infrastructure (Right dot):**
- Database connection refused or timeout
- Primary database replica completely down
- Redis cache server offline
- External API returning 5xx consistently
- Storage bucket inaccessible
- Critical infrastructure on fire (literal or figurative)

**User action required:** Stop working and refresh the page. If problem persists for > 2 minutes, contact support. Do not submit important data repeatedly.

---

### 🔵 Blue — Maintenance

**Meaning:** Scheduled maintenance is in progress. The component is intentionally unavailable or read-only.

**Frontend (Left dot):**
- Maintenance mode banner active
- Feature flags disabled certain UI elements
- Read-only mode for specific modules

**Backend API (Middle dot):**
- API returning 503 with "Maintenance" message
- Health check endpoint reports "maintenance"
- Write operations disabled (GET only)
- Authentication service in maintenance

**Infrastructure (Right dot):**
- Database migration running
- Index rebuild in progress
- Backup operation active
- Schema changes being applied
- Cache warmup in progress

**User action required:** Wait. Check announcements for estimated completion time. Avoid making changes during this period.

**Expected duration:** Usually 1-15 minutes for migrations, up to 1 hour for major maintenance.

---

### 🟣 Purple — Deploying / Updating

**Meaning:** A new version is being deployed. Service may be intermittent.

**Frontend (Left dot):**
- New bundle being downloaded
- Service worker installing update
- Pending refresh notification shown
- Hot module replacement active

**Backend API (Middle dot):**
- Canary deployment in progress
- New pods starting up (Kubernetes)
- Rolling update at 50% completion
- Version mismatch between instances

**Infrastructure (Right dot):**
- Database migration running (read-only mode)
- Index creation in background
- Schema version upgrade

**User action required:** Wait 1-2 minutes. Refresh after purple dot disappears. Do not force-refresh repeatedly.

**Expected duration:** 30 seconds to 5 minutes depending on deployment strategy.

---

### 🟠 Copper / Amber — Client-side Issue

**Meaning:** The problem is specific to THIS user's browser/device, not system-wide.

**Frontend (Left dot only — backend and infrastructure remain normal colors):**

| Scenario | Copper Dot Shows For |
|----------|---------------------|
| Outdated cached version | Frontend only |
| Ad blocker active | Frontend only |
| Cookie consent not granted | Frontend only |
| Local storage corrupted | Frontend only |
| Browser extension interfering | Frontend only |
| VPN blocking WebSocket | Frontend only |
| Firewall blocking API domain | Frontend only |

**Backend API (Middle dot):** Remains 🟢 green because other users are unaffected.

**Infrastructure (Right dot):** Remains 🟢 green.

**User action required:** 
- Clear browser cache and cookies
- Disable ad blockers temporarily
- Try incognito/private mode
- Check VPN or firewall settings
- Update browser to latest version

**Troubleshooting guide:** Press F12 → Console tab → Look for red errors. Send screenshot to support.

---

### ⚪ Gray — Unknown / Not Checked

**Meaning:** The status cannot be determined. Health check failed or timed out.

**Frontend (Left dot):**
- Initial load not complete
- JavaScript not yet executed
- Browser in prerendering mode

**Backend API (Middle dot):**
- Health endpoint unreachable (network issue)
- Request timeout (> 10 seconds)
- CORS blocked the request
- DNS resolution failed

**Infrastructure (Right dot):**
- Monitoring agent down
- No response from database health check
- Network partition between checker and target

**User action required:** Refresh the page. If gray persists > 10 seconds, check your internet connection.

---

## Complete Status Matrix

| State | Frontend Dot | API Dot | Infra Dot | What Users See |
|-------|--------------|---------|-----------|----------------|
| **All systems normal** | 🟢 | 🟢 | 🟢 | Everything works |
| **User offline** | 🔴 | ⚪ | ⚪ | "No internet connection" |
| **API deployment** | 🟢 | 🟣 | 🟣 | "Backend updating, 2min" |
| **API slowdown** | 🟢 | 🟡 | 🟢 | "Experiencing slowness" |
| **Database down** | 🟢 | 🟡 | 🔴 | "Cannot load data" |
| **Scheduled maintenance** | 🔵 | 🔵 | 🔵 | "Maintenance until 14:00" |
| **Ad blocker active** | 🟠 | 🟢 | 🟢 | "Disable ad blocker" |
| **Cache issue only** | 🟢 | 🟢 | 🟡 | "Data may be outdated" |

---

## Tooltip Text on Hover

```markdown
Left dot (Frontend):
- 🟢 Green: "Frontend operational — all good"
- 🟡 Yellow: "Frontend degraded — UI may be slow"
- 🔴 Red: "Frontend offline — refresh or check internet"
- 🔵 Blue: "Frontend maintenance — updates in progress"
- 🟣 Purple: "Frontend updating — new version loading"
- 🟠 Copper: "Browser issue — clear cache or disable ad blocker"
- ⚪ Gray: "Frontend status unknown — refresh page"

Middle dot (Backend API):
- 🟢 Green: "API operational — response time < 500ms"
- 🟡 Yellow: "API degraded — response slow or partial failures"
- 🔴 Red: "API down — all requests failing"
- 🔵 Blue: "API maintenance — read-only or offline"
- 🟣 Purple: "API deploying — rolling update in progress"
- ⚪ Gray: "API unreachable — health check timed out"

Right dot (Infrastructure):
- 🟢 Green: "All infrastructure operational"
- 🟡 Yellow: "Infrastructure degraded — DB/cache lag or high load"
- 🔴 Red: "Infrastructure critical — DB down or unreachable"
- 🔵 Blue: "Infrastructure maintenance — migrations running"
- 🟣 Purple: "Infrastructure updating — schema changes"
- ⚪ Gray: "Infrastructure status unknown — check monitoring"
```

---

## User Communication Guidelines

### When to show a message alongside the dots

| Condition | Show message |
|-----------|--------------|
| Any 🔴 red dot | ✅ Yes — immediate banner |
| Any 🟡 yellow dot | ✅ Yes — subtle notification |
| 🔵 blue or 🟣 purple | ✅ Yes — with ETA if known |
| 🟠 copper | ✅ Yes — troubleshooting suggestion |
| All 🟢 green | ❌ No message needed |

---

## Decision Tree for Determining Status

```
Is browser online?
├─ NO  → Frontend = 🔴 Red, API = ⚪ Gray, Infra = ⚪ Gray
└─ YES → Continue

Can JavaScript execute without errors?
├─ NO  → Frontend = 🔴 Red
└─ YES → Continue

Can API health endpoint be reached (< 5s)?
├─ NO  → API = 🔴 Red or ⚪ Gray
└─ YES → Check API response
    ├─ 200-299 & < 500ms → API = 🟢 Green
    ├─ 200-299 & > 500ms → API = 🟡 Yellow
    ├─ 503 with "maintenance" → API = 🔵 Blue
    ├─ 503 with "deploying" → API = 🟣 Purple
    └─ 5xx → API = 🔴 Red

Is database responding?
├─ Healthy → Infra = 🟢 Green
├─ Lag > 5s or pool > 80% → Infra = 🟡 Yellow
├─ Migration running → Infra = 🔵 Blue
└─ Down → Infra = 🔴 Red

Is issue isolated to this browser?
├─ Other users working? → Frontend = 🟠 Copper
└─ All users affected → Keep standard colors
```

---
