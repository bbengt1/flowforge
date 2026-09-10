/**
 * Thin Portal host client on jonny's #129 map (`e113-#129`).
 *
 * GET /portal/adapter → capability map.
 * POST /portal/adapter/assertions {portalRoles} → compact JWS once.
 * Exchange stays POST /embed/exchange in the embed shell.
 *
 * Relates to #123 / Part of #120. Keep #123 open. Do not change apps/api.
 */

import {
  forgetEmbedAssertion,
  isAllowedEmbedMessageOrigin,
} from "./embed-contract.ts";
import { callIdentityProxy } from "./identity-client.ts";
import { emptyDevIdentity, type DevIdentity } from "./identity-headers.ts";
import type { ProblemDetails } from "./problem.ts";
import {
  PORTAL_ADAPTER_PATH,
  PORTAL_DENIED_MESSAGE,
  PORTAL_HOSTILE_ISSUER_MESSAGE,
  PORTAL_MINT_PATH,
  PORTAL_REPLAY_MESSAGE,
  buildPortalAssertionMessage,
  parsePortalMintAssertion,
  portalEntryAllowsMount,
  portalMintBody,
  validatePortalRoles,
  type PortalEntryRbac,
} from "./portal-adapter-contract.ts";
import { generateRequestId } from "./request-id.ts";

export type PortalMintSuccess = {
  ok: true;
  assertion: string;
  tokenId: string;
  requestId: string;
  statusCode: number;
};

export type PortalMintFailure = {
  ok: false;
  requestId: string;
  statusCode: number;
  problem: ProblemDetails;
  forbidden: boolean;
};

function localProblem(
  instance: string,
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
    instance,
    code,
    request_id: requestId,
  };
}

export async function fetchPortalAdapter(
  identity: DevIdentity = emptyDevIdentity(),
): Promise<
  | { ok: true; statusCode: number; requestId: string; data: unknown }
  | PortalMintFailure
> {
  const result = await callIdentityProxy<unknown>(PORTAL_ADAPTER_PATH, identity, {
    method: "GET",
  });
  if (!result.ok) {
    return {
      ok: false,
      requestId: result.requestId,
      statusCode: result.statusCode,
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

export async function mintPortalAssertion(
  rbac: PortalEntryRbac,
  input: {
    portalRoles: string[];
    subject?: string;
    displayName?: string;
    issuer?: string;
    tenantId?: string;
    workbenchKey?: string;
    ttlSeconds?: number;
  },
  identity: DevIdentity = emptyDevIdentity(),
): Promise<PortalMintSuccess | PortalMintFailure> {
  const requestId = generateRequestId();
  if (!portalEntryAllowsMount(rbac)) {
    return {
      ok: false,
      requestId,
      statusCode: 403,
      forbidden: true,
      problem: localProblem(
        PORTAL_MINT_PATH,
        requestId,
        403,
        "forbidden",
        "Portal entry denied",
        PORTAL_DENIED_MESSAGE,
      ),
    };
  }

  const validated = validatePortalRoles(input.portalRoles);
  if (!validated.ok) {
    return {
      ok: false,
      requestId,
      statusCode: 400,
      forbidden: false,
      problem: localProblem(
        PORTAL_MINT_PATH,
        requestId,
        400,
        "invalid-request",
        "Invalid request",
        validated.errors[0] ?? "portalRoles are invalid.",
      ),
    };
  }

  const result = await callIdentityProxy<unknown>(PORTAL_MINT_PATH, identity, {
    method: "POST",
    body: portalMintBody({
      portalRoles: validated.portalRoles,
      subject: input.subject,
      displayName: input.displayName,
      issuer: input.issuer,
      tenantId: input.tenantId,
      workbenchKey: input.workbenchKey,
      ttlSeconds: input.ttlSeconds,
    }),
  });
  if (!result.ok) {
    const hostile = result.statusCode === 403;
    return {
      ok: false,
      requestId: result.requestId,
      statusCode: result.statusCode,
      forbidden: hostile,
      problem: {
        ...result.problem,
        detail:
          result.statusCode === 409
            ? PORTAL_REPLAY_MESSAGE
            : hostile
              ? result.problem.detail || PORTAL_HOSTILE_ISSUER_MESSAGE
              : result.problem.detail,
      },
    };
  }

  const parsed = parsePortalMintAssertion(result.data);
  if (!parsed.ok) {
    return {
      ok: false,
      requestId: result.requestId,
      statusCode: 502,
      forbidden: false,
      problem: localProblem(
        PORTAL_MINT_PATH,
        result.requestId,
        502,
        "invalid-request",
        "Invalid mint response",
        parsed.errors[0] ?? "Mint did not return a compact JWS.",
      ),
    };
  }

  return {
    ok: true,
    assertion: parsed.assertion,
    tokenId: parsed.tokenId,
    requestId: result.requestId,
    statusCode: result.statusCode,
  };
}

export function deliverPortalAssertion(
  target: Window | null | undefined,
  holder: { assertion: string },
  targetOrigin: string,
  allowlist: readonly string[] = [],
  selfOrigin?: string,
): { delivered: boolean; forgotten: true } {
  const message = buildPortalAssertionMessage(holder.assertion);
  forgetEmbedAssertion(holder);
  if (!message || !target) {
    return { delivered: false, forgotten: true };
  }
  const origin = targetOrigin.trim();
  if (!isAllowedEmbedMessageOrigin(origin, allowlist, { selfOrigin })) {
    return { delivered: false, forgotten: true };
  }
  target.postMessage(message, origin);
  return { delivered: true, forgotten: true };
}

/**
 * ADV-013 cross-origin sender. postMessage target is the embed origin
 * (iframe dest). The shared host allowlist still authorizes the Portal
 * sender — empty list, `*`, and unallowlisted Portal origins fail closed.
 * Does not weaken ADV-011: the in-repo same-origin helper is unchanged.
 */
export function deliverCrossOriginPortalAssertion(
  target: Window | null | undefined,
  holder: { assertion: string },
  input: {
    embedOrigin: string;
    portalOrigin: string;
    allowlist: readonly string[];
  },
): { delivered: boolean; forgotten: true } {
  const message = buildPortalAssertionMessage(holder.assertion);
  forgetEmbedAssertion(holder);
  if (!message || !target) {
    return { delivered: false, forgotten: true };
  }
  const embedOrigin = input.embedOrigin.trim();
  const portalOrigin = input.portalOrigin.trim();
  if (
    !embedOrigin ||
    embedOrigin === "*" ||
    embedOrigin === "null" ||
    input.allowlist.length === 0
  ) {
    return { delivered: false, forgotten: true };
  }
  try {
    const parsed = new URL(embedOrigin);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.origin !== embedOrigin
    ) {
      return { delivered: false, forgotten: true };
    }
  } catch {
    return { delivered: false, forgotten: true };
  }
  if (
    !isAllowedEmbedMessageOrigin(portalOrigin, input.allowlist, {
      selfOrigin: portalOrigin,
    })
  ) {
    return { delivered: false, forgotten: true };
  }
  target.postMessage(message, embedOrigin);
  return { delivered: true, forgotten: true };
}

export function emptyPortalAssertionHolder(): { assertion: string } {
  return { assertion: "" };
}
