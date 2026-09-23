package core

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"
	"unicode"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/bbengt1/flowforge/apps/api/internal/observability"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
)

// Security is the TLS/proxy/CORS/session policy applied at the HTTP boundary.
// Empty TrustedProxies means X-Forwarded-* headers are ignored.
// Empty AllowedOrigins means only same-origin or Origin-less callers (fail closed).
// TrustIdentityHeaders is false by default (fail closed): client-supplied
// X-FlowForge-Issuer / X-FlowForge-Subject are not authentication and
// POST /session must not upsert principals from those values. Enable only
// via config.Load() when TRUSTED_DEV_IDENTITY_HEADERS is explicit and the
// process is not production-locked.
type Security struct {
	TrustedProxies       []*net.IPNet
	RequireTLS           bool
	AllowedOrigins       []string
	TrustIdentityHeaders bool
	// ProductionLocked forces Secure on first-party session and OIDC
	// cookies. cmd/api sets it from authz.ProductionLocked (empty,
	// production, or unknown APP_ENV, or REQUIRE_TLS). The zero value
	// does not lock, so unit tests and explicit local/dev/test HTTP
	// can still bootstrap Login.
	ProductionLocked bool
	Session          SessionPolicy
	VaultKeys        vault.Keys
	JobBindingKey    []byte
}

// SessionPolicy is idle/absolute lifetime for browser sessions.
type SessionPolicy struct {
	IdleTimeout     time.Duration
	AbsoluteTimeout time.Duration
}

func (s Security) sessionPolicy() SessionPolicy {
	p := s.Session
	if p.IdleTimeout <= 0 {
		p.IdleTimeout = session.DefaultIdleTimeout
	}
	if p.AbsoluteTimeout <= 0 {
		p.AbsoluteTimeout = session.DefaultAbsoluteTimeout
	}
	if p.IdleTimeout > p.AbsoluteTimeout {
		p.IdleTimeout = p.AbsoluteTimeout
	}
	return p
}

func (s Security) RequestIsHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	if !s.fromTrustedProxy(r) {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https")
}

func (s Security) fromTrustedProxy(r *http.Request) bool {
	ip := clientIP(r)
	if ip == nil {
		return false
	}
	for _, network := range s.TrustedProxies {
		if network != nil && network.Contains(ip) {
			return true
		}
	}
	return false
}

func clientIP(r *http.Request) net.IP {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	return net.ParseIP(host)
}

type contextKey int

const (
	RequestIDKey contextKey = iota + 1
	metaKey
	principalKey
)

type requestMeta struct {
	route        string
	quotaCharged bool
}

// RequestIDHeader is the correlation header accepted and returned on every response.
const RequestIDHeader = "X-Request-ID"

// MaxRequestBody is the maximum accepted request body size (1 MiB).
const MaxRequestBody int64 = 1 << 20

func WithRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(RequestIDHeader)
		if !ValidRequestID(id) {
			id = GenerateRequestID()
		}
		w.Header().Set(RequestIDHeader, id)
		ctx := context.WithValue(r.Context(), RequestIDKey, id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func tlsProbePath(path string) bool {
	return path == "/api/v1/health" || path == "/api/v1/readiness"
}

func WithSecureHeaders(sec Security, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		https := sec.RequestIsHTTPS(r)
		// Kubelet HTTP probes hit the pod directly (no Ingress TLS).
		if sec.RequireTLS && !https && !tlsProbePath(r.URL.Path) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "TLS is required.")
			return
		}
		h := w.Header()
		h.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Cache-Control", "no-store")
		if https {
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

func WithRecover(log *slog.Logger, next http.Handler) http.Handler {
	if log == nil {
		log = slog.Default()
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			rec := recover()
			if rec == nil {
				return
			}
			log.Error("panic",
				"request_id", RequestIDFromContext(r.Context()),
				"error", fmt.Sprint(rec),
			)
			if !headerWritten(w) {
				WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func WithObserve(log *slog.Logger, registry *observability.Registry, next http.Handler) http.Handler {
	if log == nil {
		log = slog.Default()
	}
	_ = observability.Install(context.Background())
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ctx := observability.WithResponseSlot(observability.ExtractHTTP(r.Context(), r.Header))
		ctx, span := observability.Tracer().Start(ctx, "http.server", trace.WithSpanKind(trace.SpanKindServer))
		defer span.End()
		meta := &requestMeta{route: "unmatched"}
		r = r.WithContext(context.WithValue(ctx, metaKey, meta))
		// Set traceparent before the handler writes. WriteHeader snapshots
		// headers; a later Set is not sent on a real connection.
		observability.InjectHTTP(r.Context(), w.Header())
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)

		route := meta.route
		if route == "" {
			route = "unmatched"
		}
		status := sw.status
		duration := time.Since(start)
		registry.Observe(r.Method, route, status, duration)
		span.SetAttributes(
			attribute.String("http.request.method", r.Method),
			attribute.String("http.route", route),
			attribute.Int("http.response.status_code", status),
		)
		if status >= http.StatusInternalServerError {
			span.SetStatus(codes.Error, "server error")
		}
		if !sw.wrote {
			observability.InjectHTTP(r.Context(), w.Header())
		}

		// Path only — never RawQuery, headers, cookies, or bodies.
		// trace_id is a correlation id, not a credential.
		args := []any{
			"request_id", RequestIDFromContext(r.Context()),
			"method", r.Method,
			"path", r.URL.Path,
			"route", route,
			"status", status,
			"duration_ms", duration.Milliseconds(),
			"bytes", sw.bytes,
		}
		if sc := span.SpanContext(); sc.HasTraceID() {
			args = append(args, "trace_id", sc.TraceID().String())
		}
		log.Info("request", args...)
	})
}

func WithBodyLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ContentLength > MaxRequestBody {
			WriteProblem(w, r, http.StatusRequestEntityTooLarge, CodeRequestTooLarge, "Request Too Large", "The request body exceeds the 1048576 byte limit.")
			return
		}
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, MaxRequestBody)
		}
		next.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
	bytes  int
	wrote  bool
}

func (w *statusWriter) WriteHeader(code int) {
	if w.wrote {
		return
	}
	w.wrote = true
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(p []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(p)
	w.bytes += n
	return n, err
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func headerWritten(w http.ResponseWriter) bool {
	if sw, ok := w.(*statusWriter); ok {
		return sw.wrote
	}
	return false
}

// RequestIDFromContext returns the request correlation ID, or empty if unset.
func RequestIDFromContext(ctx context.Context) string {
	id, _ := ctx.Value(RequestIDKey).(string)
	return id
}

// RouteFromContext returns the matched mux pattern, or "unmatched" if unset.
func RouteFromContext(ctx context.Context) string {
	if meta, ok := ctx.Value(metaKey).(*requestMeta); ok && meta != nil && meta.route != "" {
		return meta.route
	}
	return "unmatched"
}

func SetRoute(r *http.Request, route string) {
	if meta, ok := r.Context().Value(metaKey).(*requestMeta); ok && meta != nil {
		meta.route = route
	}
}

func ValidRequestID(id string) bool {
	n := len(id)
	if n < 16 || n > 128 {
		return false
	}
	for _, r := range id {
		if r > unicode.MaxASCII {
			return false
		}
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '-' {
			return false
		}
	}
	return true
}

func GenerateRequestID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "0000000000000000"
	}
	return hex.EncodeToString(b[:])
}
