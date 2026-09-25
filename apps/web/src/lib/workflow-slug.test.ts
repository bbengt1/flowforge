import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WORKFLOW_TEMPLATES, workflowTemplateById } from "./workflow-templates.ts";
import { rememberCreatedWorkflow, takeCreatedWorkflow } from "./created-workflow.ts";
import {
  WORKFLOW_SLUG_PREVIEW_FALLBACK,
  WORKFLOW_SLUG_PREVIEW_HINT,
  WORKFLOW_SLUG_PREVIEW_LABEL,
  WORKFLOW_SLUG_PREVIEW_MAX_LEN,
  createdWorkflowSlugDetail,
  previewCreateFormSlug,
  previewWorkflowSlug,
  workflowCreateRequestFields,
} from "./workflow-slug.ts";

describe("previewWorkflowSlug", () => {
  it("matches the API derivation rules", () => {
    assert.equal(WORKFLOW_SLUG_PREVIEW_MAX_LEN, 63);
    assert.equal(previewWorkflowSlug("Deploy API"), "deploy-api");
    assert.equal(previewWorkflowSlug("restart-api-rollout"), "restart-api-rollout");
    assert.equal(previewWorkflowSlug("O'Reilly (prod) #2"), "o-reilly-prod-2");
    assert.equal(previewWorkflowSlug("9 lives"), "w-9-lives");
    assert.equal(previewWorkflowSlug("123"), "w-123");
    assert.equal(previewWorkflowSlug("!!!"), WORKFLOW_SLUG_PREVIEW_FALLBACK);
    assert.equal(previewWorkflowSlug("  "), WORKFLOW_SLUG_PREVIEW_FALLBACK);
    assert.equal(previewWorkflowSlug(""), WORKFLOW_SLUG_PREVIEW_FALLBACK);
    assert.equal(previewWorkflowSlug("部署"), WORKFLOW_SLUG_PREVIEW_FALLBACK);
    assert.equal(previewWorkflowSlug("🎉"), WORKFLOW_SLUG_PREVIEW_FALLBACK);
    assert.equal(previewWorkflowSlug("Café"), "caf");
    assert.equal(previewWorkflowSlug("Catalog"), "catalog");
    assert.equal(previewWorkflowSlug("A--B   C"), "a-b-c");

    const long = `${"A".repeat(80)} ${"B".repeat(80)}`;
    const capped = previewWorkflowSlug(long);
    assert.equal(capped, "a".repeat(63));
    assert.equal(capped.length, 63);
    assert.equal(capped.endsWith("-"), false);

    const cutOnHyphen = `${"a".repeat(62)}!!b`;
    assert.equal(previewWorkflowSlug(cutOnHyphen), "a".repeat(62));

    const digitCap = `9${"a".repeat(59)} zzz`;
    const digitSlug = previewWorkflowSlug(digitCap);
    assert.equal(digitSlug, `w-9${"a".repeat(59)}`);
    assert.ok(digitSlug.length <= 63);
    assert.equal(digitSlug.startsWith("w-"), true);
    assert.equal(digitSlug.endsWith("-"), false);
  });

  it("previews the name the create form will send", () => {
    assert.equal(previewCreateFormSlug("Redeploy API", "Blank draft"), "redeploy-api");
    assert.equal(previewCreateFormSlug("  ", "Blank draft"), "blank-draft");
    assert.equal(previewCreateFormSlug("", "Blank draft"), "blank-draft");
    assert.equal(previewCreateFormSlug("🎉", "Blank draft"), "workflow");
    assert.equal(previewCreateFormSlug("", ""), "workflow");
  });
});

describe("workflowCreateRequestFields", () => {
  it("omits an unedited slug preview", () => {
    assert.deepEqual(
      workflowCreateRequestFields({
        name: "Redeploy API",
        slug: "redeploy-api",
        slugEdited: false,
      }),
      { name: "Redeploy API" },
    );
    assert.equal(
      "slug" in
        workflowCreateRequestFields({
          name: "Redeploy",
          slug: previewWorkflowSlug("Redeploy"),
          slugEdited: false,
        }),
      false,
    );
    assert.deepEqual(
      workflowCreateRequestFields({
        name: "  ",
        slug: "workflow",
        slugEdited: false,
      }),
      {},
    );
  });

  it("sends a slug only after the field is edited, including an explicit duplicate", () => {
    assert.deepEqual(
      workflowCreateRequestFields({
        name: "Redeploy",
        slug: "  custom-slug  ",
        slugEdited: true,
      }),
      { name: "Redeploy", slug: "custom-slug" },
    );
    assert.deepEqual(
      workflowCreateRequestFields({
        name: "Deploy copy",
        slug: "deploy-copy",
        slugEdited: true,
      }),
      { name: "Deploy copy", slug: "deploy-copy" },
    );
    assert.deepEqual(
      workflowCreateRequestFields({
        name: "Redeploy",
        slug: "   ",
        slugEdited: true,
      }),
      { name: "Redeploy" },
    );
  });
});

describe("created workflow slug", () => {
  it("labels the preview as an estimate and confirms the server slug", () => {
    assert.equal(WORKFLOW_SLUG_PREVIEW_LABEL, "Suggested slug");
    assert.match(WORKFLOW_SLUG_PREVIEW_HINT, /may add a number/);
    const preview = previewWorkflowSlug("My Flow");
    assert.equal(preview, "my-flow");
    const detail = createdWorkflowSlugDetail({
      slug: "my-flow-2",
      name: "My Flow",
    });
    assert.equal(detail, "Created as my-flow-2");
    assert.equal(detail.includes(preview), false);
    assert.equal(createdWorkflowSlugDetail({ slug: "  my-flow-2  " }), "Created as my-flow-2");
    assert.equal(createdWorkflowSlugDetail({ slug: "", name: "My Flow" }), "My Flow");
    assert.equal(createdWorkflowSlugDetail(null), "Editable draft ready");
  });

  it("hands the create response to the editor once", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const draft = {
      workflowId: id,
      revision: 1,
      definitionYaml: "apiVersion: flowforge/v1\nkind: Workflow\n",
      digest: "sha256:handoff",
      summary: {
        apiVersion: "flowforge/v1",
        name: "My Flow",
        triggers: [],
        nodes: [],
        edges: [],
        outputs: [],
      },
      warnings: [],
      validationState: "valid",
      updatedAt: "2026-09-25T00:00:00Z",
    };
    const workflow = {
      id,
      slug: "my-flow-2",
      name: "My Flow",
      status: "draft",
      draftRevision: 1,
      draftDigest: draft.digest,
      latestVersionNumber: 0,
      createdAt: "2026-09-25T00:00:00Z",
      updatedAt: "2026-09-25T00:00:00Z",
    };
    rememberCreatedWorkflow({ workflow, draft });
    assert.equal(takeCreatedWorkflow("other"), null);
    const taken = takeCreatedWorkflow(id);
    assert.equal(taken?.workflow.slug, "my-flow-2");
    assert.equal(takeCreatedWorkflow(id), null);
    rememberCreatedWorkflow({
      workflow: { ...workflow, slug: "   " },
      draft,
    });
    assert.equal(takeCreatedWorkflow(id), null);
    rememberCreatedWorkflow({
      workflow,
      draft: { ...draft, workflowId: "44444444-4444-4444-8444-444444444444" },
    });
    assert.equal(takeCreatedWorkflow(id), null);
  });
});

describe("starter templates", () => {
  it("carries no metadata.slug and no slug hint", () => {
    assert.ok(WORKFLOW_TEMPLATES.length >= 4);
    for (const template of WORKFLOW_TEMPLATES) {
      assert.equal("slugHint" in template, false);
      assert.equal(template.definitionYaml.includes(`name: ${template.name}`), true);
      assert.equal(/^\s*slug\s*:/m.test(template.definitionYaml), false);
      assert.equal(template.definitionYaml.includes("kind: Workflow"), true);
    }
    const blank = workflowTemplateById("blank");
    assert.ok(blank);
    assert.equal(blank.definitionYaml.includes("blank-draft"), false);
    assert.equal(blank.name, "Blank draft");
  });
});
