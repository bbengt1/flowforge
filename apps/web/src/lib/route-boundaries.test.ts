import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EMBED_CHROME_MISSING_SESSION_MESSAGE } from "./embed-contract.ts";
import {
  rewriteEmbedAdv021Unchanged,
  rewriteEmbedAdv024Unchanged,
} from "./rewrite-embed-mount.ts";
import {
  G04_BRIEF,
  G04_EPIC,
  G04_FINDING,
  G04_HELP,
  G04_ID,
  G04_KEEP_EPIC_OPEN,
  G04_KEEP_PHASE_OPEN,
  G04_PHASE,
  G04_STORY,
  INVENTED_EMBED_BOUNDARY_FILES,
  PRIMARY_APP_SEGMENTS,
  PRIMARY_SEGMENT_LOADING_FILES,
  PRIMARY_SEGMENT_NOT_FOUND_FILES,
  ROOT_BOUNDARY_FILES,
  ROUTE_BOUNDARIES,
  ROUTE_BOUNDARY_AUTO_CLOSE_TOKENS,
  ROUTE_BOUNDARY_CHROME_SOURCES,
  ROUTE_BOUNDARY_FILES,
  ROUTE_ERROR_RETRY_LABEL,
  ROUTE_NOT_FOUND_HOME_HREF,
  boundaryHasRetry,
  boundaryOmitsStandaloneAuthChrome,
  boundaryUsesV1Tokens,
  boundaryWiresReset,
  globalErrorDefinesDocument,
  routeBoundariesHoldHardLines,
  routeBoundaryDocsHeld,
  routeErrorDigest,
  routeNotFoundHomeHref,
} from "./route-boundaries.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

function repoSource(relative: string): string {
  return readFileSync(join(here, "..", "..", "..", "..", relative), "utf8");
}

function repoExists(relative: string): boolean {
  return existsSync(join(here, "..", "..", relative));
}

describe("G.0.4 route boundaries", () => {
  it("relates to #407 and keeps G.0 / G open", () => {
    assert.equal(G04_STORY, 407);
    assert.equal(G04_PHASE, 402);
    assert.equal(G04_EPIC, 401);
    assert.equal(G04_KEEP_PHASE_OPEN, true);
    assert.equal(G04_KEEP_EPIC_OPEN, true);
    assert.equal(G04_ID, "G.0.4-route-boundaries");
    assert.equal(G04_FINDING, "F1");
    assert.equal(G04_BRIEF, "docs/internal/claude-code-gap-analysis.md");
    assert.equal(ROUTE_BOUNDARIES.keep402Open, true);
    assert.equal(ROUTE_BOUNDARIES.keep401Open, true);
    assert.match(G04_HELP, /Try again/);
    assert.match(G04_HELP, /session\.embed/);
    const frontend = repoSource("docs/reference/frontend-ui.md");
    assert.equal(routeBoundaryDocsHeld(frontend), true);
    for (const token of ROUTE_BOUNDARY_AUTO_CLOSE_TOKENS) {
      assert.equal(frontend.includes(token), false, token);
    }
  });

  it("ships root global-error + segment error with retry", () => {
    for (const file of ROOT_BOUNDARY_FILES) {
      assert.equal(repoExists(file), true, file);
    }
    const globalError = source("src/app/global-error.tsx");
    const segmentError = source("src/app/error.tsx");
    const panel = source("src/components/chrome/RouteErrorPanel.tsx");
    assert.equal(globalErrorDefinesDocument(globalError), true);
    assert.equal(boundaryWiresReset(globalError), true);
    assert.equal(boundaryWiresReset(segmentError), true);
    assert.equal(boundaryHasRetry(panel), true);
    assert.match(segmentError, /"use client"/);
    assert.match(globalError, /"use client"/);
    assert.match(panel, new RegExp(ROUTE_ERROR_RETRY_LABEL));
    assert.equal(routeErrorDigest({ digest: "abc123digestref" }), "abc123digestref");
    assert.equal(routeErrorDigest({}), "");
  });

  it("puts loading and not-found on primary App Router segments", () => {
    assert.deepEqual([...PRIMARY_APP_SEGMENTS], [
      "workflows",
      "executions",
      "credentials",
      "approvals",
      "alerts",
      "config",
      "actions",
      "templates",
      "settings",
      "audit",
      "membership",
      "isolation",
    ]);
    assert.equal(PRIMARY_SEGMENT_LOADING_FILES.length, PRIMARY_APP_SEGMENTS.length);
    assert.equal(PRIMARY_SEGMENT_NOT_FOUND_FILES.length, PRIMARY_APP_SEGMENTS.length);
    for (const file of ROUTE_BOUNDARY_FILES) {
      assert.equal(repoExists(file), true, file);
    }
    const rootLoading = source("src/app/loading.tsx");
    const rootNotFound = source("src/app/not-found.tsx");
    assert.match(rootLoading, /RouteLoadingFallback/);
    assert.match(rootNotFound, /AppRouteNotFound/);
    for (const file of PRIMARY_SEGMENT_LOADING_FILES) {
      assert.match(source(file), /RouteLoadingFallback/, file);
    }
    for (const file of PRIMARY_SEGMENT_NOT_FOUND_FILES) {
      assert.match(source(file), /AppRouteNotFound/, file);
    }
    assert.equal(routeNotFoundHomeHref(false), ROUTE_NOT_FOUND_HOME_HREF);
    assert.equal(routeNotFoundHomeHref(true), "/embed/v1/workflows");
  });

  it("leaves the ADV-021 embed path unchanged and does not invent a second tree", () => {
    assert.equal(routeBoundariesHoldHardLines(), true);
    assert.equal(rewriteEmbedAdv021Unchanged(), true);
    assert.equal(rewriteEmbedAdv024Unchanged(), true);
    assert.match(EMBED_CHROME_MISSING_SESSION_MESSAGE, /session\.embed/);
    const shell = source("src/components/shell/WorkspaceShell.tsx");
    const embedChrome = source("src/components/embed/EmbedChrome.tsx");
    const embedGate = source("src/components/embed/EmbedExchangeGate.tsx");
    assert.match(shell, /isSessionEmbedMode/);
    assert.match(embedChrome, /sessionEmbed/);
    assert.match(embedGate, /exchangeEmbedAssertion/);
    assert.equal(embedChrome.includes("LoginLanding"), false);
    assert.equal(embedChrome.includes("FirstRunWizard"), false);
    assert.equal(embedChrome.includes("ChangePasswordLanding"), false);
    assert.equal(shell.includes("LoginLanding"), false);
    for (const file of INVENTED_EMBED_BOUNDARY_FILES) {
      assert.equal(repoExists(file), false, file);
    }
  });

  it("uses V.1 tokens and never mounts Login / wizard / change-password", () => {
    for (const file of ROUTE_BOUNDARY_CHROME_SOURCES) {
      const text = source(file);
      assert.equal(boundaryUsesV1Tokens(text), true, file);
      if (!file.endsWith("route-boundaries.ts")) {
        assert.equal(boundaryOmitsStandaloneAuthChrome(text), true, file);
      }
    }
    const panel = source("src/components/chrome/RouteErrorPanel.tsx");
    const loading = source("src/components/chrome/RouteLoadingFallback.tsx");
    const notFound = source("src/components/chrome/RouteNotFound.tsx");
    assert.match(panel, /ff-overview-create|ff-shell-panel/);
    assert.match(loading, /ff-shell/);
    assert.match(notFound, /EMBED_MOUNT_HEADER/);
    assert.equal(ROUTE_BOUNDARIES.draftsNeverRun, true);
    assert.equal(ROUTE_BOUNDARIES.vaultDisplayNameUuidOnly, true);
    assert.equal(ROUTE_BOUNDARIES.noGreenfieldApis, true);
    assert.equal(ROUTE_BOUNDARIES.noJonnyChange, true);
  });
});
