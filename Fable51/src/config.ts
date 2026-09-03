import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required in Fable51/.env (see .env.example)`);
  }
  return value.trim();
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  rootDir,
  publicDir: path.join(rootDir, "public"),
  dataDir: path.join(rootDir, "data"),
  sitesDir: path.join(rootDir, "data", "sites"),
  screenshotsDir: path.join(rootDir, "data", "screenshots"),
  port: envNumber("PORT", 3000),
  roundMs: envNumber("ROUND_SECONDS", 300) * 1000,
  resultsMs: envNumber("RESULTS_SECONDS", 60) * 1000,
  /** Extra time after the timer for in-flight builds to finish before judging. */
  buildGraceMs: 20_000,
  maxSubmissions: 6,
  maxPromptLength: 1500,
  maxNameLength: 24,
  publicUrl: process.env.PUBLIC_URL?.trim() || "https://PromptWars.AIWeek.fun",
  apiKey: requireEnv("OPENAI_APIKEY"),
  buildModel: process.env.OPENAI_MODEL_OPEN?.trim() || requireEnv("OPENAI_MODEL_INTERACT"),
  judgeModel: process.env.OPENAI_MODEL_INTERACT?.trim() || requireEnv("OPENAI_MODEL_OPEN")
};
