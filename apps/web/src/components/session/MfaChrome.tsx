"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Field } from "@/components/a11y/Field";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import { useMfaStatusQuery } from "@/components/session/useMfaStatusQuery";
import {
  MFA_NOT_APPLICABLE,
  MFA_PRIVILEGED_LOUD,
  MFA_SESSION_ON,
  MFA_SETUP_ONCE,
  decideMfaChrome,
  mfaStatusQueryKey,
  mfaChromeLoudNotice,
  mfaCodeIsSubmittable,
  mfaFailureMessage,
  type MfaRequiredNotice,
  type MfaStatus,
} from "@/lib/oidc-mfa";
import { enrollMfa, verifyMfa } from "@/lib/oidc-mfa-client";
import { QueryCacheError } from "@/lib/query-cache";
import { getSessionSnapshot } from "@/lib/session-store";
import { FF_LOUD_WARNING_CLASS } from "@/lib/vault-executions-visual";

type MfaChromeProps = {
  variant: "account" | "step-up";
  notice?: MfaRequiredNotice | null;
  onSatisfied?: () => void;
};

export function MfaChrome({ variant, notice, onSatisfied }: MfaChromeProps) {
  const embed = useEmbedMode();
  const queryClient = useQueryClient();
  const query = useMfaStatusQuery(!embed);
  const [uri, setUri] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const status = query.data ?? null;
  const loaded = query.isSuccess || query.isError;
  const loadError =
    query.error instanceof QueryCacheError
      ? mfaFailureMessage(query.error.statusCode, query.error.problem.detail)
      : null;
  const error = actionError ?? loadError;

  if (embed) {
    return null;
  }

  const sessionActive = getSessionSnapshot().active;
  const decision = decideMfaChrome({
    embed: false,
    sessionActive,
    applicable: status?.applicable === true,
  });

  function rememberStatus(next: MfaStatus) {
    queryClient.setQueryData(
      mfaStatusQueryKey(getSessionSnapshot().session),
      next,
    );
    setActionError(null);
  }

  async function refreshStatus() {
    setActionError(null);
    const result = await query.refetch();
    if (result.error instanceof QueryCacheError) {
      setActionError(
        mfaFailureMessage(result.error.statusCode, result.error.problem.detail),
      );
    }
  }

  async function startEnroll() {
    setPending(true);
    setActionError(null);
    setCopied(false);
    const result = await enrollMfa();
    setPending(false);
    if (!result.ok) {
      if (result.statusCode === 409) {
        setUri(null);
        await refreshStatus();
      }
      setActionError(mfaFailureMessage(result.statusCode, result.problem.detail));
      return;
    }
    rememberStatus(result.status);
    setUri(result.otpauthUri);
  }

  async function submitCode() {
    const submitted = code;
    setCode("");
    setPending(true);
    setActionError(null);
    const result = await verifyMfa(submitted);
    setPending(false);
    if (!result.ok) {
      setActionError(mfaFailureMessage(result.statusCode, result.problem.detail));
      return;
    }
    setUri(null);
    rememberStatus(result.data);
    setDone(true);
    onSatisfied?.();
  }

  async function copyUri() {
    if (!uri) {
      return;
    }
    try {
      await navigator.clipboard.writeText(uri);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (!loaded) {
    return (
      <p role="status" className="text-sm" style={{ color: "var(--ff-muted)" }}>
        Checking multi-factor authentication…
      </p>
    );
  }

  if (decision === "ignore") {
    return (
      <p className="text-sm" style={{ color: "var(--ff-muted)" }}>
        {error ?? MFA_NOT_APPLICABLE}
      </p>
    );
  }

  const showEnroll = status?.enrolled !== true && !uri;
  const canVerify = status?.enrolled === true || Boolean(uri);
  const loud = mfaChromeLoudNotice({
    enforcement: status?.enforcement ?? "on",
    variant,
    satisfied: status?.satisfied === true,
    hasSetupUri: Boolean(uri),
    done,
    requiredMessage: notice?.message ?? MFA_PRIVILEGED_LOUD,
  });

  return (
    <div className="grid gap-4">
      {loud ? (
        <p
          role="status"
          className={
            loud.tone === "warning"
              ? `${FF_LOUD_WARNING_CLASS} px-3 py-2 text-sm font-medium`
              : "rounded-[var(--ff-radius)] px-3 py-2 text-sm font-medium"
          }
          style={
            loud.tone === "warning"
              ? undefined
              : {
                  background: "var(--ff-danger-surface)",
                  color: "var(--ff-danger)",
                }
          }
        >
          {loud.message}
        </p>
      ) : null}
      {status && status.satisfied && !uri ? (
        <p className="text-sm" style={{ color: "var(--ff-muted)" }}>
          {MFA_SESSION_ON}
        </p>
      ) : null}
      {showEnroll ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            void startEnroll();
          }}
          className="w-full px-3 py-2 text-sm font-semibold disabled:opacity-60"
          style={{
            background: "var(--ff-accent)",
            color: "var(--ff-accent-foreground)",
            borderRadius: "var(--ff-radius)",
          }}
        >
          {pending ? "Preparing setup…" : "Set up MFA"}
        </button>
      ) : null}
      {uri ? (
        <div className="grid gap-2">
          <p className="text-sm" style={{ color: "var(--ff-text)" }}>
            {MFA_SETUP_ONCE}
          </p>
          <textarea
            readOnly
            rows={3}
            spellCheck={false}
            autoComplete="off"
            aria-label="Authenticator setup link"
            value={uri}
            className="w-full px-3 py-2 font-mono text-xs outline-none"
            style={{
              background: "var(--ff-canvas)",
              border: "1px solid var(--ff-border)",
              borderRadius: "var(--ff-radius)",
              color: "var(--ff-text)",
            }}
          />
          <button
            type="button"
            onClick={() => {
              void copyUri();
            }}
            className="w-full px-3 py-2 text-sm font-semibold"
            style={{
              background: "var(--ff-canvas)",
              color: "var(--ff-text)",
              border: "1px solid var(--ff-border)",
              borderRadius: "var(--ff-radius)",
            }}
          >
            {copied ? "Copied" : "Copy setup link"}
          </button>
        </div>
      ) : null}
      {status?.privileged_permissions.length ? (
        <div>
          <p className="text-xs font-medium" style={{ color: "var(--ff-muted)" }}>
            Privileged permissions
          </p>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {status.privileged_permissions.map((permission) => (
              <li key={permission}>{permission}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {error && !canVerify ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-[var(--ff-radius)] px-3 py-2 text-sm"
          style={{
            background: "var(--ff-danger-surface)",
            color: "var(--ff-danger)",
          }}
        >
          <span aria-hidden="true">!</span>
          <span>{error}</span>
        </p>
      ) : null}
      {canVerify ? (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submitCode();
          }}
        >
          <Field
            id="mfa-code"
            label="Authenticator code"
            className="grid gap-1 text-sm"
            error={
              error ? (
                <>
                  <span aria-hidden="true">!</span>
                  <span>{error}</span>
                </>
              ) : undefined
            }
            errorClassName="flex items-start gap-2 rounded-[var(--ff-radius)] px-3 py-2 text-sm"
            errorStyle={{
              background: "var(--ff-danger-surface)",
              color: "var(--ff-danger)",
            }}
          >
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              spellCheck={false}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              className="w-full px-3 py-2 outline-none"
              style={{
                background: "var(--ff-canvas)",
                border: "1px solid var(--ff-border)",
                borderRadius: "var(--ff-radius)",
                color: "var(--ff-text)",
              }}
            />
          </Field>
          <button
            type="submit"
            disabled={pending || !mfaCodeIsSubmittable(code)}
            className="w-full px-3 py-2 text-sm font-semibold disabled:opacity-60"
            style={{
              background: "var(--ff-accent)",
              color: "var(--ff-accent-foreground)",
              borderRadius: "var(--ff-radius)",
            }}
          >
            {pending ? "Verifying…" : variant === "step-up" ? "Verify and continue" : "Verify MFA"}
          </button>
        </form>
      ) : null}
    </div>
  );
}
