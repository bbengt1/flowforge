package httpnotify

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// Request is one http.request or notification.webhook execution.
type Request struct {
	Operation        string
	ConnectionID     string
	WorkspaceID      string
	Method           string
	Path             string
	Host             string
	TimeoutSeconds   int
	Payload          map[string]any
	Permissions      []string
	Policy           PolicyContext
	Connection       ConnectionContext
	ResponseSchema   map[string]any
	ResponseMaxBytes int
	SchemaPublished  bool
	IdempotencyKey   string
	Handle           *Handle
	Resolver         Resolver
	Transport        RoundTripper
	CorrelationID    string
	ActorID          string
	LeaseLost        bool
	UnknownOutcome   bool
}

// Handle is a scoped worker credential. Authorization never appears on results.
type Handle struct {
	Authorization string
}

// RoundTripper is the HTTP primitive. Tests inject a fake.
type RoundTripper interface {
	RoundTrip(*http.Request) (*http.Response, error)
}

// Result is the redacted engine outcome persisted on the job.
type Result struct {
	OK                bool           `json:"ok"`
	Operation         string         `json:"operation"`
	ConnectionID      string         `json:"connectionId,omitempty"`
	ConnectionType    string         `json:"connectionType,omitempty"`
	Method            string         `json:"method,omitempty"`
	Host              string         `json:"host,omitempty"`
	Path              string         `json:"path,omitempty"`
	StatusCode        int            `json:"statusCode,omitempty"`
	ResolvedAddresses []string       `json:"resolvedAddresses,omitempty"`
	ConnectedAddress  string         `json:"connectedAddress,omitempty"`
	Redirects         int            `json:"redirects,omitempty"`
	Truncated         bool           `json:"truncated,omitempty"`
	Body              map[string]any `json:"body,omitempty"`
	PolicyRevision    string         `json:"policyRevision,omitempty"`
	PolicyDigest      string         `json:"policyDigest,omitempty"`
	CorrelationID     string         `json:"correlationId,omitempty"`
	Audit             map[string]any `json:"audit,omitempty"`
	Error             *EngineError   `json:"error,omitempty"`
}

// Execute authorizes, revalidates policy, normalizes the endpoint, allowlists
// every resolved address (including redirects), then delivers a bounded request.
func Execute(ctx context.Context, req Request) Result {
	out := Result{
		Operation:      normalizeOp(req.Operation),
		ConnectionID:   strings.TrimSpace(req.ConnectionID),
		ConnectionType: req.Connection.Type,
		Method:         strings.ToUpper(strings.TrimSpace(req.Method)),
		Path:           strings.TrimSpace(req.Path),
		PolicyRevision: req.Policy.Revision,
		PolicyDigest:   req.Policy.Digest,
		CorrelationID:  strings.TrimSpace(req.CorrelationID),
	}
	if out.Method == "" {
		if out.Operation == NodeWebhook {
			out.Method = http.MethodPost
		} else {
			out.Method = http.MethodGet
		}
	}
	if req.LeaseLost || req.UnknownOutcome {
		out.Error = engineError(CodeIndeterminate, "Lease lost after dispatch; outcome is indeterminate.", http.StatusConflict)
		return finishHTTP(req, out)
	}
	if err := authorizeHTTP(req, out.Operation); err != nil {
		out.Error = err
		return finishHTTP(req, out)
	}
	if err := gatePins(req, out.Operation); err != nil {
		out.Error = err
		return finishHTTP(req, out)
	}
	if err := RejectUnauthorizedSecrets(req.Payload, req.Connection.Policy); err != nil {
		out.Error = err
		return finishHTTP(req, out)
	}

	host, herr := SelectHost(req.Connection.Policy, req.Host)
	if herr != nil {
		out.Error = herr
		return finishHTTP(req, out)
	}
	out.Host = host
	port := SelectPort(req.Connection.Policy, 0)
	path := out.Path
	if path == "" {
		path = "/"
		out.Path = path
	}
	ep, nerr := NormalizeEndpoint(host, path, port, req.Connection.Policy.TLSRequired)
	if nerr != nil {
		out.Error = nerr
		return finishHTTP(req, out)
	}
	out.Path = ep.Path
	if err := EnforceMethodPathTLS(out.Method, ep.Path, ep, req.Connection.Policy); err != nil {
		out.Error = err
		return finishHTTP(req, out)
	}

	timeout := req.TimeoutSeconds
	if timeout <= 0 {
		timeout = DefaultTimeoutSeconds
	}
	if timeout > MaxTimeoutSeconds {
		timeout = MaxTimeoutSeconds
	}
	if ctx == nil {
		ctx = context.Background()
	}
	var cancel context.CancelFunc
	ctx, cancel = context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()

	allowPrivate := privateDestinationsAllowed(req)
	resolved, resErr := ResolveHostname(ctx, req.Resolver, ep.Host, allowPrivate)
	if resErr != nil {
		out.Error = resErr
		return finishHTTP(req, out)
	}
	if err := VerifyResolvedAddresses(ep.Host, resolved.Addresses, req.Connection.Policy.AllowedAddresses, req.Connection.Policy.AddressesPresent, allowPrivate); err != nil {
		out.Error = err
		return finishHTTP(req, out)
	}
	out.ResolvedAddresses = addressStrings(resolved.Addresses)
	if err := ValidatePolicy(req.Policy, out.Operation, ep.Host, out.ResolvedAddresses); err != nil {
		out.Error = err
		return finishHTTP(req, out)
	}

	body, berr := encodePayload(req.Payload, out.Method, req.Connection.Policy.MaxRequestBytes)
	if berr != nil {
		out.Error = berr
		return finishHTTP(req, out)
	}

	httpReq, err := http.NewRequestWithContext(ctx, out.Method, ep.URL.String(), bytes.NewReader(body))
	if err != nil {
		out.Error = engineError(CodeInvalidEndpoint, "request could not be constructed", http.StatusBadRequest)
		return finishHTTP(req, out)
	}
	httpReq.Host = ep.Host
	if len(body) > 0 {
		httpReq.Header.Set("Content-Type", "application/json")
	}
	if out.Operation == NodeWebhook {
		key := strings.TrimSpace(req.IdempotencyKey)
		if key == "" {
			key = strings.TrimSpace(req.CorrelationID)
		}
		if key != "" {
			httpReq.Header.Set(IdempotencyHeader, key)
		}
	}
	if req.Handle != nil && strings.TrimSpace(req.Handle.Authorization) != "" {
		httpReq.Header.Set("Authorization", req.Handle.Authorization)
	}

	rt := req.Transport
	if rt == nil {
		rt = newPinnedTransport(ctx, req.Resolver, req.Connection.Policy, resolved.DialIP, ep)
	}
	client := &http.Client{
		Transport: rt,
		Timeout:   time.Duration(timeout) * time.Second,
		CheckRedirect: func(r *http.Request, via []*http.Request) error {
			return validateRedirect(ctx, req, r, via)
		},
	}
	resp, doErr := client.Do(httpReq)
	if doErr != nil {
		out.Error = mapDoError(doErr)
		return finishHTTP(req, out)
	}
	defer resp.Body.Close()
	out.StatusCode = resp.StatusCode
	out.Redirects = redirectCount(resp)
	out.ConnectedAddress = DialNetworkAddress(resolved.DialIP, ep.Port)

	maxResp := req.Connection.Policy.MaxResponseBytes
	if req.ResponseMaxBytes > 0 && req.ResponseMaxBytes < maxResp {
		maxResp = req.ResponseMaxBytes
	}
	limited := io.LimitReader(resp.Body, int64(maxResp)+1)
	raw, readErr := io.ReadAll(limited)
	if readErr != nil {
		out.Error = asEngineError(readErr, CodeDeliveryFailed)
		return finishHTTP(req, out)
	}
	if len(raw) > maxResp {
		out.Truncated = true
		out.Error = engineError(CodeOversize, "response exceeded the configured size limit", http.StatusRequestEntityTooLarge)
		return finishHTTP(req, out)
	}
	if decoded, ok := decodeJSONObject(raw); ok {
		out.Body = RedactValue(decoded).(map[string]any)
		if len(req.ResponseSchema) > 0 && !schemaAllows(req.ResponseSchema, decoded) {
			out.Error = engineError(CodeSchemaRejected, "response did not match the pinned response schema", http.StatusBadRequest)
			return finishHTTP(req, out)
		}
	} else if len(raw) > 0 {
		out.Body = map[string]any{"bytes": len(raw)}
	}
	if resp.StatusCode >= 400 {
		out.Error = engineError(CodeDeliveryFailed, "remote endpoint returned an error status", http.StatusBadGateway)
		return finishHTTP(req, out)
	}
	out.OK = true
	return finishHTTP(req, out)
}

func privateDestinationsAllowed(req Request) bool {
	if req.Connection.Policy.AllowPrivateDestinations {
		return true
	}
	switch req.Policy.Kind {
	case "http", "notification":
		return req.Policy.AllowPrivateDestinations
	default:
		return false
	}
}

func authorizeHTTP(req Request, op string) *EngineError {
	needed := RequiredPermissions(op)
	if op == NodeHTTPRequest && len(req.ResponseSchema) == 0 {
		filtered := needed[:0]
		for _, perm := range needed {
			if perm == authz.PermResponseSchemaUse {
				continue
			}
			filtered = append(filtered, perm)
		}
		needed = filtered
	}
	for _, perm := range needed {
		if !authz.Allows(req.Permissions, perm) {
			return engineError(CodePermissionDenied, "missing required permission", http.StatusForbidden)
		}
	}
	return nil
}

func gatePins(req Request, op string) *EngineError {
	if req.WorkspaceID != "" && req.Connection.WorkspaceID != "" && req.WorkspaceID != req.Connection.WorkspaceID {
		return engineError(CodeTenancyDenied, "connection belongs to another workspace", http.StatusForbidden)
	}
	if !req.Connection.Published {
		return engineError(CodeUnpublishedPin, "only published connection revisions can be used", http.StatusBadRequest)
	}
	want := ExpectedConnectionType(op)
	if want != "" && req.Connection.Type != want {
		return engineError(CodeWrongConnectionType, "pinned connection type does not match the node", http.StatusBadRequest)
	}
	if len(req.ResponseSchema) > 0 && !req.SchemaPublished {
		return engineError(CodeUnpublishedPin, "only published response-schema revisions can be used", http.StatusBadRequest)
	}
	return nil
}

func encodePayload(payload map[string]any, method string, max int) ([]byte, *EngineError) {
	if payload == nil || method == http.MethodGet || method == http.MethodHead {
		return nil, nil
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, engineError(CodeInvalidEndpoint, "payload is not JSON", http.StatusBadRequest)
	}
	if max <= 0 {
		max = DefaultMaxRequestBytes
	}
	if len(raw) > max {
		return nil, engineError(CodeOversize, "request exceeded the configured size limit", http.StatusRequestEntityTooLarge)
	}
	return raw, nil
}

func validateRedirect(ctx context.Context, req Request, next *http.Request, via []*http.Request) error {
	policy := req.Connection.Policy
	if !policy.AllowRedirects || policy.MaxRedirects <= 0 {
		return engineError(CodeRedirectDenied, "redirects are denied by the connection endpoint policy", http.StatusForbidden)
	}
	if len(via) >= policy.MaxRedirects {
		return engineError(CodeRedirectDenied, "redirect hop limit exceeded", http.StatusForbidden)
	}
	if next == nil || next.URL == nil {
		return engineError(CodeRedirectDenied, "redirect location is missing", http.StatusForbidden)
	}
	if next.URL.User != nil {
		return engineError(CodeRedirectDenied, "redirect userinfo is denied", http.StatusForbidden)
	}
	host := next.URL.Hostname()
	port := 0
	if p := next.URL.Port(); p != "" {
		port, _ = atoi(p)
	}
	tlsRequired := policy.TLSRequired || next.URL.Scheme == "https"
	if policy.TLSRequired && next.URL.Scheme != "https" {
		return engineError(CodeTLSRequired, "redirect is not HTTPS", http.StatusForbidden)
	}
	ep, err := NormalizeEndpoint(host, next.URL.EscapedPath(), port, tlsRequired)
	if err != nil {
		return err
	}
	if e := EnforceMethodPathTLS(next.Method, ep.Path, ep, policy); e != nil {
		e.Code = CodeRedirectDenied
		return e
	}
	allowPrivate := privateDestinationsAllowed(req)
	resolved, rerr := ResolveHostname(ctx, req.Resolver, ep.Host, allowPrivate)
	if rerr != nil {
		return rerr
	}
	if e := VerifyResolvedAddresses(ep.Host, resolved.Addresses, policy.AllowedAddresses, policy.AddressesPresent, allowPrivate); e != nil {
		return e
	}
	if e := ValidatePolicy(req.Policy, normalizeOp(req.Operation), ep.Host, addressStrings(resolved.Addresses)); e != nil {
		return e
	}
	return nil
}

func mapDoError(err error) *EngineError {
	if err == nil {
		return nil
	}
	var ee *EngineError
	if errorsAsEngine(err, &ee) {
		return ee
	}
	if inner, ok := err.(*url.Error); ok && inner.Err != nil {
		if errorsAsEngine(inner.Err, &ee) {
			return ee
		}
	}
	return asEngineError(err, CodeDeliveryFailed)
}

func errorsAsEngine(err error, dest **EngineError) bool {
	if err == nil {
		return false
	}
	if ee, ok := err.(*EngineError); ok {
		*dest = ee
		return true
	}
	return false
}

func redirectCount(resp *http.Response) int {
	n := 0
	for resp != nil && resp.Request != nil && resp.Request.Response != nil {
		n++
		resp = resp.Request.Response
	}
	return n
}

func finishHTTP(req Request, out Result) Result {
	out.Body, _ = RedactValue(out.Body).(map[string]any)
	out.Audit = redactAudit(map[string]any{
		"operation":         out.Operation,
		"connectionId":      out.ConnectionID,
		"connectionType":    out.ConnectionType,
		"method":            out.Method,
		"host":              out.Host,
		"path":              out.Path,
		"statusCode":        out.StatusCode,
		"resolvedAddresses": out.ResolvedAddresses,
		"connectedAddress":  out.ConnectedAddress,
		"redirects":         out.Redirects,
		"truncated":         out.Truncated,
		"correlationId":     out.CorrelationID,
		"outcome":           outcomeOf(out.OK, out.Error),
	})
	if out.Error != nil {
		out.OK = false
	}
	_ = req
	return out
}

func outcomeOf(ok bool, err *EngineError) string {
	if err != nil {
		if err.Code == CodeIndeterminate {
			return "indeterminate"
		}
		return "denied"
	}
	if ok {
		return "success"
	}
	return "failed"
}

func redactAudit(in map[string]any) map[string]any {
	out, _ := RedactValue(in).(map[string]any)
	return out
}

func normalizeOp(op string) string {
	op = strings.TrimSpace(op)
	switch op {
	case NodeHTTPRequest, NodeWebhook, NodeEmail:
		return op
	default:
		if op == "" {
			return NodeHTTPRequest
		}
		return op
	}
}

func schemaAllows(schema map[string]any, value map[string]any) bool {
	if schema == nil {
		return true
	}
	typ, _ := schema["type"].(string)
	if typ != "" && typ != "object" {
		return false
	}
	if raw, ok := schema["required"].([]any); ok {
		for _, item := range raw {
			name, _ := item.(string)
			if name != "" {
				if _, exists := value[name]; !exists {
					return false
				}
			}
		}
	}
	return true
}

func atoi(s string) (int, error) {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, ErrInvalid
		}
		n = n*10 + int(r-'0')
	}
	return n, nil
}

type pinnedTransport struct {
	base   *http.Transport
	dialIP net.IP
	port   int
}

func newPinnedTransport(_ context.Context, _ Resolver, _ EndpointPolicy, dialIP net.IP, ep NormalizedEndpoint) *http.Transport {
	_ = dialIP
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	return &http.Transport{
		DisableKeepAlives: true,
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
			ServerName: ep.Host,
		},
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			if dialIP == nil {
				return nil, engineError(CodeAddressDenied, "no verified destination address", http.StatusForbidden)
			}
			return dialer.DialContext(ctx, "tcp", DialNetworkAddress(dialIP, ep.Port))
		},
	}
}

func (t *pinnedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if t == nil || t.base == nil {
		return nil, engineError(CodeDeliveryFailed, "transport is not configured", http.StatusBadGateway)
	}
	_ = t.port
	return t.base.RoundTrip(req)
}
