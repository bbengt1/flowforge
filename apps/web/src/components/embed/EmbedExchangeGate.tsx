"use client";

import { useEffect, useMemo, useState } from "react";
import { ProblemBanner } from "@/components/ProblemBanner";
import { emptyAssertionHolder, exchangeEmbedAssertion } from "@/lib/embed-client";
import {
  EMBED_ASSERTION_MESSAGE_TYPE,
  EMBED_AUDIENCE,
  EMBED_EXCHANGE_HELP,
  EMBED_HOST_DISPLAY_HELP,
  EMBED_MOUNT_PREFIX,
  EMBED_SDK,
  embedPostMessageAllowlist,
  isAllowedEmbedMessageOrigin,
  parseEmbedAssertionMessage,
  parseEmbedHostDisplay,
  type EmbedHostDisplay,
  type EmbedVerifiedContext,
} from "@/lib/embed-contract";
import {
  EMBED_TENANCY_ROUTE_MAP_SOURCE,
  EMBED_VERIFIED_HELP,
  embedVerifiedLabel,
  verifiedWorkspaceFromExchange,
} from "@/lib/embed-tenancy-contract";
import type { ProblemDetails } from "@/lib/problem";

type EmbedExchangeGateProps = {
  search: string;
};

export function EmbedExchangeGate({ search }: EmbedExchangeGateProps) {
  const [assertion, setAssertion] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [message, setMessage] = useState("");
  const [context, setContext] = useState<EmbedVerifiedContext | null>(null);
  const [receivedVia, setReceivedVia] = useState<"form" | "postMessage" | null>(
    null,
  );
  const hostDisplay = useMemo(
    () => parseEmbedHostDisplay(new URLSearchParams(search.replace(/^\?/, ""))),
    [search],
  );
  const allowlist = useMemo(
    () =>
      embedPostMessageAllowlist({
        WEB_EMBED_FRAME_ANCESTORS: process.env.WEB_EMBED_FRAME_ANCESTORS,
        NEXT_PUBLIC_EMBED_FRAME_ANCESTORS:
          process.env.NEXT_PUBLIC_EMBED_FRAME_ANCESTORS,
      }),
    [],
  );

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const parsed = parseEmbedAssertionMessage(event.data);
      if (!parsed) {
        return;
      }
      const sameOrigin = event.origin === window.location.origin;
      if (!sameOrigin && !isAllowedEmbedMessageOrigin(event.origin, allowlist)) {
        return;
      }
      setAssertion(parsed.assertion);
      setReceivedVia("postMessage");
      setProblem(null);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [allowlist]);

  async function exchange() {
    setPending(true);
    setProblem(null);
    setMessage("");
    const holder = emptyAssertionHolder();
    holder.assertion = assertion;
    const result = await exchangeEmbedAssertion(holder);
    setAssertion("");
    setPending(false);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setContext(result.context);
    setMessage(result.message);
    setReceivedVia(null);
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="space-y-2">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E11.2 · {EMBED_SDK} · {EMBED_TENANCY_ROUTE_MAP_SOURCE}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          Exchange a host assertion
        </h1>
        <p className="text-sm leading-6 text-zinc-600">
          {EMBED_EXCHANGE_HELP} Mount is {EMBED_MOUNT_PREFIX}. Audience is{" "}
          <code>{EMBED_AUDIENCE}</code>. Relates to #122 / Part of #120 — keep
          #122 open. {EMBED_VERIFIED_HELP}
        </p>
      </header>

      {problem ? <ProblemBanner problem={problem} /> : null}
      {message ? (
        <p
          role="status"
          className="rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-950"
        >
          {message}
        </p>
      ) : null}

      <HostDisplayCard display={hostDisplay} />

      <section className="rounded-2xl border border-zinc-200 bg-white px-5 py-5">
        <h2 className="text-lg font-semibold tracking-tight">
          Assertion exchange
        </h2>
        <label className="mt-4 block text-sm font-medium text-zinc-800">
          Compact JWS assertion
          <textarea
            className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono text-xs"
            rows={4}
            spellCheck={false}
            autoComplete="off"
            value={assertion}
            onChange={(event) => {
              setAssertion(event.target.value);
              setReceivedVia("form");
            }}
            placeholder="header.payload.signature"
          />
        </label>
        {receivedVia === "postMessage" ? (
          <p className="mt-2 text-xs text-zinc-500">
            Received via {EMBED_ASSERTION_MESSAGE_TYPE} postMessage. It will be
            forgotten after exchange.
          </p>
        ) : null}
        <button
          type="button"
          className="mt-4 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          disabled={pending || !assertion.trim()}
          onClick={() => void exchange()}
        >
          {pending ? "Exchanging…" : "Exchange assertion"}
        </button>
      </section>

      {context ? <VerifiedContextCard context={context} /> : null}
    </main>
  );
}

function VerifiedContextCard({
  context,
}: {
  context: EmbedVerifiedContext;
}) {
  const verified = verifiedWorkspaceFromExchange(context);
  if (!verified) {
    return null;
  }
  return (
    <section className="rounded-2xl border border-teal-200 bg-teal-50 px-5 py-4 text-sm">
      <p className="text-xs font-medium tracking-wide text-teal-800 uppercase">
        FlowForge verified · {context.sdk}
      </p>
      <p className="mt-2 text-teal-950">{EMBED_VERIFIED_HELP}</p>
      <dl className="mt-3 grid gap-1">
        <DisplayRow label="Tenant / workbench" value={embedVerifiedLabel(verified)} />
        <DisplayRow label="Workspace" value={verified.workspaceName} />
      </dl>
    </section>
  );
}

function HostDisplayCard({ display }: { display: EmbedHostDisplay }) {
  const empty =
    !display.host &&
    !display.tenant &&
    !display.tenantId &&
    !display.workbench &&
    !display.displayName;
  if (empty) {
    return (
      <p className="text-sm text-zinc-600">{EMBED_HOST_DISPLAY_HELP}</p>
    );
  }
  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm">
      <p className="text-xs font-medium tracking-wide text-amber-800 uppercase">
        Host display · unverified
      </p>
      <p className="mt-2 text-zinc-700">{EMBED_HOST_DISPLAY_HELP}</p>
      <dl className="mt-3 grid gap-1">
        <DisplayRow label="Host" value={display.host} />
        <DisplayRow label="Tenant" value={display.tenant || display.tenantId} />
        <DisplayRow label="Workbench" value={display.workbench} />
        <DisplayRow label="Display name" value={display.displayName} />
      </dl>
    </section>
  );
}

function DisplayRow({ label, value }: { label: string; value: string }) {
  if (!value) {
    return null;
  }
  return (
    <div>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="font-medium text-zinc-900">{value}</dd>
    </div>
  );
}
