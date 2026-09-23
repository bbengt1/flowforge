package core

import (
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/quota"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func QuotaUnshared(store quota.Taker) bool {
	switch store.(type) {
	case *quota.Memory, nil:
		return true
	default:
		return false
	}
}

// chargeQuota consumes one workspace token for the matched route.
// Auth doors are not charged. A store error is 503. A deny is 429.
// One request is charged once even when authorization runs twice.
func (s *Server) chargeQuota(w http.ResponseWriter, r *http.Request, workspaceID string) bool {
	// HA probes never consult the limiter. A down store must not 503 them.
	if probeRequest(r) {
		return true
	}
	class := quotaClass(r)
	if class == "" {
		return true
	}
	meta, _ := r.Context().Value(metaKey).(*requestMeta)
	if meta != nil && meta.quotaCharged {
		return true
	}
	capacity, refill, unlimited, known := s.QuotaLimits.Bucket(class)
	if !known || (!unlimited && (s.Quota == nil || capacity <= 0)) {
		WriteRateStoreUnavailable(w, r)
		return false
	}
	if unlimited {
		if meta != nil {
			meta.quotaCharged = true
		}
		return true
	}
	decision, err := s.Quota.Take(r.Context(), workspaceID, class, capacity, refill, s.ClockNow())
	if err != nil {
		WriteRateStoreUnavailable(w, r)
		return false
	}
	if !decision.Allowed {
		WriteRateLimited(w, r, decision.RetryAfter, quotaDenyDetail(class))
		return false
	}
	if meta != nil {
		meta.quotaCharged = true
	}
	return true
}

func probeRequest(r *http.Request) bool {
	if r == nil || r.URL == nil {
		return false
	}
	if quota.IsProbe(r.URL.Path) {
		return true
	}
	pattern := RouteFromContext(r.Context())
	_, path, ok := strings.Cut(pattern, " ")
	if !ok {
		path = pattern
	}
	return quota.IsProbe(path)
}

func quotaClass(r *http.Request) string {
	pattern := RouteFromContext(r.Context())
	method, path, ok := strings.Cut(pattern, " ")
	if !ok {
		method = r.Method
		path = r.URL.Path
	}
	return quota.ClassForRoute(method, path)
}

func quotaDenyDetail(class string) string {
	switch class {
	case quota.ClassExecute:
		return "Workspace execution rate limit exceeded. Retry after the configured window."
	case quota.ClassDownload:
		return "Workspace download rate limit exceeded. Retry after the configured window."
	case quota.ClassRead:
		return "Workspace read rate limit exceeded. Retry after the configured window."
	default:
		return "Workspace rate limit exceeded. Retry after the configured window."
	}
}

func WriteRateStoreUnavailable(w http.ResponseWriter, r *http.Request) {
	WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Rate limit store is not available.")
}

func (s *Server) executionCap() int {
	if s.QuotaLimits.ExecuteConcurrency < 0 {
		return 0
	}
	return s.QuotaLimits.ExecuteConcurrency
}

func (s *Server) CapStart(in wfstore.StartInput) wfstore.StartInput {
	if in.MaxOpen == 0 {
		in.MaxOpen = s.executionCap()
	}
	return in
}
