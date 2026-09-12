import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EMBED_CHIPS_SET_COOKIE,
  EMBED_CHROME_MISSING_SESSION_MESSAGE,
  EMBED_MOUNT_PREFIX,
  EMBED_ROUTES,
} from "./embed-contract.ts";
import { parseSessionEmbedChrome } from "./session-embed-contract.ts";
import {
  INVENTED_EMBED_TREES,
  JONNY_R71_NOTE,
  R71_EPIC,
  R71_KEEP_STORY_OPEN,
  R71_STORY,
  R7_HARD_LINE,
  R7_HARD_LINE_HELP,
  R7_LATER_STORY_NOTES,
  REWRITE_EMBED_FAIL_CLOSED_HELP,
  REWRITE_EMBED_MOUNT,
  REWRITE_EMBED_MOUNT_ATTR,
  REWRITE_EMBED_MOUNT_HELP,
  REWRITE_EMBED_MOUNT_PREFIX,
  REWRITE_EMBED_MOUNT_SOURCES,
  REWRITE_EMBED_SHELL_TOOLS,
  REWRITE_EMBED_SURFACES,
  REWRITE_EMBED_TOOLS_ATTR,
  rewriteEmbedAdv021Unchanged,
  rewriteEmbedAdv024Unchanged,
  rewriteEmbedBoundaryMoved,
  rewriteEmbedChipsUnchanged,
  rewriteEmbedChromeMayMount,
  rewriteEmbedFrameAncestorFailClosedUnchanged,
  rewriteEmbedHoldsR7HardLine,
  rewriteEmbedHostIssuerBindUnchanged,
  rewriteEmbedHostQueryNeverAuthorizes,
  rewriteEmbedInventedTree,
  rewriteEmbedLeavesLaterStories,
  rewriteEmbedMountState,
  rewriteEmbedNavOmitsAdv024WithoutGrant,
  rewriteEmbedPeekedAssertionNeverAuthorizes,
  rewriteEmbedProductChildrenState,
  rewriteEmbedR2R6PathsUnchanged,
  rewriteEmbedSameTreeAsStandalone,
  rewriteEmbedShellToolsVisible,
} from "./rewrite-embed-mount.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

const GET_SESSION = {
  session: {
    id: "sess-1",
    embed: {
      mode: "embed",
      sdk: "embed.v1",
      tenantId: "ten-1",
      tenantSlug: "acme",
      tenantName: "Acme",
      workbenchKey: "ops",
      workspaceId: "ws-1",
      workspaceName: "Ops",
      capabilities: ["workflow.view"],
    },
  },
  principal: { display_name: "Ada" },
};

describe("R7.1 rewrite chrome on /embed/v1 + session.embed", () => {
  it("keeps #276 open and stays on epic #233", () => {
    assert.equal(R71_STORY, 276);
    assert.equal(R71_EPIC, 233);
    assert.equal(R71_KEEP_STORY_OPEN, true);
    assert.equal(rewriteEmbedHoldsR7HardLine(), true);
    assert.equal(REWRITE_EMBED_MOUNT.inheritR7HardLine, true);
    assert.equal(R7_HARD_LINE.adv021ChromeFromSessionEmbedOnly, true);
    assert.equal(R7_HARD_LINE.adv021FailClosedWithoutSessionEmbedOnEmbedV1, true);
    assert.equal(R7_HARD_LINE.adv024MembershipIsolationStayGrantGated, true);
    assert.equal(R7_HARD_LINE.adv024ReshapeIsR72DoNotWeakenGrant, true);
    assert.equal(R7_HARD_LINE.hostQueryDisplayOnlyNeverAuthorization, true);
    assert.equal(R7_HARD_LINE.noSecondEmbedTreeSameMountsAsStandalone, true);
    assert.equal(R7_HARD_LINE.doNotWeakenIssuerFailClosed, true);
    assert.equal(R7_HARD_LINE.doNotWeakenFrameAncestorFailClosed, true);
    assert.match(R7_HARD_LINE_HELP, /session\.embed only/);
    assert.match(R7_HARD_LINE_HELP, /do not weaken the grant/);
    assert.equal(REWRITE_EMBED_MOUNT.d6MigrateInPlace, true);
    assert.equal(REWRITE_EMBED_MOUNT.sameMountsAsStandalone, true);
    assert.equal(REWRITE_EMBED_MOUNT.noSecondEmbedTree, true);
    assert.equal(REWRITE_EMBED_MOUNT.noNewEmbedOrigin, true);
    assert.equal(REWRITE_EMBED_MOUNT.noPortalDbShare, true);
    assert.equal(REWRITE_EMBED_MOUNT.noAppsApiChanges, true);
    assert.equal(REWRITE_EMBED_MOUNT_PREFIX, "/embed/v1");
    assert.equal(REWRITE_EMBED_MOUNT_PREFIX, EMBED_MOUNT_PREFIX);
    assert.match(REWRITE_EMBED_MOUNT_HELP, /session\.embed/);
    assert.match(REWRITE_EMBED_MOUNT_HELP, /no second embed tree/i);
    assert.equal(
      REWRITE_EMBED_FAIL_CLOSED_HELP,
      EMBED_CHROME_MISSING_SESSION_MESSAGE,
    );
    assert.equal(rewriteEmbedLeavesLaterStories(), true);
    assert.match(R7_LATER_STORY_NOTES.r72, /#277/);
    assert.match(R7_LATER_STORY_NOTES.r73, /#278/);
    assert.match(R7_LATER_STORY_NOTES.r74, /#279/);
  });

  it("fail-closes rewrite chrome without GET /session session.embed (ADV-021)", () => {
    const chrome = parseSessionEmbedChrome(GET_SESSION);
    assert.equal(rewriteEmbedChromeMayMount(chrome), true);
    assert.equal(rewriteEmbedChromeMayMount(null), false);
    assert.equal(
      rewriteEmbedMountState({
        sessionChecked: false,
        sessionActive: false,
        sessionEmbed: null,
      }),
      "waiting",
    );
    assert.equal(
      rewriteEmbedMountState({
        sessionChecked: true,
        sessionActive: false,
        sessionEmbed: null,
      }),
      "closed",
    );
    assert.equal(
      rewriteEmbedMountState({
        sessionChecked: true,
        sessionActive: true,
        sessionEmbed: null,
      }),
      "closed",
    );
    assert.equal(
      rewriteEmbedMountState({
        sessionChecked: true,
        sessionActive: true,
        sessionEmbed: chrome,
      }),
      "open",
    );
    assert.equal(rewriteEmbedAdv021Unchanged(), true);
    assert.match(EMBED_CHROME_MISSING_SESSION_MESSAGE, /not chrome authority/);
  });

  it("mounts product children only after session.embed + verified bind", () => {
    const chrome = parseSessionEmbedChrome(GET_SESSION);
    assert.equal(
      rewriteEmbedProductChildrenState({
        sessionChecked: false,
        sessionActive: false,
        sessionEmbed: null,
        verified: false,
      }),
      "waiting",
    );
    assert.equal(
      rewriteEmbedProductChildrenState({
        sessionChecked: true,
        sessionActive: true,
        sessionEmbed: null,
        verified: false,
      }),
      "exchange",
    );
    assert.equal(
      rewriteEmbedProductChildrenState({
        sessionChecked: true,
        sessionActive: true,
        sessionEmbed: chrome,
        verified: false,
      }),
      "exchange",
    );
    assert.equal(
      rewriteEmbedProductChildrenState({
        sessionChecked: true,
        sessionActive: true,
        sessionEmbed: chrome,
        verified: true,
      }),
      "mount",
    );
    assert.equal(
      rewriteEmbedProductChildrenState({
        sessionChecked: true,
        sessionActive: true,
        sessionEmbed: chrome,
        verified: true,
        tenancyMismatch: true,
      }),
      "mismatch",
    );
  });

  it("ignores host ?tenant= / ?workbench= and peeked assertion leftovers", () => {
    assert.equal(
      rewriteEmbedHostQueryNeverAuthorizes({
        host: "https://evil.example",
        tenant: "evil",
        tenantId: "evil-ten",
        workbench: "prod",
        displayName: "spoof",
        unverified: true,
      }),
      true,
    );
    assert.equal(
      rewriteEmbedPeekedAssertionNeverAuthorizes({
        iss: "https://evil.example",
        tenant_id: "evil-ten",
        workbench_key: "prod",
        capabilities: ["workspace.administer"],
      }),
      true,
    );
    assert.equal(REWRITE_EMBED_MOUNT.hostQueryNeverAuthorization, true);
    assert.equal(
      REWRITE_EMBED_MOUNT.hostTenantWorkbenchNeverAuthorization,
      true,
    );
  });

  it("keeps CHIPS and host-issuer bind intact", () => {
    assert.equal(rewriteEmbedChipsUnchanged(), true);
    assert.equal(EMBED_CHIPS_SET_COOKIE, "SameSite=None; Secure; Partitioned");
    assert.equal(rewriteEmbedHostIssuerBindUnchanged(), true);
    assert.equal(rewriteEmbedFrameAncestorFailClosedUnchanged(), true);
    assert.equal(rewriteEmbedBoundaryMoved(), false);
    assert.match(JONNY_R71_NOTE, /No embed boundary moved/);
    assert.match(JONNY_R71_NOTE, /Do not invent/);
  });

  it("does not weaken ADV-024 grant gating", () => {
    assert.equal(rewriteEmbedAdv024Unchanged(), true);
    assert.equal(rewriteEmbedNavOmitsAdv024WithoutGrant(), true);
    assert.equal(REWRITE_EMBED_MOUNT.adv024ReshapeIsR72, true);
    const membership = EMBED_ROUTES.find((route) => route.id === "membership");
    const isolation = EMBED_ROUTES.find((route) => route.id === "isolation");
    assert.equal(membership?.grant, "membership-isolation");
    assert.equal(isolation?.grant, "membership-isolation");
  });

  it("keeps the same /embed/v1 tree as standalone — no second embed tree", () => {
    assert.equal(rewriteEmbedSameTreeAsStandalone(), true);
    assert.equal(rewriteEmbedR2R6PathsUnchanged(), true);
    assert.deepEqual(
      REWRITE_EMBED_SURFACES.map((surface) => surface.id),
      [
        "r2.1-library",
        "r2.2-inspector",
        "r2.3-undo-redo",
        "r2.4-fit-snap",
        "r2.5-layout",
        "r3.1-ndv-parameters",
        "r3.2-ndv-mapping",
        "r3.3-ndv-validation",
        "r4.1-executions-inbox",
        "r4.2-runs-overlay",
        "r4.3-ndv-run-io",
        "r5.1-vault-find",
        "r5.2-credential-detail",
        "r5.3-ndv-add-credential",
        "r6.1-editor-activation",
        "r6.2-home-activation",
        "r6.3-test-run",
      ],
    );
    for (const surface of REWRITE_EMBED_SURFACES) {
      const route = EMBED_ROUTES.find((item) => item.id === surface.routeId);
      assert.ok(route, surface.id);
      assert.ok(route?.embed.startsWith("/embed/v1"), surface.id);
    }
    const nextConfig = source("next.config.ts");
    assert.match(nextConfig, /source: "\/embed\/v1\/:path\*"/);
    assert.match(nextConfig, /destination: "\/:path\*"/);
    assert.equal(rewriteEmbedInventedTree(nextConfig), false);
    for (const tree of INVENTED_EMBED_TREES) {
      assert.equal(
        EMBED_ROUTES.some(
          (route) =>
            route.standalone.startsWith(tree) || route.embed.startsWith(tree),
        ),
        false,
        tree,
      );
    }
  });

  it("mounts Commands and Search on embed chrome only after session.embed", () => {
    assert.deepEqual(REWRITE_EMBED_SHELL_TOOLS, ["search", "commands"]);
    assert.equal(rewriteEmbedShellToolsVisible("waiting"), false);
    assert.equal(rewriteEmbedShellToolsVisible("closed"), false);
    assert.equal(rewriteEmbedShellToolsVisible("open"), true);
    assert.equal(
      REWRITE_EMBED_MOUNT.mountSearchAndCommandsAfterSessionEmbed,
      true,
    );

    const embedChrome = source("src/components/embed/EmbedChrome.tsx");
    assert.match(embedChrome, /CommandPalette/);
    assert.match(embedChrome, /GlobalSearch/);
    assert.match(embedChrome, new RegExp(REWRITE_EMBED_MOUNT_ATTR));
    assert.match(embedChrome, new RegExp(REWRITE_EMBED_TOOLS_ATTR));
    assert.match(embedChrome, /rewriteEmbedMountState/);
    assert.match(embedChrome, /rewriteEmbedShellToolsVisible/);

    const shell = source("src/components/shell/WorkspaceShell.tsx");
    assert.match(shell, /isSessionEmbedMode\(session\.embedChrome\)/);
    assert.match(shell, /<EmbedExchangeGate/);
    assert.match(shell, /swaggerUrl=\{swaggerUrl\}/);
    assert.equal(rewriteEmbedInventedTree(embedChrome), false);
    assert.equal(rewriteEmbedInventedTree(shell), false);
  });

  it("does not invent API contracts or pull later R7 stories", () => {
    for (const relative of REWRITE_EMBED_MOUNT_SOURCES) {
      const text = source(relative);
      if (relative === "src/lib/rewrite-embed-mount.ts") {
        assert.match(text, /Keep #276 open/);
        continue;
      }
      assert.equal(rewriteEmbedInventedTree(text), false, relative);
    }
    assert.equal(REWRITE_EMBED_MOUNT.doNotInventContracts, true);
    assert.equal(REWRITE_EMBED_MOUNT.jonnyStandbyOnlyIfBoundaryMoves, true);
  });
});
