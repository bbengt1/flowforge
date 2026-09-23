package httpapi

import (
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/quota"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func quotaUnshared(store quota.Taker) bool {
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
	class := quotaClass(r)
	if class == "" {
		return true
	}
	meta, _ := r.Context().Value(metaKey).(*requestMeta)
	if meta != nil && meta.quotaCharged {
		return true
	}
	capacity, refill, unlimited, known := s.quotaLimits.Bucket(class)
	if !known || (!unlimited && (s.quota == nil || capacity <= 0)) {
		writeRateStoreUnavailable(w, r)
		return false
	}
	if unlimited {
		if meta != nil {
			meta.quotaCharged = true
		}
		return true
	}
	decision, err := s.quota.Take(r.Context(), workspaceID, class, capacity, refill, s.clockNow())
	if err != nil {
		writeRateStoreUnavailable(w, r)
		return false
	}
	if !decision.Allowed {
		writeRateLimited(w, r, decision.RetryAfter, quotaDenyDetail(class))
		return false
	}
	if meta != nil {
		meta.quotaCharged = true
	}
	return true
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

func writeRateStoreUnavailable(w http.ResponseWriter, r *http.Request) {
	WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Rate limit store is not available.")
}

func (s *Server) executionCap() int {
	if s.quotaLimits.ExecuteConcurrency < 0 {
		return 0
	}
	return s.quotaLimits.ExecuteConcurrency
}

func (s *Server) capStart(in wfstore.StartInput) wfstore.StartInput {
	if in.MaxOpen == 0 {
		in.MaxOpen = s.executionCap()
	}
	return in
}
