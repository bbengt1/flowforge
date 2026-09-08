"use client";

import { useState } from "react";
import type { ControlPlaneProbe } from "@/lib/control-plane";
import { probeFromProxyResponse } from "@/lib/control-plane";
import { safeProblemDetail } from "@/lib/problem";
import { generateRequestId, REQUEST_ID_HEADER } from "@/lib/request-id";

type ApiHealthCardProps = {
  initialHealth: ControlPlaneProbe;
  initialReadiness: ControlPlaneProbe;
  publicHealthUrl: string;
  publicReadinessUrl: string;
};

export function ApiHealthCard({
  initialHealth,
  initialReadiness,
  publicHealthUrl,
  publicReadinessUrl,
}: ApiHealthCardProps) {
  const [health, setHealth] = useState(initialHealth);
  const [readiness, setReadiness] = useState(initialReadiness);
  const [pending, setPending] = useState(false);

  async function refresh() {
    setPending(true);
    try {
      const requestId = generateRequestId();
      const [nextHealth, nextReadiness] = await Promise.all([
        refreshProxy("/api/control-plane/health", requestId),
        refreshProxy("/api/control-plane/readiness", requestId),
      ]);
      setHealth(nextHealth);
      setReadiness(nextReadiness);
    } catch {
      const requestId = generateRequestId();
      const fallback: ControlPlaneProbe = {
        ok: false,
        statusCode: null,
        status: null,
        requestId,
        problem: {
          type: "urn:flowforge:problem:control-plane-unreachable",
          title: "Control Plane Unreachable",
          status: 503,
          detail: "Could not reach the UI health proxy.",
          instance: "/api/control-plane/health",
          code: "control-plane-unreachable",
          request_id: requestId,
        },
      };
      setHealth(fallback);
      setReadiness({
        ...fallback,
        problem: fallback.problem
          ? { ...fallback.problem, instance: "/api/control-plane/readiness" }
          : null,
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      aria-labelledby="api-status-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="api-status-heading" className="text-lg font-semibold">
            Control plane
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            Liveness is{" "}
            <a
              className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
              href={publicHealthUrl}
            >
              {publicHealthUrl}
            </a>
            . Readiness is{" "}
            <a
              className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
              href={publicReadinessUrl}
            >
              {publicReadinessUrl}
            </a>
            . Failures keep RFC 9457 problem details and{" "}
            <code className="font-mono text-xs">X-Request-ID</code>.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={pending}
          className="shrink-0 rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
        >
          {pending ? "Checking…" : "Check again"}
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <ProbeStatus
          label="Health"
          expected="ok"
          probe={health}
        />
        <ProbeStatus
          label="Readiness"
          expected="ready"
          probe={readiness}
        />
      </div>
    </section>
  );
}

async function refreshProxy(
  path: string,
  requestId: string,
): Promise<ControlPlaneProbe> {
  const response = await fetch(path, {
    cache: "no-store",
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
  return probeFromProxyResponse(response, requestId);
}

function ProbeStatus({
  label,
  expected,
  probe,
}: {
  label: string;
  expected: string;
  probe: ControlPlaneProbe;
}) {
  const problem = probe.problem;
  const headingId = `${label.toLowerCase()}-status-heading`;

  return (
    <article
      aria-labelledby={headingId}
      className="rounded-xl bg-zinc-50 px-4 py-3 text-sm leading-6"
    >
      <h3 id={headingId} className="font-medium text-zinc-900">
        {label}
      </h3>
      <p role="status" className="mt-1">
        {probe.ok ? (
          <>
            <span className="font-medium text-emerald-800">
              {expected === "ready" ? "Ready." : "Healthy."}
            </span>{" "}
            API returned <code className="font-mono">{probe.status}</code>
            {probe.statusCode ? ` (${probe.statusCode})` : null}.
          </>
        ) : (
          <>
            <span className="font-medium text-amber-800">
              {problem ? `${problem.title}.` : "Not available yet."}
            </span>{" "}
            {problem ? (
              <>
                {safeProblemDetail(problem.detail)}
                {probe.statusCode ? ` (${probe.statusCode})` : null}.
              </>
            ) : (
              "The Go control plane is not reachable yet."
            )}
          </>
        )}
      </p>
      {problem ? (
        <dl className="mt-3 space-y-1 font-mono text-xs text-zinc-600">
          <div>
            <dt className="inline text-zinc-500">code </dt>
            <dd className="inline">{problem.code}</dd>
          </div>
          {problem.request_id ? (
            <div>
              <dt className="inline text-zinc-500">request_id </dt>
              <dd className="inline break-all">{problem.request_id}</dd>
            </div>
          ) : null}
        </dl>
      ) : probe.requestId ? (
        <p className="mt-3 font-mono text-xs text-zinc-500">
          request_id {probe.requestId}
        </p>
      ) : null}
    </article>
  );
}
