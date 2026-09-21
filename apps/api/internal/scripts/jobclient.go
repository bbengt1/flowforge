package scripts

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// APIJobConfig is an in-memory control-plane connection for script Jobs.
// Token and CA bytes must never be logged or copied onto the Job.
// TokenFile is re-read on each request so a projected ServiceAccount
// token can rotate without restarting the runner. Token is the fallback
// for tests.
type APIJobConfig struct {
	Host      string
	Token     string
	TokenFile string
	CAData    []byte
	Namespace string
	PollEvery time.Duration
	Timeout   time.Duration
	// ControlPlane is required unless SkipNetworkPolicy is set.
	// SkipNetworkPolicy is local/dev only. cmd/runner never sets it
	// while production-locked.
	ControlPlane      ControlPlaneConfig
	SkipNetworkPolicy bool
}

// APIJobClient submits batch/v1 Jobs and reads the runner container log.
type APIJobClient struct {
	host         string
	token        string
	tokenFile    string
	namespace    string
	pollEvery    time.Duration
	controlPlane ControlPlaneConfig
	skipPolicy   bool
	http         *http.Client
}

// NewAPIJobClient builds a TLS client. HTTP hosts are rejected. The token
// stays on the client and is compared against the Job body before create
// so a rendered manifest cannot carry it.
func NewAPIJobClient(cfg APIJobConfig) (*APIJobClient, error) {
	return newAPIJobClient(cfg, false)
}

// newAPIJobClient is NewAPIJobClient with an explicit HTTP switch used by
// httptest. Production callers must pass allowHTTP false.
func newAPIJobClient(cfg APIJobConfig, allowHTTP bool) (*APIJobClient, error) {
	host := strings.TrimRight(strings.TrimSpace(cfg.Host), "/")
	u, err := url.Parse(host)
	// https, or http only when the httptest switch is on. Userinfo is rejected.
	allowed := err == nil && u.Host != "" && u.User == nil && (u.Scheme == "https" || (allowHTTP && u.Scheme == "http"))
	if !allowed {
		return nil, engineError(CodeIsolationDenied, "script runner API server must be https.", http.StatusForbidden)
	}
	tokenFile := strings.TrimSpace(cfg.TokenFile)
	token := strings.TrimSpace(cfg.Token)
	if tokenFile != "" {
		loaded, loadErr := readTokenFile(tokenFile)
		if loadErr != nil {
			return nil, loadErr
		}
		token = loaded
	}
	if len(token) < 16 || strings.ContainsAny(token, "\r\n") {
		return nil, engineError(CodeSecretForbidden, "script runner API token is missing.", http.StatusForbidden)
	}
	ns := strings.TrimSpace(cfg.Namespace)
	if !validJobNamespace(ns) {
		return nil, engineError(CodeIsolationDenied, "script Job namespace is invalid.", http.StatusForbidden)
	}
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: u.Hostname()}
	if len(cfg.CAData) > 0 {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(cfg.CAData) {
			return nil, engineError(CodeIsolationDenied, "script runner API CA could not be parsed.", http.StatusForbidden)
		}
		tlsCfg.RootCAs = pool
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	poll := cfg.PollEvery
	if poll <= 0 {
		poll = 250 * time.Millisecond
	}
	cp := cfg.ControlPlane
	if !cfg.SkipNetworkPolicy {
		var normErr error
		cp, normErr = normalizeControlPlane(cp)
		if normErr != nil {
			if errors.Is(normErr, ErrControlPlaneMissing) {
				return nil, engineError(CodeNetworkPolicyDenied, "control-plane API CIDR or Service is missing.", http.StatusForbidden)
			}
			return nil, engineError(CodeNetworkPolicyDenied, "control-plane API CIDR or Service is invalid.", http.StatusForbidden)
		}
	}
	return &APIJobClient{
		host:         host,
		token:        token,
		tokenFile:    tokenFile,
		namespace:    ns,
		pollEvery:    poll,
		controlPlane: cp,
		skipPolicy:   cfg.SkipNetworkPolicy,
		http: &http.Client{
			Timeout: timeout,
			Transport: &http.Transport{
				TLSClientConfig: tlsCfg,
			},
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}, nil
}

// Submit creates the Job, polls until it succeeds or fails, and returns
// the runner container log as stdout. API error bodies are discarded.
func (c *APIJobClient) Submit(ctx context.Context, manifest map[string]any) (IsolatedResult, error) {
	if c == nil {
		return IsolatedResult{}, engineError(CodeRunnerNotImplemented, "script runner Job client is not configured.", http.StatusNotImplemented)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	token, err := c.currentToken()
	if err != nil {
		return IsolatedResult{}, err
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		return IsolatedResult{}, engineError(CodeIsolationDenied, "script Job could not be encoded.", http.StatusForbidden)
	}
	if bytes.Contains(raw, []byte(token)) {
		return IsolatedResult{}, engineError(CodeSecretForbidden, "script Job rejected credential material.", http.StatusForbidden)
	}
	meta, _ := manifest["metadata"].(map[string]any)
	name, _ := meta["name"].(string)
	ns, _ := meta["namespace"].(string)
	name = strings.TrimSpace(name)
	ns = strings.TrimSpace(ns)
	if name == "" || ns != c.namespace || !validJobNamespace(ns) {
		return IsolatedResult{}, engineError(CodeIsolationDenied, "script Job name or namespace is invalid.", http.StatusForbidden)
	}
	if !c.skipPolicy {
		if err := c.enforceNetworkPolicy(ctx, token); err != nil {
			return IsolatedResult{}, err
		}
	}
	createPath := "/apis/batch/v1/namespaces/" + url.PathEscape(ns) + "/jobs"
	if _, err := c.do(ctx, http.MethodPost, createPath, raw, token); err != nil {
		return IsolatedResult{}, err
	}
	itemPath := createPath + "/" + url.PathEscape(name)
	for {
		obj, err := c.do(ctx, http.MethodGet, itemPath, nil, token)
		if err != nil {
			return IsolatedResult{}, err
		}
		status, _ := obj["status"].(map[string]any)
		succeeded, _ := asInt(status["succeeded"])
		failed, _ := asInt(status["failed"])
		if succeeded > 0 || failed > 0 {
			logs, logErr := c.containerLogs(ctx, ns, name, token)
			if logErr != nil {
				return IsolatedResult{}, logErr
			}
			code := 0
			if failed > 0 {
				code = 1
			}
			return IsolatedResult{OK: failed == 0 && succeeded > 0, ExitCode: code, Stdout: logs}, nil
		}
		if err := c.wait(ctx); err != nil {
			return IsolatedResult{}, engineError(CodeIndeterminate, "script Job stopped before a result.", http.StatusConflict)
		}
	}
}

// NetworkPolicyEnforced reports whether Submit refuses to create a Job
// until the live script NetworkPolicy matches the control-plane config.
func (c *APIJobClient) NetworkPolicyEnforced() bool {
	return c != nil && !c.skipPolicy
}

func (c *APIJobClient) enforceNetworkPolicy(ctx context.Context, token string) error {
	cfg := c.controlPlane
	if cfg.Service != "" {
		path := "/api/v1/namespaces/" + url.PathEscape(cfg.ServiceNamespace) + "/services/" + url.PathEscape(cfg.Service)
		obj, err := c.do(ctx, http.MethodGet, path, nil, token)
		if err != nil {
			return networkPolicyDenied()
		}
		sel, selErr := serviceSelector(obj)
		if selErr != nil {
			return networkPolicyDenied()
		}
		cfg.Selector = sel
	}
	path := "/apis/networking.k8s.io/v1/namespaces/" + url.PathEscape(c.namespace) + "/networkpolicies/" + url.PathEscape(ScriptRunnerNetworkPolicyName)
	obj, err := c.do(ctx, http.MethodGet, path, nil, token)
	if err != nil {
		return networkPolicyDenied()
	}
	return ValidateScriptNetworkPolicy(obj, cfg)
}

func (c *APIJobClient) containerLogs(ctx context.Context, ns, jobName, token string) (string, error) {
	q := url.Values{}
	q.Set("labelSelector", "job-name="+jobName)
	listPath := "/api/v1/namespaces/" + url.PathEscape(ns) + "/pods?" + q.Encode()
	var pod string
	for attempt := 0; attempt < 5; attempt++ {
		obj, err := c.do(ctx, http.MethodGet, listPath, nil, token)
		if err != nil {
			return "", err
		}
		items, _ := obj["items"].([]any)
		for _, item := range items {
			m, _ := item.(map[string]any)
			meta, _ := m["metadata"].(map[string]any)
			name, _ := meta["name"].(string)
			if strings.TrimSpace(name) != "" {
				pod = name
				break
			}
		}
		if pod != "" {
			break
		}
		if err := c.wait(ctx); err != nil {
			return "", engineError(CodeIndeterminate, "script Job stopped before a result.", http.StatusConflict)
		}
	}
	if pod == "" {
		return "", engineError(CodeIsolationDenied, "script Job pod was not found.", http.StatusForbidden)
	}
	logPath := "/api/v1/namespaces/" + url.PathEscape(ns) + "/pods/" + url.PathEscape(pod) + "/log?container=runner"
	body, err := c.doRaw(ctx, http.MethodGet, logPath, nil, token)
	if err != nil {
		return "", err
	}
	if len(body) > MaxOutputBytes {
		return "", engineError(CodeOutputTooLarge, "script output exceeds the size limit.", http.StatusBadRequest)
	}
	return string(body), nil
}

func (c *APIJobClient) do(ctx context.Context, method, path string, body []byte, token string) (map[string]any, error) {
	payload, err := c.doRaw(ctx, method, path, body, token)
	if err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(payload)) == 0 {
		return map[string]any{}, nil
	}
	var obj map[string]any
	if err := json.Unmarshal(payload, &obj); err != nil || obj == nil {
		return nil, engineError(CodeIsolationDenied, "script Job response could not be parsed.", http.StatusForbidden)
	}
	return obj, nil
}

func (c *APIJobClient) doRaw(ctx context.Context, method, path string, body []byte, token string) ([]byte, error) {
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.host+path, rdr)
	if err != nil {
		return nil, engineError(CodeIsolationDenied, "script Job request could not be built.", http.StatusForbidden)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, engineError(CodeIsolationDenied, "script runner API could not be reached.", http.StatusForbidden)
	}
	defer res.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(res.Body, MaxOutputBytes+1))
	if err != nil {
		return nil, engineError(CodeIsolationDenied, "script Job response could not be read.", http.StatusForbidden)
	}
	if res.StatusCode >= 300 {
		return nil, engineError(CodeIsolationDenied, "Kubernetes API rejected the script Job.", http.StatusForbidden)
	}
	return payload, nil
}

func (c *APIJobClient) currentToken() (string, error) {
	if strings.TrimSpace(c.tokenFile) == "" {
		return c.token, nil
	}
	return readTokenFile(c.tokenFile)
}

func readTokenFile(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) > 8192 {
		return "", engineError(CodeSecretForbidden, "script runner API token is missing.", http.StatusForbidden)
	}
	token := strings.TrimSpace(string(raw))
	if len(token) < 16 || strings.ContainsAny(token, "\r\n") {
		return "", engineError(CodeSecretForbidden, "script runner API token is missing.", http.StatusForbidden)
	}
	return token, nil
}

func (c *APIJobClient) wait(ctx context.Context) error {
	timer := time.NewTimer(c.pollEvery)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
