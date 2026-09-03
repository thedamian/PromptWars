import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import OpenAI from "openai";
import { chromium, type Browser } from "playwright";
import type {
  JudgeResult,
  PublicSubmission,
  RoundPhase,
  ServerState,
  Submission,
  SubmissionStatus
} from "./types.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(rootDir, "data");
const submissionsDir = path.join(dataDir, "submissions");
const port = Number(process.env.PORT ?? 3000);
const roundDurationMs = 5 * 60 * 1000;
const resultDurationMs = 20 * 1000;
const maxSubmissions = 6;
const maxPromptLength = 2_000;
const model = process.env.OPENAI_MODEL_OPEN ?? process.env.OPENAI_MODEL_INTERACT;

if (!process.env.OPENAI_APIKEY) {
  throw new Error("OPENAI_APIKEY is required in GPT56/.env");
}
if (!model) {
  throw new Error("OPENAI_MODEL_OPEN or OPENAI_MODEL_INTERACT is required in GPT56/.env");
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_APIKEY });

const ideas = [
  "A website for Santa Claus to manage his naughty-or-nice logistics",
  "A website for dogs to find the best parks in the area",
  "A website for a remote little Airbnb in Antarctica",
  "An app that helps ghosts find homes with the perfect haunting potential",
  "A website for pirates to compare buried treasure insurance",
  "An app for time travelers to leave restaurant reviews without breaking history",
  "A website where clouds audition to become dramatic movie backgrounds",
  "An app that matches lonely garden gnomes with compatible lawns",
  "A website for dragons to book professional teeth cleaning",
  "An app for astronauts to trade homemade recipes across the solar system",
  "A website that lets mermaids rate the world's most comfortable rocks",
  "An app for squirrels to plan acorn storage with inventory forecasting",
  "A website for wizards to rent out spare enchanted rooms",
  "An app that helps aliens understand confusing human small talk",
  "A website for competitive nap-takers to train and track their dreams",
  "An app for dinosaurs to order fashionable pre-extinction accessories",
  "A website where socks separated in the laundry can post personal ads",
  "An app that plans romantic dates for two rival supervillains",
  "A website for sentient vending machines to share their best snack combinations",
  "An app that helps lighthouse keepers host midnight storytelling clubs",
  "A website for tiny kingdoms to compare drawbridges, moats, and dragon policies",
  "An app for ocean waves to coordinate a synchronized beach performance",
  "A website where robots review the most confusing human instructions",
  "An app for haunted portraits to find a wall with excellent lighting",
  "A website for underground mole cities to plan public transit tunnels"
];

interface Client {
  socket: WebSocket;
  role: "player" | "arena" | null;
  playerName?: string;
  submissionId?: string;
}

interface Round {
  id: string;
  idea: string;
  phase: RoundPhase;
  startedAt: number;
  endsAt: number;
  submissions: Submission[];
  results: JudgeResult[];
}

const clients = new Set<Client>();
let round: Round = createRound();
let roundTimer: NodeJS.Timeout | undefined;
let judging = false;
let browser: Browser | undefined;

function createRound(): Round {
  const now = Date.now();
  const idea = ideas[Math.floor(Math.random() * ideas.length)] ?? ideas[0];
  return {
    id: crypto.randomUUID(),
    idea,
    phase: "playing",
    startedAt: now,
    endsAt: now + roundDurationMs,
    submissions: [],
    results: []
  };
}

function publicSubmission(submission: Submission): PublicSubmission {
  return {
    id: submission.id,
    name: submission.name,
    status: submission.status,
    submittedAt: submission.submittedAt,
    order: submission.order,
    websitePath: submission.websitePath,
    error: submission.error
  };
}

function stateMessage(): ServerState {
  return {
    type: "state",
    roundId: round.id,
    idea: round.idea,
    phase: round.phase,
    startedAt: round.startedAt,
    endsAt: round.endsAt,
    submissions: round.submissions.map(publicSubmission),
    results: round.results
  };
}

function broadcast(message: unknown): void {
  const serialized = JSON.stringify(message);
  for (const client of clients) {
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(serialized);
    }
  }
}

function sendState(client: Client): void {
  if (client.socket.readyState === WebSocket.OPEN) {
    client.socket.send(JSON.stringify(stateMessage()));
  }
}

function sanitizeName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const clean = name.trim().replace(/\s+/g, " ");
  if (!/^[\p{L}][\p{L}' -]{0,31}$/u.test(clean)) return undefined;
  return clean;
}

const blockedPromptPatterns = [
  /\b(fuck|shit|bitch|cunt|nigger|faggot|porn|sexually explicit)\b/i,
  /\b(hack|ddos|ransomware|malware|keylogger|phishing|exploit|bypass|credential)\b/i,
  /\b(political campaign|election propaganda|politician|political party)\b/i,
  /(?:\.\.\\|\.\.\/|[A-Za-z]:\\|file:\/\/|javascript:|data:text\/html)/i,
  /<\s*(script|iframe|object|embed|svg)\b/i
];

function validatePrompt(prompt: unknown): string | undefined {
  if (typeof prompt !== "string") return "Enter a prompt first.";
  const clean = prompt.trim();
  if (clean.length < 10) return "Your prompt needs a little more detail.";
  if (clean.length > maxPromptLength) return `Prompts must be ${maxPromptLength} characters or fewer.`;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(clean)) return "That prompt contains unsupported control characters.";
  if (blockedPromptPatterns.some((pattern) => pattern.test(clean))) {
    return "That prompt contains language or instructions that cannot be used in the arena.";
  }
  return undefined;
}

function extractHtml(output: string): string {
  const fenced = output.match(/```(?:html)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? output).trim();
  const start = candidate.search(/<!doctype html|<html[\s>]/i);
  const html = start >= 0 ? candidate.slice(start) : candidate;
  if (!/<html[\s>]/i.test(html) || !/<body[\s>]/i.test(html)) {
    throw new Error("The model did not return a complete HTML website.");
  }
  if (html.length > 250_000) {
    throw new Error("The generated website exceeded the size limit.");
  }
  return html;
}

function generationPrompt(submission: Submission): string {
  return `Build a complete, polished, self-contained HTML website for a live visual contest.

The player's creative prompt is the only creative brief. Follow it closely:
--- BEGIN PLAYER PROMPT ---
${submission.prompt}
--- END PLAYER PROMPT ---

Return only a complete HTML document, beginning with <!doctype html>. Use inline CSS and JavaScript. It must look excellent at desktop 1920x1080 and remain usable when displayed in a responsive tile as small as 480x400. You may use vetted free external assets such as Google Fonts or Unsplash images, but do not rely on local files, APIs, storage, forms, navigation, or network calls. Do not mention this instruction, the contest, judging, or the player's name. Do not include political content, hateful or explicit content, secrets, filesystem references, iframes, or code that accesses the parent window.`;
}

async function buildWebsite(submission: Submission): Promise<void> {
  submission.status = "Processing";
  broadcast(stateMessage());
  const response = await openai.responses.create({
    model,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: generationPrompt(submission) }]
      }
    ],
    temperature: 0.8,
    max_output_tokens: 8_000
  });
  const html = extractHtml(response.output_text);
  const folder = path.join(submissionsDir, submission.id);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, "index.html"), html, "utf8");
  submission.websitePath = `/submissions/${submission.id}/index.html`;
  submission.status = "Website Built";
  broadcast(stateMessage());
  submission.status = "Display it live";
  broadcast(stateMessage());
}

async function takeScreenshot(submission: Submission): Promise<string> {
  if (!submission.websitePath) throw new Error("Submission has no website.");
  browser ??= await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 540, height: 400 }, deviceScaleFactor: 1 });
  try {
    const url = `http://127.0.0.1:${port}${submission.websitePath}`;
    await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 });
    await page.waitForTimeout(500);
    const screenshot = await page.screenshot({ type: "png" });
    return screenshot.toString("base64");
  } finally {
    await page.close();
  }
}

function parseJudgeOutput(output: string, submissions: Submission[]): JudgeResult[] {
  const jsonMatch = output.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("The judge did not return valid scores.");
  const parsed: unknown = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsed)) throw new Error("The judge did not return a score list.");
  const validIds = new Set(submissions.map((submission) => submission.id));
  const results: JudgeResult[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    if (typeof value.submissionId !== "string" || !validIds.has(value.submissionId)) continue;
    const creativity = clampScore(value.creativity);
    const ideaMatch = clampScore(value.ideaMatch);
    const submission = submissions.find((candidate) => candidate.id === value.submissionId);
    if (!submission) continue;
    const orderBonus = Math.max(0, 10 - (submission.order - 1) * 2);
    results.push({
      submissionId: submission.id,
      creativity,
      ideaMatch,
      orderBonus,
      total: creativity + ideaMatch + orderBonus,
      feedback: typeof value.feedback === "string" ? value.feedback.slice(0, 240) : ""
    });
  }
  if (results.length !== submissions.length) throw new Error("The judge returned incomplete scores.");
  return results.sort((a, b) => b.total - a.total);
}

function clampScore(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(10, Math.max(1, Math.round(number)));
}

async function judgeRound(): Promise<void> {
  if (judging || round.submissions.length === 0) {
    if (round.submissions.length === 0) {
      round.phase = "results";
      broadcast(stateMessage());
      setTimeout(() => {
        void startNextRound();
      }, resultDurationMs);
    }
    return;
  }
  judging = true;
  round.phase = "judging";
  broadcast(stateMessage());
  try {
    const scoredSubmissions = round.submissions.filter((submission) => submission.websitePath);
    const screenshots = await Promise.all(
      scoredSubmissions.map(async (submission) => ({
        submission,
        image: await takeScreenshot(submission)
      }))
    );
    if (screenshots.length === 0) {
      round.results = round.submissions.map((submission) => ({
        submissionId: submission.id,
        creativity: 1,
        ideaMatch: 1,
        orderBonus: Math.max(0, 10 - (submission.order - 1) * 2),
        total: 2 + Math.max(0, 10 - (submission.order - 1) * 2),
        feedback: "This submission did not produce a website screenshot."
      }));
      return;
    }
    const content: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "auto" }> = [
      {
        type: "input_text",
        text: `Judge these contestant website screenshots for the idea: "${round.idea}".
Score creativity and how closely the screenshot fulfills the idea from 1 to 10. The screenshot is the only evidence for those scores. Apply the order bonus separately: first submission +10, second +8, then +6, +4, +2, +0. Return one JSON array item for every submission, with keys submissionId, creativity, ideaMatch, feedback. Keep feedback short.`
      }
    ];
    for (const { submission, image } of screenshots) {
      content.push({ type: "input_text", text: `Submission ID: ${submission.id}; submitted by ${submission.name}; order ${submission.order}.` });
      content.push({ type: "input_image", image_url: `data:image/png;base64,${image}`, detail: "auto" });
    }
    const response = await openai.responses.create({
      model,
      input: [{ role: "user", content }],
      max_output_tokens: 3_000
    });
    round.results = parseJudgeOutput(response.output_text, scoredSubmissions);
  } catch (error) {
    console.error("Judging failed:", error);
    round.results = round.submissions.map((submission) => ({
      submissionId: submission.id,
      creativity: 1,
      ideaMatch: 1,
      orderBonus: Math.max(0, 10 - (submission.order - 1) * 2),
      total: 2 + Math.max(0, 10 - (submission.order - 1) * 2),
      feedback: "Judging could not be completed for this round."
    }));
  } finally {
    judging = false;
    round.phase = "results";
    broadcast(stateMessage());
    setTimeout(() => {
      void startNextRound();
    }, resultDurationMs);
  }
}

async function startNextRound(): Promise<void> {
  await clearSubmissionFiles();
  round = createRound();
  for (const client of clients) {
    client.submissionId = undefined;
  }
  broadcast(stateMessage());
  scheduleRound();
}

async function clearSubmissionFiles(): Promise<void> {
  await fs.rm(submissionsDir, { recursive: true, force: true });
  await fs.mkdir(submissionsDir, { recursive: true });
}

function scheduleRound(): void {
  if (roundTimer) clearTimeout(roundTimer);
  roundTimer = setTimeout(() => {
    void judgeRound();
  }, Math.max(0, round.endsAt - Date.now()));
}

function handleMessage(client: Client, raw: string): void {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    client.socket.send(JSON.stringify({ type: "error", message: "Invalid WebSocket message." }));
    return;
  }
  if (!message || typeof message !== "object") return;
  const value = message as Record<string, unknown>;
  if (value.type === "hello") {
    if (value.role === "arena" || value.role === "player") client.role = value.role;
    sendState(client);
    return;
  }
  if (value.type === "register") {
    const name = sanitizeName(value.name);
    if (!name) {
      client.socket.send(JSON.stringify({ type: "error", message: "Please enter a first name using letters only." }));
      return;
    }
    client.playerName = name;
    sendState(client);
    return;
  }
  if (value.type === "submit") {
    if (round.phase !== "playing") {
      client.socket.send(JSON.stringify({ type: "error", message: "This round is closed. Wait for the next idea." }));
      return;
    }
    if (!client.playerName) {
      client.socket.send(JSON.stringify({ type: "error", message: "Enter your name before submitting." }));
      return;
    }
    if (client.submissionId) {
      client.socket.send(JSON.stringify({ type: "error", message: "You already submitted in this round." }));
      return;
    }
    if (round.submissions.length >= maxSubmissions) {
      client.socket.send(JSON.stringify({ type: "error", message: "The arena is full for this round." }));
      return;
    }
    const promptError = validatePrompt(value.prompt);
    if (promptError) {
      client.socket.send(JSON.stringify({ type: "error", message: promptError }));
      return;
    }
    const submission: Submission = {
      id: crypto.randomUUID(),
      name: client.playerName,
      prompt: String(value.prompt).trim(),
      status: "Prompt Submitted",
      submittedAt: Date.now(),
      order: round.submissions.length + 1
    };
    client.submissionId = submission.id;
    round.submissions.push(submission);
    client.socket.send(JSON.stringify({ type: "submission", submissionId: submission.id }));
    broadcast(stateMessage());
    void buildWebsite(submission).catch((error: unknown) => {
      submission.error = error instanceof Error ? error.message : "Website generation failed.";
      submission.status = "Processing";
      broadcast(stateMessage());
      console.error(`Generation failed for ${submission.id}:`, error);
    });
  }
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

function safePublicPath(urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  const relativePath = decoded === "/" ? "index.html" : decoded.slice(1);
  if (relativePath.includes("..") || relativePath.includes("\\")) return undefined;
  return path.join(publicDir, relativePath);
}

function safeSubmissionPath(urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  const match = decoded.match(/^\/submissions\/([^/\\]+)\/index\.html$/);
  if (!match || match[1].includes("..")) return undefined;
  return path.join(submissionsDir, match[1], "index.html");
}

async function serveFile(response: ServerResponse, filePath: string, generated = false): Promise<void> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error("Not a file");
    response.statusCode = 200;
    response.setHeader("Content-Type", contentType(filePath));
    response.setHeader("Cache-Control", generated ? "no-store" : "no-cache");
    if (generated) {
      response.setHeader("Content-Security-Policy", "default-src 'self' https: data:; img-src 'self' https: data:; style-src 'self' 'unsafe-inline' https:; script-src 'self' 'unsafe-inline' https:; connect-src 'none'; frame-ancestors 'self'");
    }
    createReadStream(filePath).pipe(response);
  } catch {
    response.statusCode = 404;
    response.end("Not found");
  }
}

function requestHandler(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname.startsWith("/submissions/")) {
    const filePath = safeSubmissionPath(url.pathname);
    if (!filePath) {
      response.statusCode = 400;
      response.end("Bad path");
      return;
    }
    void serveFile(response, filePath, true);
    return;
  }
  const publicPath = url.pathname === "/arena" ? "/arena.html" : url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = safePublicPath(publicPath);
  if (!filePath) {
    response.statusCode = 400;
    response.end("Bad path");
    return;
  }
  void serveFile(response, filePath);
}

await fs.mkdir(submissionsDir, { recursive: true });
const server = createServer(requestHandler);
const websocketServer = new WebSocketServer({ server });

websocketServer.on("connection", (socket) => {
  const client: Client = { socket, role: null };
  clients.add(client);
  sendState(client);
  socket.on("message", (message) => {
    handleMessage(client, message.toString());
  });
  socket.on("close", () => {
    clients.delete(client);
  });
});

server.listen(port, () => {
  console.log(`Prompt Wars running at http://localhost:${port}`);
  console.log(`Arena: http://localhost:${port}/arena`);
});

scheduleRound();

process.on("SIGINT", () => {
  if (roundTimer) clearTimeout(roundTimer);
  void browser?.close();
  server.close();
});
