import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_WORKBENCH_STORY,
  isDefaultWorkbench,
  pickDefaultWorkbench,
  workspaceLookupFromMembership,
} from "./default-workbench.ts";
import type { Membership } from "./identity-types.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

function membership(
  slug: string,
  workbench: string,
  tenantId = "tenant-1",
): Membership {
  return {
    tenant: {
      id: tenantId,
      slug,
      name: slug,
      status: "active",
    },
    workspace: {
      id: `${slug}-${workbench}`,
      tenant_id: tenantId,
      workbench_key: workbench,
      name: `${slug} ${workbench}`,
      status: "active",
    },
    roles: ["admin"],
    permissions: ["workspace.administer", "workflow.edit"],
  };
}

describe("post-login default workbench (#369)", () => {
  it("cites the follow-up story", () => {
    assert.equal(DEFAULT_WORKBENCH_STORY, 369);
  });

  it("prefers localseed local/default", () => {
    const other = membership("acme", "ops");
    const local = membership("local", "default", "tenant-local");
    const picked = pickDefaultWorkbench([other, local]);
    assert.equal(isDefaultWorkbench(local), true);
    assert.equal(isDefaultWorkbench(other), false);
    assert.equal(picked, local);
    assert.deepEqual(workspaceLookupFromMembership(local), {
      tenantId: "tenant-local",
      tenantSlug: "local",
      workbenchKey: "default",
    });
  });

  it("binds the sole membership when it is not local/default", () => {
    const only = membership("acme", "ops");
    assert.equal(pickDefaultWorkbench([only]), only);
  });

  it("returns null when the list is empty", () => {
    assert.equal(pickDefaultWorkbench([]), null);
  });

  it("lists memberships from a standalone session without a prior lookup", () => {
    const provider = source("src/components/shell/WorkspaceProvider.tsx");
    assert.match(provider, /pickDefaultWorkbench/);
    assert.match(provider, /callIdentityProxy<ItemList<Membership>>\("\/workspaces"/);
    assert.match(provider, /hasOperatorCaller\(session\.active, identity, headerFallback\)/);
    assert.doesNotMatch(provider, /switchWorkspace\(host/);
    assert.doesNotMatch(provider, /searchParams\.get\("tenant"\)/);
    assert.doesNotMatch(provider, /session\.embed\s*=/);
  });

  it("does not invent embed bind or a greenfield session type", () => {
    const helper = source("src/lib/default-workbench.ts");
    assert.match(helper, /not a session bind/);
    assert.match(helper, /not a new session type/);
    assert.match(helper, /#369/);
  });
});
