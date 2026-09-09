package kubernetes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

func operatorPerms() []string {
	return authz.ExpandRoles([]string{authz.RoleOperator})
}

func applyYAML() string {
	return "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\n  namespace: cp-ops-nprd\ndata:\n  app: ready\n"
}

func baseApplyReq(client ClusterClient) Request {
	return Request{
		Operation:       "kubernetes.apply",
		ClusterTargetID: "11111111-1111-4111-8111-111111111111",
		Namespace:       "cp-ops-nprd",
		Manifests:       applyYAML(),
		DryRun:          "server",
		Wait:            "none",
		TimeoutSeconds:  30,
		Permissions:     operatorPerms(),
		Policy:          policyNS(),
		Target:          targetNS(),
		Client:          client,
		CorrelationID:   "corr-1",
	}
}

func TestApplyDryRunThenPersist(t *testing.T) {
	fake := NewFakeClient()
	res := Execute(context.Background(), baseApplyReq(fake))
	if !res.OK || res.Error != nil {
		t.Fatalf("apply: %+v", res.Error)
	}
	if !res.ServerDryRun || !res.Applied || fake.DryRuns != 1 || fake.Applies != 1 {
		t.Fatalf("dry-run/apply counts dry=%d apply=%d res=%+v", fake.DryRuns, fake.Applies, res)
	}
	if res.FieldManager != FieldManager || res.Force {
		t.Fatalf("ssa = %+v", res)
	}
	if len(res.Resources) != 1 || res.Resources[0].Name != "cfg" || res.Resources[0].Namespace != "cp-ops-nprd" {
		t.Fatalf("resources = %+v", res.Resources)
	}
	if !strings.HasPrefix(res.ManifestDigest, "sha256:") {
		t.Fatal(res.ManifestDigest)
	}
}

func TestApplyWaitReadyIsDeferred(t *testing.T) {
	fake := NewFakeClient()
	req := baseApplyReq(fake)
	req.Wait = "ready"
	res := Execute(context.Background(), req)
	if !res.OK || res.Observation != ObservationDeferred {
		t.Fatalf("wait ready: %+v", res)
	}
}

func TestApplyOwnershipConflictNeverForced(t *testing.T) {
	fake := NewFakeClient()
	obj := Unstructured{
		"apiVersion": "v1",
		"kind":       "ConfigMap",
		"metadata":   map[string]any{"name": "cfg", "namespace": "cp-ops-nprd"},
		"data":       map[string]any{"app": "other"},
	}
	fake.SeedOwned(obj, "helm", []string{"data.app"})
	res := Execute(context.Background(), baseApplyReq(fake))
	if res.OK || res.Error == nil || res.Error.Code != CodeOwnershipConflict {
		t.Fatalf("conflict = %+v", res)
	}
	if fake.Applies != 0 {
		t.Fatalf("forced persist: %d", fake.Applies)
	}
}

func TestApplyPolicyAndRBACDenial(t *testing.T) {
	t.Run("namespace policy", func(t *testing.T) {
		fake := NewFakeClient()
		req := baseApplyReq(fake)
		req.Namespace = "prod"
		res := Execute(context.Background(), req)
		if res.OK || res.Error == nil || res.Error.Code != CodeNamespaceDenied {
			t.Fatalf("ns deny: %+v", res.Error)
		}
		if fake.DryRuns != 0 {
			t.Fatal("cluster contacted after policy deny")
		}
	})
	t.Run("rbac", func(t *testing.T) {
		fake := NewFakeClient()
		fake.Deny = func(verb, kind, namespace, name string) error {
			return engineError(CodeRBACDenied, "RoleBinding does not allow apply", http.StatusForbidden)
		}
		res := Execute(context.Background(), baseApplyReq(fake))
		if res.OK || res.Error == nil || res.Error.Code != CodeRBACDenied {
			t.Fatalf("rbac: %+v", res.Error)
		}
	})
	t.Run("flowforge permission", func(t *testing.T) {
		fake := NewFakeClient()
		req := baseApplyReq(fake)
		req.Permissions = authz.ExpandRoles([]string{authz.RoleViewer})
		res := Execute(context.Background(), req)
		if res.OK || res.Error == nil || res.Error.Code != CodePermissionDenied {
			t.Fatalf("perm: %+v", res.Error)
		}
	})
	t.Run("secret", func(t *testing.T) {
		fake := NewFakeClient()
		req := baseApplyReq(fake)
		req.Manifests = "apiVersion: v1\nkind: Secret\nmetadata:\n  name: leaked\nstringData:\n  token: nope\n"
		res := Execute(context.Background(), req)
		if res.OK || res.Error == nil || res.Error.Code != CodeSecretForbidden {
			t.Fatalf("secret: %+v", res.Error)
		}
		if fake.DryRuns != 0 {
			t.Fatal("secret reached cluster")
		}
	})
}

func TestGetListNamespaceIsolation(t *testing.T) {
	fake := NewFakeClient()
	fake.Seed(Unstructured{
		"apiVersion": "v1", "kind": "ConfigMap",
		"metadata": map[string]any{"name": "cfg", "namespace": "cp-ops-nprd"},
		"data":     map[string]any{"app": "ready"},
	}, FieldManager)
	fake.Seed(Unstructured{
		"apiVersion": "v1", "kind": "ConfigMap",
		"metadata": map[string]any{"name": "other", "namespace": "kube-system"},
		"data":     map[string]any{"token": "should-not-list"},
	}, FieldManager)

	get := Request{
		Operation: "kubernetes.get", ClusterTargetID: "t", Namespace: "cp-ops-nprd",
		Kind: "ConfigMap", Name: "cfg", Permissions: operatorPerms(),
		Policy: policyNS(), Target: targetNS(), Client: fake,
	}
	res := Execute(context.Background(), get)
	if !res.OK || len(res.Items) != 1 {
		t.Fatalf("get: %+v", res)
	}

	cross := get
	cross.Namespace = "kube-system"
	denied := Execute(context.Background(), cross)
	if denied.OK || denied.Error == nil || denied.Error.Code != CodeNamespaceDenied {
		t.Fatalf("cross-ns get: %+v", denied.Error)
	}

	list := Request{
		Operation: "kubernetes.list", ClusterTargetID: "t", Namespace: "cp-ops-nprd",
		Kind: "ConfigMap", Permissions: operatorPerms(),
		Policy: policyNS(), Target: targetNS(), Client: fake,
	}
	listed := Execute(context.Background(), list)
	if !listed.OK || len(listed.Items) != 1 || listed.Resources[0].Name != "cfg" {
		t.Fatalf("list: %+v", listed)
	}
}

func TestOutputsRedactSecretsAndHandleOmitsKubeconfig(t *testing.T) {
	fake := NewFakeClient()
	fake.Seed(Unstructured{
		"apiVersion": "v1", "kind": "ConfigMap",
		"metadata":   map[string]any{"name": "cfg", "namespace": "cp-ops-nprd"},
		"data":       map[string]any{"token": "super-secret"},
		"kubeconfig": "apiVersion: v1",
	}, FieldManager)
	res := Execute(context.Background(), Request{
		Operation: "kubernetes.get", Namespace: "cp-ops-nprd", Kind: "ConfigMap", Name: "cfg",
		Permissions: operatorPerms(), Policy: policyNS(), Target: targetNS(), Client: fake,
	})
	raw, _ := json.Marshal(res)
	if strings.Contains(string(raw), "super-secret") || strings.Contains(string(raw), "apiVersion: v1\nkind: Config") {
		t.Fatalf("leaked: %s", raw)
	}

	h, err := NewHandleFromKubeconfig("h1", "t1", "c1", []byte(`{"kubeconfig":"apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster:\n    server: https://127.0.0.1\n    certificate-authority-data: QQ==\ncontexts:\n- name: ctx\n  context:\n    cluster: c\n    user: u\ncurrent-context: ctx\nusers:\n- name: u\n  user:\n    token: very-secret-token\n"}`), time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	pub, _ := json.Marshal(h)
	if strings.Contains(string(pub), "very-secret-token") || strings.Contains(string(pub), "kubeconfig") || strings.Contains(string(pub), "Bearer") {
		t.Fatalf("handle leaked: %s", pub)
	}
	if h.Expired(time.Now()) {
		t.Fatal("fresh handle expired")
	}
}

func TestMissingClientRejected(t *testing.T) {
	req := baseApplyReq(nil)
	req.Client = nil
	res := Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeMissingClient {
		t.Fatalf("missing client: %+v", res.Error)
	}
}

func TestPolicyDenyDoesNotContactCluster(t *testing.T) {
	fake := NewFakeClient()
	req := baseApplyReq(fake)
	req.Policy.Deny = true
	res := Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodePolicyDenied {
		t.Fatalf("deny: %+v", res.Error)
	}
	if fake.DryRuns != 0 || fake.Applies != 0 {
		t.Fatal("cluster contacted")
	}
}
