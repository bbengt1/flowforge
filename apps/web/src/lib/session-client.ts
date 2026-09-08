import { attachCsrfHeader, resolveCsrfToken, shouldAttachCsrf } from "./csrf.ts";
import { fetchSameOriginProxy, type IdentityClientResult } from "./identity-client.ts";
import { generateRequestId, REQUEST_ID_HEADER } from "./request-id.ts";
import { isUnauthenticatedProblem, parseBrowserSession } from "./session.ts";
import {
  CSRF_HEADER,
  type SessionEstablishBody,
  type SessionPayload,
  sessionProxyPath,
} from "./session-contract.ts";
import {
  clearSession,
  getSessionSnapshot,
  markSessionStale,
  setActiveSession,
} from "./session-store.ts";

export type SessionForm = {
  issuer: string;
  subject: string;
  displayName: string;
};

export async function establishSession(
  form: SessionForm,
): Promise<IdentityClientResult<SessionPayload>> {
  const requestId = generateRequestId();
  const instance = sessionProxyPath();
  const body: SessionEstablishBody = {
    issuer: form.issuer.trim(),
    subject: form.subject.trim(),
  };
  if (form.displayName.trim()) {
    body.display_name = form.displayName.trim();
  }
  const headers: Record<string, string> = {
    Accept: "application/json, application/problem+json",
    "Content-Type": "application/json",
    [REQUEST_ID_HEADER]: requestId,
  };
  const token = resolveCsrfToken();
  if (token) {
    attachCsrfHeader(headers, token);
  }

  const result = await fetchSameOriginProxy<SessionPayload>({
    instance,
    method: "POST",
    headers,
    body: JSON.stringify(body),
    requestId,
  });
  if (result.ok) {
    applySessionPayload(result.data);
  }
  return result;
}

export async function refreshSession(): Promise<IdentityClientResult<SessionPayload>> {
  const requestId = generateRequestId();
  const previous = getSessionSnapshot();
  const result = await fetchSameOriginProxy<SessionPayload>({
    instance: sessionProxyPath(),
    method: "GET",
    headers: {
      Accept: "application/json, application/problem+json",
      [REQUEST_ID_HEADER]: requestId,
    },
    requestId,
  });
  if (result.ok) {
    applySessionPayload(result.data);
    return result;
  }
  if (isUnauthenticatedProblem(result.problem)) {
    if (previous.active) {
      markSessionStale();
    } else {
      clearSession();
    }
  }
  return result;
}

export async function endSession(): Promise<IdentityClientResult<unknown>> {
  const requestId = generateRequestId();
  const instance = sessionProxyPath();
  const headers: Record<string, string> = {
    Accept: "application/json, application/problem+json",
    [REQUEST_ID_HEADER]: requestId,
  };
  if (shouldAttachCsrf("DELETE", instance)) {
    const token = resolveCsrfToken();
    if (token) {
      headers[CSRF_HEADER] = token;
    }
  }
  const result = await fetchSameOriginProxy<unknown>({
    instance,
    method: "DELETE",
    headers,
    requestId,
  });
  clearSession();
  return result;
}

function applySessionPayload(payload: SessionPayload): void {
  const parsed = parseBrowserSession(payload);
  if (parsed) {
    setActiveSession(parsed);
  }
}
