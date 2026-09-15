"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { FirstRunWizard } from "@/components/bootstrap/FirstRunWizard";
import { ProblemBanner } from "@/components/ProblemBanner";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import { useWorkspace } from "@/components/shell/WorkspaceProvider";
import { loadBootstrapGate } from "@/lib/first-run-bootstrap-client";
import {
  FIRST_RUN_WIZARD_COMPLETE_HREF,
  shouldFetchBootstrapGate,
  type BootstrapChrome,
  type BootstrapStatus,
} from "@/lib/first-run-bootstrap";
import type { ProblemDetails } from "@/lib/problem";
import {
  FF_WIZARD_EYEBROW_CLASS,
  FF_WIZARD_HELP_CLASS,
  FF_WIZARD_MUTED_CLASS,
  FF_WIZARD_ROOT_CLASS,
  FF_WIZARD_TITLE_CLASS,
  FF_WIZARD_VALUE,
} from "@/lib/settings-wizard-visual";

type BootstrapGateProps = {
  children: ReactNode;
};

export function BootstrapGate({ children }: BootstrapGateProps) {
  const embed = useEmbedMode();
  const { identity } = useWorkspace();
  const router = useRouter();
  const [chrome, setChrome] = useState<BootstrapChrome>("blocked");
  const [status, setStatus] = useState<BootstrapStatus | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [checked, setChecked] = useState(false);

  const applyHome = useCallback(() => {
    setChrome("home");
    setProblem(null);
  }, []);

  useEffect(() => {
    if (!shouldFetchBootstrapGate(embed)) {
      return;
    }
    let cancelled = false;
    void loadBootstrapGate({ embed: false, identity }).then((result) => {
      if (cancelled) {
        return;
      }
      setChrome(result.decision.chrome);
      setStatus(result.decision.status);
      setProblem(result.ok ? null : result.problem);
      setChecked(true);
    });
    return () => {
      cancelled = true;
    };
  }, [embed, identity]);

  if (embed) {
    return children;
  }

  if (!checked) {
    return (
      <main
        id="main-content"
        tabIndex={-1}
        data-ff-wizard={FF_WIZARD_VALUE}
        className={`${FF_WIZARD_ROOT_CLASS} mx-auto flex min-h-full w-full max-w-2xl flex-col gap-4 px-6 py-16 outline-none`}
      >
        <p role="status" className={`text-sm ${FF_WIZARD_MUTED_CLASS}`}>
          Checking first-run setup…
        </p>
      </main>
    );
  }

  if (chrome === "wizard" && status) {
    return (
      <FirstRunWizard
        initialStatus={status}
        onComplete={() => {
          applyHome();
          router.replace(FIRST_RUN_WIZARD_COMPLETE_HREF);
        }}
      />
    );
  }

  if (chrome === "blocked" && problem) {
    return (
      <main
        id="main-content"
        tabIndex={-1}
        data-ff-wizard={FF_WIZARD_VALUE}
        className={`${FF_WIZARD_ROOT_CLASS} mx-auto flex min-h-full w-full max-w-2xl flex-col gap-6 px-6 py-16 outline-none`}
      >
        <header className="space-y-3">
          <p className={FF_WIZARD_EYEBROW_CLASS}>B.6 · First-run setup</p>
          <h1 className={`text-3xl tracking-tight ${FF_WIZARD_TITLE_CLASS}`}>
            Setup is unavailable
          </h1>
          <p className={FF_WIZARD_HELP_CLASS}>
            The bootstrap gate could not be read. This is not a skip to
            product home and not a second login gate.
          </p>
        </header>
        <ProblemBanner problem={problem} />
      </main>
    );
  }

  return children;
}
