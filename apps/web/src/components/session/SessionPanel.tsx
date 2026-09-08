"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { ProblemBanner } from "@/components/ProblemBanner";
import { callIdentityProxy } from "@/lib/identity-client";
import { emptyDevIdentity } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";
import {
  formatSessionCountdown,
  isCsrfProblem,
  sessionExpiryState,
} from "@/lib/session";
import {
  endSession,
  establishSession,
  refreshSession,
} from "@/lib/session-client";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

const EXAMPLE_LOGIN = {
  issuer: "https://flowforge.local",
  subject: "operator-chloe",
  displayName: "Chloe (dev)",
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
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void refreshSession();
  }, []);

  useEffect(() => {
    if (!snapshot.active || !snapshot.session.expiresAt) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [snapshot.active, snapshot.session.expiresAt]);

  useEffect(() => {
    if (!snapshot.active) {
      return;
    }
    if (snapshot.session.issuer) {
      setIssuer(snapshot.session.issuer);
    }
    if (snapshot.session.subject) {
      setSubject(snapshot.session.subject);
    }
    if (snapshot.session.displayName) {
      setDisplayName(snapshot.session.displayName);
    }
  }, [
    snapshot.active,
    snapshot.session.displayName,
    snapshot.session.issuer,
    snapshot.session.subject,
  ]);

  const expiry = sessionExpiryState(snapshot.session.expiresAt, now);
  const countdown = formatSessionCountdown(snapshot.session.expiresAt, now);

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
    if (!result.ok && result.statusCode !== 401) {
      setProblem(result.problem);
    }
  }

  async function exerciseMissingCsrf() {
    setPending("csrf");
    setProblem(null);
    const result = await callIdentityProxy(
      "/tenants",
      emptyDevIdentity(),
      {
        method: "POST",
        body: { slug: "csrf-fail-closed", name: "CSRF fail-closed" },
        omitCsrf: true,
      },
    );
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
    }
  }

  return (
    <section
      id="session"
      aria-labelledby="session-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
            Browser session · E2.3
          </p>
          <h2 id="session-heading" className="mt-1 text-lg font-semibold">
            Cookie session
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-zinc-600">
            Calls jonny&apos;s session endpoints through the same-origin{" "}
            <code className="font-mono text-xs">/api/control-plane/session</code>{" "}
            proxy with <code className="font-mono text-xs">credentials: include</code>.
            The API issues HttpOnly session cookies. Mutations send{" "}
            <code className="font-mono text-xs">X-CSRF-Token</code>. Bearer
            tokens are never placed in localStorage or the URL.
          </p>
        </div>
        {snapshot.active ? (
          <button
            type="button"
            onClick={() => void logout()}
            disabled={pending !== null}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-60"
          >
            {pending === "logout" ? "Signing out…" : "Log out"}
          </button>
        ) : null}
      </div>

      {snapshot.stale ? (
        <div
          role="status"
          className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
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
            <dt className="text-zinc-500">Subject</dt>
            <dd className="font-mono text-sm">{snapshot.session.subject}</dd>
          </div>
          <div>
            <dt className="text-zinc-500">Issuer</dt>
            <dd className="font-mono text-xs break-all text-zinc-700">
              {snapshot.session.issuer || "—"}
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">Display name</dt>
            <dd>{snapshot.session.displayName || "—"}</dd>
          </div>
          <div>
            <dt className="text-zinc-500">Expiry</dt>
            <dd
              className={
                expiry === "expired" || expiry === "warning"
                  ? "font-medium text-amber-800"
                  : "font-medium"
              }
            >
              {countdown}
            </dd>
            {snapshot.session.expiresAt ? (
              <dd className="font-mono text-xs text-zinc-500">
                {snapshot.session.expiresAt}
              </dd>
            ) : null}
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
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
          </label>
          <label className="text-sm">
            <span className="font-medium">Subject</span>
            <input
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="font-medium">Display name (optional)</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              autoComplete="off"
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
          </label>
          <div>
            <button
              type="submit"
              disabled={pending !== null || !issuer.trim() || !subject.trim()}
              className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-2 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
            >
              {pending === "login" ? "Establishing…" : "Establish session"}
            </button>
          </div>
        </form>
      )}

      {snapshot.active ? (
        <div className="mt-5 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 px-4 py-3">
          <p className="text-sm font-medium">Fail-closed CSRF exercise</p>
          <p className="mt-1 text-sm text-zinc-600">
            Sends a state-changing request without{" "}
            <code className="font-mono text-xs">X-CSRF-Token</code>. Expected
            result is problem+json <code className="font-mono text-xs">csrf-required</code>.
          </p>
          <button
            type="button"
            onClick={() => void exerciseMissingCsrf()}
            disabled={pending !== null}
            className="mt-3 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-60"
          >
            {pending === "csrf" ? "Sending…" : "Send mutation without CSRF"}
          </button>
        </div>
      ) : null}

      {problem ? (
        <div className="mt-4">
          <ProblemBanner problem={problem} />
          {isCsrfProblem(problem) ? (
            <p className="mt-2 text-sm text-zinc-600">
              CSRF fail-closed: the mutation was rejected and not applied.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
