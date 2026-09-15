"use client";

import { useState } from "react";
import type { ControlPlaneProbe } from "@/lib/control-plane";
import { probeFromProxyResponse } from "@/lib/control-plane";
import { safeProblemDetail } from "@/lib/problem";
import { generateRequestId, REQUEST_ID_HEADER } from "@/lib/request-id";
import {
  FF_SETTINGS_GHOST_CLASS,
  FF_SETTINGS_LINK_CLASS,
  FF_SETTINGS_MUTED_CLASS,
  FF_SETTINGS_NESTED_CLASS,
  FF_SETTINGS_PANEL_CLASS,
  FF_SETTINGS_SKIP_CLASS,
  FF_SETTINGS_TITLE_CLASS,
} from "@/lib/settings-wizard-visual";

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
      className={FF_SETTINGS_PANEL_CLASS}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="api-status-heading" className={`text-lg ${FF_SETTINGS_TITLE_CLASS}`}>
            Control plane
          </h2>
          <p className={`mt-1 text-sm ${FF_SETTINGS_MUTED_CLASS}`}>
            Liveness is{" "}
            <a className={FF_SETTINGS_LINK_CLASS} href={publicHealthUrl}>
              {publicHealthUrl}
            </a>
            . Readiness is{" "}
            <a className={FF_SETTINGS_LINK_CLASS} href={publicReadinessUrl}>
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
          className={`shrink-0 ${FF_SETTINGS_GHOST_CLASS}`}
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
      className={`${FF_SETTINGS_NESTED_CLASS} px-4 py-3 text-sm leading-6`}
    >
      <h3 id={headingId} className={`font-medium ${FF_SETTINGS_TITLE_CLASS}`}>
        {label}
      </h3>
      <p role="status" className="mt-1">
        {probe.ok ? (
          <>
            <span className={`font-medium ${FF_SETTINGS_TITLE_CLASS}`}>
              {expected === "ready" ? "Ready." : "Healthy."}
            </span>{" "}
            API returned <code className="font-mono">{probe.status}</code>
            {probe.statusCode ? ` (${probe.statusCode})` : null}.
          </>
        ) : (
          <>
            <span className={`font-medium ${FF_SETTINGS_SKIP_CLASS} inline px-1.5 py-0.5 text-xs`}>
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
        <dl className={`mt-3 space-y-1 font-mono text-xs ${FF_SETTINGS_MUTED_CLASS}`}>
          <div>
            <dt className="inline">code </dt>
            <dd className="inline">{problem.code}</dd>
          </div>
          {problem.request_id ? (
            <div>
              <dt className="inline">request_id </dt>
              <dd className="inline break-all">{problem.request_id}</dd>
            </div>
          ) : null}
        </dl>
      ) : probe.requestId ? (
        <p className={`mt-3 font-mono text-xs ${FF_SETTINGS_MUTED_CLASS}`}>
          request_id {probe.requestId}
        </p>
      ) : null}
    </article>
  );
}
