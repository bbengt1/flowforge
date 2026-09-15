import {
  KUBERNETES_ROLLOUT_CANCEL_HELP,
  KUBERNETES_ROLLOUT_NO_MUTATION_MESSAGE,
  KUBERNETES_ROLLOUT_REDACTION_HELP,
  type KubernetesRolloutAuditSnapshot,
  type KubernetesRolloutObservation,
} from "@/lib/kubernetes-rollout-contract";
import {
  FF_INBOX_MUTED_CLASS,
  FF_INBOX_PANEL_CLASS,
  FF_INBOX_TITLE_CLASS,
  FF_LOUD_INDETERMINATE_CLASS,
  FF_LOUD_WARNING_CLASS,
} from "@/lib/vault-executions-visual";

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
    <section className={FF_INBOX_PANEL_CLASS}>
      <h2 className={`text-lg ${FF_INBOX_TITLE_CLASS}`}>Rollout observation</h2>
      <p className={`mt-1 text-sm ${FF_INBOX_MUTED_CLASS}`}>
        Bounded watch of Deployment, StatefulSet, DaemonSet, or Job
        progress from existing execution steps and audit.{" "}
        {KUBERNETES_ROLLOUT_NO_MUTATION_MESSAGE}
      </p>
      <p className={`mt-1 text-xs ${FF_INBOX_MUTED_CLASS}`}>{KUBERNETES_ROLLOUT_REDACTION_HELP}</p>
      {observations.length === 0 ? (
        <p className={`mt-3 text-sm ${FF_INBOX_MUTED_CLASS}`}>
          No observation payload yet. Poll continues on{" "}
          <code className="font-mono text-xs">GET /executions/{"{id}"}</code>{" "}
          for <code className="font-mono text-xs">result.observation</code>,{" "}
          <code className="font-mono text-xs">result.status.progress[]</code>,
          and redacted <code className="font-mono text-xs">result.audit</code>.
        </p>
      ) : (
        <ul className="mt-4 grid gap-3">
          {observations.map((item) => (
            <li
              key={item.stepId || `${item.nodeId}-${item.phase}`}
              className={
                item.phase === "failed" || item.failedClosed
                  ? `rounded-xl p-4 ${FF_LOUD_INDETERMINATE_CLASS}`
                  : FF_INBOX_PANEL_CLASS
              }
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium">
                    <span aria-hidden="true">{phaseIcon(item.phase)} </span>
                    {item.phaseLabel}
                  </p>
                  <p className={`mt-1 font-mono text-xs ${FF_INBOX_MUTED_CLASS}`}>
                    {item.nodeType || "node"}
                    {item.kind ? ` · ${item.kind}` : ""}
                    {item.name ? `/${item.name}` : ""}
                    {item.namespace ? ` · ns ${item.namespace}` : ""}
                  </p>
                </div>
                <p className={`text-xs font-medium ${FF_INBOX_MUTED_CLASS}`}>
                  {item.phase}
                  {item.observation ? ` · ${item.observation}` : ""}
                </p>
              </div>
              <p className="mt-2 text-sm">
                Recognition: {item.recognition}.
              </p>
              <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                {item.observation ? (
                  <div>
                    <dt className={FF_INBOX_MUTED_CLASS}>Observation</dt>
                    <dd className="font-mono">{item.observation}</dd>
                  </div>
                ) : null}
                {item.timeoutSeconds != null ? (
                  <div>
                    <dt className={FF_INBOX_MUTED_CLASS}>Timeout (seconds)</dt>
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
                    <dt className={FF_INBOX_MUTED_CLASS}>Correlation id</dt>
                    <dd className="font-mono break-all">{item.correlationId}</dd>
                  </div>
                ) : null}
                {item.policyRevision ? (
                  <div>
                    <dt className={FF_INBOX_MUTED_CLASS}>Policy revision</dt>
                    <dd className="font-mono break-all">{item.policyRevision}</dd>
                  </div>
                ) : null}
              </dl>
              {item.progress.length > 0 ? (
                <ul className="mt-3 grid gap-2">
                  {item.progress.map((row, index) => (
                    <li
                      key={`${row.kind}/${row.namespace}/${row.name}/${index}`}
                      className={`rounded-lg px-3 py-2 font-mono text-xs ${FF_INBOX_PANEL_CLASS}`}
                    >
                      {[row.kind, row.namespace, row.name].filter(Boolean).join("/")}
                      {row.state ? ` · ${row.state}` : ""}
                      {row.reason ? ` · ${row.reason}` : ""}
                      {row.readyReplicas != null
                        ? ` · ready ${row.readyReplicas}`
                        : ""}
                      {row.observedGeneration != null
                        ? ` · observedGen ${row.observedGeneration}`
                        : ""}
                    </li>
                  ))}
                </ul>
              ) : null}
              {item.resources.length > 0 ? (
                <p className={`mt-2 font-mono text-xs ${FF_INBOX_MUTED_CLASS}`}>
                  {item.resources}
                    .map((resource) =>
                      [resource.kind, resource.namespace, resource.name]
                        .filter(Boolean)
                        .join("/"),
                    )
                    .join(" · ")}
                </p>
              ) : null}
              <p className="mt-3 text-sm">{item.stopCopy}</p>
              {item.failedClosed ? (
                <p className={`mt-2 text-sm ${FF_LOUD_WARNING_CLASS}`}>
                  Unexpected secret fields were stripped. Diagnostics stay
                  redacted.
                </p>
              ) : null}
              {item.note ? (
                <p className={`mt-2 text-xs ${FF_INBOX_MUTED_CLASS}`}>{item.note}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {auditSnapshots.length > 0 ? (
        <div className="mt-5">
          <h3 className="text-sm font-semibold">Redacted observation audit</h3>
          <p className={`mt-1 text-xs ${FF_INBOX_MUTED_CLASS}`}>
            Actor, target, policy revision, resource identities, and
            correlation id only. Same E5.4 / E6.4 audit browse — no secrets.
          </p>
          <ul className="mt-3 grid gap-2">
            {auditSnapshots.map((event) => (
              <li
                key={`${event.action}-${event.occurredAt}-${event.correlationId}`}
                className={`${FF_INBOX_PANEL_CLASS} text-sm`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <p className="font-medium">{event.action || "observation"}</p>
                  <p className={`text-xs ${FF_INBOX_MUTED_CLASS}`}>{event.outcome || "—"}</p>
                </div>
                <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className={FF_INBOX_MUTED_CLASS}>Actor</dt>
                    <dd className="font-mono break-all">{event.actorId || "—"}</dd>
                  </div>
                  <div>
                    <dt className={FF_INBOX_MUTED_CLASS}>Cluster target</dt>
                    <dd className="font-mono break-all">
                      {event.clusterTargetId || "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className={FF_INBOX_MUTED_CLASS}>Policy revision</dt>
                    <dd className="font-mono break-all">
                      {event.policyRevision || "—"}
                    </dd>
                  </div>
                  {event.policyDigest ? (
                    <div>
                      <dt className={FF_INBOX_MUTED_CLASS}>Policy digest</dt>
                      <dd className="font-mono break-all">{event.policyDigest}</dd>
                    </div>
                  ) : null}
                  {event.manifestDigest ? (
                    <div>
                      <dt className={FF_INBOX_MUTED_CLASS}>Manifest digest</dt>
                      <dd className="font-mono break-all">{event.manifestDigest}</dd>
                    </div>
                  ) : null}
                  {event.watch ? (
                    <div>
                      <dt className={FF_INBOX_MUTED_CLASS}>Watch</dt>
                      <dd className="font-mono">{event.watch}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt className={FF_INBOX_MUTED_CLASS}>Correlation id</dt>
                    <dd className="font-mono break-all">
                      {event.correlationId || "—"}
                    </dd>
                  </div>
                </dl>
                {event.resources.length > 0 ? (
                  <p className={`mt-2 font-mono text-xs ${FF_INBOX_MUTED_CLASS}`}>
                    {event.resources
                      .map((resource) =>
                        [resource.kind, resource.namespace, resource.name]
                          .filter(Boolean)
                          .join("/"),
                      )
                      .join(" · ")}
                  </p>
                ) : null}
                <p className={`mt-2 text-xs ${FF_INBOX_MUTED_CLASS}`}>{event.occurredAt || "—"}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className={`mt-4 text-xs ${FF_INBOX_MUTED_CLASS}`}>{KUBERNETES_ROLLOUT_CANCEL_HELP}</p>
    </section>
  );
}

function countRow(label: string, value: number | null) {
  if (value == null) {
    return null;
  }
  return (
    <div key={label}>
      <dt className={FF_INBOX_MUTED_CLASS}>{label}</dt>
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
    case "skipped":
      return "–";
    case "progressing":
      return "…";
    default:
      return "◉";
  }
}
