import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";

import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { ArenaRoom } from "./rooms/ArenaRoom.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());

// Serve the built client (if present)
const clientDist = path.resolve(__dirname, "../../client-dist");
app.use(express.static(clientDist));
app.get(
  "/healthz",
  (_req: any, res: { json: (arg0: { ok: boolean }) => any }) =>
    res.json({ ok: true })
);
app.get("/*path", (_req, res) =>
  res.sendFile(path.join(clientDist, "index.html"))
);

const server = http.createServer(app);

// Attach Colyseus WS transport to the same HTTP server
const gameServer = new Server({
  transport: new WebSocketTransport({ server }),
});

// Define matchmaking room(s)
gameServer.define("arena", ArenaRoom);

const PORT = Number(process.env.PORT || 2567);

server.listen(PORT, () => {
  console.log(`HTTP + WS listening on http://localhost:${PORT}`);
  console.log(`Colyseus endpoint: ws://localhost:${PORT}`);
});
