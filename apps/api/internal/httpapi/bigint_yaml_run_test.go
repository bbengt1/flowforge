package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/localworker"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/bbengt1/flowforge/apps/api/internal/webhook"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func bigYAMLRunDoc(gates string) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: big-yaml-run
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: constants
      type: data.set
      name: Constants
      with:
        value:
          big: 99999999999999999999
` + gates
}

func bigYAMLGate(id, with string) string {
	return `    - id: ` + id + `
      type: flow.condition
      name: ` + id + `
      with:
` + with
}

func bigYAMLEdges(ids ...string) string {
	s := "  edges:\n"
	for _, id := range ids {
		s += "    - from: constants.result\n      to: " + id + ".value\n"
	}
	return s
}

// A YAML literal beyond int64 reaches a run with its digits: op: gt and
// op: eq compare it exactly, and a CEL with.expr that reads it fails closed
// with expression-runtime without echoing the value.
func runBigYAMLInteger(t *testing.T, h http.Handler, admin identity.User, tenant identity.Tenant, ws identity.Workspace) {
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)

	run := func(t *testing.T, doc string) map[string]map[string]any {
		t.Helper()
		created := createWorkflow(t, h, admin, tenant, ws, doc)
		pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "big-run")
		exec := startExecution(t, h, admin, tenant, ws, created.Workflow.ID, pub.Version.ID)
		client := localworker.NewHTTP(localworker.HTTPConfig{BaseURL: srv.URL, Issuer: admin.Issuer, Subject: admin.ExternalSubject, WorkerID: "big-yaml", Lease: 30 * time.Second})
		if _, err := localworker.NewRunner(client, localworker.Config{WorkerID: "big-yaml"}).Drain(t.Context()); err != nil {
			t.Fatal(err)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, workspaceRequest(http.MethodGet, "/api/v1/executions/"+exec.ID+"/steps", nil, admin, tenant, ws))
		if rec.Code != http.StatusOK {
			t.Fatalf("steps: %d %s", rec.Code, rec.Body.String())
		}
		var listed struct {
			Items []map[string]any `json:"items"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
			t.Fatal(err)
		}
		out := map[string]map[string]any{}
		for _, it := range listed.Items {
			out[it["nodeId"].(string)] = it
		}
		return out
	}

	t.Run("op compares exactly", func(t *testing.T) {
		doc := bigYAMLRunDoc(
			bigYAMLGate("gtbelow", "        op: gt\n        path: big\n        compare: 99999999999999999998\n")+
				bigYAMLGate("gtsame", "        op: gt\n        path: big\n        compare: 99999999999999999999\n")+
				bigYAMLGate("eqsame", "        op: eq\n        path: big\n        compare: 99999999999999999999\n")+
				bigYAMLGate("eqbelow", "        op: eq\n        path: big\n        compare: 99999999999999999998\n")) +
			bigYAMLEdges("gtbelow", "gtsame", "eqsame", "eqbelow")
		steps := run(t, doc)
		for id, port := range map[string]string{"gtbelow": "true", "gtsame": "false", "eqsame": "true", "eqbelow": "false"} {
			st := steps[id]
			if st == nil || st["status"] != "succeeded" {
				t.Fatalf("%s: %v", id, st)
			}
			if got := st["output"].(map[string]any)["port"]; got != port {
				t.Fatalf("%s: port = %v, want %s", id, got, port)
			}
		}
	})
	t.Run("expr fails closed", func(t *testing.T) {
		doc := bigYAMLRunDoc(bigYAMLGate("celgate", "        expr: {expr: 'item.big > 1'}\n")) + bigYAMLEdges("celgate")
		steps := run(t, doc)
		st := steps["celgate"]
		if st == nil || st["status"] != "failed" {
			t.Fatalf("celgate: %v", st)
		}
		e := st["error"].(map[string]any)
		msg, _ := e["message"].(string)
		if e["code"] != "expression-runtime" || strings.Contains(msg, "99999999999999999999") || strings.Contains(msg, "1e+20") {
			t.Fatalf("celgate error = %v", e)
		}
	})
}

func TestWorkflowYAMLBigIntegerRunMemory(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	runBigYAMLInteger(t, h, admin, tenant, ws)
}

func TestWorkflowYAMLBigIntegerRunAgainstPostgres(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	pool, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	n := time.Now().UnixNano()
	user := identity.User{Issuer: "https://idp.example", ExternalSubject: fmt.Sprintf("big-yaml-run-%d", n), DisplayName: "Admin"}
	keys := vault.TestKeys()
	workflows := wfstore.NewPostgres(pool)
	ops := opsconfig.NewMemory()
	hooks := webhook.NewPostgres(pool)
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:          identity.NewPostgres(pool),
		Scoped:         isolation.NewPostgres(pool),
		Sessions:       session.NewMemory(),
		Workflows:      workflows,
		Ops:            ops,
		Hooks:          hooks,
		Vault:          vault.NewPostgres(pool, keys, vault.CompositeRefFinder{workflows, ops, hooks}),
		Keys:           keys,
		Approvals:      approval.NewMemory(),
		PlatformAdmins: []authz.PrincipalRef{{Issuer: user.Issuer, Subject: user.ExternalSubject}},
	}))
	tenant, ws := exactIntakeTenant(t, h, user, fmt.Sprintf("by%d", n%1_000_000_000_000))
	runBigYAMLInteger(t, h, user, tenant, ws)
}
