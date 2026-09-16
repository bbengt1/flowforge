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
  BOOTSTRAP_TLS_REWRITE_PENDING,
  BOOTSTRAP_TLS_REWRITE_TOAST,
  BOOTSTRAP_TLS_SKIP_LABEL,
  BOOTSTRAP_TLS_SKIP_PENDING,
  BOOTSTRAP_TLS_SKIP_SUCCESS,
  BOOTSTRAP_TLS_SKIP_WARNING,
  DEFAULT_BOOTSTRAP_TLS_ACTION,
  bootstrapProblemMessage,
  bootstrapStepIsAhead,
  canOpenBootstrapStep,
  currentBootstrapStep,
  decideTlsPublicUrlRewrite,
  emptyTlsUploadDraft,
  mutationConflictIsComplete,
  normalizePublicBaseUrl,
  wizardDevAdminDefaults,
  wizardDevPublicUrlDefault,
  wizardTlsInput,
  type BootstrapStatus,
  type BootstrapStepId,
  type BootstrapTlsAction,
} from "@/lib/first-run-bootstrap";
import {
  dohertyStatusRole,
  type DohertyPhase,
} from "@/lib/doherty-pending-chrome";
import type { ProblemDetails } from "@/lib/problem";
import {
  FF_WIZARD_CONTROL_CLASS,
  FF_WIZARD_EYEBROW_CLASS,
  FF_WIZARD_HELP_CLASS,
  FF_WIZARD_MUTED_CLASS,
  FF_WIZARD_PANEL_CLASS,
  FF_WIZARD_PRIMARY_CLASS,
  FF_WIZARD_PROGRESS_CLASS,
  FF_WIZARD_PROGRESS_ITEM_CLASS,
  FF_WIZARD_ROOT_CLASS,
  FF_WIZARD_SKIP_CLASS,
  FF_WIZARD_TITLE_CLASS,
  FF_WIZARD_VALUE,
  wizardStatusClassName,
} from "@/lib/settings-wizard-visual";

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
  const [issuer, setIssuer] = useState(() => wizardDevAdminDefaults().issuer);
  const [subject, setSubject] = useState(() => wizardDevAdminDefaults().subject);
  const [displayName, setDisplayName] = useState("");
  const [publicBaseUrl, setPublicBaseUrl] = useState(
    () => wizardDevPublicUrlDefault(),
  );
  const [tlsAction, setTlsAction] = useState<BootstrapTlsAction>(
    DEFAULT_BOOTSTRAP_TLS_ACTION,
  );
  const [tlsDraft, setTlsDraft] = useState(emptyTlsUploadDraft);
  const [urlRewriteToast, setUrlRewriteToast] = useState(false);

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
    messages?: { pending?: string; success?: string },
  ): Promise<boolean> {
    if (!canOpenBootstrapStep(status, step) || busy) {
      return false;
    }
    setProblem(null);
    setFeedback({
      phase: "pending",
      message: messages?.pending ?? STEP_PENDING[step],
    });
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
        return false;
      }
      setFeedback({
        phase: "error",
        message: bootstrapProblemMessage(result.statusCode, result.problem),
      });
      setProblem(result.problem);
      return false;
    }
    setStatus(result.status);
    setFeedback({
      phase: "success",
      message: messages?.success ?? STEP_SUCCESS[step],
    });
    if (result.status.complete || currentBootstrapStep(result.status) === "done") {
      onComplete();
    }
    return true;
  }

  /**
   * Incomplete bootstrap already overwrites public URL. Re-POST after
   * Create/Upload while the gate is still open — do not wait for TLS
   * MarkComplete (that 409s URL writes). Bypass the step rail; public
   * URL is already ready.
   */
  async function rewriteHttpLocalhostPublicUrlIfNeeded(): Promise<boolean> {
    const rewrite = decideTlsPublicUrlRewrite({
      tlsAction,
      publicBaseUrl,
    });
    if (!rewrite) {
      return true;
    }
    if (busy) {
      return false;
    }
    setProblem(null);
    setFeedback({
      phase: "pending",
      message: BOOTSTRAP_TLS_REWRITE_PENDING,
    });
    const result = await setBootstrapPublicUrl({
      embed: false,
      identity,
      publicBaseUrl: rewrite.rewriteTo,
    });
    if (!result.ok) {
      if (mutationConflictIsComplete(result.statusCode, result.problem)) {
        setFeedback({
          phase: "success",
          message: "Setup is already complete. Opening workflows…",
        });
        onComplete();
        return false;
      }
      setFeedback({
        phase: "error",
        message: bootstrapProblemMessage(result.statusCode, result.problem),
      });
      setProblem(result.problem);
      return false;
    }
    setStatus(result.status);
    setPublicBaseUrl(rewrite.rewriteTo);
    setUrlRewriteToast(true);
    setFeedback({
      phase: "success",
      message: BOOTSTRAP_TLS_REWRITE_TOAST,
    });
    return true;
  }

  return (
    <main
      id="main-content"
      tabIndex={-1}
      data-ff-wizard={FF_WIZARD_VALUE}
      className={`${FF_WIZARD_ROOT_CLASS} mx-auto flex min-h-full w-full max-w-3xl flex-col gap-8 px-6 py-12 outline-none`}
    >
      <header className="space-y-3">
        <p className={FF_WIZARD_EYEBROW_CLASS}>B.6 · First-run setup</p>
        <h1 className={`text-3xl tracking-tight ${FF_WIZARD_TITLE_CLASS}`}>
          Set up this FlowForge instance
        </h1>
        <p className={FF_WIZARD_HELP_CLASS}>
          Persistence, first admin, public URL, then TLS — in that order.
          Earlier steps cannot be skipped. On TLS you may Skip for now
          (HTTP until Settings). Drafts still do not run. This wizard
          never appears on embed chrome.
        </p>
      </header>

      <ol className={FF_WIZARD_PROGRESS_CLASS} aria-label="Setup progress">
        {progress.map(({ step, index, ready, active, locked }) => (
          <li
            key={step}
            aria-current={active ? "step" : undefined}
            data-bootstrap-step={step}
            data-bootstrap-step-state={
              ready ? "ready" : active ? "current" : locked ? "locked" : "pending"
            }
            className={FF_WIZARD_PROGRESS_ITEM_CLASS}
          >
            <p className="text-[11px] font-medium tracking-wide uppercase">
              Step {index + 1}
            </p>
            <p className={`text-sm ${FF_WIZARD_TITLE_CLASS}`}>
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
          className={wizardStatusClassName(feedback.phase)}
        >
          {feedback.message}
        </p>
      ) : null}

      {urlRewriteToast ? (
        <p
          role="status"
          data-bootstrap-tls-url-toast=""
          className={`${FF_WIZARD_SKIP_CLASS} px-4 py-3 text-sm leading-6`}
        >
          {BOOTSTRAP_TLS_REWRITE_TOAST}
        </p>
      ) : null}

      {problem ? <ProblemBanner problem={problem} /> : null}

      {current === "persistence" ? (
        <section className={`${FF_WIZARD_PANEL_CLASS} space-y-4`}>
          <h2 className={`text-lg ${FF_WIZARD_TITLE_CLASS}`}>Persistence</h2>
          <p className={`text-sm leading-6 ${FF_WIZARD_MUTED_CLASS}`}>
            {BOOTSTRAP_STEP_HELP.persistence}
          </p>
          <button
            type="button"
            disabled={busy}
            className={FF_WIZARD_PRIMARY_CLASS}
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
        <section className={`${FF_WIZARD_PANEL_CLASS} space-y-4`}>
          <h2 className={`text-lg ${FF_WIZARD_TITLE_CLASS}`}>First admin</h2>
          <p className={`text-sm leading-6 ${FF_WIZARD_MUTED_CLASS}`}>
            {BOOTSTRAP_STEP_HELP.firstAdmin}
          </p>
          <div className="grid gap-3">
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Issuer</span>
              <input
                value={issuer}
                onChange={(event) => setIssuer(event.target.value)}
                autoComplete="off"
                className={FF_WIZARD_CONTROL_CLASS}
                placeholder="https://idp.example"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">External subject</span>
              <input
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                autoComplete="off"
                className={FF_WIZARD_CONTROL_CLASS}
                placeholder="admin-1"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Display name (optional)</span>
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="off"
                className={FF_WIZARD_CONTROL_CLASS}
              />
            </label>
          </div>
          <button
            type="button"
            disabled={busy || !issuer.trim() || !subject.trim()}
            className={FF_WIZARD_PRIMARY_CLASS}
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
        <section className={`${FF_WIZARD_PANEL_CLASS} space-y-4`}>
          <h2 className={`text-lg ${FF_WIZARD_TITLE_CLASS}`}>Public URL</h2>
          <p className={`text-sm leading-6 ${FF_WIZARD_MUTED_CLASS}`}>
            {BOOTSTRAP_STEP_HELP.publicUrl}
          </p>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Public base URL</span>
            <input
              value={publicBaseUrl}
              onChange={(event) => setPublicBaseUrl(event.target.value)}
              autoComplete="off"
              className={FF_WIZARD_CONTROL_CLASS}
              placeholder="https://flows.example.com"
            />
          </label>
          <button
            type="button"
            disabled={busy || !normalizePublicBaseUrl(publicBaseUrl)}
            className={FF_WIZARD_PRIMARY_CLASS}
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
        <section
          className={`${FF_WIZARD_PANEL_CLASS} space-y-4`}
          data-bootstrap-tls-step=""
        >
          <h2 className={`text-lg ${FF_WIZARD_TITLE_CLASS}`}>TLS</h2>
          <p className={`text-sm leading-6 ${FF_WIZARD_MUTED_CLASS}`}>
            {BOOTSTRAP_STEP_HELP.tls}
          </p>
          <p
            role="status"
            data-bootstrap-tls-skip-warning=""
            className={`${FF_WIZARD_SKIP_CLASS} px-4 py-3 text-sm leading-6`}
          >
            {BOOTSTRAP_TLS_SKIP_WARNING}
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
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="tls-action"
                data-bootstrap-tls-action="skip"
                checked={tlsAction === "skip"}
                onChange={() => {
                  setTlsAction("skip");
                  setTlsDraft(emptyTlsUploadDraft());
                }}
              />
              {BOOTSTRAP_TLS_SKIP_LABEL}
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
                  className={`${FF_WIZARD_CONTROL_CLASS} font-mono text-xs`}
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
                  className={`${FF_WIZARD_CONTROL_CLASS} font-mono text-xs`}
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
            className={FF_WIZARD_PRIMARY_CLASS}
            onClick={() => {
              const tls = wizardTlsInput(tlsAction, tlsDraft);
              if (!tls) {
                return;
              }
              void (async () => {
                if (tlsAction !== "skip") {
                  const rewritten = await rewriteHttpLocalhostPublicUrlIfNeeded();
                  if (!rewritten) {
                    return;
                  }
                }
                await runStep(
                  "tls",
                  () =>
                    setBootstrapTls({
                      embed: false,
                      identity,
                      tls,
                    }),
                  tlsAction === "skip"
                    ? {
                        pending: BOOTSTRAP_TLS_SKIP_PENDING,
                        success: BOOTSTRAP_TLS_SKIP_SUCCESS,
                      }
                    : undefined,
                );
              })();
            }}
          >
            {tlsAction === "skip"
              ? "Skip for now and finish"
              : "Enable TLS and finish"}
          </button>
        </section>
      ) : null}
    </main>
  );
}
