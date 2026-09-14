package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/bootstrap"
	"github.com/bbengt1/flowforge/apps/api/internal/localseed"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/tlsmaterial"
)

func (s *Server) requireBootstrap(w http.ResponseWriter, r *http.Request) bool {
	if s.bootstrap != nil {
		return true
	}
	WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Bootstrap store is not available.")
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
func (s *Server) getBootstrap(w http.ResponseWriter, r *http.Request) {
	if !s.requireBootstrap(w, r) {
		return
	}
	st, err := s.bootstrap.Get(r.Context())
	if err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	if st.Complete {
		if _, ok := s.requirePrincipal(w, r); !ok {
			return
		}
	}
	writeJSON(w, http.StatusOK, st.Status())
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
func (s *Server) postBootstrapPersistence(w http.ResponseWriter, r *http.Request) {
	if !s.requireBootstrap(w, r) {
		return
	}
	st, err := s.bootstrap.Get(r.Context())
	if err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	if st.Complete {
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Bootstrap is already complete. Persistence is edited in Settings.")
		return
	}
	if !s.allowIncompleteWizard(w, r) {
		return
	}
	if !s.requirePersistenceReady(w, r) {
		return
	}
	if !decodePersistenceConfirm(w, r) {
		return
	}
	if err := s.bootstrap.SetStep(r.Context(), bootstrap.StepPersistence, true); err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	st, err = s.bootstrap.Get(r.Context())
	if err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	if !st.PersistenceReady || st.Complete {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Persistence is not ready.")
		return
	}
	writeJSON(w, http.StatusOK, st.Status())
}

// postBootstrapAdmins is wizard step 2 (B.3). It upserts the first
// admin identity (localseed PLATFORM_ADMINS / workspace-admin pattern),
// then sets steps.firstAdmin.ready via Store.SetStep. It never marks
// bootstrap complete, never returns a password / hash / KEK, and never
// stores a password (local login has not landed).
//
// Auth matches incomplete-install GET /bootstrap and B.2: no session is
// required while the gate is incomplete. After complete, this wizard
// handler rejects with 409 (Settings-only). Embed sessions are 403.
// CSRF is required when an ff_session cookie is presented.
func (s *Server) postBootstrapAdmins(w http.ResponseWriter, r *http.Request) {
	if !s.requireBootstrap(w, r) {
		return
	}
	st, err := s.bootstrap.Get(r.Context())
	if err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	if st.Complete {
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Bootstrap is already complete. Users are edited in Settings.")
		return
	}
	if !s.allowIncompleteWizard(w, r) {
		return
	}
	if !st.PersistenceReady {
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Persistence must be ready before creating the first admin.")
		return
	}
	if !s.requireStore(w, r) {
		return
	}
	issuer, subject, display, ok := decodeFirstAdmin(w, r)
	if !ok {
		return
	}
	if _, err := localseed.ProvisionAdmin(r.Context(), s.store, issuer, subject, display); err != nil {
		writeIdentityError(w, r, err)
		return
	}
	if err := s.bootstrap.SetStep(r.Context(), bootstrap.StepFirstAdmin, true); err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	st, err = s.bootstrap.Get(r.Context())
	if err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	if !st.FirstAdminReady || st.Complete {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "First admin is not ready.")
		return
	}
	writeJSON(w, http.StatusCreated, st.Status())
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
func (s *Server) postBootstrapPublicURL(w http.ResponseWriter, r *http.Request) {
	if !s.requireBootstrap(w, r) {
		return
	}
	st, err := s.bootstrap.Get(r.Context())
	if err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	if st.Complete {
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Bootstrap is already complete. The public URL is edited in Settings.")
		return
	}
	if !s.allowIncompleteWizard(w, r) {
		return
	}
	if !st.FirstAdminReady {
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "First admin must be ready before setting the public URL.")
		return
	}
	publicBaseURL, ok := decodePublicBaseURL(w, r)
	if !ok {
		return
	}
	if err := s.bootstrap.SetPublicURL(r.Context(), publicBaseURL); err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	st, err = s.bootstrap.Get(r.Context())
	if err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	if !st.PublicURLReady || st.Complete {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Public URL is not ready.")
		return
	}
	writeJSON(w, http.StatusOK, st.Status())
}

// postBootstrapTLS is wizard step 4 (B.5). It enables TLS by creating
// a self-signed certificate or accepting a one-shot PEM upload, writes
// the pair to TLS_CERT_FILE / TLS_KEY_FILE, sets steps.tls via
// Store.SetTLS, then MarkComplete. It never returns the key, PEM, or
// KEK. ACME / Let’s Encrypt is out of scope.
//
// Auth matches incomplete-install GET /bootstrap and B.2–B.4: no
// session is required while the gate is incomplete. After complete,
// this wizard handler rejects with 409 (Settings-only). Embed
// sessions are 403. CSRF is required when an ff_session cookie is
// presented. Public URL must be ready first (fail-closed order).
func (s *Server) postBootstrapTLS(w http.ResponseWriter, r *http.Request) {
	if !s.requireBootstrap(w, r) {
		return
	}
	st, err := s.bootstrap.Get(r.Context())
	if err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	if st.Complete {
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Bootstrap is already complete. TLS is edited in Settings.")
		return
	}
	if !s.allowIncompleteWizard(w, r) {
		return
	}
	if !st.PublicURLReady {
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Public URL must be ready before enabling TLS.")
		return
	}
	action, certPEM, keyPEM, ok := decodeBootstrapTLS(w, r)
	if !ok {
		return
	}
	if s.tlsMaterials == nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "TLS certificate files are not configured.")
		return
	}
	mode := bootstrap.TLSModeSelfSigned
	switch action {
	case tlsActionCreateSelfSigned:
		hosts := tlsmaterial.HostsFromPublicBaseURL(st.PublicBaseURL)
		certPEM, keyPEM, err = tlsmaterial.CreateSelfSigned(hosts, s.clock().UTC())
		if err != nil {
			writeTLSMaterialError(w, r, err)
			return
		}
	case tlsActionUpload:
		mode = bootstrap.TLSModeUploaded
		if err := tlsmaterial.ValidatePair(certPEM, keyPEM); err != nil {
			writeTLSMaterialError(w, r, err)
			return
		}
	default:
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "action must be create-self-signed or upload.")
		return
	}
	if err := s.tlsMaterials.Write(certPEM, keyPEM); err != nil {
		writeTLSMaterialError(w, r, err)
		return
	}
	if err := s.bootstrap.SetTLS(r.Context(), true, mode); err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	if err := s.bootstrap.MarkComplete(r.Context()); err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	st, err = s.bootstrap.Get(r.Context())
	if err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	if !st.TLSReady || !st.Complete {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "TLS is not ready.")
		return
	}
	writeJSON(w, http.StatusOK, st.Status())
}

// allowIncompleteWizard reuses B.1 incomplete openness. A presented
// session cookie is validated (CSRF on POST). Embed-bound sessions are
// forbidden — the wizard is standalone only.
func (s *Server) allowIncompleteWizard(w http.ResponseWriter, r *http.Request) bool {
	if token := sessionCookieValue(r); token != "" {
		if _, ok := s.requireSessionPrincipal(w, r, token); !ok {
			return false
		}
		if embedSessionBound(r) {
			if pc := principalFromRequest(r); pc != nil && pc.session != nil {
				s.auditSession(r, *pc.session, session.EventPrivilegeDenied, session.OutcomeDenied, "embed session cannot use first-run wizard")
			}
			WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "The first-run wizard is standalone only.")
			return false
		}
	}
	return true
}

func (s *Server) requirePersistenceReady(w http.ResponseWriter, r *http.Request) bool {
	if s.db == nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "PostgreSQL is not reachable")
		return false
	}
	if err := s.db.Ping(r.Context()); err != nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "PostgreSQL is not reachable")
		return false
	}
	return true
}

func decodePersistenceConfirm(w http.ResponseWriter, r *http.Request) bool {
	var raw map[string]any
	if !DecodeJSON(w, r, &raw) {
		return false
	}
	for key := range raw {
		if persistenceBodyForbidden(key) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Persistence confirm accepts only confirm:true and never accepts credentials.")
			return false
		}
	}
	if len(raw) != 1 {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Persistence confirm accepts only confirm:true and never accepts credentials.")
		return false
	}
	confirm, ok := raw["confirm"].(bool)
	if !ok || !confirm {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "confirm must be true.")
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

func decodeFirstAdmin(w http.ResponseWriter, r *http.Request) (issuer, subject, display string, ok bool) {
	var raw map[string]any
	if !DecodeJSON(w, r, &raw) {
		return "", "", "", false
	}
	var password any
	hasPassword := false
	for key, value := range raw {
		norm := strings.ToLower(strings.ReplaceAll(key, "-", "_"))
		if firstAdminBodyForbidden(norm) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "First admin accepts issuer, external_subject, and optional display_name. Credentials are not accepted.")
			return "", "", "", false
		}
		switch norm {
		case "issuer":
			issuer, _ = value.(string)
		case "external_subject":
			subject, _ = value.(string)
		case "display_name":
			display, _ = value.(string)
		case "password":
			password = value
			hasPassword = true
		default:
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "First admin accepts issuer, external_subject, and optional display_name.")
			return "", "", "", false
		}
	}
	if hasPassword && password != nil {
		s, isStr := password.(string)
		if !isStr || strings.TrimSpace(s) != "" {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Local login is not available. Credentials are not stored.")
			return "", "", "", false
		}
	}
	issuer = strings.TrimSpace(issuer)
	subject = strings.TrimSpace(subject)
	display = strings.TrimSpace(display)
	if !authz.ValidIssuer(issuer) || !authz.ValidSubject(subject) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "issuer and external_subject are required.")
		return "", "", "", false
	}
	if len(display) > 200 {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "display_name is too long.")
		return "", "", "", false
	}
	return issuer, subject, display, true
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
	if !DecodeJSON(w, r, &raw) {
		return "", false
	}
	var publicBaseURL string
	found := false
	for key, value := range raw {
		norm := strings.ToLower(strings.ReplaceAll(key, "-", "_"))
		if publicURLBodyForbidden(norm) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Public URL accepts only publicBaseUrl. Credentials are not accepted.")
			return "", false
		}
		switch norm {
		case "publicbaseurl", "public_base_url":
			s, ok := value.(string)
			if !ok {
				WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "publicBaseUrl must be an http(s) origin.")
				return "", false
			}
			publicBaseURL = s
			found = true
		default:
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Public URL accepts only publicBaseUrl.")
			return "", false
		}
	}
	if !found {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "publicBaseUrl is required.")
		return "", false
	}
	normalized, err := bootstrap.NormalizePublicBaseURL(publicBaseURL)
	if err != nil || normalized == "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "publicBaseUrl must be an http(s) origin. HTTPS is preferred; HTTP is allowed for local installs.")
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
)

func decodeBootstrapTLS(w http.ResponseWriter, r *http.Request) (action string, certPEM, keyPEM []byte, ok bool) {
	var raw map[string]any
	if !DecodeJSON(w, r, &raw) {
		return "", nil, nil, false
	}
	var certStr, keyStr string
	hasCert, hasKey := false, false
	for key, value := range raw {
		norm := strings.ToLower(strings.ReplaceAll(key, "-", "_"))
		if tlsBodyForbidden(norm) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "TLS accepts action create-self-signed or upload. Credentials other than a one-shot certificate pair are not accepted.")
			return "", nil, nil, false
		}
		switch norm {
		case "action":
			s, isStr := value.(string)
			if !isStr {
				WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "action must be create-self-signed or upload.")
				return "", nil, nil, false
			}
			action = strings.TrimSpace(s)
		case "certpem", "cert_pem":
			s, isStr := value.(string)
			if !isStr {
				WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "certPem must be a certificate.")
				return "", nil, nil, false
			}
			certStr = s
			hasCert = true
		case "keypem", "key_pem":
			s, isStr := value.(string)
			if !isStr {
				WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "keyPem must be a private key.")
				return "", nil, nil, false
			}
			keyStr = s
			hasKey = true
		default:
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "TLS accepts action create-self-signed or upload.")
			return "", nil, nil, false
		}
	}
	switch strings.ToLower(action) {
	case "acme", "letsencrypt", "lets-encrypt", "lets_encrypt":
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "ACME / Let's Encrypt is not available.")
		return "", nil, nil, false
	}
	switch action {
	case tlsActionCreateSelfSigned:
		if hasCert || hasKey {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "create-self-signed does not accept a certificate or key.")
			return "", nil, nil, false
		}
		return action, nil, nil, true
	case tlsActionUpload:
		if strings.TrimSpace(certStr) == "" || strings.TrimSpace(keyStr) == "" {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "upload requires certPem and keyPem.")
			return "", nil, nil, false
		}
		return action, []byte(certStr), []byte(keyStr), true
	default:
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "action must be create-self-signed or upload.")
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
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "The certificate and key are not valid.")
		return
	}
	WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "TLS certificate files are not available.")
}

func writeBootstrapError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, bootstrap.ErrUnavailable) {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Bootstrap state is not available.")
		return
	}
	if errors.Is(err, bootstrap.ErrInvalid) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "The bootstrap request is not valid.")
		return
	}
	WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Bootstrap state is not available.")
}
