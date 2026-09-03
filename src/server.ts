import dotenv from "dotenv";
dotenv.config();

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import express from "express";
import OpenAI from "openai";
import QRCode from "qrcode";
import { chromium } from "playwright";
import { Server } from "socket.io";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const publicDir = path.join(repoRoot, "public");
const generatedDir = path.join(repoRoot, "generated-sites");
const screenshotsDir = path.join(repoRoot, "screenshots");
const port = Number(process.env.PORT ?? 3000);
const siteBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const challengeIdeas = [
  "A website for Santa Claus to manage his naughty-or-nice dashboard.",
  "A website for dogs to find the best parks in the area.",
  "A website for a remote little Airbnb in Antarctica.",
  "A website for cosmic librarians cataloging star migrations.",
  "A site for haunted house owners to track ghostly guests.",
  "A website for tiny dragons to compare fireproof rooftops.",
  "A website for mushroom farmers selling mood lighting.",
  "A site for an underwater city to coordinate jellyfish taxis.",
  "A website for sentient vending machines to lobby for tastier snacks.",
  "A website for time-traveling bakers timing the perfect cronuts.",
  "A website for a moon colony that rents telescopes.",
  "A website for penguins to book ice-cold luxury hotels.",
  "A website for cloud pirates planning weather raids.",
  "A website for retired astronauts to matchmake stargazing tours.",
  "A website for a village of squirrels to choose the best acorn stock.",
  "A site for a bakery run by tiny robots that only make palm-sized buns.",
  "A website for mermaids to book moonlit coral spa days.",
  "A website for giant owls to track the best rooftop night markets.",
  "A site for a secret volcano resort with warm hot springs.",
  "A website for sleepy gnomes organizing midnight tea parties.",
  "A website for a floating city of jellyfish chefs.",
  "A site for alien librarians organizing planets by mood.",
  "A website for a festival of tiny dragons in the desert.",
  "A website for rain cloud farmers predicting perfect thunder.",
  "A website for moonlit vending machines selling dreams.",
  "A website for sleepy hedgehogs building the world’s cutest smart home.",
  "A website for a hidden moon cave cafe serving comet espresso.",
  "A website for subterranean bees running a glowing honey economy."
];

type SubmissionStatus =
  | "prompt-submitted"
  | "processing"
  | "website-built"
  | "display-it-live"
  | "rejected";

interface Score {
  creativity: number;
  correctness: number;
  timeliness: number;
  total: number;
  summary: string;
}

interface Submission {
  id: string;
  playerName: string;
  prompt: string;
  idea: string;
  createdAt: number;
  sitePath: string | null;
  status: SubmissionStatus;
  score: Score | null;
  rejectedReason?: string;
}

let currentChallengeIndex = 0;
let challengeStartedAt = Date.now();
let challengeEndsAt = challengeStartedAt + FIVE_MINUTES_MS;
let roundLock = false;
const submissions: Submission[] = [];

function getCurrentChallenge(): string {
  return challengeIdeas[currentChallengeIndex] ?? challengeIdeas[0];
}

function getCurrentState() {
  return {
    currentChallenge: getCurrentChallenge(),
    challengeIndex: currentChallengeIndex,
    challengeStartedAt,
    challengeEndsAt,
    remainingMs: Math.max(0, challengeEndsAt - Date.now()),
    submissions: submissions
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((submission) => ({
        id: submission.id,
        playerName: submission.playerName,
        prompt: submission.prompt,
        idea: submission.idea,
        createdAt: submission.createdAt,
        sitePath: submission.sitePath,
        status: submission.status,
        score: submission.score,
        rejectedReason: submission.rejectedReason ?? null
      }))
  };
}

function emitState() {
  io.emit("state", getCurrentState());
}

function sanitizeText(value: string, fallback = "Player"): string {
  const cleaned = value.trim().replace(/\s+/g, " ");
  return cleaned.length > 0 ? cleaned.slice(0, 40) : fallback;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getChallengeKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .filter((word) => !["with", "that", "this", "site", "website", "for", "into", "from", "have", "will", "about"].includes(word));
}

function calculateOverlapIndex(a: string, b: string): number {
  const wordsA = new Set(getChallengeKeywords(a));
  const wordsB = new Set(getChallengeKeywords(b));
  const overlap = [...wordsA].filter((word) => wordsB.has(word)).length;
  return overlap / Math.max(wordsA.size, 1, wordsB.size);
}

const profanityList = [
  "damn",
  "hell",
  "shit",
  "crap",
  "bitch",
  "asshole",
  "fuck",
  "nude",
  "porn",
  "sex",
  "kill",
  "murder",
  "bomb",
  "weapon",
  "attack"
];

const unsafePatterns = [
  "<script",
  "</script>",
  "javascript:",
  "onerror",
  "onload",
  "eval(",
  "document.cookie",
  "window.open",
  "fetch(\"http",
  "axios",
  "curl ",
  "wget ",
  "base64",
  "rm -rf",
  "drop table",
  "select * from",
  "<iframe",
  "<object",
  "<embed",
  "file://",
  "../",
  "..\\",
  "child_process",
  "require(\"fs\")",
  "fs.readfile"
];

async function checkSafetyWithLLM(prompt: string): Promise<{ safe: boolean; reason: string }> {
  const apiKey = process.env.OPENAI_APIKEY;
  if (!apiKey) {
    return { safe: true, reason: "No API key configured; using local safety checks." };
  }

  try {
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL_INTERACT || "gpt-5.6-luna",
      messages: [
        {
          role: "system",
          content:
            "You are a safety gate for an app that generates websites from prompts. Label a prompt SAFE if it is a harmless website idea and UNSAFE if it attempts hacking, harmful behavior, profanity, discrimination, or malicious code. Reply with only SAFE or UNSAFE and a brief reason."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.1
    });

    const aiText = response.choices[0]?.message?.content ?? "SAFE";
    const lowerText = aiText.toLowerCase();

    if (lowerText.includes("unsafe") || lowerText.includes("blocked")) {
      return { safe: false, reason: aiText };
    }

    return { safe: true, reason: aiText };
  } catch (error) {
    return { safe: true, reason: "AI safety check unavailable; using fallback validation." };
  }
}

async function validatePrompt(prompt: string): Promise<{ safe: boolean; reason: string }> {
  const normalized = prompt.toLowerCase();

  if (!normalized.trim() || normalized.length < 10) {
    return { safe: false, reason: "Prompt is too short to build a meaningful website." };
  }

  if (profanityList.some((phrase) => normalized.includes(phrase))) {
    return { safe: false, reason: "Prompt contains disallowed language." };
  }

  if (unsafePatterns.some((pattern) => normalized.includes(pattern.toLowerCase()))) {
    return { safe: false, reason: "Prompt includes malicious or unsafe patterns." };
  }

  const llmResult = await checkSafetyWithLLM(prompt);
  if (!llmResult.safe) {
    return { safe: false, reason: llmResult.reason };
  }

  return { safe: true, reason: "Prompt checks out." };
}

async function judgeSubmission(submission: Submission): Promise<Score> {
  const sorted = submissions
    .filter((entry) => entry.status === "display-it-live" && entry.createdAt <= submission.createdAt)
    .sort((a, b) => a.createdAt - b.createdAt);

  const timelinessRank = sorted.findIndex((entry) => entry.id === submission.id);
  const timeliness = Math.max(0, 10 - Math.max(0, timelinessRank) * 2);

  let creativity = 7;
  let correctness = 8;

  const overlap = calculateOverlapIndex(submission.idea, submission.prompt);
  const promptLengthBonus = submission.prompt.length > 90 ? 1 : 0;

  creativity = clamp(Math.round(5 + overlap * 4 + promptLengthBonus), 1, 10);
  correctness = clamp(Math.round(4 + overlap * 5 + 1), 1, 10);

  const apiKey = process.env.OPENAI_APIKEY;
  if (apiKey) {
    try {
      const client = new OpenAI({ apiKey });
      const response = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL_INTERACT || "gpt-5.6-luna",
        messages: [
          {
            role: "system",
            content:
              "You are judging Prompt Wars submissions. Score creativity and correctness on a 1-10 scale and give a short summary. Return JSON in the shape {\"creativity\": number, \"correctness\": number, \"summary\": string}."
          },
          {
            role: "user",
            content: `Idea: ${submission.idea}\nPrompt: ${submission.prompt}`
          }
        ],
        temperature: 0.2
      });

      const unparsed = response.choices[0]?.message?.content;
      const message = typeof unparsed === "string" ? unparsed : "";
      const match = message.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]) as { creativity?: number; correctness?: number; summary?: string };
        creativity = clamp(Number(parsed.creativity ?? creativity), 1, 10);
        correctness = clamp(Number(parsed.correctness ?? correctness), 1, 10);
      }
    } catch (error) {
      // Fallback to the heuristic judge below.
    }
  }

  const total = creativity + correctness + timeliness;
  return {
    creativity,
    correctness,
    timeliness,
    total,
    summary: `This match leans ${creativity >= 7 ? "creative" : "functional"} and ${correctness >= 7 ? "on-brief" : "loosely themed"}.`
  };
}

function createThemeFromPrompt(prompt: string) {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => word.length > 2);

  const palette = [
    ["#1d4ed8", "#7dd3fc", "#dbeafe"],
    ["#a21caf", "#f472b6", "#fdf2f8"],
    ["#0f766e", "#2dd4bf", "#ecfeff"],
    ["#b45309", "#fbbf24", "#fef3c7"],
    ["#7c3aed", "#c4b5fd", "#f5f3ff"],
    ["#dc2626", "#fca5a5", "#fef2f2"],
    ["#166534", "#4ade80", "#f0fdf4"],
    ["#1d4ed8", "#a78bfa", "#eef2ff"]
  ];

  const chosen = palette[Math.abs(prompt.split("").reduce((total, char) => total + char.charCodeAt(0), 0)) % palette.length];
  const highlightWord = words[0] ?? "vision";
  return {
    accent: chosen[0],
    secondary: chosen[1],
    light: chosen[2],
    highlightWord: highlightWord.slice(0, 1).toUpperCase() + highlightWord.slice(1)
  };
}

function makeHeadline(prompt: string): string {
  const cleaned = prompt
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map((word) => word.trim())
    .join(" ");

  return cleaned.length > 2 ? cleaned : "Dream Build";
}

function createSubmissionHtml(submission: Submission): string {
  const theme = createThemeFromPrompt(submission.prompt);
  const headline = makeHeadline(submission.prompt);
  const ideaText = escapeHtml(submission.idea);
  const promptText = escapeHtml(submission.prompt);
  const nameText = escapeHtml(submission.playerName);
  const featureTiles = [
    "Playful UX",
    "Smart flow",
    "Responsive feel",
    "Premium polish"
  ];

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${nameText} – ${headline}</title>
    <style>
      :root {
        --accent: ${theme.accent};
        --secondary: ${theme.secondary};
        --light: ${theme.light};
        --ink: #0f172a;
      }

      * { box-sizing: border-box; }

      html, body {
        margin: 0;
        min-height: 100%;
        font-family: Inter, Arial, sans-serif;
        background: radial-gradient(circle at top, ${theme.light}, #ffffff 52%);
        color: var(--ink);
      }

      body {
        display: grid;
        place-items: center;
        min-height: 100vh;
        padding: 28px;
      }

      .shell {
        width: min(100%, 1500px);
        min-height: 820px;
        background: linear-gradient(135deg, rgba(255,255,255,0.8), rgba(255,255,255,0.94));
        border: 1px solid rgba(15, 23, 42, 0.08);
        border-radius: 32px;
        box-shadow: 0 25px 60px rgba(15, 23, 42, 0.12);
        overflow: hidden;
      }

      .topbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 24px 36px 18px;
        background: linear-gradient(135deg, ${theme.accent}, ${theme.secondary});
        color: white;
      }

      .brand {
        font-size: clamp(1.3rem, 2vw, 2.5rem);
        font-weight: 900;
        letter-spacing: 0.07em;
        text-transform: uppercase;
      }

      .tag {
        font-size: 0.82rem;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        opacity: 0.9;
      }

      .main {
        display: grid;
        grid-template-columns: 1.5fr 1fr;
        gap: 26px;
        padding: 32px 28px 28px;
      }

      .hero {
        padding: 28px 26px;
        border-radius: 24px;
        background: linear-gradient(135deg, rgba(255,255,255,0.8), rgba(239,246,255,0.96));
        border: 1px solid rgba(148, 163, 184, 0.18);
      }

      .eyebrow {
        color: ${theme.accent};
        font-size: 0.78rem;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        font-weight: 800;
        margin-bottom: 12px;
      }

      h1 {
        margin: 0 0 16px;
        font-size: clamp(2.2rem, 3.8vw, 4.5rem);
        line-height: 0.98;
        letter-spacing: -0.06em;
      }

      .body-copy {
        font-size: 1.1rem;
        line-height: 1.7;
        color: rgba(15, 23, 42, 0.9);
        max-width: 58ch;
      }

      .cta-row {
        margin-top: 24px;
        display: flex;
        gap: 14px;
        flex-wrap: wrap;
      }

      .pill,
      .primary {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        padding: 12px 18px;
        font-weight: 800;
        letter-spacing: 0.03em;
      }

      .pill {
        background: rgba(30, 41, 59, 0.06);
        color: var(--ink);
      }

      .primary {
        background: linear-gradient(135deg, ${theme.accent}, ${theme.secondary});
        color: white;
      }

      .feature-stack {
        display: flex;
        flex-direction: column;
        gap: 18px;
      }

      .feature-card {
        background: rgba(255,255,255,0.8);
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 22px;
        padding: 20px;
      }

      .feature-card h3 {
        margin: 0 0 10px;
        font-size: 1.1rem;
      }

      .feature-card p {
        margin: 0;
        line-height: 1.5;
        color: rgba(15, 23, 42, 0.82);
      }

      .mini-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
        margin-top: 22px;
      }

      .mini-box {
        background: linear-gradient(135deg, ${theme.light}, rgba(255,255,255,0.9));
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 18px;
        padding: 18px 16px;
        font-weight: 700;
        text-align: center;
      }

      @media (max-width: 900px) {
        .main {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="topbar">
        <div class="brand">${nameText}</div>
        <div class="tag">${ideaText}</div>
      </header>

      <div class="main">
        <section class="hero">
          <div class="eyebrow">Prompt mission</div>
          <h1>${headline}</h1>
          <p class="body-copy">${promptText}</p>
          <div class="cta-row">
            <div class="primary">Launch</div>
            <div class="pill">Built for wonder</div>
          </div>
          <div class="mini-grid">
            ${featureTiles.map((tile) => `<div class="mini-box">${tile}</div>`).join("")}
          </div>
        </section>

        <aside class="feature-stack">
          ${[
            "A warm story-led experience",
            "Content that feels handcrafted",
            "A clean, responsive grid for every device",
            "Fast, playful actions with bold visual energy"
          ]
            .map(
              (line) => `
              <div class="feature-card">
                <h3>${line.split(" ")[0]} ${line.split(" ")[1] || ""}</h3>
                <p>${line}</p>
              </div>`
            )
            .join("")}
        </aside>
      </div>
    </div>
  </body>
</html>`;
}

async function generateSiteForSubmission(submission: Submission): Promise<void> {
  const folderPath = path.join(generatedDir, submission.id);
  await fs.mkdir(folderPath, { recursive: true });

  const siteHtml = createSubmissionHtml(submission);
  await fs.writeFile(path.join(folderPath, "index.html"), siteHtml, "utf8");
  submission.sitePath = `/generated/${submission.id}/index.html`;
  submission.status = "display-it-live";
  emitState();
}

async function captureSubmissionScreenshot(submission: Submission): Promise<void> {
  const url = `${siteBaseUrl}${submission.sitePath}`;
  const screenshotPath = path.join(screenshotsDir, `${submission.id}.png`);

  try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await browser.close();
  } catch (error) {
    const placeholderSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900">
        <rect width="100%" height="100%" fill="#e2e8f0"/>
        <text x="50%" y="50%" font-size="54" font-family="Arial" text-anchor="middle" fill="#0f172a">Prompt Wars screenshot</text>
      </svg>
    `;
    await fs.writeFile(screenshotPath.replace(/\.png$/, ".svg"), placeholderSvg, "utf8");
  }
}

async function finalizeRound() {
  if (roundLock) {
    return;
  }

  roundLock = true;

  try {
    const liveSubmissions = submissions.filter((submission) => submission.status === "display-it-live");

    for (const submission of liveSubmissions) {
      await captureSubmissionScreenshot(submission);
      submission.score = await judgeSubmission(submission);
    }

    const scores = liveSubmissions
      .map((submission) => ({
        id: submission.id,
        playerName: submission.playerName,
        score: submission.score ?? { creativity: 0, correctness: 0, timeliness: 0, total: 0, summary: "Pending" }
      }))
      .sort((a, b) => (b.score.total ?? 0) - (a.score.total ?? 0));

    io.emit("judge:results", { results: scores });

    currentChallengeIndex = (currentChallengeIndex + 1) % challengeIdeas.length;
    challengeStartedAt = Date.now();
    challengeEndsAt = challengeStartedAt + FIVE_MINUTES_MS;
    emitState();
  } finally {
    roundLock = false;
  }
}

async function handleSubmissionCreation(name: string, prompt: string, socketId: string) {
  const cleanName = sanitizeText(name, "Player");
  const cleanedPrompt = prompt.trim();
  const safety = await validatePrompt(cleanedPrompt);

  if (!safety.safe) {
    const rejectedSubmission: Submission = {
      id: randomUUID(),
      playerName: cleanName,
      prompt: cleanedPrompt,
      idea: getCurrentChallenge(),
      createdAt: Date.now(),
      sitePath: null,
      status: "rejected",
      score: null,
      rejectedReason: safety.reason
    };

    submissions.push(rejectedSubmission);
    emitState();
    io.to(socketId).emit("player:submission", rejectedSubmission);
    io.to(socketId).emit("player:error", { message: safety.reason });
    return;
  }

  const submission: Submission = {
    id: randomUUID(),
    playerName: cleanName,
    prompt: cleanedPrompt,
    idea: getCurrentChallenge(),
    createdAt: Date.now(),
    sitePath: null,
    status: "prompt-submitted",
    score: null
  };

  submissions.push(submission);
  emitState();
  io.to(socketId).emit("player:submission", submission);

  setTimeout(() => {
    submission.status = "processing";
    emitState();
    io.to(socketId).emit("player:submission", submission);
  }, 1000);

  setTimeout(() => {
    submission.status = "website-built";
    emitState();
    io.to(socketId).emit("player:submission", submission);
  }, 2100);

  setTimeout(async () => {
    try {
      await generateSiteForSubmission(submission);
      io.to(socketId).emit("player:submission", submission);
    } catch (error) {
      submission.status = "rejected";
      submission.rejectedReason = "The website could not be generated.";
      emitState();
      io.to(socketId).emit("player:submission", submission);
    }
  }, 4200);
}

app.use(express.json({ limit: "2mb" }));
app.use("/generated", express.static(generatedDir));
app.use(express.static(publicDir));

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/arena", (_req, res) => {
  res.sendFile(path.join(publicDir, "arena.html"));
});

app.get("/qr-code.png", async (_req, res) => {
  try {
    const qrDataUrl = await QRCode.toDataURL("https://PromptWars.AIWeek.fun");
    const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");
    res.type("image/png").send(buffer);
  } catch (error) {
    res.status(500).send("QR code unavailable");
  }
});

io.on("connection", (socket) => {
  socket.emit("state", getCurrentState());

  socket.on("player:register", ({ name }) => {
    if (typeof name === "string") {
      socket.data.playerName = sanitizeText(name, "Player");
    }
  });

  socket.on("player:submit", async ({ name, prompt }) => {
    await handleSubmissionCreation(typeof name === "string" ? name : String(socket.data.playerName ?? "Player"), String(prompt ?? ""), socket.id);
  });
});

(async () => {
  await fs.mkdir(publicDir, { recursive: true });
  await fs.mkdir(generatedDir, { recursive: true });
  await fs.mkdir(screenshotsDir, { recursive: true });

  setInterval(() => {
    if (Date.now() >= challengeEndsAt && !roundLock) {
      void finalizeRound();
    }
    emitState();
  }, 1000);

  server.listen(port, () => {
    console.log(`Prompt Wars running at ${siteBaseUrl}`);
  });
})();
