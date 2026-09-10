import { attachCsrfHeader, resolveCsrfToken, shouldAttachCsrf } from "./csrf.ts";
import { persistVerifiedFromSession } from "./embed-tenancy-client.ts";
import { fetchSameOriginProxy, type IdentityClientResult } from "./identity-client.ts";
import type { ItemList } from "./identity-types.ts";
import { generateRequestId, REQUEST_ID_HEADER } from "./request-id.ts";
import { isUnauthenticatedProblem, parseBrowserSession } from "./session.ts";
import {
  CSRF_HEADER,
  SESSION_AUDIT_PATH,
  SESSION_LOGOUT_PATH,
  SESSION_PATH,
  SESSION_REFRESH_PATH,
  type SessionAuditEvent,
  type SessionEstablishBody,
  type SessionPayload,
  sessionBrowserPath,
} from "./session-contract.ts";
import { parseSessionEmbedChrome } from "./session-embed-contract.ts";
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
  const instance = sessionBrowserPath(SESSION_PATH);
  const body: SessionEstablishBody = {
    issuer: form.issuer.trim(),
    external_subject: form.subject.trim(),
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

export async function loadCurrentSession(): Promise<IdentityClientResult<SessionPayload>> {
  const requestId = generateRequestId();
  const previous = getSessionSnapshot();
  const result = await fetchSameOriginProxy<SessionPayload>({
    instance: sessionBrowserPath(SESSION_PATH),
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

export async function refreshSession(): Promise<IdentityClientResult<SessionPayload>> {
  const requestId = generateRequestId();
  const instance = sessionBrowserPath(SESSION_REFRESH_PATH);
  const headers: Record<string, string> = {
    Accept: "application/json, application/problem+json",
    [REQUEST_ID_HEADER]: requestId,
  };
  if (shouldAttachCsrf("POST", instance)) {
    const token = resolveCsrfToken();
    if (token) {
      headers[CSRF_HEADER] = token;
    }
  }
  const result = await fetchSameOriginProxy<SessionPayload>({
    instance,
    method: "POST",
    headers,
    requestId,
  });
  if (result.ok) {
    applySessionPayload(result.data);
    return result;
  }
  if (isUnauthenticatedProblem(result.problem)) {
    markSessionStale();
  }
  return result;
}

export async function endSession(): Promise<IdentityClientResult<unknown>> {
  const requestId = generateRequestId();
  const instance = sessionBrowserPath(SESSION_LOGOUT_PATH);
  const headers: Record<string, string> = {
    Accept: "application/json, application/problem+json",
    [REQUEST_ID_HEADER]: requestId,
  };
  if (shouldAttachCsrf("POST", instance)) {
    const token = resolveCsrfToken();
    if (token) {
      headers[CSRF_HEADER] = token;
    }
  }
  const result = await fetchSameOriginProxy<unknown>({
    instance,
    method: "POST",
    headers,
    requestId,
  });
  clearSession();
  return result;
}

export async function loadSessionAudit(): Promise<
  IdentityClientResult<ItemList<SessionAuditEvent>>
> {
  const requestId = generateRequestId();
  return fetchSameOriginProxy<ItemList<SessionAuditEvent>>({
    instance: sessionBrowserPath(SESSION_AUDIT_PATH),
    method: "GET",
    headers: {
      Accept: "application/json, application/problem+json",
      [REQUEST_ID_HEADER]: requestId,
    },
    requestId,
  });
}

function applySessionPayload(payload: SessionPayload): void {
  const parsed = parseBrowserSession(payload);
  if (!parsed) {
    return;
  }
  // fetchSameOriginProxy already captured header/body CSRF into the store.
  // Prefer that (header wins over body) so a rotated token is kept when
  // the snapshot is replaced.
  const remembered = getSessionSnapshot().session.csrfToken;
  if (remembered) {
    parsed.csrfToken = remembered;
  }
  setActiveSession(parsed, parseSessionEmbedChrome(payload));
  persistVerifiedFromSession(payload.session);
}
