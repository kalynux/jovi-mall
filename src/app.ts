import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { requestIdMiddleware } from './api/middlewares/request-id.middleware';
import { errorHandlerMiddleware } from './api/middlewares/error-handler.middleware';
import { ERROR_CODES } from './core/error-codes';
import { createAppError } from './core/errors';

const app = express();

// ─── Request Correlation ID (must be first) ───────────────────────────────────
app.use(requestIdMiddleware);

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "'unsafe-inline'"], // Allow inline scripts for development
      "script-src-attr": ["'unsafe-inline'"], // Allow inline event handlers for development
    },
  },
}));

// CORS configuration for session authentication (cookies)
app.use(cors({
  origin: true, // Allow any origin in development (or specify your frontend URL)
  credentials: true, // Required for cookies
}));

app.use(express.json());
app.use(cookieParser()); // Required for session authentication

// Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve test page from same origin (for testing session auth)
app.get('/test-auth', (req, res) => {
  res.send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Login & Connect Google Calendar</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        padding: 40px;
        max-width: 500px;
        margin: auto;
      }
      input,
      select,
      button {
        width: 100%;
        padding: 10px;
        margin-top: 10px;
        font-size: 16px;
      }
      button {
        cursor: pointer;
      }
      #connect {
        display: none;
        margin-top: 30px;
      }
      .error {
        color: red;
        margin-top: 10px;
      }
      .success {
        color: green;
        margin-top: 10px;
      }
    </style>
  </head>
  <body>
    <h2>User Login (Session Cookie)</h2>

    <input
      id="identifier"
      type="text"
      placeholder="Email or Phone"
      value="vendor@example.com"
    />
    <input
      id="password"
      type="password"
      placeholder="Password"
      value="password123"
    />

    <select id="role">
      <option value="vendor">Vendor</option>
      <option value="customer">Customer</option>
      <option value="agency">Agency</option>
      <option value="agent">Agent</option>
      <option value="admin">Admin</option>
    </select>

    <button onclick="login()">Login with Session Cookie</button>

    <div id="message"></div>

    <div id="connect">
      <h2>Google Calendar</h2>
      <button onclick="connectGoogle()">Connect Google Calendar</button>
    </div>

    <script>
      async function login() {
        const identifier = document.getElementById("identifier").value;
        const password = document.getElementById("password").value;
        const role = document.getElementById("role").value;

        console.log({ identifier, password, role });

        try {
          const res = await fetch("/api/auth/browser/login", {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ identifier, password, role }),
          });

          console.log("Response status:", res.status);
          const data = await res.json();
          console.log("Response data:", data);

          if (!res.ok) {
            document.getElementById("message").innerHTML =
              '<div class="error">Login failed: ' +
              (data.error || data.message || "Unknown error") +
              "</div>";
            return;
          }

          document.getElementById("message").innerHTML =
            '<div class="success">Login successful! Session cookie set.</div>';
          document.getElementById("connect").style.display = "block";
        } catch (error) {
          console.error("Login error:", error);
          document.getElementById("message").innerHTML =
            '<div class="error">Login error: ' + error.message + "</div>";
        }
      }

      function connectGoogle() {
        // Direct navigation - browser will automatically send cookies
        window.location.href = '/api/integrations/google/connect';
      }
    </script>
  </body>
</html>`);
});

import { apiRouter } from './api';
app.use('/api', apiRouter);

// ─── 404 Handler (unmatched routes) ──────────────────────────────────────────
app.use((_req: Request, _res: Response, next: NextFunction) => {
  next(createAppError(ERROR_CODES.NOT_FOUND, 404, 'Route not found'));
});

// ─── Global Error Handler (must be last) ─────────────────────────────────────
app.use(errorHandlerMiddleware);

export { app };
