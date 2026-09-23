package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/machine"
)

const (
	machineRateIP     = 60
	machineRateClient = 30
)

func (s *Server) postMachineToken(w http.ResponseWriter, r *http.Request) {
	if !s.requireStore(w, r) || !s.requireSessions(w, r) || !s.requireMachineStore(w, r) {
		return
	}
	clientID, secret, assertion, ok := decodeMachineToken(w, r)
	if !ok {
		return
	}
	if !s.allowMachineIP(r) {
		s.auditLoginRejected(r, "rate-limited")
		s.writeMachineRateLimited(w, r)
		return
	}
	clientID, err := machine.NormalizeClientID(clientID)
	if err != nil {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "client_id is required.")
		return
	}
	if !s.allowMachineClient(clientID) {
		s.auditLoginRejected(r, "rate-limited")
		s.writeMachineRateLimited(w, r)
		return
	}
	principal, err := s.machines.GetByClientID(r.Context(), clientID)
	if err != nil {
		if !errors.Is(err, machine.ErrNotFound) {
			s.logMachine("machine_lookup", r, err)
			WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Machine principal store is not available.")
			return
		}
		machine.DummyVerify(secret)
		s.auditLoginRejected(r, "invalid machine credentials")
		WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", invalidCredentialsDetail)
		return
	}
	now := s.clockNow()
	err = machine.Authenticate(principal, secret, assertion, now, func(jti string, until time.Time) error {
		return s.machines.ConsumeJTI(r.Context(), jti, principal.ClientID, until, now)
	})
	if err != nil {
		if errors.Is(err, machine.ErrInvalid) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "client_id and one credential are required.")
			return
		}
		s.auditLoginRejected(r, "invalid machine credentials")
		WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", invalidCredentialsDetail)
		return
	}
	user, err := s.store.GetUser(r.Context(), principal.UserID)
	if err != nil {
		s.logMachine("machine_user", r, err)
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Identity store is not available.")
		return
	}
	if user.Status != "active" || user.Issuer != machine.Issuer {
		s.auditLoginRejected(r, "invalid machine credentials")
		WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", invalidCredentialsDetail)
		return
	}
	s.mintStandaloneSession(w, r, user, "machine-principal")
}

func (s *Server) postMachinePrincipal(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireMachineAdmin(w, r); !ok {
		return
	}
	in, ok := decodeMachineCreate(w, r)
	if !ok {
		return
	}
	display, err := machine.NormalizeDisplayName(in.displayName)
	if err != nil {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "display_name is required.")
		return
	}
	clientID := strings.TrimSpace(in.clientID)
	if clientID == "" {
		clientID, err = machine.NewClientID()
		if err != nil {
			WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Machine principal store is not available.")
			return
		}
	}
	clientID, err = machine.NormalizeClientID(clientID)
	if err != nil {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "client_id is invalid.")
		return
	}
	hash, pub, ok := s.machineFactors(w, r, in.secret, in.publicKey, true)
	if !ok {
		return
	}
	tenantID, workspaceID, workbench, err := s.resolveMachineWorkspace(r, in.tenantID, in.tenantSlug, in.workbench)
	if err != nil {
		if errors.Is(err, machine.ErrInvalid) || errors.Is(err, machine.ErrWorkspace) {
			writeMachineError(w, r, err)
			return
		}
		writeIdentityError(w, r, err)
		return
	}
	user, err := s.store.UpsertUser(r.Context(), machine.Issuer, clientID, display)
	if err != nil {
		writeIdentityError(w, r, err)
		return
	}
	if user.Status != "active" {
		WriteForbidden(w, r)
		return
	}
	created, err := s.machines.Create(r.Context(), machine.Input{
		UserID:       user.ID,
		ClientID:     clientID,
		DisplayName:  display,
		SecretHash:   hash,
		PublicKey:    pub,
		Grants:       in.grants,
		TenantID:     tenantID,
		WorkspaceID:  workspaceID,
		WorkbenchKey: workbench,
		Now:          s.clockNow(),
	})
	if err != nil {
		writeMachineError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, created.View())
}

func (s *Server) listMachinePrincipals(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireMachineAdmin(w, r); !ok {
		return
	}
	q, ok := parsePage(w, r)
	if !ok {
		return
	}
	items, next, err := s.machines.ListPage(r.Context(), q)
	if rejectPageErr(w, r, err) {
		return
	}
	if err != nil {
		writeMachineError(w, r, err)
		return
	}
	views := make([]machine.View, 0, len(items))
	for _, item := range items {
		views = append(views, item.View())
	}
	writePage(w, views, q, next)
}

func (s *Server) getMachinePrincipal(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireMachineAdmin(w, r); !ok {
		return
	}
	item, err := s.machines.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		writeMachineError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, item.View())
}

func (s *Server) rotateMachinePrincipal(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireMachineAdmin(w, r); !ok {
		return
	}
	secret, pubRaw, ok := decodeMachineRotate(w, r)
	if !ok {
		return
	}
	hash, pub, ok := s.machineFactors(w, r, secret, pubRaw, false)
	if !ok {
		return
	}
	item, err := s.machines.Rotate(r.Context(), r.PathValue("id"), machine.Rotation{
		SecretHash: hash,
		PublicKey:  pub,
		Now:        s.clockNow(),
	})
	if err != nil {
		writeMachineError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, item.View())
}

func (s *Server) revokeMachinePrincipal(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireMachineAdmin(w, r); !ok {
		return
	}
	if !emptyOrObject(w, r) {
		return
	}
	item, err := s.machines.Revoke(r.Context(), r.PathValue("id"), s.clockNow())
	if err != nil {
		writeMachineError(w, r, err)
		return
	}
	if err := s.store.SetUserStatus(r.Context(), item.UserID, "disabled"); err != nil {
		s.logMachine("machine_disable_user", r, err)
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Identity store is not available.")
		return
	}
	if s.sessions != nil {
		if err := s.sessions.RevokeByUser(r.Context(), item.UserID, s.clockNow()); err != nil {
			s.logMachine("machine_revoke_sessions", r, err)
			WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Session store is not available.")
			return
		}
	}
	fresh, err := s.machines.Get(r.Context(), item.ID)
	if err != nil {
		writeMachineError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, fresh.View())
}

func (s *Server) requireMachineStore(w http.ResponseWriter, r *http.Request) bool {
	if s.machines != nil {
		return true
	}
	WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Machine principal store is not available.")
	return false
}

func (s *Server) requireMachineAdmin(w http.ResponseWriter, r *http.Request) (identity.User, bool) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return identity.User{}, false
	}
	if !s.requirePlatformAdmin(w, r, user) {
		return identity.User{}, false
	}
	if !s.requireMachineStore(w, r) {
		return identity.User{}, false
	}
	return user, true
}

func (s *Server) machineFactors(w http.ResponseWriter, r *http.Request, secret, pubRaw string, needOne bool) (string, []byte, bool) {
	var hash string
	var pub []byte
	if secret != "" {
		hashed, err := machine.HashSecret(secret)
		if err != nil {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "secret does not meet the required length.")
			return "", nil, false
		}
		hash = hashed
	}
	if pubRaw != "" {
		parsed, err := machine.ParsePublicKey(pubRaw)
		if err != nil {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "assertion_public_key must be a raw Ed25519 public key.")
			return "", nil, false
		}
		pub = parsed
	}
	if needOne && hash == "" && len(pub) == 0 {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "secret or assertion_public_key is required.")
		return "", nil, false
	}
	if !needOne && hash == "" && len(pub) == 0 {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "secret or assertion_public_key is required.")
		return "", nil, false
	}
	return hash, pub, true
}

func (s *Server) resolveMachineWorkspace(r *http.Request, tenantID, tenantSlug, workbench string) (string, string, string, error) {
	tenantID = strings.TrimSpace(tenantID)
	tenantSlug = strings.TrimSpace(tenantSlug)
	workbench = strings.TrimSpace(workbench)
	if tenantID == "" && tenantSlug == "" && workbench == "" {
		return "", "", "", nil
	}
	if (tenantID == "" && tenantSlug == "") || workbench == "" {
		return "", "", "", machine.ErrInvalid
	}
	ws, tenant, err := s.store.ResolveWorkspace(r.Context(), tenantID, tenantSlug, workbench)
	if err != nil {
		return "", "", "", err
	}
	if ws.Status != "active" || tenant.Status != "active" {
		return "", "", "", machine.ErrWorkspace
	}
	return tenant.ID, ws.ID, ws.WorkbenchKey, nil
}

func (s *Server) allowMachineIP(r *http.Request) bool {
	if s.machineLimiter == nil {
		return false
	}
	return s.machineLimiter.Allow("machine-ip:"+s.requestClientIP(r), machineRateIP, s.clockNow())
}

func (s *Server) allowMachineClient(clientID string) bool {
	if s.machineLimiter == nil {
		return false
	}
	return s.machineLimiter.Allow("machine-client:"+clientID, machineRateClient, s.clockNow())
}

func (s *Server) writeMachineRateLimited(w http.ResponseWriter, r *http.Request) {
	retry := time.Minute
	if s.machineLimiter != nil {
		retry = s.machineLimiter.RetryAfter(s.clockNow())
	}
	writeRateLimited(w, r, retry, "Machine token rate limit exceeded. Retry after the configured window.")
}

func (s *Server) logMachine(msg string, r *http.Request, err error) {
	if s.log == nil || err == nil {
		return
	}
	s.log.Error(msg, "request_id", RequestIDFromContext(r.Context()), "error", err.Error())
}

func (s *Server) machineAllows(r *http.Request, user identity.User, action string) bool {
	if user.Issuer != machine.Issuer || s.machines == nil || action == "" {
		return false
	}
	p, err := s.machines.GetByUserID(r.Context(), user.ID)
	if err != nil || p.Status != machine.StatusActive {
		return false
	}
	return authz.Allows(p.Grants, action)
}

func (s *Server) unionMachinePerms(r *http.Request, user identity.User, ws identity.Workspace, perms []string) ([]string, error) {
	if user.Issuer != machine.Issuer || s.machines == nil {
		return perms, nil
	}
	p, err := s.machines.GetByUserID(r.Context(), user.ID)
	if errors.Is(err, machine.ErrNotFound) {
		return perms, nil
	}
	if err != nil {
		return nil, err
	}
	if p.Status != machine.StatusActive {
		return nil, machine.ErrRevoked
	}
	if p.WorkspaceID == "" {
		return perms, nil
	}
	if !strings.EqualFold(p.WorkspaceID, ws.ID) {
		return nil, machine.ErrWorkspace
	}
	return machine.UnionWorkspace(perms, p.Grants), nil
}

type machineCreateBody struct {
	displayName string
	clientID    string
	secret      string
	publicKey   string
	grants      []string
	tenantID    string
	tenantSlug  string
	workbench   string
}

func decodeMachineToken(w http.ResponseWriter, r *http.Request) (clientID, secret, assertion string, ok bool) {
	raw, ok := decodeObject(w, r)
	if !ok {
		return "", "", "", false
	}
	var hasSecret, hasAssertion bool
	for key, value := range raw {
		norm := strings.ToLower(strings.ReplaceAll(key, "-", "_"))
		switch norm {
		case "client_id":
			clientID, _ = value.(string)
		case "secret":
			secret, _ = value.(string)
			hasSecret = true
		case "assertion":
			assertion, _ = value.(string)
			hasAssertion = true
		default:
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Machine token accepts client_id and secret or assertion.")
			return "", "", "", false
		}
	}
	if strings.TrimSpace(clientID) == "" || hasSecret == hasAssertion {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "client_id and one credential are required.")
		return "", "", "", false
	}
	if hasSecret && secret == "" || hasAssertion && strings.TrimSpace(assertion) == "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "client_id and one credential are required.")
		return "", "", "", false
	}
	return clientID, secret, strings.TrimSpace(assertion), true
}

func decodeMachineCreate(w http.ResponseWriter, r *http.Request) (machineCreateBody, bool) {
	raw, ok := decodeObject(w, r)
	if !ok {
		return machineCreateBody{}, false
	}
	var body machineCreateBody
	for key, value := range raw {
		norm := strings.ToLower(strings.ReplaceAll(key, "-", "_"))
		if machineBodyForbidden(norm) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Machine principal create does not accept secret material fields other than secret or assertion_public_key.")
			return machineCreateBody{}, false
		}
		switch norm {
		case "display_name":
			body.displayName, _ = value.(string)
		case "client_id":
			body.clientID, _ = value.(string)
		case "secret":
			body.secret, _ = value.(string)
		case "assertion_public_key":
			body.publicKey, _ = value.(string)
		case "grants":
			grants, grantOK := stringList(value)
			if !grantOK {
				WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "grants must be an array of permission keys.")
				return machineCreateBody{}, false
			}
			body.grants = grants
		case "tenant_id":
			body.tenantID, _ = value.(string)
		case "tenant_slug":
			body.tenantSlug, _ = value.(string)
		case "workbench_key":
			body.workbench, _ = value.(string)
		default:
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Unknown machine principal field.")
			return machineCreateBody{}, false
		}
	}
	return body, true
}

func decodeMachineRotate(w http.ResponseWriter, r *http.Request) (secret, publicKey string, ok bool) {
	raw, ok := decodeObject(w, r)
	if !ok {
		return "", "", false
	}
	for key, value := range raw {
		norm := strings.ToLower(strings.ReplaceAll(key, "-", "_"))
		if machineBodyForbidden(norm) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Rotate accepts secret or assertion_public_key.")
			return "", "", false
		}
		switch norm {
		case "secret":
			secret, _ = value.(string)
		case "assertion_public_key":
			publicKey, _ = value.(string)
		default:
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Rotate accepts secret or assertion_public_key.")
			return "", "", false
		}
	}
	return secret, publicKey, true
}

func machineBodyForbidden(key string) bool {
	switch key {
	case "password", "passwd", "hash", "secret_hash", "password_hash", "kek",
		"private_key", "privatekey", "token", "assertion", "ciphertext":
		return true
	default:
		return false
	}
}

func decodeObject(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	var raw map[string]any
	if !DecodeJSON(w, r, &raw) {
		return nil, false
	}
	if raw == nil {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Request body is required.")
		return nil, false
	}
	return raw, true
}

func emptyOrObject(w http.ResponseWriter, r *http.Request) bool {
	if r.ContentLength == 0 && r.Header.Get("Content-Type") == "" {
		return true
	}
	raw, ok := decodeObject(w, r)
	if !ok {
		return false
	}
	if len(raw) > 0 {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Revoke does not accept a body.")
		return false
	}
	return true
}

func stringList(value any) ([]string, bool) {
	items, ok := value.([]any)
	if !ok {
		return nil, false
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		s, ok := item.(string)
		if !ok {
			return nil, false
		}
		out = append(out, s)
	}
	return out, true
}

func writeMachineError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, machine.ErrInvalid):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Machine principal request is invalid.")
	case errors.Is(err, machine.ErrBinding):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Workspace-scoped grants require a workspace binding.")
	case errors.Is(err, machine.ErrConflict):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "That machine principal already exists.")
	case errors.Is(err, machine.ErrNotFound), errors.Is(err, identity.ErrNotFound):
		WriteProblem(w, r, http.StatusNotFound, CodeNotFound, "Not Found", "Machine principal not found.")
	case errors.Is(err, machine.ErrRevoked):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Machine principal is revoked.")
	case errors.Is(err, machine.ErrWorkspace), errors.Is(err, identity.ErrDisabled):
		WriteForbidden(w, r)
	default:
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Machine principal store is not available.")
	}
}
