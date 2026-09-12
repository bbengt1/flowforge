import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isWorkflowEditorPath } from "./editor-chrome.ts";
import { listExecutionsPath } from "./execution-contract.ts";
import {
  PRODUCT_HOME,
  PRODUCT_HOME_HREF,
  PRODUCT_HOME_SOURCES,
  SETTINGS_HEALTH_HREF,
  SETTINGS_HREF,
  SETTINGS_OPENAPI_HREF,
  UX8_EPIC,
  UX8_KEEP_STORY_OPEN,
  UX8_STORY,
  editorDeepLinkUnchanged,
  editorIsProductHome,
  isProductHomePath,
  productHomeCapabilities,
  productHomeHref,
  shouldLandOnWorkflowsHome,
  templateCreatedEditorHref,
  workflowEditorHref,
  workflowHomeLastRunHref,
  workflowHomeRowActions,
} from "./product-home.ts";

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

describe("UX.8 product home", () => {
  it("keeps #203 open and cites epic #195", () => {
    assert.equal(UX8_STORY, 203);
    assert.equal(UX8_EPIC, 195);
    assert.equal(UX8_KEEP_STORY_OPEN, true);
    assert.equal(PRODUCT_HOME.rootWithWorkflowViewLandsOnWorkflows, true);
    assert.equal(PRODUCT_HOME.healthAndOpenApiLiveUnderSettings, true);
    assert.equal(PRODUCT_HOME.editorIsNotASecondHome, true);
    assert.equal(PRODUCT_HOME.deepLinksStayValidStandaloneAndEmbed, true);
    assert.equal(PRODUCT_HOME.templatesPostDraftThenOpenEditor, true);
    assert.equal(PRODUCT_HOME.noAppsApiChanges, true);
  });

  it("sends workflow.view to /workflows and keeps health/OpenAPI on Settings", () => {
    assert.equal(shouldLandOnWorkflowsHome(["workflow.view"]), true);
    assert.equal(shouldLandOnWorkflowsHome(null), false);
    assert.equal(shouldLandOnWorkflowsHome(["execution.view"]), false);
    assert.equal(productHomeHref(["workflow.view"]), PRODUCT_HOME_HREF);
    assert.equal(productHomeHref([]), SETTINGS_HREF);
    assert.equal(isProductHomePath("/workflows"), true);
    assert.equal(isProductHomePath("/"), false);
    assert.equal(isProductHomePath(`/workflows/${WORKFLOW_ID}`), false);
    assert.equal(SETTINGS_HEALTH_HREF, "/settings#health");
    assert.equal(SETTINGS_OPENAPI_HREF, "/settings#api-docs");

    const root = source("src/app/page.tsx");
    assert.equal(root.includes("ApiHealthCard"), false);
    assert.equal(root.includes("ApiDocsLinks"), false);
    assert.match(root, /ProductHomeLanding/);

    const landing = source("src/components/home/ProductHomeLanding.tsx");
    assert.match(landing, /shouldLandOnWorkflowsHome/);
    assert.match(landing, /router\.replace\(PRODUCT_HOME_HREF\)/);
    assert.match(landing, /href=\{PRODUCT_HOME_HREF\}/);

    const settings = source("src/app/settings/page.tsx");
    assert.match(settings, /ApiHealthCard/);
    assert.match(settings, /ApiDocsLinks/);
    assert.match(settings, /id="health"/);
    assert.match(settings, /id="api-docs"/);
  });

  it("gates home rows and sends last run to /executions/{id} or ?workflowId=", () => {
    const viewer = productHomeCapabilities(["workflow.view"]);
    assert.equal(viewer.canExecute, false);
    assert.equal(viewer.canPublish, false);
    assert.equal(viewer.canViewWebhooks, true);
    assert.equal(viewer.canViewSchedules, true);
    assert.equal(viewer.canSeeLastRun, false);

    const editor = productHomeCapabilities([
      "workflow.view",
      "workflow.execute",
      "execution.view",
    ]);
    const published = workflowHomeRowActions({
      published: true,
      lastRunId: EXECUTION_ID,
      workflowId: WORKFLOW_ID,
      capabilities: editor,
    });
    assert.equal(published.openEditor, `/workflows/${WORKFLOW_ID}`);
    assert.equal(published.startPublished, true);
    assert.equal(published.testRun, false);
    assert.equal(published.webhooks, true);
    assert.equal(published.schedules, true);
    assert.equal(published.lastRunHref, `/executions/${EXECUTION_ID}`);
    assert.equal(published.activationHref, `/workflows/${WORKFLOW_ID}#activation`);

    const draft = workflowHomeRowActions({
      published: false,
      workflowId: WORKFLOW_ID,
      capabilities: editor,
    });
    assert.equal(draft.startPublished, false);
    assert.equal(draft.testRun, false);
    assert.equal(
      draft.lastRunHref,
      listExecutionsPath({ workflowId: WORKFLOW_ID }),
    );
    assert.equal(
      workflowHomeLastRunHref({ workflowId: WORKFLOW_ID }),
      `/executions?workflowId=${WORKFLOW_ID}`,
    );

    const locked = workflowHomeRowActions({
      published: true,
      lastRunId: EXECUTION_ID,
      workflowId: WORKFLOW_ID,
      capabilities: viewer,
    });
    assert.equal(locked.startPublished, false);
    assert.equal(locked.testRun, false);
    assert.equal(locked.lastRunHref, null);

    const publisher = productHomeCapabilities([
      "workflow.view",
      "workflow.publish",
      "workflow.execute",
    ]);
    const unpublishedTest = workflowHomeRowActions({
      published: false,
      workflowId: WORKFLOW_ID,
      capabilities: publisher,
    });
    assert.equal(unpublishedTest.startPublished, false);
    assert.equal(unpublishedTest.testRun, true);

    const home = source("src/components/home/WorkflowHome.tsx");
    assert.match(home, /Start published/);
    assert.match(home, /Test run/);
    assert.match(home, /workflowHomeLastRunHref/);
    assert.match(home, /canViewWebhooks/);
    assert.match(home, /canViewSchedules/);
    assert.match(home, /canSeeLastRun/);
  });

  it("keeps the editor off the home list and templates routing into /workflows/{id}", () => {
    assert.equal(editorIsProductHome(`/workflows/${WORKFLOW_ID}`), false);
    assert.equal(isWorkflowEditorPath(`/workflows/${WORKFLOW_ID}`), true);
    assert.equal(isProductHomePath(`/workflows/${WORKFLOW_ID}`), false);
    assert.equal(editorDeepLinkUnchanged(WORKFLOW_ID), true);
    assert.equal(
      templateCreatedEditorHref(WORKFLOW_ID),
      workflowEditorHref(WORKFLOW_ID),
    );
    assert.equal(templateCreatedEditorHref(""), PRODUCT_HOME_HREF);

    const operator = source("src/components/workflows/WorkflowOperator.tsx");
    assert.equal(operator.includes("WorkflowList"), false);
    assert.equal(operator.includes('from "@/components/home/WorkflowHome"'), false);

    const editorPage = source("src/app/workflows/[id]/page.tsx");
    assert.match(editorPage, /WorkflowOperator/);
    assert.equal(editorPage.includes("WorkflowHome"), false);

    const templates = source("src/app/templates/page.tsx");
    assert.match(templates, /createWorkflow/);
    assert.match(templates, /templateCreatedEditorHref/);

    const home = source("src/components/home/WorkflowHome.tsx");
    assert.match(home, /templateCreatedEditorHref/);
    assert.match(home, /router\.push\(templateCreatedEditorHref/);

    assert.deepEqual(
      [...PRODUCT_HOME_SOURCES],
      [
        "src/app/page.tsx",
        "src/components/home/ProductHomeLanding.tsx",
        "src/components/home/WorkflowHome.tsx",
        "src/app/settings/page.tsx",
        "src/app/templates/page.tsx",
        "src/app/workflows/page.tsx",
        "src/app/workflows/[id]/page.tsx",
        "src/components/workflows/WorkflowOperator.tsx",
      ],
    );
  });
});
