/**
 * SCIM workspace tokens client. Cookie session + X-CSRF-Token on writes
 * via the same-origin identity proxy. The create body carries only
 * `displayName`; the workspace is server-derived and never sent.
 *
 * The create result keeps the plaintext apart from the record so the
 * caller can cache the record and hand the plaintext to the reveal panel
 * only. Nothing here logs, stores, or caches either.
 */

import { callIdentityProxy } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import type { ProblemDetails } from "./problem.ts";
import {
  SCIM_TOKENS_API_PATH,
  normalizeScimTokenName,
  readScimTokenCreated,
  readScimTokenList,
  scimTokenApiPath,
  type ScimToken,
  type ScimTokenList,
} from "./scim-tokens.ts";

export type ScimTokensFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
};

export type ScimTokenListResult = {
  ok: true;
  requestId: string;
  list: ScimTokenList;
};

export type ScimTokenCreateResult = {
  ok: true;
  requestId: string;
  record: ScimToken | null;
  /** Shown once in the reveal panel, then dropped. Null when unreadable. */
  plaintext: string | null;
};

export type ScimTokenRevokeResult = {
  ok: true;
  requestId: string;
  /** The server answered 404: unknown, another workspace's, or gone already. */
  alreadyGone: boolean;
};

function failed(result: {
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
}): ScimTokensFailure {
  return {
    ok: false,
    statusCode: result.statusCode,
    requestId: result.requestId,
    problem: result.problem,
  };
}

export async function listScimTokens(
  identity: DevIdentity,
): Promise<ScimTokenListResult | ScimTokensFailure> {
  const result = await callIdentityProxy<unknown>(SCIM_TOKENS_API_PATH, identity);
  if (!result.ok) {
    return failed(result);
  }
  return { ok: true, requestId: result.requestId, list: readScimTokenList(result.data) };
}

export async function createScimToken(
  identity: DevIdentity,
  displayName: string,
): Promise<ScimTokenCreateResult | ScimTokensFailure> {
  const result = await callIdentityProxy<unknown>(SCIM_TOKENS_API_PATH, identity, {
    method: "POST",
    body: { displayName: normalizeScimTokenName(displayName) },
  });
  if (!result.ok) {
    return failed(result);
  }
  const { record, plaintext } = readScimTokenCreated(result.data);
  return { ok: true, requestId: result.requestId, record, plaintext };
}

/**
 * Idempotent on the server (204 again for a revoked token). A 404 means
 * the token is not there for this workspace, so the web treats it as
 * already gone and refreshes the list.
 */
export async function revokeScimToken(
  identity: DevIdentity,
  tokenId: string,
): Promise<ScimTokenRevokeResult | ScimTokensFailure> {
  const result = await callIdentityProxy<unknown>(scimTokenApiPath(tokenId), identity, {
    method: "DELETE",
  });
  if (!result.ok) {
    if (result.statusCode === 404) {
      return { ok: true, requestId: result.requestId, alreadyGone: true };
    }
    return failed(result);
  }
  return { ok: true, requestId: result.requestId, alreadyGone: false };
}
