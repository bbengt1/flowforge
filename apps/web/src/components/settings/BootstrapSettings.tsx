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
import {
  FF_SETTINGS_LINK_CLASS,
  FF_SETTINGS_MUTED_CLASS,
  FF_SETTINGS_PANEL_CLASS,
  FF_SETTINGS_SKIP_CLASS,
  FF_SETTINGS_TITLE_CLASS,
} from "@/lib/settings-wizard-visual";

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
      className={FF_SETTINGS_PANEL_CLASS}
    >
      <h2 id="settings-bootstrap-heading" className={`text-base ${FF_SETTINGS_TITLE_CLASS}`}>
        Instance setup
      </h2>
      <p className={`mt-2 max-w-3xl text-sm leading-6 ${FF_SETTINGS_MUTED_CLASS}`}>
        After first-run setup completes, URL, TLS, users, and persistence
        edits stay here. The wizard does not remount.
      </p>
      {pending ? (
        <p role="status" className={`mt-3 text-sm ${FF_SETTINGS_MUTED_CLASS}`}>
          Loading instance setup…
        </p>
      ) : null}
      {problem && problem.status !== 401 ? (
        <div className="mt-3">
          <ProblemBanner problem={problem} />
        </div>
      ) : null}
      {problem?.status === 401 ? (
        <p className={`mt-3 text-sm ${FF_SETTINGS_MUTED_CLASS}`}>
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
          className={`${FF_SETTINGS_SKIP_CLASS} mt-4 px-4 py-3 text-sm leading-6`}
        >
          {BOOTSTRAP_TLS_SKIP_BOOTSTRAP_BANNER}{" "}
          <Link href={SETTINGS_TLS_HREF} className={`font-medium underline ${FF_SETTINGS_LINK_CLASS}`}>
            Enable TLS later
          </Link>
          .
        </p>
      ) : null}
      {status && settingsHandoffAfterComplete(status) ? (
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
          <div id="persistence">
            <dt className={`font-medium ${FF_SETTINGS_TITLE_CLASS}`}>Persistence</dt>
            <dd className={`mt-1 ${FF_SETTINGS_MUTED_CLASS}`}>
              {status.steps.persistence.ready
                ? "PostgreSQL is ready. Process DATABASE_URL is not shown and is not edited as a DSN here."
                : "Not marked ready."}
            </dd>
          </div>
          <div>
            <dt className={`font-medium ${FF_SETTINGS_TITLE_CLASS}`}>Users</dt>
            <dd className={`mt-1 ${FF_SETTINGS_MUTED_CLASS}`}>
              {status.steps.firstAdmin.ready
                ? "First admin is ready. Edit members from "
                : "First admin is not marked ready. "}
              {status.steps.firstAdmin.ready ? (
                <Link
                  href={SETTINGS_USERS_HANDOFF_HREF}
                  className={FF_SETTINGS_LINK_CLASS}
                >
                  Workspace members
                </Link>
              ) : null}
              {status.steps.firstAdmin.ready ? "." : null}
            </dd>
          </div>
          <div id="public-url">
            <dt className={`font-medium ${FF_SETTINGS_TITLE_CLASS}`}>Public URL</dt>
            <dd className={`mt-1 ${FF_SETTINGS_MUTED_CLASS}`}>
              {status.steps.publicUrl.ready
                ? "A public origin is configured. The URL is not echoed here."
                : "Public URL is not marked ready."}
            </dd>
          </div>
          <div
            id="tls"
            data-bootstrap-tls-mode={status.steps.tls.mode ?? "none"}
          >
            <dt className={`font-medium ${FF_SETTINGS_TITLE_CLASS}`}>TLS</dt>
            <dd
              className={
                tlsStepIsSkipped(status.steps.tls)
                  ? `${FF_SETTINGS_SKIP_CLASS} mt-1 px-3 py-2`
                  : `mt-1 ${FF_SETTINGS_MUTED_CLASS}`
              }
            >
              {tlsSettingsDescription(status.steps.tls)}
            </dd>
          </div>
        </dl>
      ) : null}
      <p className={`mt-3 text-xs ${FF_SETTINGS_MUTED_CLASS}`}>
        Permalinks:{" "}
        <Link href={SETTINGS_BOOTSTRAP_HREF} className={`font-mono ${FF_SETTINGS_LINK_CLASS}`}>
          {SETTINGS_BOOTSTRAP_HREF}
        </Link>
        ,{" "}
        <Link href={SETTINGS_PERSISTENCE_HREF} className={`font-mono ${FF_SETTINGS_LINK_CLASS}`}>
          {SETTINGS_PERSISTENCE_HREF}
        </Link>
        ,{" "}
        <Link href={SETTINGS_PUBLIC_URL_HREF} className={`font-mono ${FF_SETTINGS_LINK_CLASS}`}>
          {SETTINGS_PUBLIC_URL_HREF}
        </Link>
        ,{" "}
        <Link href={SETTINGS_TLS_HREF} className={`font-mono ${FF_SETTINGS_LINK_CLASS}`}>
          {SETTINGS_TLS_HREF}
        </Link>
      </p>
    </section>
  );
}
