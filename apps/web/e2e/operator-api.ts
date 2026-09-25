import type { Page, Route } from "@playwright/test";

/**
 * Same-origin stand-in for the control plane. Metadata only:
 * display name + UUID. No passwords, KEKs, assertions, or PEM.
 * Browser fetches are fulfilled here so CI does not need Postgres.
 */

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const WORKFLOW_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";
const CREDENTIAL_ID = "55555555-5555-4555-8555-555555555555";
const EXECUTION_ID = "66666666-6666-4666-8666-666666666666";
const FAILED_EXECUTION_ID = "6a6a6a6a-6a6a-4a6a-8a6a-6a6a6a6a6a6a";
const CANCELED_EXECUTION_ID = "6c6c6c6c-6c6c-4c6c-8c6c-6c6c6c6c6c6c";
const APPROVAL_ID = "77777777-7777-4777-8777-777777777777";
const USER_ID = "88888888-8888-4888-8888-888888888888";

export const OPERATOR_WORKFLOW_ID = WORKFLOW_ID;
export const OPERATOR_EXECUTION_ID = EXECUTION_ID;
export const OPERATOR_FAILED_EXECUTION_ID = FAILED_EXECUTION_ID;
export const OPERATOR_CANCELED_EXECUTION_ID = CANCELED_EXECUTION_ID;
export const OPERATOR_FOLDER_NAME = "Runbooks";

const FOLDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const PERMISSIONS = [
  "workflow.view",
  "workflow.edit",
  "workflow.publish",
  "workflow.execute",
  "credential.view",
  "execution.view",
  "approval.view",
] as const;

const tenant = {
  id: TENANT_ID,
  slug: "acme",
  name: "Acme",
  status: "active",
};

const workspace = {
  id: WORKSPACE_ID,
  tenant_id: TENANT_ID,
  workbench_key: "ops",
  name: "Ops",
  status: "active",
};

const principal = {
  id: USER_ID,
  issuer: "https://flowforge.local",
  external_subject: "operator-ada",
  display_name: "Ada Operator",
  status: "active",
};

const membership = {
  workspace,
  tenant,
  roles: ["operator"],
  permissions: [...PERMISSIONS],
};

const currentWorkspace = {
  workspace,
  tenant,
  principal,
  roles: ["operator"],
  permissions: [...PERMISSIONS],
};

const workflow = {
  id: WORKFLOW_ID,
  slug: "deploy",
  name: "Deploy",
  status: "draft",
  draftRevision: 1,
};

const folder = {
  id: FOLDER_ID,
  workspaceId: WORKSPACE_ID,
  parentId: null,
  name: OPERATOR_FOLDER_NAME,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:00.000Z",
};

const draftSummary = {
  apiVersion: "flowforge/v1",
  name: "Deploy",
  triggers: [],
  nodes: [],
  edges: [],
  outputs: [],
};

const draft = {
  workflowId: WORKFLOW_ID,
  revision: 1,
  definitionYaml: [
    "apiVersion: flowforge/v1",
    "name: Deploy",
    "triggers: []",
    "nodes: []",
    "edges: []",
    "outputs: []",
    "",
  ].join("\n"),
  digest: "sha256:e2e-draft",
  summary: draftSummary,
  warnings: [],
};

const credential = {
  id: CREDENTIAL_ID,
  displayName: "prod-k8s",
  type: "kubernetes",
  status: "active",
  tags: ["prod"],
};

const execution = {
  id: EXECUTION_ID,
  workflowId: WORKFLOW_ID,
  workflowName: "Deploy",
  workflowSlug: "deploy",
  workflowVersionId: VERSION_ID,
  workflowVersionNumber: 1,
  status: "succeeded",
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:01:00.000Z",
  startedAt: "2026-09-01T12:00:00.000Z",
  finishedAt: "2026-09-01T12:01:00.000Z",
  permittedActions: ["view"],
};

const STEP_GATE = "12121212-1212-4212-8212-121212121212";
const STEP_NOTIFY = "13131313-1313-4313-8313-131313131313";
const STEP_ROLLBACK = "14141414-1414-4414-8414-141414141414";
const STEP_DOWNSTREAM = "15151515-1515-4515-8515-151515151515";

const publishedYaml = [
  "apiVersion: flowforge/v1",
  "kind: Workflow",
  "metadata:",
  "  name: Deploy",
  "spec:",
  "  description: Branch statuses for replay.",
  "  triggers:",
  "    - id: manual",
  "      type: manual",
  "  nodes:",
  "    - id: gate",
  "      type: flow.approval",
  "      name: Approval gate",
  "    - id: notify",
  "      type: data.set",
  "      name: Notify",
  "    - id: rollback",
  "      type: data.set",
  "      name: Rollback",
  "    - id: downstream",
  "      type: data.set",
  "      name: Downstream",
  "  edges:",
  "    - from: gate.approved",
  "      to: notify.input",
  "    - from: gate.rejected",
  "      to: rollback.input",
  "    - from: notify.result",
  "      to: downstream.input",
  "",
].join("\n");

const publishedVersion = {
  id: VERSION_ID,
  workflowId: WORKFLOW_ID,
  versionNumber: 1,
  digest: "sha256:e2e-published",
  definitionYaml: publishedYaml,
  publishNote: "",
  publishedAt: "2026-09-01T12:00:00.000Z",
};

const executionDetail = {
  ...execution,
  status: "running",
  finishedAt: "",
  steps: [
    {
      id: STEP_GATE,
      nodeId: "gate",
      nodeType: "flow.approval",
      attempt: 1,
      status: "succeeded",
      startedAt: "2026-09-01T12:00:00.000Z",
      finishedAt: "2026-09-01T12:00:05.000Z",
    },
    {
      id: STEP_NOTIFY,
      nodeId: "notify",
      nodeType: "data.set",
      attempt: 1,
      status: "pending",
    },
    {
      id: STEP_ROLLBACK,
      nodeId: "rollback",
      nodeType: "data.set",
      attempt: 1,
      status: "skipped",
      finishedAt: "2026-09-01T12:00:05.000Z",
    },
    {
      id: STEP_DOWNSTREAM,
      nodeId: "downstream",
      nodeType: "data.set",
      attempt: 1,
      status: "pending",
    },
  ],
  jobs: [
    {
      id: "16161616-1616-4616-8616-161616161616",
      executionStepId: STEP_DOWNSTREAM,
      status: "blocked",
    },
    {
      id: "17171717-1717-4717-8717-171717171717",
      executionStepId: STEP_ROLLBACK,
      status: "skipped",
    },
  ],
  auditEvents: [
    {
      id: "19191919-1919-4919-8919-191919191919",
      action: "execution.started",
      outcome: "ok",
    },
  ],
  artifacts: [],
};

const retryAllowed = { retry: { allowed: true } };

const failedExecutionDetail = {
  ...execution,
  id: FAILED_EXECUTION_ID,
  status: "failed",
  capabilities: retryAllowed,
  finishedAt: "2026-09-01T12:00:06.000Z",
  steps: [
    {
      id: STEP_GATE,
      nodeId: "gate",
      nodeType: "data.set",
      attempt: 1,
      status: "failed",
      startedAt: "2026-09-01T12:00:00.000Z",
      finishedAt: "2026-09-01T12:00:05.000Z",
      capabilities: retryAllowed,
    },
    {
      id: STEP_NOTIFY,
      nodeId: "notify",
      nodeType: "data.set",
      attempt: 1,
      status: "pending",
    },
    {
      id: STEP_ROLLBACK,
      nodeId: "rollback",
      nodeType: "data.set",
      attempt: 1,
      status: "skipped",
      finishedAt: "2026-09-01T12:00:05.000Z",
    },
    {
      id: STEP_DOWNSTREAM,
      nodeId: "downstream",
      nodeType: "data.set",
      attempt: 1,
      status: "pending",
    },
  ],
  jobs: [
    {
      id: "16161616-1616-4616-8616-161616161616",
      executionStepId: STEP_DOWNSTREAM,
      status: "blocked",
    },
    {
      id: "17171717-1717-4717-8717-171717171717",
      executionStepId: STEP_ROLLBACK,
      status: "skipped",
    },
  ],
  auditEvents: [
    {
      id: "19191919-1919-4919-8919-191919191919",
      action: "execution.failed",
      outcome: "error",
    },
  ],
  artifacts: [],
};

const canceledDenial = {
  retry: {
    allowed: false,
    code: "execution_not_retryable",
    reason: "run_canceled",
  },
};

const canceledExecutionDetail = {
  ...execution,
  id: CANCELED_EXECUTION_ID,
  status: "canceled",
  finishedAt: "2026-09-01T12:00:06.000Z",
  capabilities: canceledDenial,
  steps: [
    {
      id: STEP_GATE,
      nodeId: "gate",
      nodeType: "flow.approval",
      attempt: 1,
      status: "canceled",
      startedAt: "2026-09-01T12:00:00.000Z",
      finishedAt: "2026-09-01T12:00:04.000Z",
      capabilities: canceledDenial,
    },
    {
      id: STEP_NOTIFY,
      nodeId: "notify",
      nodeType: "data.set",
      attempt: 1,
      status: "pending",
      capabilities: {
        retry: {
          allowed: false,
          code: "execution_not_retryable",
          reason: "step_not_started",
        },
      },
    },
  ],
  jobs: [],
  auditEvents: [],
  artifacts: [],
};

const approval = {
  id: APPROVAL_ID,
  status: "pending",
  workflowId: WORKFLOW_ID,
  workflowName: "Deploy",
  requestedBy: "operator-ada",
  requestedAt: "2026-09-01T12:00:00.000Z",
  binding: {
    workflowVersionId: VERSION_ID,
    operation: "deploy",
  },
  validity: { current: true },
  permittedActions: ["view"],
};

const canceledGateApproval = {
  id: "7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c7c",
  status: "pending",
  workflowId: WORKFLOW_ID,
  workflowName: "Deploy",
  executionId: CANCELED_EXECUTION_ID,
  executionStatus: "canceled",
  requestedBy: "operator-ada",
  requestedAt: "2026-09-01T12:00:00.000Z",
  binding: {
    workflowVersionId: VERSION_ID,
    operation: "deploy",
    nodeId: "gate",
  },
  validity: { current: true },
  permittedActions: ["approve", "reject"],
};

const session = {
  csrf_token: "e2e-csrf",
  principal,
  session: {
    id: "99999999-9999-4999-8999-999999999999",
    idle_expires_at: "2099-01-01T00:00:00.000Z",
    absolute_expires_at: "2099-01-01T12:00:00.000Z",
    must_change_password: false,
  },
};

const bootstrapComplete = {
  complete: true,
  incomplete: false,
  skipped: false,
  standaloneOnly: true,
  steps: {
    persistence: { ready: true },
    firstAdmin: { ready: true },
    publicUrl: { ready: true },
    tls: { ready: true, mode: "skipped" },
  },
};

function problem(path: string, status: number, code: string, title: string) {
  return {
    status,
    contentType: "application/problem+json",
    body: {
      type: "about:blank",
      title,
      status,
      detail: title,
      instance: path,
      code,
      request_id: "e2e",
    },
  };
}

function ok(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body,
  };
}

function apiPath(url: string): string {
  const pathname = new URL(url).pathname;
  const stripped = pathname
    .replace(/^\/api\/v1/, "")
    .replace(/^\/api\/control-plane/, "");
  return stripped.startsWith("/") ? stripped : `/${stripped}`;
}

function bodyFor(
  requestUrl: string,
  permissions: readonly string[] = PERMISSIONS,
): {
  status: number;
  contentType: string;
  body: unknown;
} {
  const path = apiPath(requestUrl);
  const granted = [...permissions];
  const folderId = new URL(requestUrl).searchParams.get("folderId")?.trim() ?? "";
  if (path === "/session") {
    return ok(session);
  }
  if (path === "/bootstrap") {
    return ok(bootstrapComplete);
  }
  if (path === "/workspaces") {
    return ok({ items: [{ ...membership, permissions: granted }] });
  }
  if (path === "/workspace") {
    return ok({ ...currentWorkspace, permissions: granted });
  }
  if (path === "/workflows" || path === "/workflows/") {
    if (folderId && folderId !== "unfiled") {
      return ok({ items: [] });
    }
    return ok({ items: [workflow] });
  }
  if (path === "/workflows/catalog") {
    return ok({
      apiVersion: "flowforge/v1",
      triggers: [],
      nodes: [],
    });
  }
  if (path === `/workflows/${WORKFLOW_ID}/draft`) {
    return ok(draft);
  }
  if (path === `/workflows/${WORKFLOW_ID}/versions`) {
    return ok({ items: [] });
  }
  if (path === `/workflows/${WORKFLOW_ID}/versions/${VERSION_ID}`) {
    return ok(publishedVersion);
  }
  if (path === `/workflows/${WORKFLOW_ID}`) {
    return ok(workflow);
  }
  if (path === "/credentials" || path === "/credentials/") {
    return ok({ items: [credential] });
  }
  if (path === "/credentials/catalog") {
    return ok({
      types: [{ type: "kubernetes", displayName: "Kubernetes" }],
    });
  }
  if (path === "/executions" || path === "/executions/") {
    return ok({ items: [execution] });
  }
  if (path === `/executions/${EXECUTION_ID}`) {
    return ok(executionDetail);
  }
  if (path.startsWith(`/executions/${EXECUTION_ID}/`)) {
    return ok({ items: [] });
  }
  if (path === `/executions/${FAILED_EXECUTION_ID}`) {
    return ok(failedExecutionDetail);
  }
  if (path.startsWith(`/executions/${FAILED_EXECUTION_ID}/`)) {
    return ok({ items: [] });
  }
  if (path === `/executions/${CANCELED_EXECUTION_ID}`) {
    return ok(canceledExecutionDetail);
  }
  if (path.startsWith(`/executions/${CANCELED_EXECUTION_ID}/`)) {
    return ok({ items: [] });
  }
  if (path === "/approvals/catalog") {
    return ok({ waitResumeEnabled: true });
  }
  if (path === "/approvals" || path.startsWith("/approvals")) {
    const executionId = new URL(requestUrl).searchParams.get("executionId");
    if (executionId === CANCELED_EXECUTION_ID) {
      return ok({ items: [canceledGateApproval] });
    }
    return ok({ items: [approval] });
  }
  if (path === "/workflow-folders") {
    return ok({ items: [folder] });
  }
  if (path === "/embed/catalog" || path === "/portal/catalog") {
    return ok({ frameAncestors: [], issuers: [] });
  }
  return ok({ items: [] });
}

async function fulfill(
  route: Route,
  permissions: readonly string[],
): Promise<void> {
  const path = apiPath(route.request().url());
  if (route.request().method() === "POST" && path === "/workflows/validate") {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        valid: true,
        summary: draftSummary,
        warnings: [],
      }),
    });
    return;
  }
  if (route.request().method() !== "GET") {
    const denied = problem(path, 405, "invalid-request", "Method not allowed");
    await route.fulfill({
      status: denied.status,
      contentType: denied.contentType,
      body: JSON.stringify(denied.body),
    });
    return;
  }
  const payload = bodyFor(route.request().url(), permissions);
  await route.fulfill({
    status: payload.status,
    contentType: payload.contentType,
    body: JSON.stringify(payload.body),
  });
}

/** Signed-in operator. Bootstrap is complete, so the wizard does not mount. */
export async function installOperatorApi(
  page: Page,
  options?: { permissions?: readonly string[] },
): Promise<void> {
  const permissions = options?.permissions ?? PERMISSIONS;
  await page.route(/\/api\/(?:v1|control-plane)\//, (route) =>
    fulfill(route, permissions),
  );
}

/** No cookie session. Standalone routes fall through to Login. */
export async function installSignedOutApi(page: Page): Promise<void> {
  await page.route(/\/api\/(?:v1|control-plane)\//, async (route) => {
    const path = apiPath(route.request().url());
    if (route.request().method() !== "GET") {
      const denied = problem(path, 405, "invalid-request", "Method not allowed");
      await route.fulfill({
        status: denied.status,
        contentType: denied.contentType,
        body: JSON.stringify(denied.body),
      });
      return;
    }
    if (path === "/session" || path === "/bootstrap") {
      const unauthenticated = problem(
        path,
        401,
        "unauthenticated",
        "Sign in required.",
      );
      await route.fulfill({
        status: unauthenticated.status,
        contentType: unauthenticated.contentType,
        body: JSON.stringify(unauthenticated.body),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [] }),
    });
  });
}

const SECRET_IN_STORAGE =
  /password|private[_ -]?key|begin [a-z ]+key|kek|kubeconfig|secret\s*[:=]/i;

/** Hard line: fixtures and the page must not persist secrets. */
export async function expectNoSecretsInBrowserStorage(page: Page): Promise<void> {
  const blob = await page.evaluate(() =>
    JSON.stringify({
      local: Object.fromEntries(
        Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]),
      ),
      session: Object.fromEntries(
        Object.keys(sessionStorage).map((key) => [
          key,
          sessionStorage.getItem(key),
        ]),
      ),
    }),
  );
  if (SECRET_IN_STORAGE.test(blob)) {
    throw new Error("browser storage contained a secret-shaped value");
  }
}
