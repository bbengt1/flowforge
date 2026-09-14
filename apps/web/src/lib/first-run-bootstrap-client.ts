/**
 * Same-origin client for B.1–B.5 / B.7 bootstrap routes. Chloe B.6 / B.7.
 *
 * GET /bootstrap is called from the standalone shell, never `/embed/v1`.
 * Mutations POST once; secrets are not kept on the parsed status.
 * Skip TLS POSTs `{action:"skip"}` only — no PEM in the body.
 * CSRF is attached by callIdentityProxy when a session is present.
 */

import { callIdentityProxy } from "./identity-client.ts";
import { emptyDevIdentity, type DevIdentity } from "./identity-headers.ts";
import type { ProblemDetails } from "./problem.ts";
import {
  BOOTSTRAP_ADMINS_PATH,
  BOOTSTRAP_PERSISTENCE_PATH,
  BOOTSTRAP_PUBLIC_URL_PATH,
  BOOTSTRAP_STATUS_PATH,
  BOOTSTRAP_TLS_PATH,
  bootstrapAdminBody,
  wizardTlsInput,
  decideBootstrapChrome,
  emptyTlsUploadDraft,
  parseBootstrapStatus,
  type BootstrapAdminInput,
  type BootstrapChromeDecision,
  type BootstrapStatus,
  type BootstrapTlsInput,
} from "./first-run-bootstrap.ts";

export type BootstrapClientFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
  strippedKeys: string[];
};

export type BootstrapStatusSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  status: BootstrapStatus;
  strippedKeys: string[];
};

export type BootstrapStatusResult = BootstrapStatusSuccess | BootstrapClientFailure;

export type BootstrapGateLoad =
  | { ok: true; decision: BootstrapChromeDecision; requestId: string }
  | (BootstrapClientFailure & { decision: BootstrapChromeDecision });

function identityOrEmpty(identity?: DevIdentity): DevIdentity {
  return identity ?? emptyDevIdentity();
}

function asFailure(
  result: Extract<Awaited<ReturnType<typeof callIdentityProxy<unknown>>>, { ok: false }>,
  strippedKeys: string[] = [],
): BootstrapClientFailure {
  return {
    ok: false,
    statusCode: result.statusCode,
    requestId: result.requestId,
    problem: result.problem,
    strippedKeys,
  };
}

function asStatus(
  result: Extract<Awaited<ReturnType<typeof callIdentityProxy<unknown>>>, { ok: true }>,
  fallbackStatus = result.statusCode,
): BootstrapStatusResult {
  const strippedKeys = collectBodySecrets(result.data);
  const status = parseBootstrapStatus(result.data);
  if (!status) {
    return {
      ok: false,
      statusCode: fallbackStatus,
      requestId: result.requestId,
      problem: {
        type: "urn:flowforge:problem:invalid-request",
        title: "Invalid Request",
        status: 400,
        detail: "Bootstrap status was missing or contained unexpected fields.",
        instance: BOOTSTRAP_STATUS_PATH,
        code: "invalid-request",
        request_id: result.requestId,
      },
      strippedKeys,
    };
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    status,
    strippedKeys,
  };
}

function collectBodySecrets(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const keys: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (
        /password|passwd|certPem|cert_pem|keyPem|key_pem|privateKey|private_key|kek|publicBaseUrl|public_base_url|DATABASE_URL|database_url|dsn|hash|ciphertext/i.test(
          key,
        )
      ) {
        keys.push(key);
      }
      walk(child);
    }
  };
  walk(value);
  return keys;
}

export async function loadBootstrapGate(input: {
  embed: boolean;
  identity?: DevIdentity;
}): Promise<BootstrapGateLoad> {
  if (input.embed) {
    return {
      ok: true,
      requestId: "",
      decision: { chrome: "ignore", status: null, reason: "embed" },
    };
  }
  const result = await callIdentityProxy<unknown>(
    BOOTSTRAP_STATUS_PATH,
    identityOrEmpty(input.identity),
  );
  if (!result.ok) {
    return {
      ...asFailure(result),
      decision: decideBootstrapChrome({
        embed: false,
        statusCode: result.statusCode,
        body: result.problem,
      }),
    };
  }
  const parsed = asStatus(result);
  if (!parsed.ok) {
    return {
      ...parsed,
      decision: decideBootstrapChrome({
        embed: false,
        statusCode: result.statusCode,
        body: result.data,
      }),
    };
  }
  return {
    ok: true,
    requestId: parsed.requestId,
    decision: decideBootstrapChrome({
      embed: false,
      statusCode: parsed.statusCode,
      body: parsed.status,
    }),
  };
}

export async function confirmBootstrapPersistence(input: {
  embed: boolean;
  identity?: DevIdentity;
}): Promise<BootstrapStatusResult> {
  if (input.embed) {
    return embedDenied(BOOTSTRAP_PERSISTENCE_PATH);
  }
  const result = await callIdentityProxy<unknown>(
    BOOTSTRAP_PERSISTENCE_PATH,
    identityOrEmpty(input.identity),
    { method: "POST", body: { confirm: true } },
  );
  return finishMutation(result);
}

export async function createBootstrapAdmin(input: {
  embed: boolean;
  identity?: DevIdentity;
  admin: BootstrapAdminInput;
}): Promise<BootstrapStatusResult> {
  if (input.embed) {
    return embedDenied(BOOTSTRAP_ADMINS_PATH);
  }
  const result = await callIdentityProxy<unknown>(
    BOOTSTRAP_ADMINS_PATH,
    identityOrEmpty(input.identity),
    { method: "POST", body: bootstrapAdminBody(input.admin) },
  );
  return finishMutation(result);
}

export async function setBootstrapPublicUrl(input: {
  embed: boolean;
  identity?: DevIdentity;
  publicBaseUrl: string;
}): Promise<BootstrapStatusResult> {
  if (input.embed) {
    return embedDenied(BOOTSTRAP_PUBLIC_URL_PATH);
  }
  const result = await callIdentityProxy<unknown>(
    BOOTSTRAP_PUBLIC_URL_PATH,
    identityOrEmpty(input.identity),
    { method: "POST", body: { publicBaseUrl: input.publicBaseUrl } },
  );
  return finishMutation(result);
}

export async function setBootstrapTls(input: {
  embed: boolean;
  identity?: DevIdentity;
  tls: BootstrapTlsInput;
}): Promise<BootstrapStatusResult> {
  if (input.embed) {
    return embedDenied(BOOTSTRAP_TLS_PATH);
  }
  const body =
    input.tls.action === "upload"
      ? wizardTlsInput("upload", input.tls)
      : wizardTlsInput(input.tls.action, emptyTlsUploadDraft());
  if (!body) {
    return {
      ok: false,
      statusCode: 400,
      requestId: "",
      problem: {
        type: "urn:flowforge:problem:invalid-request",
        title: "Invalid Request",
        status: 400,
        detail: "Upload requires both certificate and private key PEMs.",
        instance: BOOTSTRAP_TLS_PATH,
        code: "invalid-request",
        request_id: "",
      },
      strippedKeys: [],
    };
  }
  const result = await callIdentityProxy<unknown>(
    BOOTSTRAP_TLS_PATH,
    identityOrEmpty(input.identity),
    { method: "POST", body },
  );
  return finishMutation(result);
}

function finishMutation(
  result: Awaited<ReturnType<typeof callIdentityProxy<unknown>>>,
): BootstrapStatusResult {
  if (!result.ok) {
    return asFailure(result, collectBodySecrets(result.problem));
  }
  return asStatus(result);
}

function embedDenied(instance: string): BootstrapClientFailure {
  return {
    ok: false,
    statusCode: 403,
    requestId: "",
    problem: {
      type: "urn:flowforge:problem:forbidden",
      title: "Forbidden",
      status: 403,
      detail:
        "First-run bootstrap is standalone only. Embed chrome uses session.embed.",
      instance,
      code: "forbidden",
      request_id: "",
    },
    strippedKeys: [],
  };
}

/** Call after a TLS upload so PEM drafts never linger in caller state. */
export function forgetTlsUploadDraft(): { certPem: string; keyPem: string } {
  return emptyTlsUploadDraft();
}
