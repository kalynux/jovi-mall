# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start dev server with hot reload (ts-node-dev)
npm run build        # Compile TypeScript → dist/
npm run start        # Run compiled server (production)
npm run lint         # ESLint with zero warnings allowed
npm run aggregate:analytics  # Populate vendor analytics data
```

No test framework is configured in this project.

## Architecture Overview

**jovi-mall-backend** is an Express/TypeScript modular monolith following DDD-influenced layered architecture.

### Layers (top → bottom)
1. **API layer** (`src/api/`) — middleware, route mounting, global error handler
2. **Module layer** (`src/modules/`) — feature modules with controllers, services, repositories, models, validators, routes
3. **Core layer** (`src/core/`) — base repository, error system, storage abstraction, shared types
4. **Infra layer** (`src/infra/`) — Redis factory, DB connection helpers

### Module structure (consistent across all modules)
Each module under `src/modules/<name>/` follows this layout:
- `controllers/` — HTTP handlers using `asyncHandler` wrapper
- `routes/` — Express router definitions, attaches guards and controllers
- `domain/services/` — single-responsibility business logic classes
- `repositories/interfaces/` — repository contracts (`IProductRepository`, etc.)
- `repositories/mongo/` — Mongoose implementations extending `BaseRepository`
- `repositories/mappers/` — domain ↔ persistence object mapping
- `models/` — Mongoose schema definitions
- `validators/` — Zod schemas for request validation
- `dto/` — Data transfer objects

### Dependency injection
No IoC container. Repositories and services are instantiated manually at the top of each controller file, then closed over in static handler methods. Dependencies flow via constructor injection.

```typescript
// Pattern used in every controller file
const productRepository = new ProductRepositoryMongo();
const productDraftService = new ProductDraftService(productRepository, slugService);

export class VendorProductController {
  static createProduct = asyncHandler(async (req, res) => { ... });
}
```

### Error handling
**Never** use `throw new Error()` or `res.status().json({ error: ... })`. ESLint enforces this.
- Use `createAppError(code, statusCode, message?, details?)` from `src/core/errors.ts`
- Pass errors to `next(error)` — the global error handler in `src/api/middlewares/error-handler.middleware.ts` normalises AppError, ZodError, and Mongoose errors into a consistent JSON shape
- Error codes are domain-prefixed string literals defined in `src/core/error-codes.ts` (e.g. `AUTH_INVALID_CREDENTIALS`, `CATALOG_INSUFFICIENT_STOCK`)

### Auth & request context
`requireAuth` middleware (`src/api/middlewares/auth.middleware.ts`) populates `req.auth = { user, role, role_entity }`.
Vendor-scoped queries extract `req.auth!.role_entity._id.toString()` as `vendorId` and pass it to repositories, which enforce scoping at the query level.

### Base repository (`src/core/repositories/base.repository.ts`)
Generic `BaseRepository<TDoc, TDomain>` provides: `findOne`, `findById`, `paginate`, `create`, `softDelete`, `restore`, `hardDelete`. All queries automatically filter `deletedAt: null`. Pass a Mongoose `ClientSession` for transactional operations.

### Storage (`src/core/storage/`)
Factory + Strategy pattern. Active provider is selected via `STORAGE_PROVIDER` env var (`local` | `firebase` | `cloudinary`). Use `getStorageProvider()` singleton — never instantiate providers directly. Interface: `IStorageProvider` in `storage-provider.interface.ts`.

### Payments (`src/modules/payments/`)
Gateway-agnostic orchestrator (`PaymentOrchestratorService`) supports Stripe (cards), NotchPay, and MyCoolPay (mobile money). Each gateway implements `PaymentGateway` interface. Webhook payloads are deduplicated via hash before processing.

### Redis (`src/infra/redis/redis.factory.ts`)
Uses dedicated DB indices (3–10) per feature (email tokens, WhatsApp codes, booking slot locks, download tokens, etc.). Connects lazily.

### Key external integrations
- **Google Calendar** — OAuth 2.0 with encrypted token vault (`src/modules/integrations/calendar/`)
- **WhatsApp** — Meta Cloud API v18.0 (`src/modules/whatsapp/`)
- **Telegram** — Bot notifications and account linking (`src/modules/telegram/`)
- **Email** — SMTP (Nodemailer + Handlebars templates) or console provider (`src/modules/mail/`)

## Critical Files

| Purpose | Path |
|---|---|
| App bootstrap & middleware stack | `src/app.ts` |
| Route mounting | `src/api/index.ts` |
| Error factory & AppError class | `src/core/errors.ts` |
| Error code registry | `src/core/error-codes.ts` |
| Base repository | `src/core/repositories/base.repository.ts` |
| Auth middleware | `src/api/middlewares/auth.middleware.ts` |
| Storage factory/singleton | `src/core/storage/storage.factory.ts` |
| Transaction manager | `src/core/database/transaction.manager.ts` |
