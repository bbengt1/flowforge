import {
  KUBERNETES_ROLLOUT_CANCEL_HELP,
  KUBERNETES_ROLLOUT_NO_MUTATION_MESSAGE,
  KUBERNETES_ROLLOUT_REDACTION_HELP,
  type KubernetesRolloutAuditSnapshot,
  type KubernetesRolloutObservation,
} from "@/lib/kubernetes-rollout-contract";

type RolloutObservationPanelProps = {
  observations: KubernetesRolloutObservation[];
  auditSnapshots: KubernetesRolloutAuditSnapshot[];
};

export function RolloutObservationPanel({
  observations,
  auditSnapshots,
}: RolloutObservationPanelProps) {
  if (observations.length === 0 && auditSnapshots.length === 0) {
    return null;
  }
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold">Rollout observation</h2>
      <p className="mt-1 text-sm text-zinc-600">
        Bounded watch of Deployment, StatefulSet, DaemonSet, or Job
        progress from existing execution steps and audit.{" "}
        {KUBERNETES_ROLLOUT_NO_MUTATION_MESSAGE}
      </p>
      <p className="mt-1 text-xs text-zinc-500">{KUBERNETES_ROLLOUT_REDACTION_HELP}</p>
      {observations.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-600">
          No observation payload yet. The adapter is ready for jonny&apos;s
          status map — poll continues on{" "}
          <code className="font-mono text-xs">GET /executions/{"{id}"}</code>.
        </p>
      ) : (
        <ul className="mt-4 grid gap-3">
          {observations.map((item) => (
            <li
              key={item.stepId || `${item.nodeId}-${item.phase}`}
              className={
                item.phase === "failed" || item.failedClosed
                  ? "rounded-xl border-2 border-amber-700 bg-amber-50 p-4"
                  : "rounded-xl border border-zinc-200 p-4"
              }
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium">
                    <span aria-hidden="true">{phaseIcon(item.phase)} </span>
                    {item.phaseLabel}
                  </p>
                  <p className="mt-1 font-mono text-xs text-zinc-600">
                    {item.nodeType || "node"}
                    {item.kind ? ` · ${item.kind}` : ""}
                    {item.name ? `/${item.name}` : ""}
                    {item.namespace ? ` · ns ${item.namespace}` : ""}
                  </p>
                </div>
                <p className="text-xs font-medium text-zinc-700">
                  {item.phase}
                  {item.source === "contract-fallback" ? " · contract-fallback" : ""}
                </p>
              </div>
              <p className="mt-2 text-sm text-zinc-700">
                Recognition: {item.recognition}.
              </p>
              <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                {item.observation ? (
                  <div>
                    <dt className="text-zinc-500">Observation</dt>
                    <dd className="font-mono">{item.observation}</dd>
                  </div>
                ) : null}
                {item.timeoutSeconds != null ? (
                  <div>
                    <dt className="text-zinc-500">Timeout (seconds)</dt>
                    <dd className="font-mono">{item.timeoutSeconds}</dd>
                  </div>
                ) : null}
                {countRow("Ready replicas", item.readyReplicas)}
                {countRow("Available replicas", item.availableReplicas)}
                {countRow("Updated", item.updatedNumber)}
                {countRow("Desired", item.desiredNumber)}
                {countRow("Observed generation", item.observedGeneration)}
                {countRow("Generation", item.generation)}
                {countRow("Succeeded", item.succeeded)}
                {countRow("Failed", item.failed)}
                {countRow("Completions", item.completions)}
                {item.correlationId ? (
                  <div>
                    <dt className="text-zinc-500">Correlation id</dt>
                    <dd className="font-mono break-all">{item.correlationId}</dd>
                  </div>
                ) : null}
                {item.policyRevision ? (
                  <div>
                    <dt className="text-zinc-500">Policy revision</dt>
                    <dd className="font-mono break-all">{item.policyRevision}</dd>
                  </div>
                ) : null}
              </dl>
              {item.resources.length > 0 ? (
                <p className="mt-2 font-mono text-xs text-zinc-600">
                  {item.resources
                    .map((resource) =>
                      [resource.kind, resource.namespace, resource.name]
                        .filter(Boolean)
                        .join("/"),
                    )
                    .join(" · ")}
                </p>
              ) : null}
              <p className="mt-3 text-sm text-zinc-800">{item.stopCopy}</p>
              {item.failedClosed ? (
                <p className="mt-2 text-sm font-medium text-amber-950">
                  Unexpected secret fields were stripped. Diagnostics stay
                  redacted.
                </p>
              ) : null}
              {item.note ? (
                <p className="mt-2 text-xs text-zinc-500">{item.note}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {auditSnapshots.length > 0 ? (
        <div className="mt-5">
          <h3 className="text-sm font-semibold">Redacted observation audit</h3>
          <p className="mt-1 text-xs text-zinc-500">
            Actor, target, policy revision, resource identities, and
            correlation id only. Same E5.4 / E6.4 audit browse — no secrets.
          </p>
          <ul className="mt-3 grid gap-2">
            {auditSnapshots.map((event) => (
              <li
                key={`${event.action}-${event.occurredAt}-${event.correlationId}`}
                className="rounded-xl border border-zinc-200 px-4 py-3 text-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <p className="font-medium">{event.action || "observation"}</p>
                  <p className="text-xs text-zinc-600">{event.outcome || "—"}</p>
                </div>
                <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-zinc-500">Actor</dt>
                    <dd className="font-mono break-all">{event.actorId || "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-zinc-500">Cluster target</dt>
                    <dd className="font-mono break-all">
                      {event.clusterTargetId || "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-500">Policy revision</dt>
                    <dd className="font-mono break-all">
                      {event.policyRevision || "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-500">Correlation id</dt>
                    <dd className="font-mono break-all">
                      {event.correlationId || "—"}
                    </dd>
                  </div>
                </dl>
                {event.resources.length > 0 ? (
                  <p className="mt-2 font-mono text-xs text-zinc-600">
                    {event.resources
                      .map((resource) =>
                        [resource.kind, resource.namespace, resource.name]
                          .filter(Boolean)
                          .join("/"),
                      )
                      .join(" · ")}
                  </p>
                ) : null}
                <p className="mt-2 text-xs text-zinc-500">{event.occurredAt || "—"}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="mt-4 text-xs text-zinc-500">{KUBERNETES_ROLLOUT_CANCEL_HELP}</p>
    </section>
  );
}

function countRow(label: string, value: number | null) {
  if (value == null) {
    return null;
  }
  return (
    <div key={label}>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </div>
  );
}

function phaseIcon(phase: KubernetesRolloutObservation["phase"]): string {
  switch (phase) {
    case "ready":
      return "✓";
    case "failed":
      return "!";
    case "timeout":
      return "⏱";
    case "canceled":
      return "■";
    case "pending-engine":
      return "…";
    default:
      return "◉";
  }
}
