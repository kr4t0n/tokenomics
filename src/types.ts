export interface Settings {
  cursorSessionToken?: string;
}

export interface TeamInfo {
  isTeamMember: boolean;
  teamId?: number;
  teamName?: string;
  userId?: number;
  role?: string;
  pricingStrategy?: string;
  seats?: number;
}

export interface TeamInfoCache {
  tokenKey: string;
  data: TeamInfo | null;
  ts: number;
}

export interface TeamMemberSpend {
  userId: number;
  name?: string;
  email?: string;
  role?: string;
  hardLimitOverrideDollars?: number;
  includedSpendCents?: number;
  spendCents?: number;
  effectivePerUserLimitDollars?: number;
  fastPremiumRequests?: number;
  profilePictureUrl?: string;
}

export interface TeamSpendResponse {
  teamMemberSpend: TeamMemberSpend[];
  subscriptionCycleStart: string;
  nextCycleStart: string;
  totalMembers: number;
  totalPages: number;
}

export interface TeamDashboardResponse {
  isTeamMember: boolean;
  teamName?: string;
  pricingStrategy?: string;
  role?: string;
  includedSpendCents?: number;
  spendCents?: number;
  limitDollars?: number;
  cycleStart?: string;
  cycleEnd?: string;
}

export interface CursorUsageModel {
  numRequests: number;
  numRequestsTotal: number;
  numTokens: number;
  maxTokenUsage: number | null;
  maxRequestUsage: number | null;
}

export interface CursorUsageResponse {
  "gpt-4": CursorUsageModel;
  startOfMonth: string;
  [key: string]: CursorUsageModel | string;
}

export type TokenSource = "settings" | "local-db" | "none";

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

export interface CodexQuotaWindow {
  percentLeft: number;
  resetAt: string;
  windowSeconds: number;
}

export interface CodexUsageResponse {
  fiveHour: CodexQuotaWindow | null;
  weekly: CodexQuotaWindow | null;
}

export interface CodexAuth {
  accessToken: string;
  accountId: string;
}

export type CodexTokenSource = "codex-auth" | "none";
