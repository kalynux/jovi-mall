# Project Setup & Development Guide

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

**Required Variables:**
```env
# Server
PORT=3000
NODE_ENV=development

# Database
MONGO_URI=mongodb://localhost:27017/jovi-mall

# Auth
JWT_SECRET=change_me_to_something_secure_in_prod
```

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
