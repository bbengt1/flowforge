package observability

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"sync"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

const (
	// TraceParentHeader and TraceStateHeader are the W3C trace-context
	// headers. They are correlation identifiers, never credentials.
	TraceParentHeader = "traceparent"
	TraceStateHeader  = "tracestate"
)

var traceParentPattern = regexp.MustCompile(`^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$`)

// traceSlot carries an optional response trace that should win over the
// inbound HTTP server span. Job claim uses it so a worker continues the
// enqueue trace rather than the poll trace.
type traceSlot struct {
	mu     sync.Mutex
	parent string
	state  string
	set    bool
}

type traceSlotKey struct{}

// WithResponseSlot returns ctx plus a slot middleware can read after
// the handler returns.
func WithResponseSlot(ctx context.Context) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	if _, ok := ctx.Value(traceSlotKey{}).(*traceSlot); ok {
		return ctx
	}
	return context.WithValue(ctx, traceSlotKey{}, &traceSlot{})
}

// PublishResponseTrace stores spanCtx as the response trace and writes
// the W3C headers immediately. Call it before the handler writes a body;
// headers set after WriteHeader are not sent.
func PublishResponseTrace(reqCtx, spanCtx context.Context, h http.Header) {
	BindResponseTrace(reqCtx, spanCtx)
	InjectHTTP(reqCtx, h)
}

// BindResponseTrace publishes the active span on spanCtx as the W3C
// headers for the HTTP response associated with reqCtx.
func BindResponseTrace(reqCtx, spanCtx context.Context) {
	parent, state := Capture(spanCtx)
	if parent == "" {
		return
	}
	slot, _ := reqCtx.Value(traceSlotKey{}).(*traceSlot)
	if slot == nil {
		return
	}
	slot.mu.Lock()
	slot.parent = parent
	slot.state = state
	slot.set = true
	slot.mu.Unlock()
}

func responseTrace(ctx context.Context) (string, string, bool) {
	slot, _ := ctx.Value(traceSlotKey{}).(*traceSlot)
	if slot == nil {
		return "", "", false
	}
	slot.mu.Lock()
	defer slot.mu.Unlock()
	if !slot.set || !ValidTraceParent(slot.parent) {
		return "", "", false
	}
	state := slot.state
	if !ValidTraceState(state) {
		state = ""
	}
	return slot.parent, state, true
}

// ExtractHTTP returns ctx with a validated W3C trace context applied.
// Invalid or secret-like headers are ignored. The request is not failed.
func ExtractHTTP(ctx context.Context, h http.Header) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	if h == nil {
		return ctx
	}
	carrier := propagation.MapCarrier{}
	if parent := strings.TrimSpace(h.Get(TraceParentHeader)); ValidTraceParent(parent) {
		carrier.Set(TraceParentHeader, parent)
	}
	if state := strings.TrimSpace(h.Get(TraceStateHeader)); ValidTraceState(state) {
		carrier.Set(TraceStateHeader, state)
	}
	if len(carrier) == 0 {
		return ctx
	}
	return otel.GetTextMapPropagator().Extract(ctx, carrier)
}

// InjectHTTP writes the current span as W3C traceparent/tracestate.
// A response slot set by BindResponseTrace wins, so job dispatch can
// hand the enqueue trace to a worker.
func InjectHTTP(ctx context.Context, h http.Header) {
	if h == nil {
		return
	}
	if parent, state, ok := responseTrace(ctx); ok {
		h.Set(TraceParentHeader, parent)
		if state != "" {
			h.Set(TraceStateHeader, state)
		}
		return
	}
	parent, state := Capture(ctx)
	if parent == "" {
		return
	}
	h.Set(TraceParentHeader, parent)
	if state != "" {
		h.Set(TraceStateHeader, state)
	}
}

// Capture returns the current span as validated W3C headers.
// An unsampled or invalid context returns empty strings.
func Capture(ctx context.Context) (parent, state string) {
	if ctx == nil {
		return "", ""
	}
	carrier := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(ctx, carrier)
	parent = strings.TrimSpace(carrier.Get(TraceParentHeader))
	state = strings.TrimSpace(carrier.Get(TraceStateHeader))
	if !ValidTraceParent(parent) {
		return "", ""
	}
	if !ValidTraceState(state) {
		state = ""
	}
	return parent, state
}

// HasSpan reports whether ctx already carries a recorded trace id.
func HasSpan(ctx context.Context) bool {
	return trace.SpanFromContext(ctx).SpanContext().HasTraceID()
}

// Continue starts name as a child of the W3C context in parent/state,
// keeping ctx's cancellation and values. Invalid parent headers are
// ignored and the span is a child of ctx instead.
func Continue(ctx context.Context, parent, state, name string) (context.Context, trace.Span) {
	if ctx == nil {
		ctx = context.Background()
	}
	if ValidTraceParent(parent) {
		carrier := propagation.MapCarrier{TraceParentHeader: parent}
		if ValidTraceState(state) {
			carrier.Set(TraceStateHeader, state)
		}
		ctx = otel.GetTextMapPropagator().Extract(ctx, carrier)
	}
	return Tracer().Start(ctx, name)
}

// ValidTraceParent reports whether s is a W3C traceparent this process
// will store or forward. Version 00, non-zero ids, lowercase hex.
func ValidTraceParent(s string) bool {
	if !traceParentPattern.MatchString(s) {
		return false
	}
	if s[3:35] == strings.Repeat("0", 32) || s[36:52] == strings.Repeat("0", 16) {
		return false
	}
	return true
}

// ValidTraceState reports whether s is safe to persist and forward.
// Empty is valid (no vendor state). Values that look like credentials
// are rejected.
func ValidTraceState(s string) bool {
	if s == "" {
		return true
	}
	if len(s) > 512 {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r > 0x7e || r == '\\' {
			return false
		}
	}
	lower := strings.ToLower(s)
	for _, banned := range []string{"bearer ", "password", "secret", "token", "authorization", "credential"} {
		if strings.Contains(lower, banned) {
			return false
		}
	}
	return true
}
