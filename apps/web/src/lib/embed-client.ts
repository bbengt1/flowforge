/**
 * Thin embed client on jonny's #125 map. Paths and bodies come from
 * embed-contract.ts. The compact JWS is POSTed once and forgotten —
 * never written to localStorage, sessionStorage, or the URL.
 *
 * Relates to #122 / Part of #120. Keep #122 open. Do not change apps/api.
 * After exchange, persist FlowForge-verified (tenant_id, workbench_key)
 * only — host query values never become workspace lookup.
 *
 * ADV-007: fetchSameOriginProxy already sends credentials:include so
 * CHIPS Set-Cookie (SameSite=None; Secure; Partitioned) is stored and
 * sent in the iframe. Do not request Storage Access / unpartitioned
 * cookies. Cookie not sent is 401/403.
 *
 * ADV-012: HTTP 429 on exchange is backoff (not forbidden). Prefer no
 * UI change beyond showing the problem detail / Retry-After.
 */

import { persistVerifiedFromExchange } from "./embed-tenancy-client.ts";
import { identityFromVerified } from "./embed-tenancy-contract.ts";
import { saveDevIdentity } from "./dev-identity.ts";
import {
  EMBED_CATALOG_PATH,
  EMBED_EXCHANGED_MESSAGE,
  EMBED_EXCHANGE_PATH,
  EMBED_FORBIDDEN_MESSAGE,
  EMBED_JWKS_PATH,
  EMBED_PROBLEM_CODES,
  EMBED_SECRET_LEAK_MESSAGE,
  buildEmbedExchangeBody,
  embedAuthFailureMessage,
  forgetEmbedAssertion,
  parseEmbedExchangePayload,
  publicJwksOnly,
  validateEmbedAssertion,
  type EmbedVerifiedContext,
} from "./embed-contract.ts";
import { fetchSameOriginProxy } from "./identity-client.ts";
import type { ProblemDetails } from "./problem.ts";
import { generateRequestId, REQUEST_ID_HEADER } from "./request-id.ts";
import { parseBrowserSession } from "./session.ts";
import { sameOriginProxyUrl } from "./session-contract.ts";
import { getSessionSnapshot, setActiveSession } from "./session-store.ts";

export type EmbedExchangeSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  context: EmbedVerifiedContext;
  leaked: boolean;
  strippedKeys: string[];
  message: string;
};

export type EmbedExchangeFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
  forbidden: boolean;
};

function localProblem(
  path: string,
  requestId: string,
  status: number,
  code: string,
  title: string,
  detail: string,
): ProblemDetails {
  return {
    type: `urn:flowforge:problem:${code}`,
    title,
    status,
    detail,
    instance: path,
    code,
    request_id: requestId,
  };
}

export async function exchangeEmbedAssertion(
  holder: { assertion: string },
): Promise<EmbedExchangeSuccess | EmbedExchangeFailure> {
  const path = EMBED_EXCHANGE_PATH;
  const requestId = generateRequestId();
  const validated = validateEmbedAssertion(holder.assertion);
  if (!validated.ok) {
    forgetEmbedAssertion(holder);
    return {
      ok: false,
      statusCode: 400,
      requestId,
      forbidden: false,
      problem: localProblem(
        path,
        requestId,
        400,
        EMBED_PROBLEM_CODES.invalidRequest,
        "Invalid request",
        validated.errors[0] ?? "Assertion is invalid.",
      ),
    };
  }

  const instance = sameOriginProxyUrl(path);
  if (!instance) {
    forgetEmbedAssertion(holder);
    return {
      ok: false,
      statusCode: 400,
      requestId,
      forbidden: false,
      problem: localProblem(
        path,
        requestId,
        400,
        EMBED_PROBLEM_CODES.invalidRequest,
        "Invalid request",
        "Browser session calls must use the same-origin /api/v1 proxy.",
      ),
    };
  }

  const result = await fetchSameOriginProxy<unknown>({
    instance,
    method: "POST",
    headers: {
      Accept: "application/json, application/problem+json",
      "Content-Type": "application/json",
      [REQUEST_ID_HEADER]: requestId,
    },
    body: JSON.stringify(buildEmbedExchangeBody(validated.body.assertion)),
    requestId,
  });
  forgetEmbedAssertion(holder);

  if (!result.ok) {
    const auth = embedAuthFailureMessage(result.problem);
    const forbidden =
      result.statusCode === 403 ||
      result.problem.code === EMBED_PROBLEM_CODES.forbidden;
    return {
      ok: false,
      statusCode: result.statusCode,
      requestId: result.requestId,
      forbidden,
      problem: {
        ...result.problem,
        detail: auth || result.problem.detail || EMBED_FORBIDDEN_MESSAGE,
      },
    };
  }

  const parsed = parseEmbedExchangePayload(result.data);
  applyExchangeSession(result.data);
  applyVerifiedWorkspaceLookup(parsed.context);
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    context: parsed.context,
    leaked: parsed.leaked,
    strippedKeys: parsed.strippedKeys,
    message: parsed.leaked
      ? `${EMBED_EXCHANGED_MESSAGE} ${EMBED_SECRET_LEAK_MESSAGE}`
      : EMBED_EXCHANGED_MESSAGE,
  };
}

export async function fetchEmbedCatalog(): Promise<
  | { ok: true; statusCode: number; requestId: string; data: unknown }
  | EmbedExchangeFailure
> {
  return getEmbedJson(EMBED_CATALOG_PATH);
}

export async function fetchEmbedJwks(): Promise<
  | {
      ok: true;
      statusCode: number;
      requestId: string;
      keys: Record<string, unknown>[];
      leaked: boolean;
    }
  | EmbedExchangeFailure
> {
  const result = await getEmbedJson(EMBED_JWKS_PATH);
  if (!result.ok) {
    return result;
  }
  const sanitized = publicJwksOnly(result.data);
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    keys: sanitized.keys,
    leaked: sanitized.leaked,
  };
}

async function getEmbedJson(path: string): Promise<
  | { ok: true; statusCode: number; requestId: string; data: unknown }
  | EmbedExchangeFailure
> {
  const requestId = generateRequestId();
  const instance = sameOriginProxyUrl(path);
  if (!instance) {
    return {
      ok: false,
      statusCode: 400,
      requestId,
      forbidden: false,
      problem: localProblem(
        path,
        requestId,
        400,
        EMBED_PROBLEM_CODES.invalidRequest,
        "Invalid request",
        "Browser session calls must use the same-origin /api/v1 proxy.",
      ),
    };
  }
  const result = await fetchSameOriginProxy<unknown>({
    instance,
    method: "GET",
    headers: {
      Accept: "application/json, application/problem+json",
      [REQUEST_ID_HEADER]: requestId,
    },
    requestId,
  });
  if (!result.ok) {
    return {
      ok: false,
      statusCode: result.statusCode,
      requestId: result.requestId,
      forbidden: result.statusCode === 403,
      problem: result.problem,
    };
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    data: result.data,
  };
}

function applyExchangeSession(payload: unknown): void {
  const parsed = parseBrowserSession(payload);
  if (!parsed) {
    return;
  }
  const remembered = getSessionSnapshot().session.csrfToken;
  if (remembered) {
    parsed.csrfToken = remembered;
  }
  setActiveSession(parsed);
}

/**
 * After a verified exchange, persist tenant + workbench as workspace
 * lookup (same sessionStorage pattern as E2). Values come from the API
 * workspace/tenant — not from the host deep-link query.
 */
function applyVerifiedWorkspaceLookup(context: EmbedVerifiedContext): void {
  const verified = persistVerifiedFromExchange(context);
  if (!verified) {
    return;
  }
  saveDevIdentity(
    identityFromVerified(
      {
        issuer: "",
        subject: "",
        displayName: "",
        tenantId: "",
        tenantSlug: "",
        workbenchKey: "",
      },
      verified,
    ),
  );
}

export function emptyAssertionHolder(): { assertion: string } {
  return { assertion: "" };
}
