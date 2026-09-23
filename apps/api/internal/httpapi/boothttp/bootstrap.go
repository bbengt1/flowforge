package boothttp

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/bootstrap"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/localauth"
	"github.com/bbengt1/flowforge/apps/api/internal/localseed"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/tlsmaterial"
)

func requireBootstrap(s *core.Server, w http.ResponseWriter, r *http.Request) bool {
	if s.Bootstrap != nil {
		return true
	}
	core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Bootstrap store is not available.")
	return false
}

// getBootstrap returns first-run wizard status. Status only — no secrets,
// no public URL value, no private keys. Auth rule:
//
//   - incomplete: unauthenticated GET is allowed so the standalone wizard
//     can start before any admin or session exists
//   - complete: requires a normal product session (cookie) or trusted-dev
//     identity headers; unauthenticated is 401
//
// This handler must not be used to gate /embed/v1. Embed never shows the
// wizard. standaloneOnly is always true.
func getBootstrap(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if !requireBootstrap(s, w, r) {
		return
	}
	st, err := s.Bootstrap.Get(r.Context())
	if err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	if st.Complete {
		if _, ok := s.RequirePrincipal(w, r); !ok {
			return
		}
	}
	core.WriteJSON(w, http.StatusOK, st.Status())
}

// postBootstrapPersistence is wizard step 1 (B.2). It confirms that the
// process DATABASE_URL PostgreSQL is reachable, then sets
// steps.persistence.ready via Store.SetStep. It never marks bootstrap
// complete, never accepts a DSN/password/DATABASE_URL in JSON, and never
// returns secrets.
//
// Auth matches incomplete-install GET /bootstrap: no session is required
// while the gate is incomplete. After complete, this wizard handler
// rejects with 409 (Settings-only). Embed sessions are 403.
func postBootstrapPersistence(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if !requireBootstrap(s, w, r) {
		return
	}
	st, err := s.Bootstrap.Get(r.Context())
	if err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	if st.Complete {
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Bootstrap is already complete. Persistence is edited in Settings.")
		return
	}
	if !allowIncompleteWizard(s, w, r) {
		return
	}
	if !requirePersistenceReady(s, w, r) {
		return
	}
	if !decodePersistenceConfirm(w, r) {
		return
	}
	if err := s.Bootstrap.SetStep(r.Context(), bootstrap.StepPersistence, true); err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	st, err = s.Bootstrap.Get(r.Context())
	if err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	if !st.PersistenceReady || st.Complete {
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Persistence is not ready.")
		return
	}
	core.WriteJSON(w, http.StatusOK, st.Status())
}

// postBootstrapAdmins is wizard step 2 (B.3). It upserts the first
// admin identity (localseed PLATFORM_ADMINS / workspace-admin pattern),
// create-or-binds workspace admin on local/default (created if missing
// so path-2 without localseed still has a selectable workbench), then
// sets steps.firstAdmin.ready via Store.SetStep. It never marks
// bootstrap complete, never returns a password / hash / KEK, and stores
// an optional password only as a bcrypt hash for POST /login.
//
// Auth matches incomplete-install GET /bootstrap and B.2: no session is
// required while the gate is incomplete. After complete, this wizard
// handler rejects with 409 (Settings-only). Embed sessions are 403.
// CSRF is required when an ff_session cookie is presented.
func postBootstrapAdmins(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if !requireBootstrap(s, w, r) {
		return
	}
	st, err := s.Bootstrap.Get(r.Context())
	if err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	if st.Complete {
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Bootstrap is already complete. Users are edited in Settings.")
		return
	}
	if !allowIncompleteWizard(s, w, r) {
		return
	}
	if !st.PersistenceReady {
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Persistence must be ready before creating the first admin.")
		return
	}
	if !s.RequireStore(w, r) {
		return
	}
	issuer, subject, display, password, ok := decodeFirstAdmin(w, r)
	if !ok {
		return
	}
	user, err := localseed.ProvisionAdmin(r.Context(), s.Store, issuer, subject, display)
	if err != nil {
		core.WriteIdentityError(w, r, err)
		return
	}
	if password != "" {
		if err := storeLocalPassword(s, r.Context(), user.ID, subject, password); err != nil {
			core.WriteLocalPasswordError(w, r, err)
			return
		}
	}
	if err := s.Bootstrap.SetStep(r.Context(), bootstrap.StepFirstAdmin, true); err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	st, err = s.Bootstrap.Get(r.Context())
	if err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	if !st.FirstAdminReady || st.Complete {
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "First admin is not ready.")
		return
	}
	core.WriteJSON(w, http.StatusCreated, st.Status())
}

// postBootstrapPublicURL is wizard step 3 (B.4). It persists the public
// base URL via Store.SetPublicURL (instance_bootstrap.public_base_url)
// and sets steps.publicUrl.ready. It never marks bootstrap complete
// and never echoes the URL on this or GET /bootstrap.
//
// Auth matches incomplete-install GET /bootstrap and B.2/B.3: no
// session is required while the gate is incomplete. After complete,
// this wizard handler rejects with 409 (Settings-only). Embed
// sessions are 403. CSRF is required when an ff_session cookie is
// presented. First admin must be ready first (fail-closed order).
func postBootstrapPublicURL(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if !requireBootstrap(s, w, r) {
		return
	}
	st, err := s.Bootstrap.Get(r.Context())
	if err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	if st.Complete {
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Bootstrap is already complete. The public URL is edited in Settings.")
		return
	}
	if !allowIncompleteWizard(s, w, r) {
		return
	}
	if !st.FirstAdminReady {
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "First admin must be ready before setting the public URL.")
		return
	}
	publicBaseURL, ok := decodePublicBaseURL(w, r)
	if !ok {
		return
	}
	if err := s.Bootstrap.SetPublicURL(r.Context(), publicBaseURL); err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	st, err = s.Bootstrap.Get(r.Context())
	if err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	if !st.PublicURLReady || st.Complete {
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Public URL is not ready.")
		return
	}
	core.WriteJSON(w, http.StatusOK, st.Status())
}

// postBootstrapTLS is wizard step 4 (B.5 / B.7). It enables TLS by
// creating a self-signed certificate, accepting a one-shot PEM
// upload, or skipping in-process certs. Create/upload write the pair
// to TLS_CERT_FILE / TLS_KEY_FILE. Skip writes no PEM/key. All three
// set steps.tls via Store.SetTLS, then MarkComplete. It never
// returns the key, PEM, or KEK. ACME / Let’s Encrypt is out of
// scope. Skip is not a permanent lockout — Settings #tls can enable
// create/upload later.
//
// Auth matches incomplete-install GET /bootstrap and B.2–B.4: no
// session is required while the gate is incomplete. After complete,
// this wizard handler rejects with 409 (Settings-only). Embed
// sessions are 403. CSRF is required when an ff_session cookie is
// presented. Public URL must be ready first (fail-closed order).
func postBootstrapTLS(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if !requireBootstrap(s, w, r) {
		return
	}
	st, err := s.Bootstrap.Get(r.Context())
	if err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	if st.Complete {
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Bootstrap is already complete. TLS is edited in Settings.")
		return
	}
	if !allowIncompleteWizard(s, w, r) {
		return
	}
	if !st.PublicURLReady {
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Public URL must be ready before enabling TLS.")
		return
	}
	action, certPEM, keyPEM, ok := decodeBootstrapTLS(w, r)
	if !ok {
		return
	}
	mode := bootstrap.TLSModeSelfSigned
	switch action {
	case tlsActionSkip:
		mode = bootstrap.TLSModeSkipped
	case tlsActionCreateSelfSigned:
		if s.TLSMaterials == nil {
			core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "TLS certificate files are not configured.")
			return
		}
		hosts := tlsmaterial.HostsFromPublicBaseURL(st.PublicBaseURL)
		certPEM, keyPEM, err = tlsmaterial.CreateSelfSigned(hosts, s.Clock().UTC())
		if err != nil {
			writeTLSMaterialError(w, r, err)
			return
		}
		if err := s.TLSMaterials.Write(certPEM, keyPEM); err != nil {
			writeTLSMaterialError(w, r, err)
			return
		}
	case tlsActionUpload:
		if s.TLSMaterials == nil {
			core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "TLS certificate files are not configured.")
			return
		}
		mode = bootstrap.TLSModeUploaded
		if err := tlsmaterial.ValidatePair(certPEM, keyPEM); err != nil {
			writeTLSMaterialError(w, r, err)
			return
		}
		if err := s.TLSMaterials.Write(certPEM, keyPEM); err != nil {
			writeTLSMaterialError(w, r, err)
			return
		}
	default:
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", tlsActionMustBeAccepted)
		return
	}
	if err := s.Bootstrap.SetTLS(r.Context(), true, mode); err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	if err := s.Bootstrap.MarkComplete(r.Context()); err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	st, err = s.Bootstrap.Get(r.Context())
	if err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	if !st.TLSReady || !st.Complete {
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "TLS is not ready.")
		return
	}
	core.WriteJSON(w, http.StatusOK, st.Status())
}

// allowIncompleteWizard reuses B.1 incomplete openness. A presented
// session cookie is validated (CSRF on POST). Embed-bound sessions are
// forbidden — the wizard is standalone only.
func allowIncompleteWizard(s *core.Server, w http.ResponseWriter, r *http.Request) bool {
	if token := core.SessionCookieValue(r); token != "" {
		if _, ok := s.RequireSessionPrincipal(w, r, token); !ok {
			return false
		}
		if core.EmbedSessionBound(r) {
			if pc := core.PrincipalFromRequest(r); pc != nil && pc.Session != nil {
				s.AuditSession(r, *pc.Session, session.EventPrivilegeDenied, session.OutcomeDenied, "embed session cannot use first-run wizard")
			}
			core.WriteProblem(w, r, http.StatusForbidden, core.CodeForbidden, "Forbidden", "The first-run wizard is standalone only.")
			return false
		}
	}
	return true
}

func requirePersistenceReady(s *core.Server, w http.ResponseWriter, r *http.Request) bool {
	if s.DB == nil {
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "PostgreSQL is not reachable")
		return false
	}
	if err := s.DB.Ping(r.Context()); err != nil {
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "PostgreSQL is not reachable")
		return false
	}
	return true
}

func decodePersistenceConfirm(w http.ResponseWriter, r *http.Request) bool {
	var raw map[string]any
	if !core.DecodeJSON(w, r, &raw) {
		return false
	}
	for key := range raw {
		if persistenceBodyForbidden(key) {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Persistence confirm accepts only confirm:true and never accepts credentials.")
			return false
		}
	}
	if len(raw) != 1 {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Persistence confirm accepts only confirm:true and never accepts credentials.")
		return false
	}
	confirm, ok := raw["confirm"].(bool)
	if !ok || !confirm {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "confirm must be true.")
		return false
	}
	return true
}

func persistenceBodyForbidden(key string) bool {
	switch strings.ToLower(strings.ReplaceAll(key, "-", "_")) {
	case "password", "passwd", "dsn", "database_url", "databaseurl",
		"kek", "secret", "secrets", "private_key", "privatekey",
		"pem", "token", "hash", "ciphertext":
		return true
	default:
		return false
	}
}

func decodeFirstAdmin(w http.ResponseWriter, r *http.Request) (issuer, subject, display, password string, ok bool) {
	var raw map[string]any
	if !core.DecodeJSON(w, r, &raw) {
		return "", "", "", "", false
	}
	var passwordVal any
	hasPassword := false
	for key, value := range raw {
		norm := strings.ToLower(strings.ReplaceAll(key, "-", "_"))
		if firstAdminBodyForbidden(norm) {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "First admin accepts issuer, external_subject, optional display_name, and optional password.")
			return "", "", "", "", false
		}
		switch norm {
		case "issuer":
			issuer, _ = value.(string)
		case "external_subject":
			subject, _ = value.(string)
		case "display_name":
			display, _ = value.(string)
		case "password":
			passwordVal = value
			hasPassword = true
		default:
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "First admin accepts issuer, external_subject, optional display_name, and optional password.")
			return "", "", "", "", false
		}
	}
	if hasPassword && passwordVal != nil {
		s, isStr := passwordVal.(string)
		if !isStr {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "password must be a string.")
			return "", "", "", "", false
		}
		password = s
	}
	issuer = strings.TrimSpace(issuer)
	subject = strings.TrimSpace(subject)
	display = strings.TrimSpace(display)
	if !authz.ValidIssuer(issuer) || !authz.ValidSubject(subject) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "issuer and external_subject are required.")
		return "", "", "", "", false
	}
	if len(display) > 200 {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "display_name is too long.")
		return "", "", "", "", false
	}
	if strings.TrimSpace(password) == "" {
		return issuer, subject, display, "", true
	}
	if err := localauth.ValidatePassword(password); err != nil {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Password does not meet the required length.")
		return "", "", "", "", false
	}
	return issuer, subject, display, password, true
}

func storeLocalPassword(s *core.Server, ctx context.Context, userID, rawIdentifier, password string) error {
	identifier, err := localauth.NormalizeIdentifier(rawIdentifier)
	if err != nil {
		return err
	}
	hash, err := localauth.HashPassword(password)
	if err != nil {
		return err
	}
	return s.Store.SetLocalPassword(ctx, userID, identifier, hash)
}

func firstAdminBodyForbidden(key string) bool {
	switch key {
	case "passwd", "dsn", "database_url", "databaseurl",
		"kek", "secret", "secrets", "private_key", "privatekey",
		"pem", "token", "hash", "ciphertext":
		return true
	default:
		return false
	}
}

func decodePublicBaseURL(w http.ResponseWriter, r *http.Request) (string, bool) {
	var raw map[string]any
	if !core.DecodeJSON(w, r, &raw) {
		return "", false
	}
	var publicBaseURL string
	found := false
	for key, value := range raw {
		norm := strings.ToLower(strings.ReplaceAll(key, "-", "_"))
		if publicURLBodyForbidden(norm) {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Public URL accepts only publicBaseUrl. Credentials are not accepted.")
			return "", false
		}
		switch norm {
		case "publicbaseurl", "public_base_url":
			s, ok := value.(string)
			if !ok {
				core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "publicBaseUrl must be an http(s) origin.")
				return "", false
			}
			publicBaseURL = s
			found = true
		default:
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Public URL accepts only publicBaseUrl.")
			return "", false
		}
	}
	if !found {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "publicBaseUrl is required.")
		return "", false
	}
	normalized, err := bootstrap.NormalizePublicBaseURL(publicBaseURL)
	if err != nil || normalized == "" {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "publicBaseUrl must be an http(s) origin. HTTPS is preferred; HTTP is allowed for local installs.")
		return "", false
	}
	return normalized, true
}

func publicURLBodyForbidden(key string) bool {
	switch key {
	case "password", "passwd", "dsn", "database_url", "databaseurl",
		"kek", "secret", "secrets", "private_key", "privatekey",
		"pem", "token", "hash", "ciphertext":
		return true
	default:
		return false
	}
}

const (
	tlsActionCreateSelfSigned = "create-self-signed"
	tlsActionUpload           = "upload"
	tlsActionSkip             = "skip"
	tlsActionMustBeAccepted   = "action must be create-self-signed, upload, or skip."
	tlsAcceptsActions         = "TLS accepts action create-self-signed, upload, or skip."
)

func decodeBootstrapTLS(w http.ResponseWriter, r *http.Request) (action string, certPEM, keyPEM []byte, ok bool) {
	var raw map[string]any
	if !core.DecodeJSON(w, r, &raw) {
		return "", nil, nil, false
	}
	var certStr, keyStr string
	hasCert, hasKey := false, false
	for key, value := range raw {
		norm := strings.ToLower(strings.ReplaceAll(key, "-", "_"))
		if tlsBodyForbidden(norm) {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", tlsAcceptsActions+" Credentials other than a one-shot certificate pair are not accepted.")
			return "", nil, nil, false
		}
		switch norm {
		case "action":
			s, isStr := value.(string)
			if !isStr {
				core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", tlsActionMustBeAccepted)
				return "", nil, nil, false
			}
			action = strings.TrimSpace(s)
		case "certpem", "cert_pem":
			s, isStr := value.(string)
			if !isStr {
				core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "certPem must be a certificate.")
				return "", nil, nil, false
			}
			certStr = s
			hasCert = true
		case "keypem", "key_pem":
			s, isStr := value.(string)
			if !isStr {
				core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "keyPem must be a private key.")
				return "", nil, nil, false
			}
			keyStr = s
			hasKey = true
		default:
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", tlsAcceptsActions)
			return "", nil, nil, false
		}
	}
	switch strings.ToLower(action) {
	case "acme", "letsencrypt", "lets-encrypt", "lets_encrypt":
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "ACME / Let's Encrypt is not available.")
		return "", nil, nil, false
	}
	switch action {
	case tlsActionCreateSelfSigned:
		if hasCert || hasKey {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "create-self-signed does not accept a certificate or key.")
			return "", nil, nil, false
		}
		return action, nil, nil, true
	case tlsActionSkip:
		if hasCert || hasKey {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "skip does not accept a certificate or key.")
			return "", nil, nil, false
		}
		return action, nil, nil, true
	case tlsActionUpload:
		if strings.TrimSpace(certStr) == "" || strings.TrimSpace(keyStr) == "" {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "upload requires certPem and keyPem.")
			return "", nil, nil, false
		}
		return action, []byte(certStr), []byte(keyStr), true
	default:
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", tlsActionMustBeAccepted)
		return "", nil, nil, false
	}
}

func tlsBodyForbidden(key string) bool {
	switch key {
	case "password", "passwd", "dsn", "database_url", "databaseurl",
		"kek", "secret", "secrets", "private_key", "privatekey",
		"token", "hash", "ciphertext":
		return true
	default:
		return false
	}
}

func writeTLSMaterialError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, tlsmaterial.ErrInvalid) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "The certificate and key are not valid.")
		return
	}
	core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "TLS certificate files are not available.")
}

func writeBootstrapError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, bootstrap.ErrUnavailable) {
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Bootstrap state is not available.")
		return
	}
	if errors.Is(err, bootstrap.ErrInvalid) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "The bootstrap request is not valid.")
		return
	}
	core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Bootstrap state is not available.")
}
