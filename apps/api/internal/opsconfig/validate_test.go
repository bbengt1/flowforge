package opsconfig

import "testing"

func TestNormalizeSpecRejectsUnknownFieldsAndInterpolation(t *testing.T) {
	_, _, err := NormalizeSpec(KindCommandProfile, map[string]any{
		"parameterSchema": map[string]any{"type": "object"},
		"template":        "echo $(whoami)",
	})
	if err == nil {
		t.Fatal("expected interpolation rejection")
	}
	_, _, err = NormalizeSpec(KindClusterTarget, map[string]any{
		"credentialId": "11111111-1111-4111-8111-111111111111",
		"endpoint":     map[string]any{"apiServer": "https://kube.example"},
		"extra":        true,
	})
	if err == nil {
		t.Fatal("expected unknown field rejection")
	}
}

func TestNormalizeSpecStableDigest(t *testing.T) {
	spec := map[string]any{
		"recipientPolicy": map[string]any{"emails": []string{"ops@example.com"}},
	}
	a, da, err := NormalizeSpec(KindRecipientList, spec)
	if err != nil {
		t.Fatal(err)
	}
	b, db, err := NormalizeSpec(KindRecipientList, spec)
	if err != nil {
		t.Fatal(err)
	}
	if da != db || da == "" || a["recipientPolicy"] == nil || b["recipientPolicy"] == nil {
		t.Fatalf("digest mismatch %s %s", da, db)
	}
}

func TestNormalizeClusterTargetAndKubernetesPolicy(t *testing.T) {
	cred := "11111111-1111-4111-8111-111111111111"
	_, _, err := NormalizeSpec(KindClusterTarget, map[string]any{
		"credentialId":      cred,
		"endpoint":          map[string]any{"apiServer": "https://kube.example"},
		"allowedNamespaces": []any{},
	})
	if err == nil {
		t.Fatal("empty allowedNamespaces must be rejected")
	}
	spec, _, err := NormalizeSpec(KindClusterTarget, map[string]any{
		"credentialId":      cred,
		"endpoint":          map[string]any{"apiServer": "https://kube.example"},
		"allowedNamespaces": []any{"cp-ops-nprd"},
		"serviceAccount":    map[string]any{"name": "flowforge-runner", "namespace": "cp-ops-nprd"},
	})
	if err != nil {
		t.Fatal(err)
	}
	sa, _ := spec["serviceAccount"].(map[string]any)
	if sa["roleTemplate"] != "namespace-scoped-runner" {
		t.Fatalf("default roleTemplate = %+v", sa)
	}

	_, _, err = NormalizeSpec(KindPolicy, map[string]any{
		"kind":   "kubernetes",
		"policy": map[string]any{"allowedNamespaces": []any{}, "extra": true},
	})
	if err == nil {
		t.Fatal("empty/unknown kubernetes policy keys must be rejected")
	}
	out, _, err := NormalizeSpec(KindPolicy, map[string]any{
		"kind": "kubernetes",
		"policy": map[string]any{
			"namespaces":          []any{"prod"},
			"kinds":               []any{"Deployment"},
			"verbs":               []any{"apply"},
			"allowedImages":       []any{"registry.example.com/api"},
			"allowedIngressHosts": []any{"app.example.com"},
			"deny":                false,
			"requireApproval":     true,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	rules, _ := out["policy"].(map[string]any)
	if _, ok := rules["allowedNamespaces"]; !ok {
		t.Fatalf("canonical namespaces missing: %+v", rules)
	}
	if err := ValidateReady(KindPolicy, map[string]any{"kind": "kubernetes", "policy": map[string]any{"requireApproval": true}}); err == nil {
		t.Fatal("publish must require namespace allowlist")
	}
	if err := ValidateReady(KindPolicy, map[string]any{"kind": "kubernetes", "policy": map[string]any{"deny": true}}); err != nil {
		t.Fatalf("deny-all is ready: %v", err)
	}
	if err := TargetNamespacesConsistent(
		map[string]any{"allowedNamespaces": []string{"staging"}},
		map[string]any{"kind": "kubernetes", "policy": map[string]any{"allowedNamespaces": []string{"prod"}}},
	); err == nil {
		t.Fatal("inconsistent namespaces must fail")
	}
	redacted := RedactSpec(map[string]any{"credentialId": cred, "kubeconfig": "apiVersion: v1"})
	if _, ok := redacted["kubeconfig"]; ok {
		t.Fatal("kubeconfig must be stripped")
	}
	schema := map[string]any{
		"parameterSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"password": map[string]any{"type": "string"},
				"token":    map[string]any{"type": "string"},
			},
		},
	}
	kept := RedactSpec(schema)
	props, _ := kept["parameterSchema"].(map[string]any)["properties"].(map[string]any)
	if props["password"] == nil || props["token"] == nil {
		t.Fatalf("schema property names must be preserved: %+v", kept)
	}
	nested := RedactSpec(map[string]any{
		"schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"kubeconfig": map[string]any{"type": "string"},
			},
			"default": map[string]any{"kubeconfig": "apiVersion: v1\nkind: Config\n"},
		},
	})
	def, _ := nested["schema"].(map[string]any)["default"].(map[string]any)
	if _, leaked := def["kubeconfig"]; leaked {
		t.Fatal("nested kubeconfig value must be stripped")
	}
	arrLeak := RedactSpec(map[string]any{
		"schema": map[string]any{"default": map[string]any{"password": []any{"hunter2"}}},
	})
	if def2, _ := arrLeak["schema"].(map[string]any)["default"].(map[string]any); def2["password"] != nil {
		t.Fatal("non-string secret values must be stripped outside properties")
	}
	origNS := []string{"prod"}
	cloned := RedactSpec(map[string]any{"allowedNamespaces": origNS})
	gotNS := cloned["allowedNamespaces"].([]string)
	gotNS[0] = "mutated"
	if origNS[0] != "prod" {
		t.Fatal("typed slices must be cloned")
	}
	prop, _ := nested["schema"].(map[string]any)["properties"].(map[string]any)
	if prop["kubeconfig"] == nil {
		t.Fatal("schema property named kubeconfig must be kept")
	}
	props["password"] = "mutated"
	if schema["parameterSchema"].(map[string]any)["properties"].(map[string]any)["password"].(map[string]any)["type"] != "string" {
		t.Fatal("redacted spec must be a deep copy")
	}
	for _, bad := range []string{"tomorrow", "PT1H1H", "P1DT"} {
		_, _, err = NormalizeSpec(KindPolicy, map[string]any{
			"kind":   "kubernetes",
			"policy": map[string]any{"allowedNamespaces": []any{"prod"}, "expiresIn": bad},
		})
		if err == nil {
			t.Fatalf("invalid expiresIn %q must be rejected", bad)
		}
	}
}

func TestNormalizeSSHTargetAndCommandProfile(t *testing.T) {
	cred := "11111111-1111-4111-8111-111111111111"
	_, _, err := NormalizeSpec(KindSSHTarget, map[string]any{
		"credentialId": cred, "hostname": "bastion.example.com",
		"hostKeyFingerprint": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		"allowedAddresses":   []any{},
	})
	if err == nil {
		t.Fatal("empty allowedAddresses must be rejected")
	}
	spec, _, err := NormalizeSpec(KindSSHTarget, map[string]any{
		"credentialId": cred, "hostname": "Bastion.Example.com",
		"hostKeyFingerprint": "SHA256:0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
		"allowedAddresses":   []any{"203.0.113.10"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if spec["hostname"] != "bastion.example.com" {
		t.Fatalf("hostname = %v", spec["hostname"])
	}
	fp, _ := spec["hostKeyFingerprint"].(string)
	if fp != "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" {
		t.Fatalf("fingerprint = %s", fp)
	}
	_, _, err = NormalizeSpec(KindSSHTarget, map[string]any{
		"credentialId": cred, "hostname": "bastion.example.com",
		"hostKeyFingerprint": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		"username":           "root",
	})
	if err == nil {
		t.Fatal("root username must be rejected")
	}

	_, _, err = NormalizeSpec(KindCommandProfile, map[string]any{
		"parameterSchema": map[string]any{"type": "object", "properties": map[string]any{"unit": map[string]any{"type": "string"}}},
		"template":        "echo $(whoami)",
	})
	if err == nil {
		t.Fatal("interpolation must be rejected")
	}
	out, _, err := NormalizeSpec(KindCommandProfile, map[string]any{
		"parameterSchema": map[string]any{
			"type":       "object",
			"properties": map[string]any{"unit": map[string]any{"type": "string", "pattern": `[A-Za-z0-9._-]+`}},
			"required":   []any{"unit"},
		},
		"template": "systemctl restart {unit}",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateSSHRunParameters(out, map[string]any{"unit": "api; rm -rf /"}); err == nil {
		t.Fatal("values outside schema must be rejected")
	}
	if err := ValidateSSHRunParameters(out, map[string]any{"unit": "nginx"}); err != nil {
		t.Fatal(err)
	}
	redacted := RedactSpec(map[string]any{"privateKey": "-----BEGIN", "passphrase": "x", "hostname": "bastion.example.com"})
	if _, ok := redacted["privateKey"]; ok {
		t.Fatal("privateKey must be stripped")
	}
	if _, ok := redacted["passphrase"]; ok {
		t.Fatal("passphrase must be stripped")
	}
}

func TestExtractRefsFromWorkflowYAML(t *testing.T) {
	src := `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: restart-api-rollout
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: restart
      type: kubernetes.apply
      name: Restart API
      with:
        clusterTargetId: 11111111-1111-4111-8111-111111111111
        namespace: cp-ops-nprd
        dryRun: server
        manifests: |
          apiVersion: apps/v1
          kind: Deployment
          metadata:
            name: api
  edges: []
`
	refs := ExtractRefs(src)
	if len(refs) != 1 || refs[0].Kind != KindClusterTarget || refs[0].ResourceID != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("refs = %+v", refs)
	}
}
