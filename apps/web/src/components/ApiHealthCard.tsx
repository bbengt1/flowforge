"use client";

import { useState } from "react";
import type { HealthCheck } from "@/lib/health";

type ApiHealthCardProps = {
  initial: HealthCheck;
  publicHealthUrl: string;
  publicReadinessUrl: string;
};

export function ApiHealthCard({
  initial,
  publicHealthUrl,
  publicReadinessUrl,
}: ApiHealthCardProps) {
  const [health, setHealth] = useState(initial);
  const [pending, setPending] = useState(false);

  async function refresh() {
    setPending(true);
    try {
      const response = await fetch("/api/control-plane/health", {
        cache: "no-store",
      });
      const body = (await response.json()) as HealthCheck;
      setHealth(body);
    } catch {
      setHealth({
        ok: false,
        statusCode: null,
        status: null,
        error: "Could not reach the UI health proxy",
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
            Checks{" "}
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
            </a>{" "}
            once migrations finish.
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

      <p
        role="status"
        className="mt-4 rounded-xl bg-zinc-50 px-4 py-3 text-sm leading-6"
      >
        {health.ok ? (
          <>
            <span className="font-medium text-emerald-800">Healthy.</span>{" "}
            API returned <code className="font-mono">{health.status}</code>
            {health.statusCode ? ` (${health.statusCode})` : null}.
          </>
        ) : (
          <>
            <span className="font-medium text-amber-800">Not available yet.</span>{" "}
            The Go control plane at{" "}
            <code className="font-mono">http://api:8080</code> is not reachable
            yet. {health.error ? `(${health.error})` : null}
          </>
        )}
      </p>
    </section>
  );
}
