import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { writeCanvasLayoutYaml } from "./editor-canvas-layout.ts";
import {
  EDITOR_WORKFLOW_NAME,
  WORKFLOW_NAME_EMPTY,
  WORKFLOW_NAME_INVALID,
  WORKFLOW_NAME_MAX_CHARS,
  WORKFLOW_NAME_SAVE_FAILED,
  editorHeadingRenamesInline,
  editorRenameUsesDraftSave,
  editorWorkflowRenameAllowed,
  workflowNameCommitDecision,
  workflowNameSaveError,
  writeYamlWorkflowName,
} from "./editor-workflow-name.ts";
import { readYamlWorkflowMeta } from "./workflow-yaml-nodes.ts";
import { STARTER_WORKFLOW_YAML } from "./workflow.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

describe("editor workflow name", () => {
  it("keeps #526 on the YAML draft-save path", () => {
    assert.equal(EDITOR_WORKFLOW_NAME.story, 526);
    assert.equal(EDITOR_WORKFLOW_NAME.yamlIsSourceOfTruth, true);
    assert.equal(EDITOR_WORKFLOW_NAME.draftsNeverRun, true);
    assert.equal(EDITOR_WORKFLOW_NAME.noNewNamePatch, true);
    assert.equal(EDITOR_WORKFLOW_NAME.slugRenameOutOfScope, true);
    assert.equal(EDITOR_WORKFLOW_NAME.inlineOnStickyHeading, true);
    assert.equal(EDITOR_WORKFLOW_NAME.enterCommits, true);
    assert.equal(EDITOR_WORKFLOW_NAME.escapeKeepsPriorName, true);
    assert.equal(EDITOR_WORKFLOW_NAME.emptyAndInvalidFailClosed, true);
    assert.equal(EDITOR_WORKFLOW_NAME.displayNameNotDnsGated, true);
    assert.equal(EDITOR_WORKFLOW_NAME.sameChromeOnEmbed, true);
    assert.equal(EDITOR_WORKFLOW_NAME.noNewEmbedRoutes, true);
    assert.equal(EDITOR_WORKFLOW_NAME.jonnyNotRequired, true);
    assert.equal(EDITOR_WORKFLOW_NAME.vaultDisplayNameUuidOnly, true);
    assert.equal(EDITOR_WORKFLOW_NAME.noSecretsInBrowser, true);
  });

  it("matches create display names and rejects empty, oversized, and control text", () => {
    assert.equal(WORKFLOW_NAME_MAX_CHARS, 200);
    assert.deepEqual(workflowNameCommitDecision("  ", "Blank draft"), {
      action: "invalid",
      error: WORKFLOW_NAME_EMPTY,
    });
    assert.deepEqual(workflowNameCommitDecision("\n\t", "Blank draft"), {
      action: "invalid",
      error: WORKFLOW_NAME_EMPTY,
    });
    assert.deepEqual(workflowNameCommitDecision("My rollout", "blank-draft"), {
      action: "commit",
      name: "My rollout",
    });
    assert.deepEqual(workflowNameCommitDecision("  Deploy: API (prod) #2  ", "blank-draft"), {
      action: "commit",
      name: "Deploy: API (prod) #2",
    });
    assert.deepEqual(workflowNameCommitDecision("O'Reilly", "blank-draft"), {
      action: "commit",
      name: "O'Reilly",
    });
    assert.deepEqual(workflowNameCommitDecision("  Blank draft  ", "Blank draft"), {
      action: "keep",
    });
    assert.deepEqual(workflowNameCommitDecision("bad\nname", "Blank draft"), {
      action: "invalid",
      error: WORKFLOW_NAME_INVALID,
    });
    assert.deepEqual(workflowNameCommitDecision("a".repeat(201), "Blank draft"), {
      action: "invalid",
      error: WORKFLOW_NAME_INVALID,
    });
    assert.deepEqual(workflowNameCommitDecision("a".repeat(200), "Blank draft"), {
      action: "commit",
      name: "a".repeat(200),
    });
  });

  it("hides secret-shaped save details", () => {
    assert.equal(workflowNameSaveError(""), WORKFLOW_NAME_SAVE_FAILED);
    assert.equal(
      workflowNameSaveError("metadata.name must be 1-200 characters"),
      "metadata.name must be 1-200 characters",
    );
    assert.equal(
      workflowNameSaveError("refused token=abc"),
      WORKFLOW_NAME_SAVE_FAILED,
    );
  });

  it("allows rename only with workflow.edit, a loaded draft, and a valid buffer", () => {
    const ready = {
      canCall: true,
      hasWorkflow: true,
      revision: 3,
      pending: null,
      canSave: true,
      permissions: ["workflow.view", "workflow.edit"],
    };
    assert.equal(editorWorkflowRenameAllowed(ready), true);
    assert.equal(
      editorWorkflowRenameAllowed({ ...ready, permissions: ["workflow.view"] }),
      false,
    );
    assert.equal(
      editorWorkflowRenameAllowed({ ...ready, permissions: null }),
      false,
    );
    assert.equal(editorWorkflowRenameAllowed({ ...ready, canSave: false }), false);
    assert.equal(editorWorkflowRenameAllowed({ ...ready, pending: "save" }), false);
    assert.equal(editorWorkflowRenameAllowed({ ...ready, revision: null }), false);
    assert.equal(editorWorkflowRenameAllowed({ ...ready, canCall: false }), false);
    assert.equal(
      editorWorkflowRenameAllowed({ ...ready, hasWorkflow: false }),
      false,
    );
  });

  it("writes metadata.name and leaves node names, slug, and layout alone", () => {
    const yaml = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: "validate-example"
  slug: keep-slug
  labels:
    name: not-the-workflow
spec:
  description: kept
  nodes:
    - id: seed
      type: data.set
      name: Seed value
      with:
        value:
          status: ready
    - id: done
      type: flow.stop
      name: Stop
`;
    const written = writeYamlWorkflowName(yaml, "renamed-flow");
    assert.ok(written);
    assert.match(written, /^ {2}name: renamed-flow$/m);
    assert.match(written, /name: Seed value/);
    assert.match(written, /name: Stop/);
    assert.match(written, /slug: keep-slug/);
    assert.match(written, /name: not-the-workflow/);
    assert.equal(written.includes("validate-example"), false);
    const fromStarter = writeYamlWorkflowName(STARTER_WORKFLOW_YAML, "renamed-flow");
    assert.ok(fromStarter);
    assert.equal(readYamlWorkflowMeta(fromStarter).name, "renamed-flow");
    assert.match(fromStarter, /name: Seed value/);
    const laidOut = writeCanvasLayoutYaml(written, {
      seed: { x: 12, y: 8 },
    });
    assert.match(laidOut, /^ {2}name: renamed-flow$/m);
    assert.match(laidOut, /x: 12/);
    assert.match(laidOut, /name: Seed value/);
  });

  it("inserts metadata.name when the key is missing and refuses unsafe blocks", () => {
    const missing = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  labels:
    team: platform
spec:
  description: kept
`;
    const inserted = writeYamlWorkflowName(missing, "added-name");
    assert.ok(inserted);
    assert.equal(readYamlWorkflowMeta(inserted).name, "added-name");
    assert.match(inserted, /description: kept/);
    const titled = writeYamlWorkflowName(missing, "Not a label");
    assert.ok(titled);
    assert.equal(readYamlWorkflowMeta(titled).name, "Not a label");
    assert.match(titled, /name: "Not a label"/);
    assert.equal(writeYamlWorkflowName(missing, " "), null);
    assert.equal(writeYamlWorkflowName(missing, "bad\nname"), null);
    const folded = `metadata:\n  name: |\n    folded\nspec:\n  description: x\n`;
    assert.equal(writeYamlWorkflowName(folded, "safe-name"), null);
    const inline = `metadata: { name: old }\nspec:\n  description: x\n`;
    assert.equal(writeYamlWorkflowName(inline, "safe-name"), null);
  });

  it("wires sticky inline rename to the draft save path", () => {
    const topBar = source("src/components/workflows/EditorTopBar.tsx");
    const operator = source("src/components/workflows/WorkflowOperator.tsx");
    assert.equal(editorHeadingRenamesInline(topBar), true);
    assert.equal(editorRenameUsesDraftSave(operator), true);
    assert.equal(operator.includes('method: "PATCH"'), false);
    assert.match(topBar, /data-editor-workflow-name="error"/);
    assert.match(topBar, /WORKFLOW_NAME_EMPTY|workflowNameCommitDecision/);
  });

  it("keeps the name column readable when secondary controls collapse", () => {
    const topBar = source("src/components/workflows/EditorTopBar.tsx");
    assert.match(topBar, /min-w-\[12rem\] grow basis-\[12rem\]/);
    assert.match(topBar, /max-\[1680px\]:basis-full/);
    assert.match(topBar, /max-\[1680px\]:sr-only/);
    assert.match(topBar, /w-full min-w-\[12rem\]/);
    assert.match(topBar, /title=\{heading\}/);
    assert.match(topBar, /title=\{context\.slug\}/);
    assert.doesNotMatch(topBar, /aria-haspopup="menu"/);
    assert.doesNotMatch(topBar, /data-editor-topbar="overflow"/);
    assert.doesNotMatch(topBar, /<details/);
    const viewer = topBar.slice(topBar.lastIndexOf(") : ("));
    assert.match(viewer, /title=\{heading\}/);
    assert.match(viewer, /\{heading\}/);
    assert.doesNotMatch(viewer, /<button/);
    assert.doesNotMatch(viewer, /data-editor-workflow-name="heading"/);
  });
});
