"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { ProblemBanner } from "@/components/ProblemBanner";
import { callIdentityProxy } from "@/lib/identity-client";
import { emptyDevIdentity } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";
import {
  effectiveExpiresAt,
  formatSessionCountdown,
  isCsrfProblem,
  sessionExpiryState,
} from "@/lib/session";
import {
  endSession,
  establishSession,
  loadCurrentSession,
  loadSessionAudit,
  refreshSession,
} from "@/lib/session-client";
import type { SessionAuditEvent } from "@/lib/session-contract";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";
import {
  LOCAL_SEED_DISPLAY_NAME,
  LOCAL_SEED_ISSUER,
  LOCAL_SEED_SUBJECT,
} from "@/lib/local-seed-example";
import {
  FF_SETTINGS_CONTROL_CLASS,
  FF_SETTINGS_EYEBROW_CLASS,
  FF_SETTINGS_GHOST_CLASS,
  FF_SETTINGS_MUTED_CLASS,
  FF_SETTINGS_NESTED_CLASS,
  FF_SETTINGS_PANEL_CLASS,
  FF_SETTINGS_PRIMARY_CLASS,
  FF_SETTINGS_SKIP_CLASS,
  FF_SETTINGS_TITLE_CLASS,
} from "@/lib/settings-wizard-visual";

const EXAMPLE_LOGIN = {
  issuer: LOCAL_SEED_ISSUER,
  subject: LOCAL_SEED_SUBJECT,
  displayName: LOCAL_SEED_DISPLAY_NAME,
};

export function SessionPanel() {
  const snapshot = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionSnapshot,
  );
  const [issuer, setIssuer] = useState(EXAMPLE_LOGIN.issuer);
  const [subject, setSubject] = useState(EXAMPLE_LOGIN.subject);
  const [displayName, setDisplayName] = useState(EXAMPLE_LOGIN.displayName);
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [audit, setAudit] = useState<SessionAuditEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void loadCurrentSession();
  }, []);

  const expiresAt = effectiveExpiresAt(snapshot.session);

  useEffect(() => {
    if (!snapshot.active || !expiresAt) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [snapshot.active, expiresAt]);

  const expiry = sessionExpiryState(expiresAt, now);
  const countdown = formatSessionCountdown(expiresAt, now);

  async function login() {
    setPending("login");
    setProblem(null);
    const result = await establishSession({ issuer, subject, displayName });
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
    }
  }

  async function logout() {
    setPending("logout");
    setProblem(null);
    const result = await endSession();
    setPending(null);
    setAudit([]);
    if (!result.ok && result.statusCode !== 401) {
      setProblem(result.problem);
    }
  }

  async function extendIdle() {
    setPending("refresh");
    setProblem(null);
    const result = await refreshSession();
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
    }
  }

  async function loadAudit() {
    setPending("audit");
    setProblem(null);
    const result = await loadSessionAudit();
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setAudit(result.data.items ?? []);
  }

  async function exerciseMissingCsrf() {
    setPending("csrf");
    setProblem(null);
    const result = await callIdentityProxy("/tenants", emptyDevIdentity(), {
      method: "POST",
      body: { slug: "csrf-fail-closed", name: "CSRF fail-closed" },
      omitCsrf: true,
    });
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
    }
  }

  return (
    <section
      id="session"
      aria-labelledby="session-heading"
      className={FF_SETTINGS_PANEL_CLASS}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className={FF_SETTINGS_EYEBROW_CLASS}>
            Browser session · E2.3
          </p>
          <h2 id="session-heading" className={`mt-1 text-lg ${FF_SETTINGS_TITLE_CLASS}`}>
            Cookie session
          </h2>
          <p className={`mt-1 max-w-2xl text-sm leading-6 ${FF_SETTINGS_MUTED_CLASS}`}>
            Calls jonny&apos;s{" "}
            <code className="font-mono text-xs">/api/v1/session</code> through
            the same-origin proxy with{" "}
            <code className="font-mono text-xs">credentials: include</code>.
            Cookies are <code className="font-mono text-xs">ff_session</code>{" "}
            (HttpOnly) and <code className="font-mono text-xs">ff_csrf</code>{" "}
            at <code className="font-mono text-xs">Path=/api/v1</code>.
            Mutations send <code className="font-mono text-xs">X-CSRF-Token</code>.
            Bearer tokens are never placed in localStorage or the URL.
            Trusted-dev <code className="font-mono text-xs">POST /session</code>{" "}
            is local/dev only — never rewrite login. Production identity is{" "}
            <code className="font-mono text-xs">POST /embed/exchange</code>.
          </p>
        </div>
        {snapshot.active ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void extendIdle()}
              disabled={pending !== null}
              className={FF_SETTINGS_GHOST_CLASS}
            >
              {pending === "refresh" ? "Refreshing…" : "Refresh idle"}
            </button>
            <button
              type="button"
              onClick={() => void logout()}
              disabled={pending !== null}
              className={FF_SETTINGS_GHOST_CLASS}
            >
              {pending === "logout" ? "Signing out…" : "Log out"}
            </button>
          </div>
        ) : null}
      </div>

      {snapshot.stale ? (
        <div
          role="status"
          className={`${FF_SETTINGS_SKIP_CLASS} mt-4 px-4 py-3 text-sm`}
        >
          <p className="font-medium">Session expired or is no longer valid</p>
          <p className="mt-1">
            Re-establish a cookie session below. State-changing requests fail
            closed until you do.
          </p>
        </div>
      ) : null}

      {snapshot.active ? (
        <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className={FF_SETTINGS_MUTED_CLASS}>Subject</dt>
            <dd className="font-mono text-sm">{snapshot.session.subject}</dd>
          </div>
          <div>
            <dt className={FF_SETTINGS_MUTED_CLASS}>Issuer</dt>
            <dd className={`font-mono text-xs break-all ${FF_SETTINGS_MUTED_CLASS}`}>
              {snapshot.session.issuer || "—"}
            </dd>
          </div>
          <div>
            <dt className={FF_SETTINGS_MUTED_CLASS}>Display name</dt>
            <dd>{snapshot.session.displayName || "—"}</dd>
          </div>
          <div>
            <dt className={FF_SETTINGS_MUTED_CLASS}>Idle expiry (30m default)</dt>
            <dd
              className={
                expiry === "expired" || expiry === "warning"
                  ? `font-medium ${FF_SETTINGS_SKIP_CLASS} inline-block px-1.5 py-0.5 text-xs`
                  : "font-medium"
              }
            >
              {countdown}
            </dd>
            <dd className={`font-mono text-xs ${FF_SETTINGS_MUTED_CLASS}`}>
              idle {snapshot.session.idleExpiresAt || "—"}
            </dd>
            <dd className={`font-mono text-xs ${FF_SETTINGS_MUTED_CLASS}`}>
              absolute {snapshot.session.absoluteExpiresAt || "—"}
            </dd>
          </div>
        </dl>
      ) : (
        <form
          className="mt-5 grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void login();
          }}
        >
          <label className="text-sm">
            <span className="font-medium">Issuer</span>
            <input
              value={issuer}
              onChange={(event) => setIssuer(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className={`mt-1 font-mono text-sm ${FF_SETTINGS_CONTROL_CLASS}`}
            />
          </label>
          <label className="text-sm">
            <span className="font-medium">Subject</span>
            <input
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className={`mt-1 font-mono text-sm ${FF_SETTINGS_CONTROL_CLASS}`}
            />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="font-medium">Display name (optional)</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              autoComplete="off"
              className={`mt-1 text-sm ${FF_SETTINGS_CONTROL_CLASS}`}
            />
          </label>
          <div>
            <button
              type="submit"
              disabled={pending !== null || !issuer.trim() || !subject.trim()}
              className={FF_SETTINGS_PRIMARY_CLASS}
            >
              {pending === "login" ? "Establishing…" : "Establish session"}
            </button>
          </div>
        </form>
      )}

      {snapshot.active ? (
        <div className="mt-5 space-y-4">
          <div className={`${FF_SETTINGS_NESTED_CLASS} border-dashed px-4 py-3`}>
            <p className={`text-sm font-medium ${FF_SETTINGS_TITLE_CLASS}`}>Fail-closed CSRF exercise</p>
            <p className={`mt-1 text-sm ${FF_SETTINGS_MUTED_CLASS}`}>
              Sends a state-changing request without{" "}
              <code className="font-mono text-xs">X-CSRF-Token</code> while{" "}
              <code className="font-mono text-xs">ff_session</code> is present.
              Expected result is problem+json CSRF fail-closed.
            </p>
            <button
              type="button"
              onClick={() => void exerciseMissingCsrf()}
              disabled={pending !== null}
              className={`mt-3 ${FF_SETTINGS_GHOST_CLASS}`}
            >
              {pending === "csrf" ? "Sending…" : "Send mutation without CSRF"}
            </button>
          </div>

          <div className={`${FF_SETTINGS_NESTED_CLASS} px-4 py-3`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className={`text-sm font-medium ${FF_SETTINGS_TITLE_CLASS}`}>Session audit</p>
              <button
                type="button"
                onClick={() => void loadAudit()}
                disabled={pending !== null}
                className={FF_SETTINGS_GHOST_CLASS}
              >
                {pending === "audit" ? "Loading…" : "Load audit events"}
              </button>
            </div>
            <p className={`mt-1 text-sm ${FF_SETTINGS_MUTED_CLASS}`}>
              <code className="font-mono text-xs">GET /api/v1/session/audit-events</code>
              . Secret-free rows only.
            </p>
            {audit.length === 0 ? (
              <p className={`mt-3 text-sm ${FF_SETTINGS_MUTED_CLASS}`}>No audit events loaded.</p>
            ) : (
              <ul className="mt-3 divide-y divide-white/10 text-sm">
                {audit.map((item) => (
                  <li key={item.id || `${item.event_type}-${item.created_at}`} className="py-2">
                    <p className="font-medium">
                      {item.event_type} · {item.outcome}
                    </p>
                    <p className={FF_SETTINGS_MUTED_CLASS}>{item.reason}</p>
                    <p className={`font-mono text-xs ${FF_SETTINGS_MUTED_CLASS}`}>
                      {item.created_at}
                      {item.request_id ? ` · ${item.request_id}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}

      {problem ? (
        <div className="mt-4">
          <ProblemBanner problem={problem} />
          {isCsrfProblem(problem) ? (
            <p className={`mt-2 text-sm ${FF_SETTINGS_MUTED_CLASS}`}>
              CSRF fail-closed: the mutation was rejected and not applied.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
