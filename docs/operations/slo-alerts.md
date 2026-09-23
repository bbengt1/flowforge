# SLOs and alert rules

G.2.4 /. This page is the operator contract for control-plane
service level objectives. It does not add a product dashboard. Scrapers
keep using `GET /api/v1/metrics` with `platform.administer` or a machine
principal granted `ops.metrics.read` ([deployment](../deployment.md#metrics-and-openapi-scrape-adv-020)).

Traces and the business series below come from the OpenTelemetry SDK.
HTTP count and latency series stay the hand-rolled Prometheus text the
scrape already published.

## Signals

| Series | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `flowforge_http_requests_total` | counter | `method`, `route`, `status` | Finished HTTP requests. |
| `flowforge_http_request_duration_seconds` | histogram | `method`, `route` | HTTP latency. |
| `flowforge_jobs_enqueued_total` | counter | none | Jobs placed on the durable queue. |
| `flowforge_queue_depth` | gauge | none | Process-local enqueue minus leave-queue. Not a cluster-wide depth. |
| `flowforge_queue_lag_seconds` | histogram | none | Age of a job at successful claim. |
| `flowforge_lease_claims_total` | counter | `result` = `claimed`, `empty`, `error` | Lease claim attempts. |
| `flowforge_lease_expirations_total` | counter | none | Claimed or running jobs marked `indeterminate` because the lease ended. |
| `flowforge_execution_outcomes_total` | counter | `outcome` = `succeeded`, `failed`, `canceled`, `indeterminate`, `queued`, `waiting` | Control-plane outcome records. User workflow failure is `failed`, not a page by itself. |
| `flowforge_vault_operations_total` | counter | `op` = `create`, `rotate`, `use`, `decrypt`; `result` = `ok`, `error` | Vault operations. No credential id, plaintext, or key material. |

Labels outside those sets are dropped. `traceparent` / `tracestate`
are not metric labels. A secret-like `tracestate` is not stored or
forwarded.

`flowforge_queue_depth` is the in-process gauge (enqueues minus claims
and cancels of still-queued jobs). Multi-replica depth is the sum of
the gauge only when every replica reports; prefer
`flowforge_queue_lag_seconds` for paging. The E12.2 evidence script
still owns the CI queue-lag check ([capacity](../reference/e12-resilience-capacity.md)).

## Objectives

| Objective | Target | Window | Burn signal |
| --- | --- | --- | --- |
| Control-plane availability | 99.9% of HTTP responses are not `5xx` | 30 days | 5xx ratio over 5 minutes above 0.1% for 10 minutes |
| Control-plane latency | 99% of HTTP requests finish in under 1 second | 30 days | p99 over 5 minutes above 1s for 15 minutes |
| Queue lag | 99% of successful claims wait under 30 seconds | 30 days | p99 lag over 5 minutes above 30s for 10 minutes |
| Lease continuity | No lease expiry while a worker should be heartbeating | rolling 15 minutes | Any increase in `flowforge_lease_expirations_total` |
| Vault decrypt | 99% of decrypt attempts succeed | 1 hour | Error ratio above 1% for 15 minutes when decrypt traffic is present |

The 30 second queue-lag target matches the E12.2 full-suite SLO. The
CI evidence gate remains 15 seconds and is not changed here.

`failed` execution outcomes are a workflow result. Page on
`indeterminate` (lease loss) and on vault decrypt errors, not on every
failed run.

## Trace export

Every API response can carry W3C `traceparent`. Job rows store that
context when the enqueue span is valid (`execution_jobs.traceparent`,
`execution_jobs.tracestate`). Workers continue it on heartbeat and
complete. The value is not a secret and is omitted from browser JSON.

| Variable | Default | Effect |
| --- | --- | --- |
| `OTEL_SERVICE_NAME` | `flowforge` | Resource service name. Values that look like secrets are ignored. |
| `OTEL_TRACES_SAMPLER` | `parentbased_always_on` | Also `always_on`, `always_off`, `traceidratio`, `parentbased_traceidratio`, `parentbased_always_off`. |
| `OTEL_TRACES_SAMPLER_ARG` | `1` (`0.1` for `parentbased_traceidratio` when unset) | Ratio in `[0,1]`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | unset | OTLP/HTTP trace export. Unset means spans stay in process and headers still propagate. The API does not dial a default localhost collector. |
| `OTEL_SDK_DISABLED` | unset | `true` leaves traces and business metrics off. The hand-rolled HTTP scrape still works. |

A down collector must not stop the API. Export setup errors are logged
and the process keeps serving. Invalid inbound trace headers are
ignored. Drafts still cannot run.

Set the same endpoint on `api`, `runner`, and the local `worker` so
enqueue and execute spans share a backend. The trace id joins them
even when each process has its own SDK.

## Example alerts

Apply with the cluster's Prometheus operator, or translate to the
Alertmanager rules the platform already runs. Do not commit a secret
or a scrape token into this file. The rules read the same series a
machine principal scrapes.
```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
 name: flowforge-slo
spec:
 groups:
 - name: flowforge.slo
 rules:
 - alert: FlowForgeAPIAvailabilityBurn
 expr: |
 (
 sum(rate(flowforge_http_requests_total{status=~"5.."}[5m]))
 /
 clamp_min(sum(rate(flowforge_http_requests_total[5m])), 1e-9)
 ) > 0.001
 for: 10m
 labels:
 severity: page
 annotations:
 summary: FlowForge API 5xx ratio is above 0.1%
 description: 30-day availability objective is 99.9% non-5xx. Correlate with traceparent and X-Request-ID. Do not attach headers or bodies.

 - alert: FlowForgeAPILatency
 expr: |
 histogram_quantile(0.99,
 sum by (le) (rate(flowforge_http_request_duration_seconds_bucket[5m]))
 ) > 1
 for: 15m
 labels:
 severity: page
 annotations:
 summary: FlowForge API p99 latency is above 1s

 - alert: FlowForgeQueueLag
 expr: |
 histogram_quantile(0.99,
 sum by (le) (rate(flowforge_queue_lag_seconds_bucket[5m]))
 ) > 30
 for: 10m
 labels:
 severity: page
 annotations:
 summary: FlowForge claim lag p99 is above the 30s queue SLO
 description: See incident-recovery worker-loss. A stuck queue is not fixed by replaying drafts.

 - alert: FlowForgeLeaseExpirations
 expr: increase(flowforge_lease_expirations_total[15m]) > 0
 for: 5m
 labels:
 severity: page
 annotations:
 summary: FlowForge marked leased jobs indeterminate
 description: A worker missed its lease. Do not assume the provider side effect did not happen.

 - alert: FlowForgeVaultDecryptErrors
 expr: |
 (
 sum(rate(flowforge_vault_operations_total{op="decrypt",result="error"}[15m]))
 /
 clamp_min(sum(rate(flowforge_vault_operations_total{op="decrypt"}[15m])), 1e-9)
 ) > 0.01
 for: 15m
 labels:
 severity: page
 annotations:
 summary: FlowForge vault decrypt error ratio is above 1%
 description: Labels are op and result only. Do not log plaintext or the credential id in the alert body.
```
