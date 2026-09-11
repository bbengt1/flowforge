import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CATALOG_SOURCE_UNAVAILABLE,
  EDITOR_ENGINE_CATALOG,
  ENGINE_CATALOG_UNAVAILABLE_HELP,
  R34_EPIC,
  R34_KEEP_STORY_OPEN,
  R34_STORY,
  isInventedCatalogSource,
  isLiveCatalogSource,
} from "./catalog-fail-closed.ts";
import { adaptActionLibrary, rejectDisabledActionType } from "./workflow-action-library.ts";
import { wizardConfigFields } from "./workflow-action-wizard.ts";
import {
  adaptKubernetesNodeEntries,
  kubernetesLibraryTypes,
  kubernetesNodeWithFields,
} from "./kubernetes-node-contract.ts";
import { observationModeFromCatalog } from "./kubernetes-rollout-contract.ts";
import { parseKubernetesEngineCatalog } from "./kubernetes.ts";
import {
  adaptSshNodeEntries,
  parseSshNodeCatalog,
  sshLibraryTypes,
  sshNodeWithFields,
} from "./ssh-node-contract.ts";
import { parseSshEngineCatalog } from "./ssh.ts";
import {
  adaptScriptNodeEntries,
  parseScriptNodeCatalog,
  scriptLibraryTypes,
  scriptNodeWithFields,
} from "./script-contract.ts";
import {
  adaptHttpNotificationEntries,
  httpNotificationActionsEnabled,
  isHttpNotificationNodeEnabled,
  parseHttpNotificationCatalog,
} from "./core-http-notification-contract.ts";
import { ndvParameterFields } from "./editor-ndv-parameters.ts";
import type { ActionLibraryEntry } from "./workflow-action-library.ts";

function liveHttpCatalog() {
  return parseHttpNotificationCatalog({
    nodes: [
      {
        type: "http.request",
        title: "HTTP request",
        allowedWith: [
          { name: "connectionId", kind: "uuid", required: true },
          { name: "method", kind: "enum", enum: ["GET", "POST"] },
          { name: "path", kind: "string" },
        ],
      },
    ],
  });
}

describe("R3.4 live-catalog-only engine contracts", () => {
  it("keeps #249 open and cites epic #229", () => {
    assert.equal(R34_STORY, 249);
    assert.equal(R34_EPIC, 229);
    assert.equal(R34_KEEP_STORY_OPEN, true);
    assert.equal(EDITOR_ENGINE_CATALOG.keep249Open, true);
    assert.equal(EDITOR_ENGINE_CATALOG.noInventedNodeTypes, true);
    assert.equal(EDITOR_ENGINE_CATALOG.noInventedAllowedWith, true);
    assert.equal(EDITOR_ENGINE_CATALOG.noInventedConfigFields, true);
    assert.equal(EDITOR_ENGINE_CATALOG.emptyFailsClosed, true);
    assert.equal(EDITOR_ENGINE_CATALOG.catalog403FailsClosed, true);
    assert.equal(EDITOR_ENGINE_CATALOG.noMarketplace, true);
    assert.ok(ENGINE_CATALOG_UNAVAILABLE_HELP.includes("fails closed"));
  });

  it("treats empty and contract-fallback sources as not live", () => {
    assert.equal(isInventedCatalogSource(CATALOG_SOURCE_UNAVAILABLE), true);
    assert.equal(isInventedCatalogSource("contract-fallback"), true);
    assert.equal(isInventedCatalogSource(undefined), true);
    assert.equal(isLiveCatalogSource("http-catalog"), true);
    assert.equal(isLiveCatalogSource("ssh-catalog"), true);
  });

  it("empty workflow catalog does not invent K8s / SSH / script / HTTP types", () => {
    const empty = adaptActionLibrary({
      apiVersion: "flowforge/v1",
      triggers: [],
      nodes: [],
    });
    assert.equal(empty.some((item) => item.type.startsWith("kubernetes.")), false);
    assert.equal(empty.some((item) => item.type === "ssh.run"), false);
    assert.equal(empty.some((item) => item.type.startsWith("script.")), false);
    assert.equal(empty.some((item) => item.type === "http.request"), false);
    assert.equal(empty.some((item) => item.type.startsWith("notification.")), false);

    const missing = adaptActionLibrary(null);
    assert.equal(missing.some((item) => item.type === "kubernetes.apply"), false);
    assert.equal(missing.some((item) => item.type === "ssh.run"), false);
    assert.equal(missing.some((item) => item.type === "script.python"), false);
    assert.equal(missing.some((item) => item.type === "http.request"), false);
    assert.equal(rejectDisabledActionType("kubernetes.apply", null).ok, false);
    assert.equal(rejectDisabledActionType("ssh.run", null).ok, false);
    assert.equal(rejectDisabledActionType("script.python", null).ok, false);
    assert.equal(rejectDisabledActionType("http.request", null).ok, false);
    assert.equal(missing.some((item) => item.type === "servicenow.ticket"), false);
    assert.equal(missing.some((item) => item.phase === "next" || item.phase === "provider"), false);
  });

  it("empty or unauthorized engine catalogs fail closed without invented fields", () => {
    assert.deepEqual([...kubernetesLibraryTypes(null)], []);
    assert.deepEqual(adaptKubernetesNodeEntries(null), []);
    assert.deepEqual(kubernetesNodeWithFields("kubernetes.apply"), []);
    assert.equal(observationModeFromCatalog(null).source, "unavailable");
    assert.equal(observationModeFromCatalog(null).live, false);

    const emptyK8s = parseKubernetesEngineCatalog({});
    assert.deepEqual(emptyK8s?.nodes, []);
    assert.deepEqual(emptyK8s?.allowedKinds, []);
    assert.equal(emptyK8s?.apply.waitReady, "");

    assert.deepEqual([...sshLibraryTypes(null)], []);
    assert.deepEqual(adaptSshNodeEntries(null), []);
    assert.deepEqual(sshNodeWithFields("ssh.run"), []);
    const sshEmpty = parseSshNodeCatalog({});
    assert.equal(sshEmpty.source, "unavailable");
    assert.deepEqual(sshEmpty.nodes, []);
    const sshEngine = parseSshEngineCatalog({});
    assert.equal(sshEngine.source, "unavailable");
    assert.equal(sshEngine.retrySafeExposed, false);

    assert.deepEqual([...scriptLibraryTypes(null)], []);
    assert.deepEqual(adaptScriptNodeEntries(null), []);
    assert.deepEqual(scriptNodeWithFields("script.python"), []);
    const scriptEmpty = parseScriptNodeCatalog({});
    assert.equal(scriptEmpty.source, "unavailable");
    assert.deepEqual(scriptEmpty.nodes, []);

    const httpEmpty = parseHttpNotificationCatalog({});
    assert.equal(httpEmpty.source, "unavailable");
    assert.deepEqual(httpEmpty.nodes, []);
    assert.deepEqual(adaptHttpNotificationEntries(null), []);
    assert.equal(httpNotificationActionsEnabled(null, null), false);
    assert.equal(isHttpNotificationNodeEnabled("http.request", null, null), false);
  });

  it("HTTP stays disabled when INTEGRATION_ACTIONS_ENABLED is off", () => {
    const gated = {
      apiVersion: "flowforge/v1" as const,
      rules: { integrationActionsEnabled: false },
      integrationGate: { enabled: false, nodes: ["http.request"] },
      triggers: [],
      nodes: [
        { type: "http.request", phase: "core" as const, enabled: true },
        { type: "notification.email", phase: "core" as const, enabled: true },
      ],
    };
    assert.equal(httpNotificationActionsEnabled(gated, null), false);
    assert.equal(isHttpNotificationNodeEnabled("http.request", null, gated), false);
    assert.deepEqual(adaptHttpNotificationEntries(gated), []);
    const library = adaptActionLibrary(gated);
    assert.equal(library.some((item) => item.type === "http.request"), false);
    assert.equal(library.some((item) => item.type === "notification.email"), false);
    assert.equal(rejectDisabledActionType("http.request", gated).ok, false);
  });

  it("live catalogs still supply types and allowedWith", () => {
    const workflow = {
      apiVersion: "flowforge/v1" as const,
      triggers: [],
      nodes: [
        {
          type: "kubernetes.apply",
          phase: "core" as const,
          title: "Apply manifests",
          allowedWith: [
            { name: "clusterTargetId", kind: "uuid", required: true },
            { name: "namespace", kind: "string", required: true },
            { name: "manifests", kind: "string" },
          ],
        },
        {
          type: "ssh.run",
          phase: "core" as const,
          allowedWith: [
            { name: "sshTargetId", kind: "uuid", required: true },
            { name: "commandProfileId", kind: "uuid", required: true },
          ],
        },
        {
          type: "script.python",
          phase: "core" as const,
          allowedWith: [
            { name: "source", kind: "string", required: true },
            { name: "runtimeProfileId", kind: "uuid", required: true },
          ],
        },
        {
          type: "http.request",
          phase: "core" as const,
          allowedWith: [
            { name: "connectionId", kind: "uuid", required: true },
            { name: "method", kind: "string" },
          ],
        },
      ],
    };
    const library = adaptActionLibrary(workflow, null, null, null, liveHttpCatalog());
    assert.equal(library.some((item) => item.type === "kubernetes.apply"), true);
    assert.equal(library.some((item) => item.type === "ssh.run"), true);
    assert.equal(library.some((item) => item.type === "script.python"), true);
    assert.equal(library.some((item) => item.type === "http.request"), true);
    assert.equal(rejectDisabledActionType("kubernetes.apply", workflow).ok, true);

    const apply = library.find((item) => item.type === "kubernetes.apply");
    const fields = wizardConfigFields(apply, "kubernetes.apply");
    assert.equal(fields.some((field) => field.name === "namespace"), true);
    assert.equal(fields.some((field) => field.name === "manifests"), true);
    assert.equal(fields.some((field) => field.name === "force"), false);
    assert.equal(fields.some((field) => field.name === "kubeconfig"), false);
  });

  it("NDV does not invent engine fields when catalogs are empty", () => {
    const entry = (type: string): ActionLibraryEntry => ({
      type,
      name: type,
      description: type,
      phase: "core",
      family: "other",
      enabled: true,
      placeable: true,
      inputs: [],
      outputs: [],
      requiredWith: [],
      allowedWith: [],
      policy: null,
      bounds: null,
      redaction: null,
      source: "catalog",
    });
    assert.deepEqual(ndvParameterFields(entry("kubernetes.apply"), "kubernetes.apply"), []);
    assert.deepEqual(ndvParameterFields(entry("ssh.run"), "ssh.run"), []);
    assert.deepEqual(ndvParameterFields(entry("http.request"), "http.request"), []);
  });
});
