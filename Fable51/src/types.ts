export type RoundPhase = "building" | "judging" | "results";

export type SubmissionStatus =
  | "submitted"
  | "processing"
  | "built"
  | "live"
  | "rejected"
  | "failed";

export interface Scores {
  creativity: number;
  accuracy: number;
  orderBonus: number;
  total: number;
  comment: string;
}

export interface Submission {
  id: string;
  roundId: string;
  playerId: string;
  playerName: string;
  prompt: string;
  order: number;
  status: SubmissionStatus;
  statusMessage?: string;
  submittedAt: number;
  builtAt?: number;
  siteUrl?: string;
  screenshotUrl?: string;
  scores?: Scores;
}

/** Fields safe to broadcast to every client (the prompt itself is never shared). */
export interface PublicSubmission {
  id: string;
  playerName: string;
  order: number;
  status: SubmissionStatus;
  statusMessage?: string;
  submittedAt: number;
  siteUrl?: string;
  screenshotUrl?: string;
  scores?: Scores;
}

export interface Round {
  id: string;
  number: number;
  idea: string;
  phase: RoundPhase;
  startedAt: number;
  endsAt: number;
  submissions: Submission[];
}

export interface PublicRound {
  id: string;
  number: number;
  idea: string;
  phase: RoundPhase;
  startedAt: number;
  endsAt: number;
  serverNow: number;
  maxSubmissions: number;
  submissions: PublicSubmission[];
}

// ---- WebSocket protocol ----

export type ClientMessage =
  | { type: "hello"; role: "arena" }
  | { type: "hello"; role: "player"; playerId?: string; name?: string }
  | { type: "join"; name: string }
  | { type: "submit"; prompt: string };

export type ServerMessage =
  | { type: "welcome"; playerId: string; name?: string }
  | { type: "state"; round: PublicRound }
  | { type: "submission"; submission: PublicSubmission }
  | { type: "yourSubmission"; submission: PublicSubmission | null }
  | { type: "error"; message: string };
