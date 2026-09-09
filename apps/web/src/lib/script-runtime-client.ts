/**
 * Typed E9.2 runtime-profile client. Paths and filters come from
 * script-runtime-contract.ts so a retarget only edits that adapter.
 * Uses existing ops-config runtime-profiles + GET /scripts/catalog.
 * Cookie session + CSRF. Never invents routes.
 */

import type { DevIdentity } from "./identity-headers.ts";
import {
  getOpsConfigCatalog,
  getOpsConfigVersion,
  listOpsConfig,
} from "./ops-config-client.ts";
import type { OpsConfigPin } from "./ops-config-types.ts";
import type { ProblemDetails } from "./problem.ts";
import { getScriptCatalog } from "./script-client.ts";
import {
  authorizedScriptRuntimeProfiles,
  parseRuntimeProfileMap,
  type ScriptRuntimeProfileMap,
} from "./script-runtime-contract.ts";

export type ScriptRuntimeClientFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
};

export type ScriptRuntimeMapSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  map: ScriptRuntimeProfileMap;
};

export type ScriptRuntimePinSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: OpsConfigPin[];
  closed: boolean;
  reason: string | null;
};

export async function getScriptRuntimeMap(
  identity: DevIdentity,
): Promise<ScriptRuntimeMapSuccess | ScriptRuntimeClientFailure> {
  const catalog = await getScriptCatalog(identity);
  if (catalog.ok) {
    return {
      ok: true,
      statusCode: catalog.statusCode,
      requestId: catalog.requestId,
      map: parseRuntimeProfileMap({
        ...catalog.catalog,
        isolation: catalog.catalog.isolation,
        notes: catalog.catalog.notes,
        languages: catalog.catalog.languages,
        nodes: catalog.catalog.nodes,
      }),
    };
  }
  const ops = await getOpsConfigCatalog(identity);
  if (ops.ok) {
    return {
      ok: true,
      statusCode: ops.statusCode,
      requestId: ops.requestId,
      map: parseRuntimeProfileMap({
        scriptEngine: ops.catalog.scriptEngine,
      }),
    };
  }
  return {
    ok: false,
    statusCode: catalog.statusCode,
    requestId: catalog.requestId,
    problem: catalog.problem,
  };
}

export async function loadPublishedScriptRuntimeProfiles(
  identity: DevIdentity,
  nodeType?: string | null,
): Promise<ScriptRuntimePinSuccess | ScriptRuntimeClientFailure> {
  const listed = await listOpsConfig(identity, "runtime_profile");
  if (!listed.ok) {
    return {
      ok: false,
      statusCode: listed.statusCode,
      requestId: listed.requestId,
      problem: listed.problem,
    };
  }
  const published = listed.items.filter(
    (item) => item.status === "published" && item.latestVersionId,
  );
  const hydrated = (
    await Promise.all(
      published.map(async (item) => {
        const version = await getOpsConfigVersion(
          identity,
          "runtime_profile",
          item.id,
          item.latestVersionId ?? "",
        );
        if (!version.ok || !item.latestVersionId || !item.latestVersionNumber) {
          return null;
        }
        const pin: OpsConfigPin = {
          kind: "runtime_profile",
          resourceId: item.id,
          versionId: item.latestVersionId,
          versionNumber: item.latestVersionNumber,
          digest: version.version.digest || item.latestVersionDigest || "",
          name: item.name,
          slug: item.slug,
          spec: version.version.spec,
        };
        return pin;
      }),
    )
  ).filter((pin): pin is OpsConfigPin => pin !== null);
  const selected = authorizedScriptRuntimeProfiles({
    pins: hydrated,
    nodeType,
    statusCode: listed.statusCode,
  });
  return {
    ok: true,
    statusCode: listed.statusCode,
    requestId: listed.requestId,
    items: selected.options,
    closed: selected.closed,
    reason: selected.reason,
  };
}
