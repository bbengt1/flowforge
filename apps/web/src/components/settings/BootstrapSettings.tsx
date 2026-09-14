"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ProblemBanner } from "@/components/ProblemBanner";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import { useWorkspace } from "@/components/shell/WorkspaceProvider";
import { loadBootstrapGate } from "@/lib/first-run-bootstrap-client";
import {
  BOOTSTRAP_TLS_SKIP_BOOTSTRAP_BANNER,
  SETTINGS_BOOTSTRAP_HREF,
  SETTINGS_PERSISTENCE_HREF,
  SETTINGS_PUBLIC_URL_HREF,
  SETTINGS_TLS_HREF,
  SETTINGS_USERS_HANDOFF_HREF,
  settingsHandoffAfterComplete,
  shouldFetchBootstrapGate,
  tlsSettingsDescription,
  tlsStepIsSkipped,
  type BootstrapStatus,
} from "@/lib/first-run-bootstrap";
import type { ProblemDetails } from "@/lib/problem";

export function BootstrapSettings() {
  const embed = useEmbedMode();
  const { identity } = useWorkspace();
  const [status, setStatus] = useState<BootstrapStatus | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [pending, setPending] = useState(!embed);

  useEffect(() => {
    if (!shouldFetchBootstrapGate(embed)) {
      return;
    }
    let cancelled = false;
    void loadBootstrapGate({ embed: false, identity }).then((result) => {
      if (cancelled) {
        return;
      }
      setStatus(result.decision.status);
      setProblem(result.ok ? null : result.problem);
      setPending(false);
    });
    return () => {
      cancelled = true;
    };
  }, [embed, identity]);

  if (embed) {
    return null;
  }

  return (
    <section
      id="bootstrap"
      aria-labelledby="settings-bootstrap-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <h2 id="settings-bootstrap-heading" className="text-base font-semibold">
        Instance setup
      </h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-600">
        After first-run setup completes, URL, TLS, users, and persistence
        edits stay here. The wizard does not remount.
      </p>
      {pending ? (
        <p role="status" className="mt-3 text-sm text-zinc-600">
          Loading instance setup…
        </p>
      ) : null}
      {problem && problem.status !== 401 ? (
        <div className="mt-3">
          <ProblemBanner problem={problem} />
        </div>
      ) : null}
      {problem?.status === 401 ? (
        <p className="mt-3 text-sm text-zinc-600">
          Sign in to see instance setup status. The first-run wizard does
          not come back after complete.
        </p>
      ) : null}
      {status &&
      settingsHandoffAfterComplete(status) &&
      tlsStepIsSkipped(status.steps.tls) ? (
        <p
          role="status"
          data-bootstrap-tls-skipped=""
          className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"
        >
          {BOOTSTRAP_TLS_SKIP_BOOTSTRAP_BANNER}{" "}
          <Link href={SETTINGS_TLS_HREF} className="font-medium text-teal-900 underline">
            Enable TLS later
          </Link>
          .
        </p>
      ) : null}
      {status && settingsHandoffAfterComplete(status) ? (
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
          <div id="persistence">
            <dt className="font-medium text-zinc-900">Persistence</dt>
            <dd className="mt-1 text-zinc-600">
              {status.steps.persistence.ready
                ? "PostgreSQL is ready. Process DATABASE_URL is not shown and is not edited as a DSN here."
                : "Not marked ready."}
            </dd>
          </div>
          <div>
            <dt className="font-medium text-zinc-900">Users</dt>
            <dd className="mt-1 text-zinc-600">
              {status.steps.firstAdmin.ready
                ? "First admin is ready. Edit members from "
                : "First admin is not marked ready. "}
              {status.steps.firstAdmin.ready ? (
                <Link
                  href={SETTINGS_USERS_HANDOFF_HREF}
                  className="text-teal-800 underline"
                >
                  Workspace members
                </Link>
              ) : null}
              {status.steps.firstAdmin.ready ? "." : null}
            </dd>
          </div>
          <div id="public-url">
            <dt className="font-medium text-zinc-900">Public URL</dt>
            <dd className="mt-1 text-zinc-600">
              {status.steps.publicUrl.ready
                ? "A public origin is configured. The URL is not echoed here."
                : "Public URL is not marked ready."}
            </dd>
          </div>
          <div
            id="tls"
            data-bootstrap-tls-mode={status.steps.tls.mode ?? "none"}
          >
            <dt className="font-medium text-zinc-900">TLS</dt>
            <dd
              className={
                tlsStepIsSkipped(status.steps.tls)
                  ? "mt-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-950"
                  : "mt-1 text-zinc-600"
              }
            >
              {tlsSettingsDescription(status.steps.tls)}
            </dd>
          </div>
        </dl>
      ) : null}
      <p className="mt-3 text-xs text-zinc-500">
        Permalinks:{" "}
        <Link href={SETTINGS_BOOTSTRAP_HREF} className="font-mono underline">
          {SETTINGS_BOOTSTRAP_HREF}
        </Link>
        ,{" "}
        <Link href={SETTINGS_PERSISTENCE_HREF} className="font-mono underline">
          {SETTINGS_PERSISTENCE_HREF}
        </Link>
        ,{" "}
        <Link href={SETTINGS_PUBLIC_URL_HREF} className="font-mono underline">
          {SETTINGS_PUBLIC_URL_HREF}
        </Link>
        ,{" "}
        <Link href={SETTINGS_TLS_HREF} className="font-mono underline">
          {SETTINGS_TLS_HREF}
        </Link>
      </p>
    </section>
  );
}
