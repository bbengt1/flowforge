import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CONFIRM_DESTRUCTIVE_IRREVERSIBLE,
  CONFIRM_DESTRUCTIVE_UNDO_HINT,
  DESTRUCTIVE_UNDO_LABEL,
  DESTRUCTIVE_UNDO_WINDOW_MS,
  FOLDER_DELETE_DESCRIPTION,
  armDestructiveUndo,
  confirmDestructiveConsequence,
  credentialDeleteImpactItems,
  destructiveImpactIdIsSecret,
  destructiveUndoStillOpen,
  emergencyStopImpact,
  folderDeleteImpact,
  memberRemoveImpact,
  openDestructiveUndo,
  sanitizeDestructiveImpact,
  scheduleDeleteImpact,
  scriptRevokeImpact,
  summarizeAffected,
  webhookDeleteImpact,
} from "./confirm-destructive.ts";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "..");

function source(relative: string): string {
  return readFileSync(join(webRoot, relative), "utf8");
}

const UNDOABLE_SURFACES = [
  "src/components/home/WorkflowHome.tsx",
  "src/components/workflows/ScheduleTriggerPanel.tsx",
  "src/components/workflows/WebhookTriggerPanel.tsx",
  "src/components/membership/MembersPanel.tsx",
] as const;

const IRREVERSIBLE_SURFACES = [
  "src/components/credentials/DeleteImpactDialog.tsx",
  "src/components/workflows/ScriptPublishStatus.tsx",
  "src/components/executions/ExecutionDetail.tsx",
  "src/components/executions/ExecutionOperateActions.tsx",
] as const;

describe("G.3.2 destructive impact", () => {
  it("drops secret-bearing ids and keeps display-name and vault uuid rows", () => {
    assert.equal(destructiveImpactIdIsSecret("secret"), true);
    assert.equal(destructiveImpactIdIsSecret("inlineSecret"), true);
    assert.equal(destructiveImpactIdIsSecret("token"), true);
    assert.equal(destructiveImpactIdIsSecret("password"), true);
    assert.equal(destructiveImpactIdIsSecret("kubeconfig"), true);
    assert.equal(destructiveImpactIdIsSecret("secretCredentialId"), true);
    assert.equal(destructiveImpactIdIsSecret("linked-vault"), false);
    assert.equal(destructiveImpactIdIsSecret("credential"), false);
    const cleaned = sanitizeDestructiveImpact([
      { id: "secret", label: "Secret", detail: "hunter2" },
      { id: "token", label: "Token", detail: "abc" },
      { id: "webhook", label: "Webhook", detail: "pub_1" },
      { id: "linked-vault", label: "Vault credential", detail: "uuid-1" },
    ]);
    assert.deepEqual(
      cleaned.map((item) => item.id),
      ["webhook", "linked-vault"],
    );
    assert.equal(JSON.stringify(cleaned).includes("hunter2"), false);
  });

  it("previews folder, schedule, webhook, member, credential, revoke, and stop impact", () => {
    const folder = folderDeleteImpact({
      name: "Ops",
      childFolderCount: 0,
      workflowCount: 0,
    });
    assert.equal(folder[0]?.detail, "Ops");
    assert.match(folder.map((item) => item.detail).join(" "), /None in this folder/);

    const unknown = folderDeleteImpact({
      name: "Ops",
      childFolderCount: 1,
      workflowCount: null,
    });
    assert.match(unknown.map((item) => item.detail).join(" "), /not empty/);

    const schedule = scheduleDeleteImpact({
      id: "sched-1",
      expression: "cron 0 * * * *",
      timezone: "UTC",
      status: "enabled",
      nextFireAt: "2026-09-23T16:00:00Z",
    });
    assert.match(schedule.map((item) => item.detail).join(" "), /sched-1/);
    assert.match(schedule.map((item) => item.detail).join(" "), /UTC/);
    assert.match(schedule.map((item) => item.detail).join(" "), /2026-09-23/);

    const webhook = webhookDeleteImpact({
      id: "hook-1",
      publicId: "pub_1",
      ingressPath: "/hooks/pub_1",
      status: "enabled",
      secretCredentialId: "11111111-1111-4111-8111-111111111111",
    });
    assert.equal(webhook[0]?.detail, "pub_1");
    assert.match(
      webhook.map((item) => item.detail).join(" "),
      /11111111-1111-4111-8111-111111111111/,
    );
    assert.equal(JSON.stringify(webhook).includes("hunter2"), false);

    const member = memberRemoveImpact({
      displayName: "Ada",
      subject: "ada",
      roles: ["viewer", "operator"],
    });
    assert.match(member.map((item) => item.detail).join(" "), /Ada/);
    assert.match(member.map((item) => item.detail).join(" "), /viewer, operator/);

    const credential = credentialDeleteImpactItems({
      credentialId: "cred-1",
      displayName: "prod-k8s",
      canDelete: false,
      blockReason: "Active executions still reference this credential.",
      drafts: ["deploy-edge"],
      versions: [],
      activeExecutions: ["deploy-edge · running"],
    });
    assert.match(credential[0]?.detail ?? "", /prod-k8s \(cred-1\)/);
    assert.match(credential.map((item) => item.detail).join(" "), /deploy-edge/);
    assert.match(credential.map((item) => item.detail).join(" "), /Active executions/);
    assert.equal(
      summarizeAffected(["a", "b", "c", "d", "e", "f", "g", "h", "i"], "None"),
      "a, b, c, d, e, f, g, h, and 1 more",
    );

    const revoke = scriptRevokeImpact({
      id: "art-1",
      digest: "sha256:abc",
      language: "javascript",
      status: "active",
    });
    assert.equal(revoke.some((item) => item.id === "signature"), false);
    assert.match(revoke.map((item) => item.detail).join(" "), /sha256:abc/);

    const stop = emergencyStopImpact({
      executionId: "exec-1",
      stepId: "step-1",
      status: "running",
    });
    assert.match(stop.map((item) => item.detail).join(" "), /exec-1/);
    assert.match(stop.map((item) => item.detail).join(" "), /step-1/);
    assert.match(stop.map((item) => item.detail).join(" "), /retry/);
  });
});

describe("G.3.2 undo only where it is real", () => {
  it("offers undo for cheap paths and states irreversible paths cannot be undone", () => {
    const undoable = confirmDestructiveConsequence("undoable");
    assert.equal(undoable.offersUndo, true);
    assert.equal(undoable.message, CONFIRM_DESTRUCTIVE_UNDO_HINT);
    assert.match(undoable.message, /before it is sent/);
    const irreversible = confirmDestructiveConsequence("irreversible");
    assert.equal(irreversible.offersUndo, false);
    assert.equal(irreversible.message, CONFIRM_DESTRUCTIVE_IRREVERSIBLE);
    assert.match(irreversible.message, /cannot be undone/);
    assert.doesNotMatch(irreversible.message, /\bUndo\b/);
  });

  it("keeps an undo window open until commit time and commits a different in-flight id", () => {
    const ticket = openDestructiveUndo({ id: "folder-1", now: 1_000, token: 1 });
    assert.equal(ticket.commitAt, 1_000 + DESTRUCTIVE_UNDO_WINDOW_MS);
    assert.equal(
      destructiveUndoStillOpen({ now: ticket.commitAt - 1, commitAt: ticket.commitAt }),
      true,
    );
    assert.equal(
      destructiveUndoStillOpen({ now: ticket.commitAt, commitAt: ticket.commitAt }),
      false,
    );
    const replaced = armDestructiveUndo({
      current: ticket,
      nextId: "folder-2",
      now: 1_500,
      token: 2,
    });
    assert.equal(replaced.commitId, "folder-1");
    assert.equal(replaced.ticket.id, "folder-2");
    const reset = armDestructiveUndo({
      current: ticket,
      nextId: "folder-1",
      now: 1_500,
      token: 3,
    });
    assert.equal(reset.commitId, null);
    assert.equal(reset.ticket.id, "folder-1");
    assert.equal(reset.ticket.token, 3);
  });
});

describe("G.3.2 shared confirm on primary surfaces", () => {
  it("uses the G.3.1 dialog and does not render an undo control on the irreversible dialog", () => {
    const component = source("src/components/a11y/ConfirmDestructive.tsx");
    assert.match(component, /from "@\/components\/a11y\/Dialog"/);
    assert.equal(component.includes('role="dialog"'), false);
    assert.match(component, /confirmDestructiveConsequence/);
    assert.match(component, /sanitizeDestructiveImpact/);
    const start = component.indexOf("export function ConfirmDestructive");
    const end = component.indexOf("export function DestructiveUndoBar");
    const body = component.slice(start, end);
    assert.equal(body.includes("DestructiveUndoBar"), false);
    assert.equal(body.includes(`{${DESTRUCTIVE_UNDO_LABEL}}`), false);
    assert.equal(body.includes('data-confirm-destructive="undo"'), false);
    assert.match(component, /data-confirm-destructive="undo"/);
    assert.equal(component.includes("LoginChrome"), false);
    assert.equal(component.includes("ChangePasswordChrome"), false);
    assert.equal(component.includes("FirstRunWizard"), false);
    assert.equal(component.includes("localStorage"), false);
    assert.equal(component.includes("/embed/v1"), false);
  });

  it("replaces ad-hoc confirms and keeps undo off irreversible paths", () => {
    for (const relative of UNDOABLE_SURFACES) {
      const text = source(relative);
      assert.match(text, /ConfirmDestructive/, relative);
      assert.match(text, /reversibility="undoable"/, relative);
      assert.match(text, /DestructiveUndoBar/, relative);
      assert.match(text, /useDestructiveUndo/, relative);
    }
    for (const relative of IRREVERSIBLE_SURFACES) {
      const text = source(relative);
      assert.match(text, /ConfirmDestructive/, relative);
      assert.match(text, /reversibility="irreversible"/, relative);
      assert.equal(text.includes("useDestructiveUndo"), false, relative);
      assert.equal(text.includes("DestructiveUndoBar"), false, relative);
    }
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.match(home, /FOLDER_EMPTY_HELP/);
    assert.match(home, /removeFolder/);
    assert.match(home, /askDeleteFolder/);
    assert.match(home, /FOLDER_DELETE_DESCRIPTION/);
    assert.equal(
      source("src/lib/confirm-destructive.ts").includes(FOLDER_DELETE_DESCRIPTION),
      true,
    );
    const folders = source("src/lib/workflow-folder.ts");
    assert.match(folders, /Drafts do not run/);
    assert.match(folders, /session\.embed/);
    const webhook = source("src/components/workflows/WebhookTriggerPanel.tsx");
    const call = webhook.slice(webhook.indexOf("webhookDeleteImpact("));
    const snippet = call.slice(0, call.indexOf(")}"));
    assert.equal(snippet.includes("secret:"), false);
    assert.equal(snippet.includes("rotateSecrets"), false);
    assert.match(snippet, /secretCredentialId/);
  });
});
