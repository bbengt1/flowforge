package observability

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/common/expfmt"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	promexp "go.opentelemetry.io/otel/exporters/prometheus"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

const instrumentationScope = "github.com/bbengt1/flowforge/apps/api"

// Install configures process-wide OpenTelemetry traces and metrics.
// It is safe to call more than once; only the first call takes effect.
// A missing collector does not fail the process: traces still propagate
// W3C traceparent/tracestate, and metrics stay on the Prometheus scrape.
// OTEL_SDK_DISABLED=true leaves the global noop providers in place.
func Install(ctx context.Context) error {
	installOnce.Do(func() {
		installErr = install(ctx)
	})
	return installErr
}

// Shutdown flushes trace exports. It is a no-op when Install did not
// start a provider.
func Shutdown(ctx context.Context) error {
	if shutdownFn == nil {
		return nil
	}
	return shutdownFn(ctx)
}

// Tracer is the control-plane tracer. It is the global noop tracer
// until Install succeeds.
func Tracer() trace.Tracer {
	return otel.Tracer(instrumentationScope)
}

// WriteOTelPrometheus appends the OpenTelemetry Prometheus exposition
// (business metrics) to w. A disabled or failed install writes nothing.
func WriteOTelPrometheus(w io.Writer) error {
	if promReg == nil {
		return nil
	}
	families, err := promReg.Gather()
	if err != nil && len(families) == 0 {
		return err
	}
	for _, family := range families {
		if _, werr := expfmt.MetricFamilyToText(w, family); werr != nil {
			return werr
		}
	}
	return err
}

var (
	installOnce sync.Once
	installErr  error
	shutdownFn  func(context.Context) error
	promReg     *prometheus.Registry
	instruments *otelInstruments
)

type otelInstruments struct {
	queueDepth        metric.Int64UpDownCounter
	jobsEnqueued      metric.Int64Counter
	queueLag          metric.Float64Histogram
	leaseClaims       metric.Int64Counter
	leaseExpirations  metric.Int64Counter
	executionOutcomes metric.Int64Counter
	vaultOps          metric.Int64Counter
}

func install(ctx context.Context) error {
	if sdkDisabled() {
		return nil
	}
	res := resource.NewSchemaless(attribute.String("service.name", serviceName()))
	reg := prometheus.NewRegistry()
	exp, err := promexp.New(
		promexp.WithRegisterer(reg),
		promexp.WithoutTargetInfo(),
		promexp.WithoutScopeInfo(),
	)
	if err != nil {
		return err
	}
	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(res),
		sdkmetric.WithReader(exp),
	)
	traceOpts := []sdktrace.TracerProviderOption{
		sdktrace.WithResource(res),
		sdktrace.WithSampler(samplerFromEnv()),
	}
	var tpShutdown func(context.Context) error
	if otlp, otlpErr := maybeOTLP(ctx); otlpErr != nil {
		slog.Default().Error("opentelemetry trace export disabled", "error", otlpErr)
	} else if otlp != nil {
		traceOpts = append(traceOpts, sdktrace.WithBatcher(otlp))
	}
	tp := sdktrace.NewTracerProvider(traceOpts...)
	tpShutdown = tp.Shutdown

	meter := mp.Meter(instrumentationScope)
	inst, err := newInstruments(meter)
	if err != nil {
		_ = mp.Shutdown(ctx)
		_ = tpShutdown(ctx)
		return err
	}

	otel.SetTextMapPropagator(propagation.TraceContext{})
	otel.SetTracerProvider(tp)
	otel.SetMeterProvider(mp)
	promReg = reg
	instruments = inst
	shutdownFn = func(ctx context.Context) error {
		return errors.Join(mp.Shutdown(ctx), tpShutdown(ctx))
	}
	return nil
}

func newInstruments(meter metric.Meter) (*otelInstruments, error) {
	var err error
	inst := &otelInstruments{}
	inst.queueDepth, err = meter.Int64UpDownCounter("flowforge_queue_depth",
		metric.WithDescription("Jobs enqueued minus jobs that left the queue in this process."),
		metric.WithUnit("1"),
	)
	if err != nil {
		return nil, err
	}
	inst.jobsEnqueued, err = meter.Int64Counter("flowforge_jobs_enqueued",
		metric.WithDescription("Jobs placed on the durable queue."),
		metric.WithUnit("1"),
	)
	if err != nil {
		return nil, err
	}
	inst.queueLag, err = meter.Float64Histogram("flowforge_queue_lag",
		metric.WithDescription("Age of a job when a worker claims it."),
		metric.WithUnit("s"),
		metric.WithExplicitBucketBoundaries(0.1, 0.5, 1, 2, 5, 15, 30, 60, 120),
	)
	if err != nil {
		return nil, err
	}
	inst.leaseClaims, err = meter.Int64Counter("flowforge_lease_claims",
		metric.WithDescription("Lease claim attempts by result."),
		metric.WithUnit("1"),
	)
	if err != nil {
		return nil, err
	}
	inst.leaseExpirations, err = meter.Int64Counter("flowforge_lease_expirations",
		metric.WithDescription("Claimed or running jobs marked indeterminate because the lease expired."),
		metric.WithUnit("1"),
	)
	if err != nil {
		return nil, err
	}
	inst.executionOutcomes, err = meter.Int64Counter("flowforge_execution_outcomes",
		metric.WithDescription("Terminal execution outcomes recorded by the control plane."),
		metric.WithUnit("1"),
	)
	if err != nil {
		return nil, err
	}
	inst.vaultOps, err = meter.Int64Counter("flowforge_vault_operations",
		metric.WithDescription("Vault operations by kind and result. Labels never include secret material."),
		metric.WithUnit("1"),
	)
	if err != nil {
		return nil, err
	}
	return inst, nil
}

func maybeOTLP(ctx context.Context) (sdktrace.SpanExporter, error) {
	if strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")) == "" &&
		strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")) == "" {
		return nil, nil
	}
	// The exporter reads the endpoint from the environment. It is not
	// constructed when those variables are empty, so a default
	// localhost:4318 dial cannot start by accident.
	return otlptracehttp.New(ctx)
}

func sdkDisabled() bool {
	v := strings.TrimSpace(os.Getenv("OTEL_SDK_DISABLED"))
	return v == "1" || strings.EqualFold(v, "true")
}

func serviceName() string {
	if name := strings.TrimSpace(os.Getenv("OTEL_SERVICE_NAME")); name != "" && len(name) <= 64 && !looksLikeSecret(name) {
		return name
	}
	return "flowforge"
}

func samplerFromEnv() sdktrace.Sampler {
	name := strings.ToLower(strings.TrimSpace(os.Getenv("OTEL_TRACES_SAMPLER")))
	ratio := 1.0
	if raw := strings.TrimSpace(os.Getenv("OTEL_TRACES_SAMPLER_ARG")); raw != "" {
		if parsed, err := strconv.ParseFloat(raw, 64); err == nil && parsed >= 0 && parsed <= 1 {
			ratio = parsed
		}
	}
	switch name {
	case "always_on":
		return sdktrace.AlwaysSample()
	case "always_off":
		return sdktrace.NeverSample()
	case "traceidratio":
		return sdktrace.TraceIDRatioBased(ratio)
	case "parentbased_always_off":
		return sdktrace.ParentBased(sdktrace.NeverSample())
	case "parentbased_traceidratio":
		if strings.TrimSpace(os.Getenv("OTEL_TRACES_SAMPLER_ARG")) == "" {
			ratio = 0.1
		}
		return sdktrace.ParentBased(sdktrace.TraceIDRatioBased(ratio))
	case "", "parentbased_always_on":
		return sdktrace.ParentBased(sdktrace.AlwaysSample())
	default:
		return sdktrace.ParentBased(sdktrace.AlwaysSample())
	}
}
