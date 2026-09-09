package httpnotify

import (
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// EndpointPolicy is the pinned connection endpointPolicy snapshot.
type EndpointPolicy struct {
	Hosts            []string
	Methods          []string
	PathPrefixes     []string
	Ports            []int
	TLSRequired      bool
	AllowRedirects   bool
	MaxRedirects     int
	AllowedAddresses []string
	AddressesPresent bool
	SecretFields     []string
	MaxRequestBytes  int
	MaxResponseBytes int
}

// ConnectionContext is the pinned connection revision used at execute.
type ConnectionContext struct {
	ID           string
	WorkspaceID  string
	Type         string
	Published    bool
	Revision     string
	Digest       string
	CredentialID string
	Policy       EndpointPolicy
}

// ConnectionContextFromSpec builds a ConnectionContext from a connection spec.
func ConnectionContextFromSpec(id string, spec map[string]any) ConnectionContext {
	if spec == nil {
		spec = map[string]any{}
	}
	typ, _ := spec["type"].(string)
	cred, _ := spec["credentialId"].(string)
	ep, _ := spec["endpointPolicy"].(map[string]any)
	if ep == nil {
		ep = map[string]any{}
	}
	ports := intSlice(ep, "ports")
	if len(ports) == 0 {
		ports = []int{443}
	}
	tls := true
	if raw, ok := ep["tlsRequired"].(bool); ok {
		tls = raw
	}
	allowRedirects, _ := ep["allowRedirects"].(bool)
	maxRedirects, _ := asInt(ep["maxRedirects"])
	if maxRedirects < 0 {
		maxRedirects = 0
	}
	if maxRedirects > MaxRedirects {
		maxRedirects = MaxRedirects
	}
	addrs, addrsPresent := allowlist(ep, KeyAllowedAddresses, "destinationAddresses")
	maxReq := DefaultMaxRequestBytes
	if n, err := asInt(ep["maxRequestBytes"]); err == nil && n > 0 {
		maxReq = n
	}
	maxResp := DefaultMaxResponseBytes
	if n, err := asInt(ep["maxResponseBytes"]); err == nil && n > 0 {
		maxResp = n
	}
	if maxReq > HardMaxBodyBytes {
		maxReq = HardMaxBodyBytes
	}
	if maxResp > HardMaxBodyBytes {
		maxResp = HardMaxBodyBytes
	}
	return ConnectionContext{
		ID:           strings.TrimSpace(id),
		Type:         strings.ToLower(strings.TrimSpace(typ)),
		CredentialID: strings.TrimSpace(cred),
		Policy: EndpointPolicy{
			Hosts:            stringSlice(ep, "hosts"),
			Methods:          upperStrings(stringSlice(ep, "methods")),
			PathPrefixes:     stringSlice(ep, "pathPrefixes"),
			Ports:            ports,
			TLSRequired:      tls,
			AllowRedirects:   allowRedirects,
			MaxRedirects:     maxRedirects,
			AllowedAddresses: addrs,
			AddressesPresent: addrsPresent,
			SecretFields:     stringSlice(ep, "secretFields"),
			MaxRequestBytes:  maxReq,
			MaxResponseBytes: maxResp,
		},
	}
}

// NormalizedEndpoint is a fail-closed URL the worker may contact.
type NormalizedEndpoint struct {
	Scheme   string
	Host     string
	Port     int
	Path     string
	RawQuery string
	URL      *url.URL
}

// NormalizeEndpoint builds an absolute URL from a pinned host + relative path.
// User-supplied unrestricted URLs, credentials, and userinfo are rejected.
func NormalizeEndpoint(host, path string, port int, tlsRequired bool) (NormalizedEndpoint, *EngineError) {
	host = strings.TrimSpace(host)
	if host == "" {
		return NormalizedEndpoint{}, engineError(CodeInvalidEndpoint, "endpoint host is required", http.StatusBadRequest)
	}
	if strings.Contains(host, "://") || strings.Contains(host, "/") || strings.Contains(host, "@") {
		return NormalizedEndpoint{}, engineError(CodeInvalidEndpoint, "host must be a hostname or IP, not a URL", http.StatusBadRequest)
	}
	canon, err := NormalizeHostname(host)
	if err != nil {
		return NormalizedEndpoint{}, engineError(CodeInvalidEndpoint, "host is not a valid hostname or IP", http.StatusBadRequest)
	}
	path = strings.TrimSpace(path)
	if path == "" {
		path = "/"
	}
	if !strings.HasPrefix(path, "/") || strings.Contains(path, "://") {
		return NormalizedEndpoint{}, engineError(CodePathDenied, "path must be a relative URL path, not a full URL", http.StatusForbidden)
	}
	rawQuery := ""
	if i := strings.IndexByte(path, '?'); i >= 0 {
		rawQuery = path[i+1:]
		path = path[:i]
	}
	if strings.Contains(path, "\\") || strings.Contains(path, "\x00") {
		return NormalizedEndpoint{}, engineError(CodePathDenied, "path contains denied characters", http.StatusForbidden)
	}
	if port <= 0 {
		if tlsRequired {
			port = 443
		} else {
			port = 80
		}
	}
	if port < 1 || port > 65535 {
		return NormalizedEndpoint{}, engineError(CodeInvalidEndpoint, "port is out of range", http.StatusBadRequest)
	}
	scheme := "https"
	if !tlsRequired {
		scheme = "http"
	}
	u := &url.URL{
		Scheme:   scheme,
		Host:     net.JoinHostPort(canon, strconv.Itoa(port)),
		Path:     path,
		RawQuery: rawQuery,
	}
	if u.User != nil || u.Opaque != "" {
		return NormalizedEndpoint{}, engineError(CodeInvalidEndpoint, "endpoint userinfo is denied", http.StatusBadRequest)
	}
	return NormalizedEndpoint{
		Scheme:   scheme,
		Host:     canon,
		Port:     port,
		Path:     path,
		RawQuery: rawQuery,
		URL:      u,
	}, nil
}

// EnforceMethodPathTLS checks the node request against the connection policy.
func EnforceMethodPathTLS(method, path string, ep NormalizedEndpoint, policy EndpointPolicy) *EngineError {
	method = strings.ToUpper(strings.TrimSpace(method))
	if method == "" {
		method = http.MethodGet
	}
	switch method {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodHead:
	default:
		return engineError(CodeMethodDenied, "method is not an allowlisted HTTP verb", http.StatusForbidden)
	}
	if len(policy.Methods) == 0 || !Allowed(policy.Methods, method) {
		return engineError(CodeMethodDenied, "method is not allowed by the connection endpoint policy", http.StatusForbidden)
	}
	if len(policy.Hosts) == 0 || !Allowed(policy.Hosts, ep.Host) {
		return engineError(CodeInvalidEndpoint, "host is not allowed by the connection endpoint policy", http.StatusForbidden)
	}
	if !portAllowed(policy.Ports, ep.Port) {
		return engineError(CodeInvalidEndpoint, "port is not allowed by the connection endpoint policy", http.StatusForbidden)
	}
	if policy.TLSRequired && ep.Scheme != "https" {
		return engineError(CodeTLSRequired, "TLS is required by the connection endpoint policy", http.StatusForbidden)
	}
	if !pathAllowed(policy.PathPrefixes, ep.Path) {
		return engineError(CodePathDenied, "path is not allowed by the connection endpoint policy", http.StatusForbidden)
	}
	_ = path
	return nil
}

func pathAllowed(prefixes []string, path string) bool {
	if len(prefixes) == 0 {
		return false
	}
	if path == "" {
		path = "/"
	}
	for _, prefix := range prefixes {
		prefix = strings.TrimSpace(prefix)
		if prefix == "" {
			continue
		}
		if prefix == "/" || strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return false
}

func portAllowed(ports []int, port int) bool {
	if len(ports) == 0 {
		return port == 443 || port == 80
	}
	for _, p := range ports {
		if p == port {
			return true
		}
	}
	return false
}

func SelectHost(policy EndpointPolicy, requested string) (string, *EngineError) {
	requested = strings.TrimSpace(requested)
	if requested != "" {
		canon, err := NormalizeHostname(requested)
		if err != nil {
			return "", engineError(CodeInvalidEndpoint, "host is not a valid hostname or IP", http.StatusBadRequest)
		}
		if !Allowed(policy.Hosts, canon) {
			return "", engineError(CodeInvalidEndpoint, "host is not allowed by the connection endpoint policy", http.StatusForbidden)
		}
		return canon, nil
	}
	if len(policy.Hosts) == 1 {
		return policy.Hosts[0], nil
	}
	if len(policy.Hosts) == 0 {
		return "", engineError(CodeInvalidEndpoint, "connection endpointPolicy.hosts is required", http.StatusBadRequest)
	}
	return "", engineError(CodeInvalidEndpoint, "host must be selected from the pinned connection allowlist", http.StatusBadRequest)
}

func SelectPort(policy EndpointPolicy, requested int) int {
	if requested > 0 && portAllowed(policy.Ports, requested) {
		return requested
	}
	if len(policy.Ports) > 0 {
		return policy.Ports[0]
	}
	if policy.TLSRequired {
		return 443
	}
	return 80
}

func upperStrings(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		s = strings.ToUpper(strings.TrimSpace(s))
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func intSlice(m map[string]any, key string) []int {
	raw, ok := m[key]
	if !ok || raw == nil {
		return nil
	}
	switch v := raw.(type) {
	case []int:
		return append([]int(nil), v...)
	case []any:
		out := make([]int, 0, len(v))
		for _, item := range v {
			n, err := asInt(item)
			if err != nil {
				continue
			}
			out = append(out, n)
		}
		return out
	default:
		if n, err := asInt(v); err == nil {
			return []int{n}
		}
		return nil
	}
}

func asInt(raw any) (int, error) {
	switch v := raw.(type) {
	case int:
		return v, nil
	case int64:
		return int(v), nil
	case float64:
		if v != float64(int(v)) {
			return 0, ErrInvalid
		}
		return int(v), nil
	default:
		return 0, ErrInvalid
	}
}
