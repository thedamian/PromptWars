import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type OpenAI from "openai";
import { config } from "./config.js";
import { pickIdea } from "./ideas.js";
import { screenPrompt } from "./moderation.js";
import { buildSite, deleteRoundSites, fallbackHtml, writeSite } from "./builder.js";
import { judgeSubmissions, screenshotSite } from "./judge.js";
import type { PublicRound, PublicSubmission, Round, Submission, SubmissionStatus } from "./types.js";

export interface GameEvents {
  state: [PublicRound];
  submission: [PublicSubmission, Submission];
}

export class Game extends EventEmitter<GameEvents> {
  private round!: Round;
  private roundNumber = 0;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = new Set<Promise<void>>();

  constructor(private readonly openai: OpenAI, private readonly localBaseUrl: string) {
    super();
  }

  start(): void {
    void this.startRound();
  }

  get current(): Round {
    return this.round;
  }

  publicRound(): PublicRound {
    const r = this.round;
    return {
      id: r.id,
      number: r.number,
      idea: r.idea,
      phase: r.phase,
      startedAt: r.startedAt,
      endsAt: r.endsAt,
      serverNow: Date.now(),
      maxSubmissions: config.maxSubmissions,
      submissions: r.submissions.map(toPublic)
    };
  }

  submissionFor(playerId: string): Submission | undefined {
    const mine = this.round.submissions.filter((s) => s.playerId === playerId);
    return mine[mine.length - 1];
  }

  private async startRound(): Promise<void> {
    const previous = this.round as Round | undefined;
    if (previous) await deleteRoundSites(previous.id).catch(() => undefined);

    this.roundNumber += 1;
    const now = Date.now();
    this.round = {
      id: crypto.randomUUID().slice(0, 8),
      number: this.roundNumber,
      idea: pickIdea(previous?.idea),
      phase: "building",
      startedAt: now,
      endsAt: now + config.roundMs,
      submissions: []
    };
    console.log(`[game] Round ${this.round.number} started: "${this.round.idea}"`);
    this.broadcastState();
    this.schedule(config.roundMs, () => void this.endBuilding());
  }

  private schedule(ms: number, fn: () => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(fn, ms);
  }

  private async endBuilding(): Promise<void> {
    const round = this.round;
    round.phase = "judging";
    round.endsAt = Date.now() + config.buildGraceMs;
    this.broadcastState();

    // Give in-flight builds a short grace period, then judge whatever is finished.
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise((resolve) => setTimeout(resolve, config.buildGraceMs))
    ]);
    if (this.round !== round) return;

    const contenders = round.submissions.filter((s) => s.status === "live" || s.status === "built");
    for (const s of round.submissions) {
      if (s.status === "submitted" || s.status === "processing") {
        this.setStatus(s, "failed", "Ran out of time before the site was finished.");
      }
    }

    const files = new Map<string, string>();
    for (const s of contenders) {
      try {
        const shot = await screenshotSite(round.id, s.id, `${this.localBaseUrl}${s.siteUrl}`);
        s.screenshotUrl = shot.publicUrl;
        files.set(s.id, shot.file);
      } catch (err) {
        console.error(`[judge] screenshot failed for ${s.id}:`, (err as Error).message);
      }
    }
    if (this.round !== round) return;

    const judged = contenders.filter((s) => files.has(s.id));
    const scores = await judgeSubmissions(this.openai, round.idea, judged, files);
    for (const s of judged) {
      s.scores = scores.get(s.id);
      this.emit("submission", toPublic(s), s);
    }

    round.phase = "results";
    round.endsAt = Date.now() + config.resultsMs;
    console.log(`[game] Round ${round.number} judged: ${judged.length} site(s).`);
    this.broadcastState();
    this.schedule(config.resultsMs, () => void this.startRound());
  }

  /** Returns an error string, or null on success. */
  submit(playerId: string, playerName: string, prompt: string): string | null {
    const round = this.round;
    if (round.phase !== "building") return "The round is over – wait for the next idea!";
    const existing = this.submissionFor(playerId);
    if (existing && existing.status !== "rejected") return "You already submitted a prompt this round.";
    const active = round.submissions.filter((s) => s.status !== "rejected" && s.status !== "failed");
    if (active.length >= config.maxSubmissions) return "The arena is full for this round (6 sites max). Try the next one!";
    const trimmed = prompt.trim();
    if (trimmed.length < 10) return "Your prompt is a bit short – give the AI something to work with!";
    if (trimmed.length > config.maxPromptLength) return `Prompt is too long (max ${config.maxPromptLength} characters).`;

    const submission: Submission = {
      id: crypto.randomUUID().slice(0, 8),
      roundId: round.id,
      playerId,
      playerName,
      prompt: trimmed,
      order: active.length + 1,
      status: "submitted",
      submittedAt: Date.now()
    };
    round.submissions.push(submission);
    this.emit("submission", toPublic(submission), submission);

    const task = this.process(round, submission).finally(() => this.inFlight.delete(task));
    this.inFlight.add(task);
    return null;
  }

  private async process(round: Round, s: Submission): Promise<void> {
    try {
      const screen = await screenPrompt(this.openai, s.prompt);
      if (this.round !== round) return;
      if (!screen.ok) {
        this.setStatus(s, "rejected", screen.reason ?? "Prompt rejected.");
        this.reorder(round);
        return;
      }
      this.setStatus(s, "processing", "The AI is building your website…");

      let html: string;
      try {
        html = await buildSite(this.openai, s.prompt);
      } catch (err) {
        console.error(`[build] ${s.id} failed:`, (err as Error).message);
        html = fallbackHtml(s.playerName, "The AI tripped over its own shoelaces.");
      }
      if (this.round !== round) return;

      s.siteUrl = await writeSite(round.id, s.id, html);
      s.builtAt = Date.now();
      this.setStatus(s, "built", "Website built!");
      if (round.phase === "building") {
        this.setStatus(s, "live", "Your site is live in the arena!");
      }
    } catch (err) {
      console.error(`[process] ${s.id} failed:`, (err as Error).message);
      if (this.round === round) this.setStatus(s, "failed", "Something went wrong while building your site.");
    }
  }

  /** Recompute order numbers when a rejection frees up a slot. */
  private reorder(round: Round): void {
    let n = 1;
    for (const s of round.submissions) {
      if (s.status === "rejected" || s.status === "failed") continue;
      if (s.order !== n) {
        s.order = n;
        this.emit("submission", toPublic(s), s);
      }
      n += 1;
    }
  }

  private setStatus(s: Submission, status: SubmissionStatus, message?: string): void {
    s.status = status;
    s.statusMessage = message;
    this.emit("submission", toPublic(s), s);
  }

  private broadcastState(): void {
    this.emit("state", this.publicRound());
  }
}

export function toPublic(s: Submission): PublicSubmission {
  return {
    id: s.id,
    playerName: s.playerName,
    order: s.order,
    status: s.status,
    statusMessage: s.statusMessage,
    submittedAt: s.submittedAt,
    siteUrl: s.siteUrl,
    screenshotUrl: s.screenshotUrl,
    scores: s.scores
  };
}
