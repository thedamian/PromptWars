import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import OpenAI from "openai";
import QRCode from "qrcode";
import { config } from "./config.js";
import { Game, toPublic } from "./game.js";
import { closeBrowser } from "./judge.js";
import type { ClientMessage, ServerMessage } from "./types.js";

const openai = new OpenAI({ apiKey: config.apiKey });

interface Client {
  socket: WebSocket;
  role: "player" | "arena" | null;
  playerId?: string;
  playerName?: string;
}

const clients = new Set<Client>();
const game = new Game(openai, `http://127.0.0.1:${config.port}`);

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

let qrSvg = "";

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(message: ServerMessage, filter?: (c: Client) => boolean): void {
  const data = JSON.stringify(message);
  for (const c of clients) {
    if (filter && !filter(c)) continue;
    if (c.socket.readyState === WebSocket.OPEN) c.socket.send(data);
  }
}

game.on("state", (round) => broadcast({ type: "state", round }));
game.on("submission", (pub, full) => {
  broadcast({ type: "submission", submission: pub }, (c) => c.role === "arena");
  broadcast({ type: "yourSubmission", submission: pub }, (c) => c.role === "player" && c.playerId === full.playerId);
});

// ---------- HTTP ----------

function safeJoin(base: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath).replace(/\\/g, "/");
  const resolved = path.resolve(base, "." + decoded);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

async function serveFile(res: ServerResponse, file: string, extraHeaders: Record<string, string> = {}): Promise<void> {
  try {
    let target = file;
    const stat = await fs.stat(target);
    if (stat.isDirectory()) target = path.join(target, "index.html");
    await fs.access(target);
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, { "Content-Type": mimeTypes[ext] ?? "application/octet-stream", "Cache-Control": "no-store", ...extraHeaders });
    createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;

  if (p === "/" ) return serveFile(res, path.join(config.publicDir, "index.html"));
  if (p === "/arena" || p === "/arena/") return serveFile(res, path.join(config.publicDir, "arena.html"));
  if (p === "/qr.svg") {
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
    return void res.end(qrSvg);
  }
  if (p === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return void res.end(JSON.stringify(game.publicRound()));
  }
  if (p.startsWith("/sites/")) {
    const file = safeJoin(config.sitesDir, p.slice("/sites".length));
    if (!file) return void (res.writeHead(403), res.end("Forbidden"));
    // Generated sites are untrusted: lock them down with a strict CSP.
    return serveFile(res, file, {
      "Content-Security-Policy":
        "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; media-src https: data:; frame-ancestors 'self'; form-action 'none'; base-uri 'none'",
      "X-Frame-Options": "SAMEORIGIN"
    });
  }
  if (p.startsWith("/screenshots/")) {
    const file = safeJoin(config.screenshotsDir, p.slice("/screenshots".length));
    if (!file) return void (res.writeHead(403), res.end("Forbidden"));
    return serveFile(res, file);
  }
  const file = safeJoin(config.publicDir, p);
  if (!file) return void (res.writeHead(403), res.end("Forbidden"));
  return serveFile(res, file);
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("[http]", err);
    if (!res.headersSent) res.writeHead(500);
    res.end("Server error");
  });
});

// ---------- WebSocket ----------

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket) => {
  const client: Client = { socket, role: null };
  clients.add(client);

  socket.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return send(socket, { type: "error", message: "Invalid message" });
    }
    handleMessage(client, msg);
  });
  socket.on("close", () => clients.delete(client));
  socket.on("error", () => clients.delete(client));
});

function cleanName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const cleaned = name.replace(/[<>"'`\\/]/g, "").replace(/\s+/g, " ").trim().slice(0, config.maxNameLength);
  return cleaned.length > 0 ? cleaned : null;
}

function handleMessage(client: Client, msg: ClientMessage): void {
  switch (msg.type) {
    case "hello": {
      client.role = msg.role;
      if (msg.role === "player") {
        client.playerId = typeof msg.playerId === "string" && /^[a-f0-9-]{8,36}$/i.test(msg.playerId) ? msg.playerId : crypto.randomUUID();
        client.playerName = cleanName(msg.name) ?? undefined;
        send(client.socket, { type: "welcome", playerId: client.playerId, name: client.playerName });
        const mine = game.submissionFor(client.playerId);
        send(client.socket, { type: "state", round: game.publicRound() });
        send(client.socket, { type: "yourSubmission", submission: mine ? toPublic(mine) : null });
      } else {
        send(client.socket, { type: "state", round: game.publicRound() });
      }
      return;
    }
    case "join": {
      const name = cleanName(msg.name);
      if (!name) return send(client.socket, { type: "error", message: "Please enter a name." });
      client.playerName = name;
      if (!client.playerId) client.playerId = crypto.randomUUID();
      send(client.socket, { type: "welcome", playerId: client.playerId, name });
      return;
    }
    case "submit": {
      if (client.role !== "player" || !client.playerId || !client.playerName) {
        return send(client.socket, { type: "error", message: "Enter your name first." });
      }
      if (typeof msg.prompt !== "string") return send(client.socket, { type: "error", message: "Missing prompt." });
      const error = game.submit(client.playerId, client.playerName, msg.prompt);
      if (error) send(client.socket, { type: "error", message: error });
      return;
    }
    default:
      send(client.socket, { type: "error", message: "Unknown message type" });
  }
}

// ---------- Startup ----------

async function main(): Promise<void> {
  await fs.mkdir(config.sitesDir, { recursive: true });
  await fs.mkdir(config.screenshotsDir, { recursive: true });
  // Start each server run clean.
  for (const entry of await fs.readdir(config.sitesDir)) await fs.rm(path.join(config.sitesDir, entry), { recursive: true, force: true });
  for (const entry of await fs.readdir(config.screenshotsDir)) await fs.rm(path.join(config.screenshotsDir, entry), { recursive: true, force: true });

  qrSvg = await QRCode.toString(config.publicUrl, { type: "svg", margin: 1, color: { dark: "#111827", light: "#ffffff" } });

  server.listen(config.port, () => {
    console.log(`Prompt Wars (Fable51) listening on http://localhost:${config.port}`);
    console.log(`  Players: http://localhost:${config.port}/      Arena: http://localhost:${config.port}/arena`);
    console.log(`  Build model: ${config.buildModel}   Judge model: ${config.judgeModel}`);
    game.start();
  });
}

process.on("SIGINT", async () => {
  await closeBrowser();
  process.exit(0);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
