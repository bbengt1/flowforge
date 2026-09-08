/**
 * Negative isolation exercises against jonny's E2.2 hook routes.
 * Success of each story is that access fails closed (400/403/404).
 */

export const EXAMPLE_FOREIGN_UUID = "22222222-2222-2222-2222-222222222222";
export const EXAMPLE_MISMATCH_WORKSPACE_ID =
  "33333333-3333-3333-3333-333333333333";
export const EXAMPLE_CACHE_KEY = "job-1";

export type IsolationTargetIds = {
  credentialId: string;
  artifactId: string;
  cacheKey: string;
  channelId: string;
  recordId: string;
};

export type IsolationExerciseSurface =
  | "credential"
  | "artifact"
  | "cache"
  | "realtime"
  | "record"
  | "job"
  | "audit"
  | "workspace-id";

export type IsolationExpectedOutcome = "fail-closed" | "scoped-list";

export type IsolationExerciseDef = {
  id: string;
  label: string;
  method: "GET" | "POST" | "PUT";
  path: string;
  body?: unknown;
  expectedOutcome: IsolationExpectedOutcome;
  surface: IsolationExerciseSurface;
  detail: string;
};

export function emptyIsolationTargets(): IsolationTargetIds {
  return {
    credentialId: EXAMPLE_FOREIGN_UUID,
    artifactId: EXAMPLE_FOREIGN_UUID,
    cacheKey: EXAMPLE_CACHE_KEY,
    channelId: EXAMPLE_FOREIGN_UUID,
    recordId: EXAMPLE_FOREIGN_UUID,
  };
}

export function isolationExercises(
  ids: IsolationTargetIds,
): IsolationExerciseDef[] {
  const credentialId = encodeURIComponent(ids.credentialId.trim());
  const artifactId = encodeURIComponent(ids.artifactId.trim());
  const cacheKey = encodeURIComponent(ids.cacheKey.trim());
  const channelId = encodeURIComponent(ids.channelId.trim());
  const recordId = encodeURIComponent(ids.recordId.trim());

  return [
    {
      id: "use-foreign-credential",
      label: "Use another workspace's credential",
      method: "POST",
      path: `/workspace/credentials/${credentialId}/use`,
      expectedOutcome: "fail-closed",
      surface: "credential",
      detail:
        "POST /workspace/credentials/{id}/use with a foreign credential id.",
    },
    {
      id: "get-foreign-artifact",
      label: "Read another workspace's artifact",
      method: "GET",
      path: `/workspace/artifacts/${artifactId}`,
      expectedOutcome: "fail-closed",
      surface: "artifact",
      detail: "GET /workspace/artifacts/{id} with a foreign artifact id.",
    },
    {
      id: "get-foreign-cache",
      label: "Read another workspace's cache key",
      method: "GET",
      path: `/workspace/cache/${cacheKey}`,
      expectedOutcome: "fail-closed",
      surface: "cache",
      detail:
        "GET /workspace/cache/{key} — keys are workspace-prefixed server-side.",
    },
    {
      id: "subscribe-foreign-channel",
      label: "Subscribe to another workspace's channel",
      method: "POST",
      path: `/workspace/realtime/channels/${channelId}/subscribe`,
      expectedOutcome: "fail-closed",
      surface: "realtime",
      detail:
        "POST /workspace/realtime/channels/{id}/subscribe with a foreign channel id.",
    },
    {
      id: "get-foreign-record",
      label: "Read another workspace's record",
      method: "GET",
      path: `/workspace/records/${recordId}`,
      expectedOutcome: "fail-closed",
      surface: "record",
      detail: "GET /workspace/records/{id} with a foreign record id.",
    },
    {
      id: "list-foreign-credentials",
      label: "List credentials in the current workspace",
      method: "GET",
      path: "/workspace/records?kind=credential",
      expectedOutcome: "scoped-list",
      surface: "record",
      detail:
        "GET /workspace/records?kind=credential. Cross-workspace rows must not appear; an empty list is isolation holding.",
    },
    {
      id: "list-jobs",
      label: "List jobs in the current workspace",
      method: "GET",
      path: "/workspace/jobs",
      expectedOutcome: "scoped-list",
      surface: "job",
      detail: "GET /workspace/jobs — scoped to the server-derived workspace.",
    },
    {
      id: "list-audit-events",
      label: "List audit events in the current workspace",
      method: "GET",
      path: "/workspace/audit-events",
      expectedOutcome: "scoped-list",
      surface: "audit",
      detail:
        "GET /workspace/audit-events — scoped; requires workspace.administer.",
    },
    {
      id: "reject-host-workspace-id-body",
      label: "Reject host-supplied workspace_id on write",
      method: "POST",
      path: "/workspace/records",
      body: {
        kind: "credential",
        name: "isolation-reject",
        workspace_id: EXAMPLE_MISMATCH_WORKSPACE_ID,
      },
      expectedOutcome: "fail-closed",
      surface: "workspace-id",
      detail:
        "POST /workspace/records with workspace_id in the body. The API rejects host-supplied workspace identity.",
    },
  ];
}

export function classifyIsolationResult(
  statusCode: number,
  expectedOutcome: IsolationExpectedOutcome = "fail-closed",
): {
  held: boolean;
  label: string;
} {
  if (expectedOutcome === "scoped-list") {
    if (statusCode >= 200 && statusCode < 300) {
      return {
        held: true,
        label: "Scoped list returned — foreign rows must be absent",
      };
    }
    if (statusCode === 403 || statusCode === 404) {
      return { held: true, label: "Access failed closed" };
    }
  } else if (statusCode === 400 || statusCode === 403 || statusCode === 404) {
    return { held: true, label: "Access failed closed" };
  }

  if (expectedOutcome === "fail-closed" && statusCode >= 200 && statusCode < 300) {
    return { held: false, label: "Unexpected success — isolation did not fail" };
  }
  if (statusCode === 401) {
    return { held: false, label: "Unauthenticated — set issuer and subject" };
  }
  return { held: false, label: "Control plane problem (not an isolation proof)" };
}
