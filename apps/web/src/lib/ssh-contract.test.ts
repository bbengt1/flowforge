import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMMAND_PROFILE_UI_COLLECTION,
  COMMAND_PROFILE_UPSTREAM_COLLECTION,
  SSH_API_PR,
  SSH_CONTRACT_FALLBACK_CATALOG,
  SSH_DENIED_FEATURES,
  SSH_EPIC,
  SSH_PROXY_ROUTES,
  SSH_ROUTE_MAP_SOURCE,
  SSH_SAFETY_NOTES,
  SSH_STORY,
  SSH_TARGET_UI_COLLECTION,
  SSH_TARGET_UPSTREAM_COLLECTION,
  commandProfileDraftPath,
  commandProfilesHref,
  commandProfilesPath,
  emptyCommandProfileSpec,
  emptySshTargetSpec,
  isSshProxySegments,
  retargetSshApiPath,
  retargetSshCollectionPath,
  sshCatalogPath,
  sshOpsConfigCatalogPath,
  sshTargetDraftPath,
  sshTargetPublishPath,
  sshTargetSelectPath,
  sshTargetsHref,
  sshTargetsPath,
  sshTargetVersionPath,
} from "./ssh-contract.ts";
import { SSH_DENIED_FEATURES as DENIED_FROM_TYPES } from "./ssh-types.ts";

const RESOURCE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";

describe("ssh contract (#82 retarget adapter)", () => {
  it("cites E8.1 / E8 and the #86 map on main", () => {
    assert.equal(SSH_STORY, 82);
    assert.equal(SSH_EPIC, 81);
    assert.equal(SSH_API_PR, 86);
    assert.equal(SSH_ROUTE_MAP_SOURCE, "e81-#86");
    assert.equal(SSH_TARGET_UI_COLLECTION, "ssh-targets");
    assert.equal(SSH_TARGET_UPSTREAM_COLLECTION, "ssh-targets");
    assert.equal(COMMAND_PROFILE_UI_COLLECTION, "command-profiles");
    assert.equal(COMMAND_PROFILE_UPSTREAM_COLLECTION, "command-profiles");
    assert.equal(sshOpsConfigCatalogPath(), "/ops-config/catalog");
    assert.equal(sshCatalogPath(), "/ssh/catalog");
    assert.equal(SSH_CONTRACT_FALLBACK_CATALOG.source, "unavailable");
    assert.equal(SSH_CONTRACT_FALLBACK_CATALOG.retrySafeExposed, false);
    assert.equal(SSH_CONTRACT_FALLBACK_CATALOG.quoting, undefined);
    assert.deepEqual(SSH_CONTRACT_FALLBACK_CATALOG.authMethods, []);
  });

  it("builds REST paths consistent with ops-config draft/publish/versions", () => {
    assert.equal(sshTargetsPath(), "/ssh-targets");
    assert.equal(
      sshTargetDraftPath(RESOURCE_ID),
      `/ssh-targets/${RESOURCE_ID}/draft`,
    );
    assert.equal(
      sshTargetPublishPath(RESOURCE_ID),
      `/ssh-targets/${RESOURCE_ID}/publish`,
    );
    assert.equal(
      sshTargetSelectPath(RESOURCE_ID),
      `/ssh-targets/${RESOURCE_ID}/select`,
    );
    assert.equal(
      sshTargetVersionPath(RESOURCE_ID, VERSION_ID),
      `/ssh-targets/${RESOURCE_ID}/versions/${VERSION_ID}`,
    );
    assert.equal(commandProfilesPath(), "/command-profiles");
    assert.equal(
      commandProfileDraftPath(RESOURCE_ID),
      `/command-profiles/${RESOURCE_ID}/draft`,
    );
    assert.equal(sshTargetsHref(), "/config/ssh-targets");
    assert.equal(commandProfilesHref(), "/config/command-profiles");
  });

  it("retargets UI /api/v1 collections onto upstream in one place", () => {
    assert.equal(
      retargetSshApiPath("/api/v1/ssh-targets"),
      "/api/v1/ssh-targets",
    );
    assert.equal(
      retargetSshApiPath(`/api/v1/ssh-targets/${RESOURCE_ID}/select`),
      `/api/v1/ssh-targets/${RESOURCE_ID}/select`,
    );
    assert.equal(
      retargetSshApiPath(`/api/v1/command-profiles/${RESOURCE_ID}/draft`),
      `/api/v1/command-profiles/${RESOURCE_ID}/draft`,
    );
    assert.equal(
      retargetSshApiPath("/api/v1/ops-config/catalog"),
      "/api/v1/ops-config/catalog",
    );
    assert.equal(retargetSshApiPath("/api/v1/ssh/catalog"), "/api/v1/ssh/catalog");
    assert.equal(
      retargetSshCollectionPath(
        "/api/v1/ssh-targets",
        "ssh-targets",
        "remote-targets",
      ),
      "/api/v1/remote-targets",
    );
    assert.equal(
      retargetSshCollectionPath(
        `/api/v1/command-profiles/${RESOURCE_ID}/publish`,
        "command-profiles",
        "ssh-profiles",
      ),
      `/api/v1/ssh-profiles/${RESOURCE_ID}/publish`,
    );
  });

  it("allowlists draft/publish/select/versions and rejects authorized", () => {
    assert.equal(isSshProxySegments(["ssh-targets"]), true);
    assert.equal(isSshProxySegments(["command-profiles", RESOURCE_ID]), true);
    assert.equal(isSshProxySegments(["ssh", "catalog"]), true);
    assert.equal(isSshProxySegments(["cluster-targets"]), false);
    const list = SSH_PROXY_ROUTES.some(
      (route) =>
        route.methods.includes("GET") && route.match(["ssh-targets"]),
    );
    const select = SSH_PROXY_ROUTES.some(
      (route) =>
        route.methods.includes("POST") &&
        route.match(["ssh-targets", RESOURCE_ID, "select"]),
    );
    const authorized = SSH_PROXY_ROUTES.some((route) =>
      route.match(["ssh-targets", "authorized"]),
    );
    const catalog = SSH_PROXY_ROUTES.some(
      (route) =>
        route.methods.includes("GET") && route.match(["ssh", "catalog"]),
    );
    assert.equal(list, true);
    assert.equal(select, true);
    assert.equal(authorized, false);
    assert.equal(catalog, true);
  });

  it("empty specs are secret-free and do not enable denied features", () => {
    const target = emptySshTargetSpec();
    const profile = emptyCommandProfileSpec();
    assert.equal(target.credentialId, "");
    assert.equal(target.port, 22);
    assert.equal("password" in target, false);
    assert.equal("privateKey" in target, false);
    assert.equal("agentForwarding" in target, false);
    assert.equal("portForwarding" in target, false);
    assert.equal("proxyCommand" in target, false);
    assert.equal("autoAcceptHostKey" in target, false);
    assert.equal("template" in profile, true);
    assert.equal(profile.parameterSchema.type, "object");
    assert.equal(profile.parameterSchema.additionalProperties, false);
    assert.equal(profile.retrySafe, false);
    assert.deepEqual([...SSH_DENIED_FEATURES], [...DENIED_FROM_TYPES]);
    assert.ok(
      SSH_SAFETY_NOTES.some((note) => /not an interactive terminal/i.test(note)),
    );
    assert.ok(
      SSH_SAFETY_NOTES.some((note) => /password authentication/i.test(note)),
    );
  });
});
