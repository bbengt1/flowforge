import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { emptyDevIdentity } from "./identity-headers.ts";
import type { ProblemDetails } from "./problem.ts";
import {
  BLOCKED_QUERY_KEY,
  FLOWFORGE_QUERY_META,
  QUERY_MAX_RETRIES,
  QueryCacheError,
  REMAINING_GOD_COMPONENT_QUERY_ROOTS,
  createFlowforgeQueryClient,
  executionHistoryQueryKey,
  flowforgeQueryRetryDelay,
  queryClientIsMemoryOnly,
  queryKeyHasSecret,
  queryScopeFromIdentity,
  runWithQueryRetry,
  sanitizeQueryCacheValue,
  shouldRetryQuery,
  tryQueryScope,
  workspacePermissionsQueryKey,
} from "./query-cache.ts";

function problem(status: number, detail = "failed", code = "upstream-error"): ProblemDetails {
  return {
    type: "urn:flowforge:problem:test",
    title: "Test",
    status,
    detail,
    instance: "/executions/1",
    code,
    request_id: "req-test",
  };
}

describe("query cache conventions", () => {
  it("retries 5xx and network errors only up to the cap", () => {
    const server = new QueryCacheError(problem(503));
    assert.equal(shouldRetryQuery(0, server), true);
    assert.equal(shouldRetryQuery(QUERY_MAX_RETRIES - 1, server), true);
    assert.equal(shouldRetryQuery(QUERY_MAX_RETRIES, server), false);
    assert.equal(shouldRetryQuery(0, new TypeError("network")), true);
  });

  it("does not retry 4xx, cancellations, or mutations", () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      assert.equal(
        shouldRetryQuery(0, new QueryCacheError(problem(status))),
        false,
        String(status),
      );
    }
    const client = createFlowforgeQueryClient({
      defaultOptions: { queries: { gcTime: Infinity } },
    });
    assert.equal(client.getDefaultOptions().mutations?.retry, false);
    assert.equal(client.getDefaultOptions().queries?.retry, shouldRetryQuery);
    assert.equal(client.getDefaultOptions().queries?.persister, undefined);
    assert.equal(
      client.getDefaultOptions().queries?.meta?.persistence,
      FLOWFORGE_QUERY_META.persistence,
    );
    assert.equal(queryClientIsMemoryOnly(client), true);
    assert.equal(flowforgeQueryRetryDelay(0) > 0, true);
  });

  it("applies the shared retry policy on the client", async () => {
    const client = createFlowforgeQueryClient({
      defaultOptions: { queries: { gcTime: Infinity } },
    });
    let attempts = 0;
    await assert.rejects(() =>
      client.fetchQuery({
        queryKey: ["flowforge", "test", "retry"],
        retryDelay: () => 0,
        queryFn: () => {
          attempts += 1;
          throw new QueryCacheError(problem(503, "postgres://user:password@db/app"));
        },
      }),
    );
    assert.equal(attempts, QUERY_MAX_RETRIES + 1);

    let forbiddenAttempts = 0;
    await assert.rejects(() =>
      client.fetchQuery({
        queryKey: ["flowforge", "test", "forbidden"],
        queryFn: () => {
          forbiddenAttempts += 1;
          throw new QueryCacheError(problem(403, "Bearer super-secret", "forbidden"));
        },
      }),
    );
    assert.equal(forbiddenAttempts, 1);
    const forbidden = new QueryCacheError(problem(403, "Bearer super-secret", "forbidden"));
    assert.equal(forbidden.problem.detail.includes("Bearer"), false);
    assert.equal(forbidden.problem.detail.includes("super-secret"), false);
  });

  it("keeps secrets out of keys and cached values", () => {
    const identity = {
      ...emptyDevIdentity(),
      issuer: "https://issuer.example",
      subject: "user-1",
      displayName: "super-secret-name",
      tenantId: "tenant-1",
      workbenchKey: "bench",
    };
    const scope = queryScopeFromIdentity(identity);
    assert.equal(scope.includes("super-secret-name"), false);
    assert.equal(scope.includes("user-1"), true);
    assert.equal(scope.includes("tenant-1"), true);
    assert.equal(tryQueryScope(identity), scope);
    assert.equal(
      queryKeyHasSecret(["Bearer eyJhbGciOi.jwt", "flowforge"]),
      true,
    );
    assert.equal(workspacePermissionsQueryKey(scope)?.[3], scope);
    assert.equal(executionHistoryQueryKey(scope, "exec-1", "wf-1")?.[4], "history");
    assert.equal(
      executionHistoryQueryKey("Bearer abc", "exec-1"),
      null,
    );
    assert.equal(queryKeyHasSecret(BLOCKED_QUERY_KEY), false);
    for (const root of Object.values(REMAINING_GOD_COMPONENT_QUERY_ROOTS)) {
      assert.equal(queryKeyHasSecret(root), false);
    }

    const sanitized = sanitizeQueryCacheValue({
      id: "exec-1",
      input: { password: "hunter2", dryRun: true },
      signedUrl: "https://bucket.example/object",
      note: "Bearer raw-token",
      idempotencyKey: "deploy-prod-1",
    });
    const value = sanitized.value as {
      input?: { password?: string; dryRun?: boolean };
      signedUrl?: string;
      note?: string;
      idempotencyKey?: string;
    };
    assert.equal(value.input?.password, undefined);
    assert.equal(value.input?.dryRun, true);
    assert.equal(value.signedUrl, undefined);
    assert.equal(value.note, "[redacted]");
    assert.equal(value.idempotencyKey, "deploy-prod-1");
    assert.equal(sanitized.strippedKeys.length > 0, true);
  });

  it("retries through the shared helper and then stops", async () => {
    let attempts = 0;
    const value = await runWithQueryRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new QueryCacheError(problem(502));
        }
        return "ok";
      },
      { delay: () => 0 },
    );
    assert.equal(value, "ok");
    assert.equal(attempts, 3);

    let forbidden = 0;
    await assert.rejects(() =>
      runWithQueryRetry(async () => {
        forbidden += 1;
        throw new QueryCacheError(problem(401));
      }),
    );
    assert.equal(forbidden, 1);
  });

  it("does not persist the cache or mount embed doors from the provider", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const cache = readFileSync(`${here}query-cache.ts`, "utf8");
    const provider = readFileSync(
      `${here}../components/query/QueryProvider.tsx`,
      "utf8",
    );
    const layout = readFileSync(`${here}../app/layout.tsx`, "utf8");
    const pkg = JSON.parse(
      readFileSync(`${here}../../package.json`, "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    assert.doesNotMatch(
      cache,
      /localStorage\.|sessionStorage\.|persistQueryClient\(|dehydrate\(/,
    );
    assert.doesNotMatch(
      provider,
      /localStorage|sessionStorage|persistQueryClient|dehydrate/,
    );
    assert.match(layout, /QueryProvider/);
    assert.doesNotMatch(layout, /LoginChrome|ChangePasswordChrome|FirstRunWizard/);
    const names = Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
    });
    assert.equal(names.includes("@tanstack/react-query"), true);
    assert.equal(names.some((name) => /persist/i.test(name)), false);
  });
});
