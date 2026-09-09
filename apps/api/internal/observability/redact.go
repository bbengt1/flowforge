package observability

import (
	"context"
	"log/slog"
	"net/url"
	"strings"
)

const redacted = "[redacted]"

// NewRedactingHandler wraps next so secret-bearing keys and values never
// reach the output. Used for structured JSON logs.
func NewRedactingHandler(next slog.Handler) slog.Handler {
	if next == nil {
		next = slog.NewJSONHandler(discard{}, nil)
	}
	return &redactingHandler{next: next}
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

type redactingHandler struct {
	next slog.Handler
}

func (h *redactingHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h *redactingHandler) Handle(ctx context.Context, rec slog.Record) error {
	out := slog.NewRecord(rec.Time, rec.Level, rec.Message, rec.PC)
	rec.Attrs(func(a slog.Attr) bool {
		out.AddAttrs(redactAttr(a))
		return true
	})
	return h.next.Handle(ctx, out)
}

func (h *redactingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	out := make([]slog.Attr, len(attrs))
	for i, a := range attrs {
		out[i] = redactAttr(a)
	}
	return &redactingHandler{next: h.next.WithAttrs(out)}
}

func (h *redactingHandler) WithGroup(name string) slog.Handler {
	return &redactingHandler{next: h.next.WithGroup(name)}
}

func redactAttr(a slog.Attr) slog.Attr {
	a.Value = a.Value.Resolve()
	if a.Value.Kind() == slog.KindGroup {
		group := a.Value.Group()
		out := make([]slog.Attr, len(group))
		for i, g := range group {
			out[i] = redactAttr(g)
		}
		return slog.Attr{Key: a.Key, Value: slog.GroupValue(out...)}
	}
	if shouldRedactKey(a.Key) {
		return slog.String(a.Key, redacted)
	}
	if secretString(a.Value) {
		return slog.String(a.Key, redacted)
	}
	return a
}

func shouldRedactKey(key string) bool {
	k := normalizeKey(key)
	switch k {
	case "authorization", "cookie", "set_cookie", "password", "passwd",
		"secret", "token", "access_token", "refresh_token", "id_token",
		"api_key", "apikey", "x_api_key", "database_url", "dsn",
		"credential", "credentials", "private_key", "client_secret",
		"webhook_secret", "kubeconfig", "dek_envelope", "ciphertext",
		"credential_kek", "assertion", "embed_assertion", "signing_key",
		"embed_signing_key":
		return true
	}
	for _, part := range []string{"password", "secret", "token", "authorization", "credential", "api_key"} {
		if k == part || strings.HasSuffix(k, "_"+part) || strings.HasPrefix(k, part+"_") || strings.Contains(k, "_"+part+"_") {
			return true
		}
	}
	return false
}

func normalizeKey(key string) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(key)), "-", "_")
}

func secretString(v slog.Value) bool {
	var s string
	switch v.Kind() {
	case slog.KindString:
		s = v.String()
	case slog.KindAny:
		if err, ok := v.Any().(error); ok {
			s = err.Error()
		} else {
			return false
		}
	default:
		return false
	}
	return looksLikeSecret(s)
}

func looksLikeSecret(s string) bool {
	if s == "" {
		return false
	}
	lower := strings.ToLower(s)
	if strings.HasPrefix(lower, "bearer ") {
		return true
	}
	if strings.Contains(s, "://") && strings.Contains(s, "@") {
		if u, err := url.Parse(s); err == nil && u.User != nil {
			if _, hasPass := u.User.Password(); hasPass {
				return true
			}
		}
	}
	return false
}
