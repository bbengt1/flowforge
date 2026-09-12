/**
 * R6.1 activation client — compose existing E10 list + enable/disable.
 *
 * Relates to #270 / Part of #232. Keep #270 open.
 *
 * No new activation collection. CSRF stays on the existing webhook and
 * schedule clients. Secrets are never read or shown.
 */

import type { DevIdentity } from "./identity-headers.ts";
import { isResourceId } from "./identity-proxy-ids.ts";
import type { ProblemDetails } from "./problem.ts";
import {
  disableScheduleTrigger,
  enableScheduleTrigger,
  listScheduleTriggers,
} from "./schedule-trigger-client.ts";
import type { ScheduleTriggerRecord } from "./schedule-trigger-contract.ts";
import {
  disableWebhookTrigger,
  enableWebhookTrigger,
  listWebhookTriggers,
} from "./webhook-trigger-client.ts";
import type { WebhookTriggerRecord } from "./webhook-trigger-contract.ts";
import { listWorkflowVersions } from "./workflow-client.ts";
import type { WorkflowCatalog, WorkflowVersion } from "./workflow-types.ts";
import {
  activationPinsFromRecords,
  activationTogglePlan,
  composeEditorActivation,
  notifyEditorActivationChanged,
  type ActivationIntent,
  type EditorActivationPin,
  type EditorActivationState,
  type EditorActivationToggle,
} from "./editor-activation.ts";

export type EditorActivationLoadSuccess = {
  ok: true;
  versions: WorkflowVersion[];
  webhooks: WebhookTriggerRecord[];
  schedules: ScheduleTriggerRecord[];
  pins: EditorActivationPin[];
  state: EditorActivationState;
};

export type EditorActivationLoadFailure = {
  ok: false;
  problem: ProblemDetails;
  versions: WorkflowVersion[];
  webhooks: WebhookTriggerRecord[];
  schedules: ScheduleTriggerRecord[];
  pins: EditorActivationPin[];
  state: EditorActivationState;
};

export type EditorActivationToggleSuccess = {
  ok: true;
  applied: EditorActivationToggle[];
  message: string;
};

export type EditorActivationToggleFailure = {
  ok: false;
  problem: ProblemDetails;
  applied: EditorActivationToggle[];
};

function emptyActivationProblem(detail: string): ProblemDetails {
  return {
    type: "urn:flowforge:problem:invalid-request",
    title: "Invalid request",
    status: 400,
    detail,
    instance: "/workflows/{workflowId}/triggers",
    code: "invalid-request",
    request_id: "",
  };
}

export async function loadEditorActivation(
  identity: DevIdentity,
  workflowId: string,
  options: {
    catalog?: WorkflowCatalog | null;
    selectedVersionId?: string | null;
    canView?: boolean;
  } = {},
): Promise<EditorActivationLoadSuccess | EditorActivationLoadFailure> {
  if (!isResourceId(workflowId)) {
    const state = composeEditorActivation({
      versions: [],
      pins: [],
      selectedVersionId: options.selectedVersionId,
    });
    return {
      ok: false,
      problem: emptyActivationProblem(
        "workflowId must be a workspace resource UUID.",
      ),
      versions: [],
      webhooks: [],
      schedules: [],
      pins: [],
      state,
    };
  }

  const canView = options.canView !== false;
  const [versionResult, webhookResult, scheduleResult] = await Promise.all([
    listWorkflowVersions(identity, workflowId),
    canView
      ? listWebhookTriggers(identity, workflowId, options.catalog)
      : Promise.resolve(null),
    canView
      ? listScheduleTriggers(identity, workflowId, options.catalog)
      : Promise.resolve(null),
  ]);

  const versions = versionResult.ok ? versionResult.items : [];
  const webhooks =
    webhookResult && webhookResult.ok ? webhookResult.items : [];
  const schedules =
    scheduleResult && scheduleResult.ok ? scheduleResult.items : [];
  const pins = activationPinsFromRecords({ webhooks, schedules });
  const state = composeEditorActivation({
    versions,
    pins,
    selectedVersionId: options.selectedVersionId,
  });

  const problem = !versionResult.ok
    ? versionResult.problem
    : webhookResult && !webhookResult.ok
      ? webhookResult.problem
      : scheduleResult && !scheduleResult.ok
        ? scheduleResult.problem
        : null;

  if (problem) {
    return {
      ok: false,
      problem,
      versions,
      webhooks,
      schedules,
      pins,
      state,
    };
  }

  return {
    ok: true,
    versions,
    webhooks,
    schedules,
    pins,
    state,
  };
}

export async function applyEditorActivationToggle(
  identity: DevIdentity,
  workflowId: string,
  pins: readonly EditorActivationPin[],
  versionId: string | null | undefined,
  intent: ActivationIntent,
  catalog?: WorkflowCatalog | null,
): Promise<EditorActivationToggleSuccess | EditorActivationToggleFailure> {
  const plan = activationTogglePlan(pins, versionId, intent);
  if (!isResourceId(workflowId)) {
    return {
      ok: false,
      applied: [],
      problem: emptyActivationProblem(
        "workflowId must be a workspace resource UUID.",
      ),
    };
  }
  if (!isResourceId(versionId ?? undefined)) {
    return {
      ok: false,
      applied: [],
      problem: emptyActivationProblem(
        "Activation pins a published workflowVersionId. Drafts never run.",
      ),
    };
  }
  if (plan.length === 0) {
    return {
      ok: false,
      applied: [],
      problem: emptyActivationProblem(
        intent === "enable"
          ? "No disabled webhook or schedule pins on this published version."
          : "No enabled webhook or schedule pins on this published version.",
      ),
    };
  }

  const applied: EditorActivationToggle[] = [];
  for (const step of plan) {
    const result =
      step.kind === "webhook"
        ? step.action === "disable"
          ? await disableWebhookTrigger(identity, workflowId, step.id, catalog)
          : await enableWebhookTrigger(identity, workflowId, step.id, catalog)
        : step.action === "disable"
          ? await disableScheduleTrigger(
              identity,
              workflowId,
              step.id,
              catalog,
            )
          : await enableScheduleTrigger(
              identity,
              workflowId,
              step.id,
              catalog,
            );
    if (!result.ok) {
      return {
        ok: false,
        applied,
        problem: result.problem,
      };
    }
    applied.push(step);
  }

  notifyEditorActivationChanged();
  return {
    ok: true,
    applied,
    message:
      intent === "enable"
        ? "Enabled webhook and schedule pins on this published version."
        : "Disabled webhook and schedule pins on this published version.",
  };
}
