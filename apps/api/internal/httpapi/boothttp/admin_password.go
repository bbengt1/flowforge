package boothttp

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/bootstrap"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/localauth"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

const (
	setupTokenConflictDetail = "The setup token is no longer valid."
	setupTokenRejectedDetail = "Setup token was not accepted."
	setupRateLimitDetail     = "Setup rate limit exceeded. Retry after the configured window."
	setupBodyDetail          = "Admin password setup accepts setup_token and password."
)

// adminPasswordSet is the 201 body. It does not mint a session and
// never includes the password or the setup token.
type adminPasswordSet struct {
	AdminPasswordSet   bool             `json:"adminPasswordSet"`
	MustChangePassword bool             `json:"mustChangePassword"`
	LoginReady         bool             `json:"loginReady"`
	Identifier         string           `json:"identifier"`
	Bootstrap          bootstrap.Status `json:"bootstrap"`
}

// postBootstrapAdminPassword sets the seeded admin password and
// consumes the one-time setup token. Standalone only. Path 1 (wizard
// already complete) and path 2 (wizard incomplete) both use this door
// before any login. CSRF matches the other bootstrap POSTs: required
// when ff_session is present, not required when it is absent.
func postBootstrapAdminPassword(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if !requireBootstrap(s, w, r) || !s.RequireStore(w, r) {
		return
	}
	if setupQueryRejected(w, r) {
		return
	}
	ok, retry, err := allowSetup(s, r)
	if err != nil {
		core.WriteRateStoreUnavailable(w, r)
		return
	}
	if !ok {
		core.WriteRateLimited(w, r, retry, setupRateLimitDetail)
		return
	}
	if !allowIncompleteWizard(s, w, r) {
		return
	}
	token, password, ok := decodeAdminPassword(w, r)
	if !ok {
		return
	}
	cred, err := s.Store.LookupLocalLogin(r.Context(), localauth.OneTimeIdentifier)
	if err != nil {
		if errors.Is(err, identity.ErrNotFound) {
			core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", setupTokenConflictDetail)
			return
		}
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Identity store is not available.")
		return
	}
	if err := commitAdminPassword(s, r, cred.User.ID, token, password); err != nil {
		writeSetupError(w, r, err)
		return
	}
	auditAdminPasswordSet(s, r, cred.User.ID)
	st, err := s.Bootstrap.Get(r.Context())
	status := bootstrap.State{}.Status()
	if err == nil {
		status = st.Status()
	}
	core.WriteJSON(w, http.StatusCreated, adminPasswordSet{
		AdminPasswordSet:   true,
		MustChangePassword: false,
		LoginReady:         true,
		Identifier:         localauth.OneTimeIdentifier,
		Bootstrap:          status,
	})
}

func allowSetup(s *core.Server, r *http.Request) (bool, time.Duration, error) {
	if s.SetupLimiter == nil {
		return false, bootstrap.DefaultSetupWindow, nil
	}
	limit := s.SetupIPLimit
	if limit == 0 {
		limit = bootstrap.DefaultSetupIPLimit
	}
	return s.SetupLimiter.Decide(r.Context(), bootstrap.SetupIPKey(s.RequestClientIP(r)), limit, s.ClockNow())
}

func setupQueryRejected(w http.ResponseWriter, r *http.Request) bool {
	if r.URL == nil || r.URL.RawQuery == "" {
		return false
	}
	for key := range r.URL.Query() {
		switch strings.ToLower(strings.ReplaceAll(key, "-", "_")) {
		case "setup_token", "password", "token", "passwd":
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "setup_token and password belong in the request body.")
			return true
		}
	}
	return false
}

func decodeAdminPassword(w http.ResponseWriter, r *http.Request) (token, password string, ok bool) {
	var raw map[string]any
	if !core.DecodeJSON(w, r, &raw) {
		return "", "", false
	}
	var tokenVal, passwordVal any
	hasToken, hasPassword := false, false
	for key, value := range raw {
		norm := strings.ToLower(strings.ReplaceAll(key, "-", "_"))
		switch norm {
		case "setup_token":
			tokenVal = value
			hasToken = true
		case "password":
			passwordVal = value
			hasPassword = true
		default:
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", setupBodyDetail)
			return "", "", false
		}
	}
	if !hasToken || !hasPassword {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "setup_token and password are required.")
		return "", "", false
	}
	token, tokenOK := tokenVal.(string)
	password, passOK := passwordVal.(string)
	if !tokenOK || !passOK || strings.TrimSpace(token) == "" || password == "" {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "setup_token and password are required.")
		return "", "", false
	}
	if err := bootstrap.ValidateSetupToken(token); err != nil {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "setup_token is not valid.")
		return "", "", false
	}
	if password == token || localauth.IsOneTimePassword(password) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Choose a new password that is not the one-time default and is not the current password.")
		return "", "", false
	}
	if err := localauth.ValidatePassword(password); err != nil {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Password does not meet the required length.")
		return "", "", false
	}
	return token, password, true
}

func commitAdminPassword(s *core.Server, r *http.Request, userID, token, password string) error {
	presented := bootstrap.HashSetupToken(token)
	switch b := s.Bootstrap.(type) {
	case *bootstrap.Postgres:
		hash, err := localauth.HashPassword(password)
		if err != nil {
			return err
		}
		return b.CommitAdminPassword(r.Context(), presented, userID, hash, core.RequestIDFromContext(r.Context()))
	case *bootstrap.Memory:
		return b.CommitSetupToken(r.Context(), presented, func(ctx context.Context) error {
			cred, err := s.Store.LookupLocalLoginByUser(ctx, userID)
			if err != nil {
				return err
			}
			if localauth.PasswordHashUsable(cred.PasswordHash) {
				return bootstrap.ErrSetupComplete
			}
			hash, err := localauth.HashPassword(password)
			if err != nil {
				return err
			}
			return s.Store.ChangeLocalPassword(ctx, userID, hash)
		})
	default:
		return bootstrap.ErrUnavailable
	}
}

func auditAdminPasswordSet(s *core.Server, r *http.Request, userID string) {
	event := session.AuditEvent{
		UserID:    userID,
		EventType: session.EventBootstrapAdminPasswordSet,
		Outcome:   session.OutcomeAllowed,
		Reason:    "admin-password-set",
		RequestID: core.RequestIDFromContext(r.Context()),
		CreatedAt: s.ClockNow(),
	}
	if _, memory := s.Bootstrap.(*bootstrap.Memory); memory && s.Sessions != nil {
		if err := s.Sessions.Audit(r.Context(), event); err != nil && s.Log != nil {
			s.Log.Error("session_audit_persist",
				"request_id", event.RequestID,
				"error", err.Error(),
			)
		}
	}
	if s.Log != nil {
		s.Log.Info("session_audit",
			"request_id", event.RequestID,
			"event_type", event.EventType,
			"outcome", event.Outcome,
			"user_id", userID,
		)
	}
}

func writeSetupError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, bootstrap.ErrSetupComplete):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", setupTokenConflictDetail)
	case errors.Is(err, bootstrap.ErrSetupToken):
		core.WriteProblem(w, r, http.StatusUnauthorized, core.CodeUnauthenticated, "Unauthenticated", setupTokenRejectedDetail)
	case errors.Is(err, localauth.ErrInvalidPassword), errors.Is(err, localauth.ErrOneTimePassword), errors.Is(err, bootstrap.ErrInvalid):
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Password does not meet the required length.")
	default:
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Bootstrap state is not available.")
	}
}
