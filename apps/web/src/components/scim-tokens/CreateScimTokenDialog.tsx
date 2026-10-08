"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "@/components/a11y/Dialog";
import { Field } from "@/components/a11y/Field";
import { ProblemBanner } from "@/components/ProblemBanner";
import type { DevIdentity } from "@/lib/identity-headers";
import {
  FF_OVERVIEW_DIALOG_CLASS,
  FF_OVERVIEW_MUTED_CLASS,
  FF_OVERVIEW_TITLE_CLASS,
} from "@/lib/overview-visual";
import type { ProblemDetails } from "@/lib/problem";
import {
  SCIM_TOKEN_COPIED,
  SCIM_TOKEN_COPY_FAILED,
  SCIM_TOKEN_NAME_HINT,
  SCIM_TOKEN_NAME_LABEL,
  SCIM_TOKEN_NAME_MAX_CHARS,
  SCIM_TOKEN_REVEAL_LABEL,
  SCIM_TOKEN_REVEAL_WARNING,
  SCIM_TOKEN_UNREADABLE,
  SCIM_TOKENS_API_PATH,
  normalizeScimTokenName,
  scimTokenCreateFailure,
  scimTokenNameClientError,
  type ScimTokenCreateFailure,
} from "@/lib/scim-tokens";
import { createScimToken } from "@/lib/scim-tokens-client";
import {
  FF_SETTINGS_CONTROL_CLASS,
  FF_SETTINGS_DANGER_CLASS,
  FF_SETTINGS_GHOST_CLASS,
  FF_SETTINGS_PRIMARY_CLASS,
} from "@/lib/settings-wizard-visual";

export type CreateScimTokenDialogProps = {
  identity: DevIdentity;
  maxActive: number;
  /** Called after any create attempt that may have changed the list. */
  onChanged: () => void;
  onClose: () => void;
};

type Reveal = { plaintext: string | null; name: string };

/**
 * Create a token, then show its plaintext once. Mount it only while
 * open. The plaintext lives in this component's state and nowhere else:
 * the create call is not a TanStack mutation (its result would sit in
 * the mutation cache), and closing or unmounting drops it.
 */
export function CreateScimTokenDialog({
  identity,
  maxActive,
  onChanged,
  onClose,
}: CreateScimTokenDialogProps) {
  const headingId = useId();
  const [name, setName] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);
  const [submittedName, setSubmittedName] = useState<string | null>(null);
  const [failure, setFailure] = useState<ScimTokenCreateFailure | null>(null);
  const [pending, setPending] = useState(false);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const mounted = useRef(true);
  const revealFirstRef = useRef<HTMLButtonElement | null>(null);
  const revealing = reveal !== null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The submit button unmounts when the reveal step opens, so move focus
  // to its first action instead of leaving it on the page body.
  useEffect(() => {
    if (revealing) {
      revealFirstRef.current?.focus();
    }
  }, [revealing]);

  function close() {
    setReveal(null);
    setCopy("idle");
    onClose();
  }

  // A field error belongs to the name that was sent. Editing clears it.
  const serverFieldError =
    failure?.placement === "field" && submittedName === name ? failure.message : null;
  const fieldError = clientError ?? serverFieldError;
  const notice = failure?.placement === "notice" ? failure : null;
  const banner: ProblemDetails | null =
    failure?.placement === "banner" ? failure.problem : null;
  const blocked =
    notice?.kind === "limit" ||
    notice?.kind === "not-configured" ||
    notice?.kind === "not-available" ||
    notice?.kind === "forbidden";

  async function submit() {
    const error = scimTokenNameClientError(name);
    setClientError(error);
    if (error || pending || blocked) {
      return;
    }
    const sent = normalizeScimTokenName(name);
    setSubmittedName(name);
    setFailure(null);
    setPending(true);
    let result: Awaited<ReturnType<typeof createScimToken>> | null = null;
    try {
      result = await createScimToken(identity, sent);
    } catch {
      result = null;
    } finally {
      // Refresh after every attempt that finishes, whatever the outcome:
      // a create can land on the server even when the answer is lost on
      // the way back (a dropped connection reads as a failure here).
      onChanged();
    }
    if (!mounted.current) {
      // Closed mid-request: the list was refreshed above, but there is
      // nowhere to show the plaintext. Drop it.
      return;
    }
    setPending(false);
    if (!result) {
      setFailure({ placement: "banner", problem: createDidNotFinishProblem() });
      return;
    }
    if (!result.ok) {
      setFailure(scimTokenCreateFailure(result.problem, maxActive));
      return;
    }
    setReveal({ plaintext: result.plaintext, name: result.record?.displayName ?? sent });
  }

  async function copyPlaintext(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      if (mounted.current) {
        setCopy("copied");
      }
    } catch {
      if (mounted.current) {
        setCopy("failed");
      }
    }
  }

  return (
    <Dialog
      open
      onClose={close}
      // The show-once token closes only through Done: Escape is swallowed
      // and no backdrop handler is passed, so a stray key or click can't
      // drop it. The name form keeps the normal Escape close.
      dismissible={!revealing}
      labelledBy={headingId}
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4"
    >
      {reveal ? (
        <div
          data-scim-token-dialog="reveal"
          className={`${FF_OVERVIEW_DIALOG_CLASS} w-full max-w-lg`}
        >
          <h2 id={headingId} className={`text-lg ${FF_OVERVIEW_TITLE_CLASS}`}>
            Token created
          </h2>
          <p className={`mt-1 text-sm ${FF_OVERVIEW_MUTED_CLASS}`}>
            {reveal.name}
          </p>
          {reveal.plaintext ? (
            <>
              <p
                data-scim-token-warning=""
                className={`mt-4 text-sm font-medium ${FF_SETTINGS_DANGER_CLASS}`}
              >
                {SCIM_TOKEN_REVEAL_WARNING}
              </p>
              <div className="mt-4">
                <Field id="scim-token-plaintext" label={SCIM_TOKEN_REVEAL_LABEL}>
                  <input
                    type="text"
                    readOnly
                    value={reveal.plaintext}
                    autoComplete="off"
                    spellCheck={false}
                    onFocus={(event) => event.currentTarget.select()}
                    className={`mt-1 font-mono text-xs ${FF_SETTINGS_CONTROL_CLASS}`}
                  />
                </Field>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  ref={revealFirstRef}
                  type="button"
                  data-scim-token-copy=""
                  onClick={() => {
                    if (reveal.plaintext) {
                      void copyPlaintext(reveal.plaintext);
                    }
                  }}
                  className={FF_SETTINGS_PRIMARY_CLASS}
                >
                  {copy === "copied" ? "Copied" : "Copy token"}
                </button>
                <p role="status" className={`text-sm ${FF_OVERVIEW_MUTED_CLASS}`}>
                  {copy === "copied"
                    ? SCIM_TOKEN_COPIED
                    : copy === "failed"
                      ? SCIM_TOKEN_COPY_FAILED
                      : ""}
                </p>
              </div>
            </>
          ) : (
            <p className={`mt-4 text-sm ${FF_SETTINGS_DANGER_CLASS}`}>{SCIM_TOKEN_UNREADABLE}</p>
          )}
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              ref={reveal.plaintext ? undefined : revealFirstRef}
              type="button"
              data-scim-token-done=""
              onClick={close}
              className={FF_SETTINGS_GHOST_CLASS}
            >
              Done
            </button>
          </div>
        </div>
      ) : (
        <form
          data-scim-token-dialog="create"
          className={`${FF_OVERVIEW_DIALOG_CLASS} w-full max-w-lg`}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h2 id={headingId} className={`text-lg ${FF_OVERVIEW_TITLE_CLASS}`}>
            Create SCIM token
          </h2>
          <p className={`mt-1 text-sm ${FF_OVERVIEW_MUTED_CLASS}`}>
            The token is shown once, right after you create it.
          </p>
          <div className="mt-4">
            <Field
              id="scim-token-name"
              label={SCIM_TOKEN_NAME_LABEL}
              hint={SCIM_TOKEN_NAME_HINT}
              error={fieldError}
              required
            >
              <input
                type="text"
                value={name}
                autoComplete="off"
                maxLength={SCIM_TOKEN_NAME_MAX_CHARS}
                onChange={(event) => {
                  setName(event.target.value);
                  setClientError(null);
                  if (failure?.placement === "notice" && failure.kind === "mfa-required") {
                    setFailure(null);
                  }
                }}
                className={`mt-1 ${FF_SETTINGS_CONTROL_CLASS}`}
              />
            </Field>
          </div>
          {notice ? (
            <p
              role="alert"
              data-scim-token-create-notice={notice.kind}
              className={`mt-4 text-sm ${FF_SETTINGS_DANGER_CLASS}`}
            >
              {notice.message}
            </p>
          ) : null}
          {banner ? (
            <div className="mt-4">
              <ProblemBanner problem={banner} />
            </div>
          ) : null}
          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" onClick={close} className={FF_SETTINGS_GHOST_CLASS}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending || blocked}
              className={FF_SETTINGS_PRIMARY_CLASS}
            >
              {pending ? "Creating…" : "Create token"}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** Banner for a create call that threw before it could answer. */
function createDidNotFinishProblem(): ProblemDetails {
  return {
    type: "urn:flowforge:problem:dependency-unavailable",
    title: "Service Unavailable",
    status: 503,
    detail: "The create request did not finish. Check the token list before trying again.",
    instance: SCIM_TOKENS_API_PATH,
    code: "dependency-unavailable",
    request_id: "",
  };
}
