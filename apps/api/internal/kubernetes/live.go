package kubernetes

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// RESTConfig is an in-memory cluster connection. It must never be serialized
// onto job payloads, API responses, or audit details.
type RESTConfig struct {
	Host               string
	BearerToken        string
	CAData             []byte
	ClientCert         []byte
	ClientKey          []byte
	InsecureSkipVerify bool
	ServerName         string
	Timeout            time.Duration
}

// LiveClient talks to a real cluster using server-side apply.
//
// TODO(envtest): cover API discovery, SSA dry-run, and ownership conflicts
// against kube-apiserver. FakeClient tests exercise the same engine contracts.
type LiveClient struct {
	cfg    RESTConfig
	http   *http.Client
	header http.Header
}

// NewLiveClient builds a TLS client from an in-memory REST config.
func NewLiveClient(cfg RESTConfig) (*LiveClient, error) {
	host := strings.TrimSpace(cfg.Host)
	if host == "" {
		return nil, engineError(CodeClusterUnreachable, "cluster endpoint is missing", http.StatusBadGateway)
	}
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: strings.TrimSpace(cfg.ServerName)}
	if len(cfg.CAData) > 0 {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(cfg.CAData) {
			return nil, engineError(CodeClusterUnreachable, "cluster CA could not be parsed", http.StatusBadGateway)
		}
		tlsCfg.RootCAs = pool
	}
	if cfg.InsecureSkipVerify {
		return nil, engineError(CodeClusterUnreachable, "insecure TLS is not allowed", http.StatusForbidden)
	}
	if len(cfg.ClientCert) > 0 && len(cfg.ClientKey) > 0 {
		cert, err := tls.X509KeyPair(cfg.ClientCert, cfg.ClientKey)
		if err != nil {
			return nil, engineError(CodeClusterUnreachable, "client certificate could not be parsed", http.StatusBadGateway)
		}
		tlsCfg.Certificates = []tls.Certificate{cert}
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = time.Duration(DefaultTimeoutSeconds) * time.Second
	}
	header := make(http.Header)
	if tok := strings.TrimSpace(cfg.BearerToken); tok != "" {
		header.Set("Authorization", "Bearer "+tok)
	}
	return &LiveClient{
		cfg:    cfg,
		header: header,
		http: &http.Client{
			Timeout: timeout,
			Transport: &http.Transport{
				TLSClientConfig: tlsCfg,
			},
		},
	}, nil
}

func (c *LiveClient) Apply(ctx context.Context, obj Unstructured, opts ApplyOptions) (Unstructured, error) {
	kind, _ := obj["kind"].(string)
	meta, _ := asStringKeyMap(obj["metadata"])
	name, _ := meta["name"].(string)
	ns, _ := meta["namespace"].(string)
	body, err := json.Marshal(obj)
	if err != nil {
		return nil, engineError(CodeInvalidManifest, "manifest could not be encoded", http.StatusBadRequest)
	}
	q := url.Values{}
	q.Set("fieldManager", FieldManager)
	q.Set("force", "false")
	if opts.DryRun {
		q.Set("dryRun", "All")
	}
	_ = opts.Force // ignored; Force is never sent
	path, err := resourceURL(kind, ns, name)
	if err != nil {
		return nil, err
	}
	return c.do(ctx, http.MethodPatch, path+"?"+q.Encode(), "application/apply-patch+yaml", body)
}

func (c *LiveClient) Get(ctx context.Context, kind, namespace, name string) (Unstructured, error) {
	path, err := resourceURL(kind, namespace, name)
	if err != nil {
		return nil, err
	}
	return c.do(ctx, http.MethodGet, path, "", nil)
}

func (c *LiveClient) Watch(ctx context.Context, kind, namespace, name string) (Unstructured, error) {
	// Observation polls GET. FlowForge policy still requires the watch verb;
	// the namespace Role grants get+watch on status subresources.
	return c.Get(ctx, kind, namespace, name)
}

func (c *LiveClient) List(ctx context.Context, kind, namespace string, _ ListOptions) ([]Unstructured, error) {
	path, perr := collectionURL(kind, namespace)
	if perr != nil {
		return nil, perr
	}
	obj, err := c.do(ctx, http.MethodGet, path, "", nil)
	if err != nil {
		return nil, err
	}
	items, _ := obj["items"].([]any)
	out := make([]Unstructured, 0, len(items))
	for _, item := range items {
		if m, ok := asStringKeyMap(item); ok {
			out = append(out, m)
		}
	}
	return out, nil
}

func (c *LiveClient) do(ctx context.Context, method, path, contentType string, body []byte) (Unstructured, error) {
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.cfg.Host, "/")+path, rdr)
	if err != nil {
		return nil, engineError(CodeClusterUnreachable, "cluster request could not be built", http.StatusBadGateway)
	}
	for k, vs := range c.header {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, engineError(CodeClusterUnreachable, "cluster could not be reached", http.StatusBadGateway)
	}
	defer res.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(res.Body, MaxManifestBytes))
	if res.StatusCode == http.StatusConflict {
		return nil, engineError(CodeOwnershipConflict, "server-side apply ownership conflict; Force=false", http.StatusConflict)
	}
	if res.StatusCode == http.StatusForbidden {
		return nil, engineError(CodeRBACDenied, "Kubernetes RBAC denied the request", http.StatusForbidden)
	}
	if res.StatusCode >= 400 {
		code := CodeApplyFailed
		if method == http.MethodGet {
			code = CodeReadFailed
		}
		if strings.Contains(string(payload), "dryRun") {
			code = CodeDryRunFailed
		}
		return nil, engineError(code, "Kubernetes API rejected the request", res.StatusCode)
	}
	var obj map[string]any
	if len(payload) == 0 {
		return Unstructured{}, nil
	}
	if err := json.Unmarshal(payload, &obj); err != nil {
		return nil, engineError(CodeReadFailed, "cluster response could not be parsed", http.StatusBadGateway)
	}
	return obj, nil
}

func resourceURL(kind, ns, name string) (string, *EngineError) {
	base, err := collectionURL(kind, ns)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(name) == "" {
		return "", engineError(CodeInvalidManifest, "resource name is required", http.StatusBadRequest)
	}
	return base + "/" + url.PathEscape(name), nil
}

func collectionURL(kind, ns string) (string, *EngineError) {
	group, version, resource, ok := restMapping(kind)
	if !ok {
		return "", engineError(CodeKindDenied, "resource kind is not on the engine allowlist", http.StatusForbidden)
	}
	if strings.TrimSpace(ns) == "" || !ValidNamespace(ns) {
		return "", engineError(CodeNamespaceDenied, "namespace must be a DNS-1123 label", http.StatusBadRequest)
	}
	if group == "" {
		return fmt.Sprintf("/api/%s/namespaces/%s/%s", version, url.PathEscape(ns), resource), nil
	}
	return fmt.Sprintf("/apis/%s/%s/namespaces/%s/%s", group, version, url.PathEscape(ns), resource), nil
}

// ParseKubeconfig decodes a kubeconfig document into RESTConfig. The
// returned config stays in-process and is never logged.
func ParseKubeconfig(raw []byte) (RESTConfig, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return RESTConfig{}, engineError(CodeHandleForbidden, "kubeconfig is empty", http.StatusForbidden)
	}
	var doc map[string]any
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return RESTConfig{}, engineError(CodeHandleForbidden, "kubeconfig could not be parsed", http.StatusForbidden)
	}
	current, _ := doc["current-context"].(string)
	contexts, _ := doc["contexts"].([]any)
	clusters, _ := doc["clusters"].([]any)
	users, _ := doc["users"].([]any)
	var clusterName, userName string
	for _, item := range contexts {
		m, _ := asStringKeyMap(item)
		if m == nil {
			continue
		}
		if strings.TrimSpace(fmt.Sprint(m["name"])) != strings.TrimSpace(current) && current != "" {
			if clusterName != "" {
				continue
			}
		}
		if current != "" && strings.TrimSpace(fmt.Sprint(m["name"])) != strings.TrimSpace(current) {
			continue
		}
		ctx, _ := asStringKeyMap(m["context"])
		if ctx == nil {
			continue
		}
		clusterName, _ = ctx["cluster"].(string)
		userName, _ = ctx["user"].(string)
		if current == "" {
			break
		}
	}
	cfg := RESTConfig{}
	for _, item := range clusters {
		m, _ := asStringKeyMap(item)
		if m == nil || strings.TrimSpace(fmt.Sprint(m["name"])) != strings.TrimSpace(clusterName) {
			continue
		}
		cl, _ := asStringKeyMap(m["cluster"])
		if cl == nil {
			continue
		}
		cfg.Host, _ = cl["server"].(string)
		if v, _ := cl["insecure-skip-tls-verify"].(bool); v {
			return RESTConfig{}, engineError(CodeHandleForbidden, "insecure kubeconfig TLS is not allowed", http.StatusForbidden)
		}
		if s, _ := cl["certificate-authority-data"].(string); s != "" {
			data, err := base64.StdEncoding.DecodeString(s)
			if err != nil {
				return RESTConfig{}, engineError(CodeHandleForbidden, "kubeconfig CA could not be decoded", http.StatusForbidden)
			}
			cfg.CAData = data
		}
	}
	for _, item := range users {
		m, _ := asStringKeyMap(item)
		if m == nil || strings.TrimSpace(fmt.Sprint(m["name"])) != strings.TrimSpace(userName) {
			continue
		}
		u, _ := asStringKeyMap(m["user"])
		if u == nil {
			continue
		}
		if tok, _ := u["token"].(string); tok != "" {
			cfg.BearerToken = tok
		}
		if s, _ := u["client-certificate-data"].(string); s != "" {
			data, err := base64.StdEncoding.DecodeString(s)
			if err != nil {
				return RESTConfig{}, engineError(CodeHandleForbidden, "kubeconfig client certificate could not be decoded", http.StatusForbidden)
			}
			cfg.ClientCert = data
		}
		if s, _ := u["client-key-data"].(string); s != "" {
			data, err := base64.StdEncoding.DecodeString(s)
			if err != nil {
				return RESTConfig{}, engineError(CodeHandleForbidden, "kubeconfig client key could not be decoded", http.StatusForbidden)
			}
			cfg.ClientKey = data
		}
	}
	if strings.TrimSpace(cfg.Host) == "" {
		return RESTConfig{}, engineError(CodeHandleForbidden, "kubeconfig is missing a cluster server", http.StatusForbidden)
	}
	return cfg, nil
}

// ExtractKubeconfig pulls the kubeconfig field from vault Unlock JSON.
func ExtractKubeconfig(plain []byte) ([]byte, error) {
	plain = bytes.TrimSpace(plain)
	if len(plain) == 0 {
		return nil, engineError(CodeHandleForbidden, "credential payload is empty", http.StatusForbidden)
	}
	if bytes.HasPrefix(plain, []byte("{")) {
		var obj map[string]string
		if err := json.Unmarshal(plain, &obj); err != nil {
			return nil, engineError(CodeHandleForbidden, "credential payload could not be parsed", http.StatusForbidden)
		}
		kc := strings.TrimSpace(obj[CredentialSecretField])
		if kc == "" {
			return nil, engineError(CodeHandleForbidden, "credential is missing kubeconfig", http.StatusForbidden)
		}
		return []byte(kc), nil
	}
	return plain, nil
}
