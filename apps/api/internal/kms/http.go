package kms

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	httpTimeout = 10 * time.Second
	maxResponse = 64 << 10
)

func newHTTPClient() *http.Client {
	return &http.Client{
		Timeout: httpTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			// A redirect could send a bearer token to another host.
			return http.ErrUseLastResponse
		},
	}
}

// postJSON sends payload and returns a 200 body. Failures are
// ErrUnavailable and never include the response or the request body.
func postJSON(ctx context.Context, client *http.Client, endpoint, token string, headers map[string]string, payload any) ([]byte, error) {
	if client == nil {
		client = newHTTPClient()
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, ErrUnavailable
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return nil, ErrUnavailable
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, ErrUnavailable
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse+1))
	if err != nil || len(body) > maxResponse || resp.StatusCode != http.StatusOK {
		return nil, ErrUnavailable
	}
	return body, nil
}

func parseOrigin(raw, envName string, productionLocked bool) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", fmt.Errorf("%s must be an https origin", envName)
	}
	switch u.Scheme {
	case "https":
		return "https://" + u.Host, nil
	case "http":
		if !productionLocked && loopbackHost(u.Hostname()) {
			return "http://" + u.Host, nil
		}
	}
	return "", fmt.Errorf("%s must be an https origin", envName)
}

func loopbackHost(host string) bool {
	host = strings.TrimSpace(host)
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
