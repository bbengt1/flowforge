/** Shapes from jonny's E2.2 isolation hook contract (PR #19). */

export type IsolationRecord = {
  workspace_id: string;
  id: string;
  kind: string;
  name: string;
  metadata?: Record<string, unknown>;
  created_by?: string;
  created_at?: string;
};

export type IsolationCacheValue = {
  key: string;
  value: string;
};

export type IsolationSubscribe = {
  channel_id: string;
  status: string;
};

export const ISOLATION_KINDS = [
  "credential",
  "artifact",
  "job",
  "cache",
  "realtime",
  "audit",
] as const;

export type IsolationKind = (typeof ISOLATION_KINDS)[number];
