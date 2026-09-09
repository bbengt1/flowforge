import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { DevIdentity } from "./identity-headers.ts";
import { CSRF_HEADER } from "./session-contract.ts";
import { clearSession, setActiveSession } from "./session-store.ts";
import { loadPublishedScriptRuntimeProfiles } from "./script-runtime-client.ts";

const originalFetch = globalThis.fetch;

const identity: DevIdentity = {
  issuer: "https://flowforge.local",
  subject: "operator-chloe",
  displayName: "Chloe",
  tenantId: "",
  tenantSlug: "acme",
  workbenchKey: "ops",
};

const PYTHON_ID = "66666666-6666-4666-8666-666666666666";
const GO_ID = "88888888-8888-4888-8888-888888888888";
const PYTHON_VERSION = "77777777-7777-4777-8777-777777777777";
const GO_VERSION = "99999999-9999-4999-8999-999999999999";
const DIGEST = `sha256:${"a".repeat(64)}`;
const LOCK = `sha256:${"b".repeat(64)}`;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSession();
});

function withSession() {
  setActiveSession({
    issuer: "https://flowforge.local",
    subject: "operator-chloe",
    displayName: "Chloe",
    sessionId: "sess-1",
    idleExpiresAt: null,
    absoluteExpiresAt: null,
    csrfToken: "csrf-ok",
  });
}

describe("script runtime client", () => {
  it("hydrates published profile specs and keeps only the matching language", async () => {
    withSession();
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/runtime-profiles") && !url.includes("/versions")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: PYTHON_ID,
                kind: "runtime_profile",
                name: "python-approved",
                status: "published",
                draftRevision: 1,
                latestVersionId: PYTHON_VERSION,
                latestVersionNumber: 1,
                latestVersionDigest: DIGEST,
              },
              {
                id: GO_ID,
                kind: "runtime_profile",
                name: "go-approved",
                status: "published",
                draftRevision: 1,
                latestVersionId: GO_VERSION,
                latestVersionNumber: 1,
                latestVersionDigest: DIGEST,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith(`/runtime-profiles/${PYTHON_ID}/versions/${PYTHON_VERSION}`)) {
        return new Response(
          JSON.stringify({
            id: PYTHON_VERSION,
            resourceId: PYTHON_ID,
            kind: "runtime_profile",
            versionNumber: 1,
            digest: DIGEST,
            spec: {
              language: "python",
              imageDigest: DIGEST,
              dependencyLockDigest: LOCK,
              limits: { cpuMillis: 500, memoryMib: 256, timeoutSeconds: 30, processes: 1 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith(`/runtime-profiles/${GO_ID}/versions/${GO_VERSION}`)) {
        return new Response(
          JSON.stringify({
            id: GO_VERSION,
            resourceId: GO_ID,
            kind: "runtime_profile",
            versionNumber: 1,
            digest: DIGEST,
            spec: {
              language: "go",
              imageDigest: DIGEST,
              dependencyLockDigest: LOCK,
              limits: { cpuMillis: 500, memoryMib: 256, timeoutSeconds: 30, processes: 1 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const python = await loadPublishedScriptRuntimeProfiles(identity, "script.python");
    assert.equal(python.ok, true);
    if (python.ok) {
      assert.equal(python.closed, false);
      assert.deepEqual(
        python.items.map((item) => item.resourceId),
        [PYTHON_ID],
      );
      assert.equal(python.items[0]?.spec?.language, "python");
    }

    const go = await loadPublishedScriptRuntimeProfiles(identity, "script.go");
    assert.equal(go.ok, true);
    if (go.ok) {
      assert.equal(go.closed, false);
      assert.deepEqual(
        go.items.map((item) => item.resourceId),
        [GO_ID],
      );
    }
  });

  it("fails closed on 403 and never lists leftover profiles", async () => {
    withSession();
    globalThis.fetch = (async (input, init) => {
      void init;
      if (String(input).endsWith("/runtime-profiles")) {
        return new Response(
          JSON.stringify({
            type: "urn:flowforge:problem:forbidden",
            title: "Forbidden",
            status: 403,
            detail: "Cross-workspace resource.",
            code: "forbidden",
          }),
          {
            status: 403,
            headers: { "Content-Type": "application/problem+json" },
          },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const result = await loadPublishedScriptRuntimeProfiles(identity, "script.python");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 403);
    }
    assert.equal(CSRF_HEADER, "X-CSRF-Token");
  });
});
