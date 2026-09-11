export interface AgentUsageView {
  engine: string;
  name: string;
  source: string;
  available: boolean;
  stale: boolean;
  retrievedAt?: string;
  cliVersion?: string;
  activity?: { at: string; inputTokens: number; outputTokens: number; costUSD: number };
  ordinaryUsageAllowed?: boolean | null;
  error?: string;
  buckets: {
    id: string;
    name: string;
    plan?: string | null;
    windows: {
      remainingPercent: number | null;
      label?: string;
      durationMinutes?: number | null;
      resetsAt?: string;
    }[];
    credits?: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
    blocked?: string | null;
  }[];
  resets: {
    availableCount: number | null;
    canUse: boolean;
    pending?: boolean;
    credits: { id: string; title: string; description?: string | null; expiresAt?: string }[];
  };
}
export type ResetOutcome = 'reset' | 'alreadyRedeemed' | 'nothingToReset' | 'noCredit';
export interface ResetPlan {
  id: string;
  availableCount: number;
  title: string;
  expiresAt: string;
  status: 'ready' | 'pending' | 'done';
  outcome?: ResetOutcome;
}
export interface AgentUsage {
  read(refresh?: boolean): Promise<AgentUsageView>;
  reset?: {
    prepare(owner: string): Promise<ResetPlan>;
    consume(id: string, owner: string): Promise<{ plan: ResetPlan; usage: AgentUsageView }>;
  };
}
export interface UsageView {
  agents: AgentUsageView[];
}
export interface UsageBackend {
  read(refresh?: boolean): Promise<UsageView>;
  prepare(owner: string, engine?: string): Promise<ResetPlan>;
  consume(id: string, owner: string): Promise<{ plan: ResetPlan; usage: UsageView }>;
}
