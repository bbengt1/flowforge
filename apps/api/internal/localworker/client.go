package localworker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

const (
	headerIssuer       = "X-FlowForge-Issuer"
	headerSubject      = "X-FlowForge-Subject"
	headerTenantSlug   = "X-FlowForge-Tenant-Slug"
	headerWorkbenchKey = "X-FlowForge-Workbench-Key"
)

// Claim is a successful POST /jobs/claim ticket.
type Claim struct {
	JobToken  string
	Binding   wfstore.JobBinding
	Job       wfstore.ExecutionJob
	Step      wfstore.ExecutionStep
	Execution wfstore.Execution
}

// API is the control-plane surface the local worker needs.
type API interface {
	Ready(ctx context.Context) error
	ListMemberships(ctx context.Context) ([]identity.Membership, error)
	Claim(ctx context.Context, tenantSlug, workbenchKey string) (*Claim, error)
	Heartbeat(ctx context.Context, tenantSlug, workbenchKey string, claim Claim) error
	Complete(ctx context.Context, tenantSlug, workbenchKey string, claim Claim, output map[string]any) error
	Fail(ctx context.Context, tenantSlug, workbenchKey string, claim Claim, errObj map[string]any) error
}

// HTTPConfig is the trusted-dev identity the compose worker presents.
type HTTPConfig struct {
	BaseURL    string
	Issuer     string
	Subject    string
	WorkerID   string
	Lease      time.Duration
	HTTPClient *http.Client
}

// HTTP talks to the API over the existing claim/heartbeat/complete routes.
// It does not mint tickets or bypass fencing.
type HTTP struct {
	base     string
	issuer   string
	subject  string
	workerID string
	lease    time.Duration
	client   *http.Client
}

// NewHTTP returns an API client. BaseURL is the API origin (no path).
func NewHTTP(cfg HTTPConfig) *HTTP {
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	lease := cfg.Lease
	if lease <= 0 {
		lease = wfstore.DefaultLease
	}
	return &HTTP{
		base:     strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/"),
		issuer:   strings.TrimSpace(cfg.Issuer),
		subject:  strings.TrimSpace(cfg.Subject),
		workerID: strings.TrimSpace(cfg.WorkerID),
		lease:    lease,
		client:   client,
	}
}

func (h *HTTP) Ready(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.base+"/api/v1/readiness", nil)
	if err != nil {
		return err
	}
	res, err := h.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("readiness: %s", res.Status)
	}
	return nil
}

func (h *HTTP) ListMemberships(ctx context.Context) ([]identity.Membership, error) {
	var payload struct {
		Items []identity.Membership `json:"items"`
	}
	if err := h.doJSON(ctx, http.MethodGet, "/api/v1/workspaces", "", "", nil, http.StatusOK, &payload); err != nil {
		return nil, err
	}
	return payload.Items, nil
}

func (h *HTTP) Claim(ctx context.Context, tenantSlug, workbenchKey string) (*Claim, error) {
	body := map[string]any{"workerId": h.workerID}
	if h.lease > 0 {
		body["leaseSeconds"] = int(h.lease / time.Second)
	}
	status, raw, err := h.do(ctx, http.MethodPost, "/api/v1/jobs/claim", tenantSlug, workbenchKey, body)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNoContent {
		return nil, nil
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("claim: %s", formatProblem(status, raw))
	}
	var payload struct {
		Claimed   bool                  `json:"claimed"`
		JobToken  string                `json:"jobToken"`
		Binding   wfstore.JobBinding    `json:"binding"`
		Job       wfstore.ExecutionJob  `json:"job"`
		Step      wfstore.ExecutionStep `json:"step"`
		Execution wfstore.Execution     `json:"execution"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}
	if !payload.Claimed {
		return nil, nil
	}
	return &Claim{
		JobToken:  payload.JobToken,
		Binding:   payload.Binding,
		Job:       payload.Job,
		Step:      payload.Step,
		Execution: payload.Execution,
	}, nil
}

func (h *HTTP) Heartbeat(ctx context.Context, tenantSlug, workbenchKey string, claim Claim) error {
	return h.jobAction(ctx, tenantSlug, workbenchKey, claim, "/heartbeat", map[string]any{
		"leaseSeconds": int(h.lease / time.Second),
	})
}

func (h *HTTP) Complete(ctx context.Context, tenantSlug, workbenchKey string, claim Claim, output map[string]any) error {
	body := map[string]any{}
	if output != nil {
		body["output"] = output
	}
	return h.jobAction(ctx, tenantSlug, workbenchKey, claim, "/complete", body)
}

func (h *HTTP) Fail(ctx context.Context, tenantSlug, workbenchKey string, claim Claim, errObj map[string]any) error {
	body := map[string]any{}
	if errObj != nil {
		body["error"] = errObj
	}
	return h.jobAction(ctx, tenantSlug, workbenchKey, claim, "/fail", body)
}

func (h *HTTP) jobAction(ctx context.Context, tenantSlug, workbenchKey string, claim Claim, suffix string, extra map[string]any) error {
	if strings.TrimSpace(claim.JobToken) == "" || strings.TrimSpace(claim.Job.ID) == "" {
		return fmt.Errorf("job action requires a ticket")
	}
	body := map[string]any{
		"jobToken":     claim.JobToken,
		"workerId":     h.workerID,
		"fencingToken": claim.Job.FencingToken,
	}
	for k, v := range extra {
		body[k] = v
	}
	return h.doJSON(ctx, http.MethodPost, "/api/v1/jobs/"+claim.Job.ID+suffix, tenantSlug, workbenchKey, body, http.StatusOK, nil)
}

func (h *HTTP) doJSON(ctx context.Context, method, path, tenantSlug, workbenchKey string, body any, want int, dest any) error {
	status, raw, err := h.do(ctx, method, path, tenantSlug, workbenchKey, body)
	if err != nil {
		return err
	}
	if status != want {
		return fmt.Errorf("%s %s: %s", method, path, formatProblem(status, raw))
	}
	if dest == nil || len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, dest)
}

func (h *HTTP) do(ctx context.Context, method, path, tenantSlug, workbenchKey string, body any) (int, []byte, error) {
	var rdr io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		rdr = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, h.base+path, rdr)
	if err != nil {
		return 0, nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set(headerIssuer, h.issuer)
	req.Header.Set(headerSubject, h.subject)
	if tenantSlug != "" {
		req.Header.Set(headerTenantSlug, tenantSlug)
	}
	if workbenchKey != "" {
		req.Header.Set(headerWorkbenchKey, workbenchKey)
	}
	res, err := h.client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return res.StatusCode, nil, err
	}
	return res.StatusCode, raw, nil
}

func formatProblem(status int, raw []byte) string {
	var p struct {
		Title  string `json:"title"`
		Detail string `json:"detail"`
		Code   string `json:"code"`
	}
	if err := json.Unmarshal(raw, &p); err == nil && (p.Title != "" || p.Detail != "" || p.Code != "") {
		return fmt.Sprintf("%d %s %s %s", status, p.Code, p.Title, p.Detail)
	}
	return fmt.Sprintf("%d %s", status, strings.TrimSpace(string(raw)))
}
