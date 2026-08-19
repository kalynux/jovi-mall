# Project Setup & Development Guide

> **This document covers LOCAL DEVELOPMENT.** Deploying, migrating and rotating secrets are in
> [`../docs/RUNBOOK.md`](../docs/RUNBOOK.md); the release shape they follow from is
> [`ADR-019`](../docs/ADR-019-RELEASE-SHAPE.md). Two things there are easy to get wrong from here:
> secrets come from the host's own secret store and never from a committed `.env`, and four values
> are **shared with another service under a different variable name**, so rotating one side alone
> breaks the seam silently. `.env.example` names the other side at each such variable.

## 1. Tech Stack Summary

| Layer | Technology | Notes |
| :--- | :--- | :--- |
| **Runtime** | Node.js (Latest LTS) | |
| **Language** | TypeScript | Strict mode enabled |
| **Database** | MongoDB | Mongoose (Schema definition only) or Native Driver |
| **Validation** | Zod | Runtime request validation |
| **Environment** | dotenv | 12-factor app config |

---

## 2. Environment Setup

### Prerequisites
- Node.js >= 18
- MongoDB >= 6.0 (Local or Atlas)
- npm

### Configuration
Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

`.env.example` documents **every** variable `src/` reads — all 254 of them — grouped by
subsystem, each with where the value comes from and what changes in the service when you set
it. A fresh copy runs locally as-is; the only line you must edit is `JWT_SECRET`.

**Minimum to start:**
```env
PORT=8022
NODE_ENV=development
MONGO_URI=mongodb://localhost:27017/jovi_mall   # must be a REPLICA SET — transactions are used throughout
JWT_SECRET=<openssl rand -hex 32>
```

**The environment is validated at boot** (`src/config/env.ts`). It reports every problem in one
pass — a provider named without its credentials, an integer that will not parse, a variable
whose name is no longer read — and refuses to start on the ones it can prove are wrong.
Warnings print and the service continues.

That check exists because almost every optional variable is read by a module config that
silently substitutes its default for a value it cannot parse: before it, a typo in
`COD_DEPOSIT_DEADLINE_DAYS` and a Cloudinary block under the wrong variable names both produced
a clean boot and a misconfigured service.

`npm run test:env` keeps the template honest — it re-derives what `src/` reads and fails if the
template and the code disagree in either direction.

---

## 3. Database Setup

### Local MongoDB
MongoDb is installed

### Migration Strategy
Authentication and initial data seeding is handled by scripts in `/src/scripts`.
We do not use a heavyweight ORM migration tool. Schema changes should be additive or handled via migration scripts.

---

## 4. Local Development Workflow

### Installation
```bash
npm install
```

### Running the Server
```bash
# Development (Watch mode)
npm run dev

# Build & Run
npm run build
npm start
```

### Project Structure (Scaffold)
```
/src
  /api              # Shared express middlewares, routes, utilities
  /config           # Environment variable parsing
  /core             # Base classes (Entity, Repository, AppError)
  /infra            # Database connection, Logger
  /modules          # Bounded Contexts
    /auth
    /catalog
    ...
  /scripts          # Seeding and Maintenance
```

---
