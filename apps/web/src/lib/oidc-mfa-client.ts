/**
 * Browser calls for G.2.1 OIDC + MFA. Cookies stay HttpOnly.
 * This module does not read `ff_oidc_state`, and it does not persist
 * the PKCE verifier, IdP tokens, passwords, or `otpauth_uri`.
 */

import { attachCsrfHeader, resolveCsrfToken, shouldAttachCsrf } from "./csrf.ts";
import { fetchSameOriginProxy, type IdentityClientResult } from "./identity-client.ts";
import {
  mfaCodeIsSubmittable,
  mfaEnrollBody,
  mfaEnrollBrowserPath,
  mfaStatusBrowserPath,
  mfaVerifyBody,
  mfaVerifyBrowserPath,
  oidcCallbackBody,
  oidcCallbackBrowserPath,
  oidcStartBody,
  oidcStartBrowserPath,
  parseMfaStatus,
  parseOidcStart,
  takeOtpauthUri,
  type MfaStatus,
  type OidcStartResponse,
} from "./oidc-mfa.ts";
import { generateRequestId, REQUEST_ID_HEADER } from "./request-id.ts";
import type { SessionPayload } from "./session-contract.ts";
import { rememberSessionPayload, loadCurrentSession } from "./session-client.ts";

export type MfaCallResult = IdentityClientResult<MfaStatus>;

export type MfaEnrollCallResult =
  | { ok: true; statusCode: number; requestId: string; status: MfaStatus; otpauthUri: string | null }
  | Extract<IdentityClientResult<MfaStatus>, { ok: false }>;

const JSON_HEADERS = {
  Accept: "application/json, application/problem+json",
  "Content-Type": "application/json",
};

function requestHeaders(method: string, instance: string): Record<string, string> {
  const headers: Record<string, string> = {
    ...JSON_HEADERS,
    [REQUEST_ID_HEADER]: generateRequestId(),
  };
  if (shouldAttachCsrf(method, instance)) {
    const token = resolveCsrfToken();
    if (token) {
      attachCsrfHeader(headers, token);
    }
  }
  return headers;
}

export async function startOidcLogin(): Promise<IdentityClientResult<OidcStartResponse>> {
  const instance = oidcStartBrowserPath();
  const headers = requestHeaders("POST", instance);
  const result = await fetchSameOriginProxy<unknown>({
    instance,
    method: "POST",
    headers,
    body: JSON.stringify(oidcStartBody()),
    requestId: headers[REQUEST_ID_HEADER] ?? generateRequestId(),
  });
  if (!result.ok) {
    return result;
  }
  const parsed = parseOidcStart(result.data);
  if (!parsed) {
    return {
      ok: false,
      statusCode: 502,
      requestId: result.requestId,
      problem: {
        type: "urn:flowforge:problem:upstream-error",
        title: "Upstream Error",
        status: 502,
        detail: "Sign-in failed.",
        instance,
        code: "upstream-error",
        request_id: result.requestId,
      },
    };
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    data: parsed,
  };
}

export async function completeOidcCallback(input: {
  code: string;
  state: string;
}): Promise<IdentityClientResult<SessionPayload>> {
  const instance = oidcCallbackBrowserPath();
  const headers = requestHeaders("POST", instance);
  const result = await fetchSameOriginProxy<SessionPayload>({
    instance,
    method: "POST",
    headers,
    body: JSON.stringify(oidcCallbackBody(input.code, input.state)),
    requestId: headers[REQUEST_ID_HEADER] ?? generateRequestId(),
  });
  if (result.ok) {
    rememberSessionPayload(result.data);
  }
  return result;
}

let callbackInflight: Promise<IdentityClientResult<SessionPayload>> | null = null;

/** One in-flight callback per page load so a strict-mode remount cannot replay the code. */
export function completeOidcCallbackOnce(input: {
  code: string;
  state: string;
}): Promise<IdentityClientResult<SessionPayload>> {
  if (!callbackInflight) {
    callbackInflight = completeOidcCallback(input);
  }
  return callbackInflight;
}

export function takeOidcCallbackFlight(): Promise<
  IdentityClientResult<SessionPayload>
> | null {
  return callbackInflight;
}

export function resetOidcCallbackFlightForTests(): void {
  callbackInflight = null;
}

export async function loadMfaStatus(): Promise<MfaCallResult> {
  const instance = mfaStatusBrowserPath();
  const requestId = generateRequestId();
  const result = await fetchSameOriginProxy<unknown>({
    instance,
    method: "GET",
    headers: {
      Accept: "application/json, application/problem+json",
      [REQUEST_ID_HEADER]: requestId,
    },
    requestId,
  });
  return asMfaStatus(result);
}

export async function enrollMfa(): Promise<MfaEnrollCallResult> {
  const instance = mfaEnrollBrowserPath();
  const headers = requestHeaders("POST", instance);
  const result = await fetchSameOriginProxy<unknown>({
    instance,
    method: "POST",
    headers,
    body: JSON.stringify(mfaEnrollBody()),
    requestId: headers[REQUEST_ID_HEADER] ?? generateRequestId(),
  });
  if (!result.ok) {
    return result;
  }
  const status = parseMfaStatus(result.data);
  if (!status) {
    return {
      ok: false,
      statusCode: 502,
      requestId: result.requestId,
      problem: {
        type: "urn:flowforge:problem:upstream-error",
        title: "Upstream Error",
        status: 502,
        detail: "Multi-factor authentication failed.",
        instance,
        code: "upstream-error",
        request_id: result.requestId,
      },
    };
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    status,
    otpauthUri: takeOtpauthUri(result.data),
  };
}

export async function verifyMfa(code: string): Promise<MfaCallResult> {
  const trimmed = code.trim();
  if (!mfaCodeIsSubmittable(trimmed)) {
    const requestId = generateRequestId();
    return {
      ok: false,
      statusCode: 400,
      requestId,
      problem: {
        type: "urn:flowforge:problem:invalid-request",
        title: "Invalid Request",
        status: 400,
        detail: "Multi-factor authentication failed.",
        instance: mfaVerifyBrowserPath(),
        code: "invalid-request",
        request_id: requestId,
      },
    };
  }
  const instance = mfaVerifyBrowserPath();
  const headers = requestHeaders("POST", instance);
  const result = await fetchSameOriginProxy<unknown>({
    instance,
    method: "POST",
    headers,
    body: JSON.stringify(mfaVerifyBody(trimmed)),
    requestId: headers[REQUEST_ID_HEADER] ?? generateRequestId(),
  });
  if (!result.ok) {
    return result;
  }
  const status = asMfaStatus(result);
  if (status.ok) {
    await loadCurrentSession();
  }
  return status;
}

function asMfaStatus(result: IdentityClientResult<unknown>): MfaCallResult {
  if (!result.ok) {
    return result;
  }
  const status = parseMfaStatus(result.data);
  if (!status) {
    return {
      ok: false,
      statusCode: 502,
      requestId: result.requestId,
      problem: {
        type: "urn:flowforge:problem:upstream-error",
        title: "Upstream Error",
        status: 502,
        detail: "Multi-factor authentication failed.",
        instance: mfaStatusBrowserPath(),
        code: "upstream-error",
        request_id: result.requestId,
      },
    };
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    data: status,
  };
}
