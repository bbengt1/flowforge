package httpapi

import (
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/approvalhttp"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/boothttp"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/oidchttp"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/portalhttp"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/rt"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/scimhttp"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/vaulthttp"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/webhookhttp"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/workflowhttp"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/workspacehttp"
)

// Routes is the mux source of truth. Domain packages own registration.
// OpenAPI and the identity-proxy allowlist are generated from this list
// (go run ./cmd/genroutes). Order matches the historical table so the
// generated artifacts stay stable.
//
// Package map:
//   - core: probes, workspace admin, login, session, MFA, embed, machine, lockout, alerts
//   - boothttp: first-run bootstrap and TLS
//   - workspacehttp: records, jobs, cache, realtime, workspace audit
//   - oidchttp: OIDC start and callback
//   - scimhttp: SCIM 2.0
//   - portalhttp: portal adapter
//   - workflowhttp: workflows, folders, schedules, executions, jobs, artifacts, scripts, ops-config
//   - webhookhttp: triggers and signed ingress
//   - vaulthttp: credentials
//   - approvalhttp: approvals and policy
//   - rt: route records and OpenAPI / allowlist renderers
//
//go:generate go run ../../cmd/genroutes
func Routes(s *core.Server) []rt.Route {
	if s == nil {
		s = &core.Server{}
	}
	out := []rt.Route{}
	out = append(out, core.Routes1(s)...)
	out = append(out, boothttp.Routes(s)...)
	out = append(out, core.Routes2(s)...)
	out = append(out, workspacehttp.Routes(s)...)
	out = append(out, core.Routes3(s)...)
	out = append(out, oidchttp.Routes(s)...)
	out = append(out, core.Routes4(s)...)
	out = append(out, scimhttp.Routes(s)...)
	out = append(out, core.Routes5(s)...)
	out = append(out, portalhttp.Routes(s)...)
	out = append(out, workflowhttp.Routes1(s)...)
	out = append(out, webhookhttp.Routes(s)...)
	out = append(out, workflowhttp.Routes2(s)...)
	out = append(out, core.Routes6(s)...)
	out = append(out, workflowhttp.Routes3(s)...)
	out = append(out, vaulthttp.Routes(s)...)
	out = append(out, workflowhttp.Routes4(s)...)
	out = append(out, workflowhttp.OpsRoutes(s)...)
	out = append(out, approvalhttp.Routes(s)...)
	return out
}
