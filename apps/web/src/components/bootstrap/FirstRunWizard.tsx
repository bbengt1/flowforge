"use client";

import { useMemo, useState } from "react";
import { ProblemBanner } from "@/components/ProblemBanner";
import { useWorkspace } from "@/components/shell/WorkspaceProvider";
import {
  confirmBootstrapPersistence,
  createBootstrapAdmin,
  forgetTlsUploadDraft,
  setBootstrapPublicUrl,
  setBootstrapTls,
} from "@/lib/first-run-bootstrap-client";
import {
  BOOTSTRAP_STEP_HELP,
  BOOTSTRAP_STEP_LABELS,
  BOOTSTRAP_STEPS,
  bootstrapProblemMessage,
  bootstrapStepIsAhead,
  canOpenBootstrapStep,
  currentBootstrapStep,
  emptyTlsUploadDraft,
  mutationConflictIsComplete,
  normalizePublicBaseUrl,
  type BootstrapStatus,
  type BootstrapStepId,
  type BootstrapTlsAction,
} from "@/lib/first-run-bootstrap";
import {
  dohertyStatusClassName,
  dohertyStatusRole,
  type DohertyPhase,
} from "@/lib/doherty-pending-chrome";
import type { ProblemDetails } from "@/lib/problem";

type FirstRunWizardProps = {
  initialStatus: BootstrapStatus;
  onComplete: () => void;
};

type StepFeedback = {
  phase: DohertyPhase;
  message: string;
};

const STEP_PENDING: Record<BootstrapStepId, string> = {
  persistence: "Confirming persistence…",
  firstAdmin: "Creating first admin…",
  publicUrl: "Saving public URL…",
  tls: "Enabling TLS…",
};

const STEP_SUCCESS: Record<BootstrapStepId, string> = {
  persistence: "Persistence is ready.",
  firstAdmin: "First admin is ready.",
  publicUrl: "Public URL is configured.",
  tls: "TLS is enabled. Opening workflows…",
};

export function FirstRunWizard({
  initialStatus,
  onComplete,
}: FirstRunWizardProps) {
  const { identity } = useWorkspace();
  const [status, setStatus] = useState(initialStatus);
  const [feedback, setFeedback] = useState<StepFeedback>({
    phase: "idle",
    message: "",
  });
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [issuer, setIssuer] = useState("");
  const [subject, setSubject] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  const [tlsAction, setTlsAction] = useState<BootstrapTlsAction>(
    "create-self-signed",
  );
  const [tlsDraft, setTlsDraft] = useState(emptyTlsUploadDraft);

  const current = currentBootstrapStep(status);
  const busy = feedback.phase === "pending";

  const progress = useMemo(
    () =>
      BOOTSTRAP_STEPS.map((step, index) => {
        const ready = status.steps[step].ready;
        const locked = bootstrapStepIsAhead(status, step);
        const active = canOpenBootstrapStep(status, step);
        return { step, index, ready, locked, active };
      }),
    [status],
  );

  async function runStep(
    step: BootstrapStepId,
    mutate: () => ReturnType<typeof confirmBootstrapPersistence>,
  ) {
    if (!canOpenBootstrapStep(status, step) || busy) {
      return;
    }
    setProblem(null);
    setFeedback({ phase: "pending", message: STEP_PENDING[step] });
    const result = await mutate();
    if (step === "tls") {
      setTlsDraft(forgetTlsUploadDraft());
    }
    if (!result.ok) {
      if (mutationConflictIsComplete(result.statusCode, result.problem)) {
        setFeedback({
          phase: "success",
          message: "Setup is already complete. Opening workflows…",
        });
        onComplete();
        return;
      }
      setFeedback({
        phase: "error",
        message: bootstrapProblemMessage(result.statusCode, result.problem),
      });
      setProblem(result.problem);
      return;
    }
    setStatus(result.status);
    setFeedback({ phase: "success", message: STEP_SUCCESS[step] });
    if (result.status.complete || currentBootstrapStep(result.status) === "done") {
      onComplete();
    }
  }

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-8 px-6 py-12 outline-none"
    >
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          B.6 · First-run setup
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Set up this FlowForge instance
        </h1>
        <p className="max-w-2xl text-base leading-7 text-zinc-600">
          Persistence, first admin, public URL, then TLS — in that order.
          Steps cannot be skipped. Drafts still do not run. This wizard
          never appears on embed chrome.
        </p>
      </header>

      <ol className="grid gap-2 sm:grid-cols-4" aria-label="Setup progress">
        {progress.map(({ step, index, ready, active, locked }) => (
          <li
            key={step}
            aria-current={active ? "step" : undefined}
            data-bootstrap-step={step}
            data-bootstrap-step-state={
              ready ? "ready" : active ? "current" : locked ? "locked" : "pending"
            }
            className={
              active
                ? "rounded-xl border border-teal-800 bg-white px-3 py-2"
                : ready
                  ? "rounded-xl border border-teal-200 bg-teal-50 px-3 py-2"
                  : "rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-500"
            }
          >
            <p className="text-[11px] font-medium tracking-wide uppercase">
              Step {index + 1}
            </p>
            <p className="text-sm font-semibold text-zinc-900">
              {BOOTSTRAP_STEP_LABELS[step]}
            </p>
            <p className="text-xs">
              {ready ? "Ready" : active ? "Current" : "Locked"}
            </p>
          </li>
        ))}
      </ol>

      {feedback.message ? (
        <p
          role={dohertyStatusRole(feedback.phase)}
          data-doherty-chrome="bootstrap"
          data-doherty-phase={feedback.phase}
          aria-busy={feedback.phase === "pending" ? true : undefined}
          className={dohertyStatusClassName(feedback.phase)}
        >
          {feedback.message}
        </p>
      ) : null}

      {problem ? <ProblemBanner problem={problem} /> : null}

      {current === "persistence" ? (
        <section className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Persistence</h2>
          <p className="text-sm leading-6 text-zinc-600">
            {BOOTSTRAP_STEP_HELP.persistence}
          </p>
          <button
            type="button"
            disabled={busy}
            className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
            onClick={() =>
              void runStep("persistence", () =>
                confirmBootstrapPersistence({ embed: false, identity }),
              )
            }
          >
            Confirm persistence
          </button>
        </section>
      ) : null}

      {current === "firstAdmin" ? (
        <section className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">First admin</h2>
          <p className="text-sm leading-6 text-zinc-600">
            {BOOTSTRAP_STEP_HELP.firstAdmin}
          </p>
          <div className="grid gap-3">
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Issuer</span>
              <input
                value={issuer}
                onChange={(event) => setIssuer(event.target.value)}
                autoComplete="off"
                className="rounded-lg border border-zinc-300 px-3 py-2"
                placeholder="https://idp.example"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">External subject</span>
              <input
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                autoComplete="off"
                className="rounded-lg border border-zinc-300 px-3 py-2"
                placeholder="admin-1"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Display name (optional)</span>
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="off"
                className="rounded-lg border border-zinc-300 px-3 py-2"
              />
            </label>
          </div>
          <button
            type="button"
            disabled={busy || !issuer.trim() || !subject.trim()}
            className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
            onClick={() =>
              void runStep("firstAdmin", () =>
                createBootstrapAdmin({
                  embed: false,
                  identity,
                  admin: {
                    issuer,
                    external_subject: subject,
                    display_name: displayName || undefined,
                  },
                }),
              )
            }
          >
            Create first admin
          </button>
        </section>
      ) : null}

      {current === "publicUrl" ? (
        <section className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Public URL</h2>
          <p className="text-sm leading-6 text-zinc-600">
            {BOOTSTRAP_STEP_HELP.publicUrl}
          </p>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Public base URL</span>
            <input
              value={publicBaseUrl}
              onChange={(event) => setPublicBaseUrl(event.target.value)}
              autoComplete="off"
              className="rounded-lg border border-zinc-300 px-3 py-2"
              placeholder="https://flows.example.com"
            />
          </label>
          <button
            type="button"
            disabled={busy || !normalizePublicBaseUrl(publicBaseUrl)}
            className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
            onClick={() => {
              const origin = normalizePublicBaseUrl(publicBaseUrl);
              if (!origin) {
                return;
              }
              void runStep("publicUrl", () =>
                setBootstrapPublicUrl({
                  embed: false,
                  identity,
                  publicBaseUrl: origin,
                }),
              );
            }}
          >
            Save public URL
          </button>
        </section>
      ) : null}

      {current === "tls" ? (
        <section className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">TLS</h2>
          <p className="text-sm leading-6 text-zinc-600">
            {BOOTSTRAP_STEP_HELP.tls}
          </p>
          <fieldset className="grid gap-2 text-sm">
            <legend className="font-medium">Certificate</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="tls-action"
                checked={tlsAction === "create-self-signed"}
                onChange={() => {
                  setTlsAction("create-self-signed");
                  setTlsDraft(emptyTlsUploadDraft());
                }}
              />
              Create self-signed
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="tls-action"
                checked={tlsAction === "upload"}
                onChange={() => setTlsAction("upload")}
              />
              Upload PEM
            </label>
          </fieldset>
          {tlsAction === "upload" ? (
            <div className="grid gap-3">
              <label className="grid gap-1 text-sm">
                <span className="font-medium">Certificate PEM</span>
                <textarea
                  value={tlsDraft.certPem}
                  onChange={(event) =>
                    setTlsDraft((draft) => ({
                      ...draft,
                      certPem: event.target.value,
                    }))
                  }
                  autoComplete="off"
                  spellCheck={false}
                  rows={6}
                  className="rounded-lg border border-zinc-300 px-3 py-2 font-mono text-xs"
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="font-medium">Private key PEM</span>
                <textarea
                  value={tlsDraft.keyPem}
                  onChange={(event) =>
                    setTlsDraft((draft) => ({
                      ...draft,
                      keyPem: event.target.value,
                    }))
                  }
                  autoComplete="off"
                  spellCheck={false}
                  rows={6}
                  className="rounded-lg border border-zinc-300 px-3 py-2 font-mono text-xs"
                />
              </label>
            </div>
          ) : null}
          <button
            type="button"
            disabled={
              busy ||
              (tlsAction === "upload" &&
                (!tlsDraft.certPem.trim() || !tlsDraft.keyPem.trim()))
            }
            className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
            onClick={() =>
              void runStep("tls", () =>
                setBootstrapTls({
                  embed: false,
                  identity,
                  tls:
                    tlsAction === "create-self-signed"
                      ? { action: "create-self-signed" }
                      : {
                          action: "upload",
                          certPem: tlsDraft.certPem,
                          keyPem: tlsDraft.keyPem,
                        },
                }),
              )
            }
          >
            Enable TLS and finish
          </button>
        </section>
      ) : null}
    </main>
  );
}
