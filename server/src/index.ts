// server/src/index.ts
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import express from "express";
import cors from "cors";

import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { ArenaRoom } from "./rooms/ArenaRoom.js";

// ——— Path helpers (ESM) ———
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ——— Env & constants ———
const PROD = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT ?? 2567);
const HOST = process.env.HOST ?? "0.0.0.0";

// If you serve the client from a different domain in prod, set ALLOWED_ORIGIN
// e.g. https://game.example.com
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;

// ——— Express app ———
const app = express();

// Trust reverse proxies (useful when behind Nginx/Caddy)
app.set("trust proxy", true);

// CORS: wide-open in dev; stricter in prod (same-origin or specific allowed origin)
app.use(
  cors({
    origin: (origin, cb) => {
      if (!PROD) return cb(null, true); // dev: allow all for convenience
      if (!origin) return cb(null, true); // same-origin (no Origin header)
      if (!ALLOWED_ORIGIN) return cb(null, true); // fallback: allow if not configured
      return origin === ALLOWED_ORIGIN
        ? cb(null, true)
        : cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

// Health check
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Serve built client if present (after client `vite build` + postbuild copy)
const clientDist = path.resolve(__dirname, "../../client-dist");
const hasClient = existsSync(clientDist);

if (hasClient) {
  app.use(express.static(clientDist));

  // SPA fallback to index.html for client routes
  app.get("/*", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
} else {
  // If no client build exists, keep API/WS only
  app.get("/", (_req, res) =>
    res
      .status(200)
      .type("text/plain")
      .send("Arena server running. Build client to enable static hosting.")
  );
}

// Create a single HTTP server that backs both Express and Colyseus (WS)
const httpServer = http.createServer(app);

// ——— Colyseus game server ———
const gameServer = new Server({
  // Attach WS to the *same* HTTP server (single port)
  transport: new WebSocketTransport({ server: httpServer }),
});

// Define matchmaking rooms
gameServer.define("arena", ArenaRoom);

// ——— Start listening ———
httpServer.listen(PORT, HOST, () => {
  const hostLabel = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(
    `[server] HTTP + WS listening on http://${hostLabel}:${PORT}  ${
      PROD ? "(production)" : "(dev)"
    }`
  );
  console.log(`[server] Colyseus endpoint: ws://${hostLabel}:${PORT}`);
  if (hasClient) {
    console.log(
      `[server] Serving client build from ${path.relative(
        process.cwd(),
        clientDist
      )}`
    );
  } else {
    console.log(`[server] No client build found (server/client-dist missing).`);
  }
});

// ——— Graceful shutdown ———
const shutdown = async (signal: NodeJS.Signals) => {
  try {
    console.log(`[server] Received ${signal}. Shutting down gracefully...`);
    await gameServer.gracefullyShutdown();
  } catch (err) {
    console.error("[server] Error during graceful shutdown:", err);
  } finally {
    httpServer.close(() => process.exit(0));
    // Force-exit if something hangs
    setTimeout(() => process.exit(0), 3000).unref();
  }
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
