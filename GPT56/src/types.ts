export type RoundPhase = "playing" | "judging" | "results";
export type SubmissionStatus = "Prompt Submitted" | "Processing" | "Website Built" | "Display it live";

export interface Submission {
  id: string;
  name: string;
  prompt: string;
  status: SubmissionStatus;
  submittedAt: number;
  order: number;
  websitePath?: string;
  error?: string;
}

export interface JudgeResult {
  submissionId: string;
  creativity: number;
  ideaMatch: number;
  orderBonus: number;
  total: number;
  feedback: string;
}

export interface PublicSubmission {
  id: string;
  name: string;
  status: SubmissionStatus;
  submittedAt: number;
  order: number;
  websitePath?: string;
  error?: string;
}

export interface ServerState {
  type: "state";
  roundId: string;
  idea: string;
  phase: RoundPhase;
  startedAt: number;
  endsAt: number;
  submissions: PublicSubmission[];
  results: JudgeResult[];
}
