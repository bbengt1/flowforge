"use client";

import { useEffect, useState } from "react";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import { MfaChrome } from "@/components/session/MfaChrome";
import {
  MFA_PRIVILEGED_LOUD,
  MFA_VERIFIED_RETRY,
  subscribeMfaRequired,
  type MfaRequiredNotice,
} from "@/lib/oidc-mfa";

export function MfaStepUpHost() {
  const embed = useEmbedMode();
  const [notice, setNotice] = useState<MfaRequiredNotice | null>(null);
  const [verified, setVerified] = useState(false);

  useEffect(() => {
    if (embed) {
      return;
    }
    return subscribeMfaRequired((next) => {
      setVerified(false);
      setNotice(next);
    });
  }, [embed]);

  if (embed) {
    return null;
  }

  return (
    <>
      {verified && !notice ? (
        <p
          role="status"
          className="mx-4 mt-3 rounded-[var(--ff-radius)] px-3 py-2 text-sm"
          style={{
            background: "var(--ff-surface)",
            color: "var(--ff-text)",
            border: "1px solid var(--ff-border)",
          }}
        >
          {MFA_VERIFIED_RETRY}
        </p>
      ) : null}
      {notice ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="mfa-step-up-heading"
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
        >
          <div
            className="max-h-[90vh] w-full max-w-md overflow-auto rounded-[var(--ff-radius-lg)] border px-6 py-8"
            style={{
              background: "var(--ff-surface)",
              borderColor: "var(--ff-border)",
              color: "var(--ff-text)",
            }}
          >
            <p
              className="text-xs font-medium tracking-wide uppercase"
              style={{ color: "var(--ff-accent)" }}
            >
              FlowForge
            </p>
            <h2
              id="mfa-step-up-heading"
              className="mt-2 font-semibold tracking-tight"
              style={{ fontSize: "var(--ff-type-heading)" }}
            >
              Multi-factor authentication
            </h2>
            <p className="mt-2 text-sm" style={{ color: "var(--ff-muted)" }}>
              {MFA_PRIVILEGED_LOUD}
            </p>
            <div className="mt-4">
              <MfaChrome
                variant="step-up"
                notice={notice}
                onSatisfied={() => {
                  setNotice(null);
                  setVerified(true);
                }}
              />
            </div>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="mt-4 w-full px-3 py-2 text-sm font-semibold"
              style={{
                background: "var(--ff-canvas)",
                color: "var(--ff-text)",
                border: "1px solid var(--ff-border)",
                borderRadius: "var(--ff-radius)",
              }}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
