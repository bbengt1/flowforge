package kubernetes

import "testing"

func TestAllowlistFailClosedWhenPresentAndEmpty(t *testing.T) {
	rules := map[string]any{"allowedNamespaces": []any{}}
	items, present := Namespaces(rules)
	if !present {
		t.Fatal("empty array must count as present")
	}
	if Allowed(items, "prod") {
		t.Fatal("empty allowlist must deny")
	}
}

func TestAllowlistAbsentIsNotPresent(t *testing.T) {
	items, present := Namespaces(map[string]any{"deny": true})
	if present || len(items) != 0 {
		t.Fatalf("absent key should not be present: %v %v", items, present)
	}
}

func TestAliasKeys(t *testing.T) {
	items, present := Namespaces(map[string]any{"namespaces": []string{"cp-ops-nprd"}})
	if !present || !Allowed(items, "cp-ops-nprd") {
		t.Fatalf("alias = %v present=%v", items, present)
	}
	kinds, ok := Kinds(map[string]any{"kinds": []string{"Deployment"}})
	if !ok || !Allowed(kinds, "deployment") {
		t.Fatalf("kinds alias = %v", kinds)
	}
	verbs, ok := Verbs(map[string]any{"allowedVerbs": []string{"apply"}})
	if !ok || !Allowed(verbs, "apply") {
		t.Fatalf("verbs = %v", verbs)
	}
}

func TestKindAndVerbAllowlists(t *testing.T) {
	if !KindAllowed("Deployment") || KindAllowed("Secret") || KindAllowed("ClusterRole") {
		t.Fatal("engine kind allowlist")
	}
	if !VerbAllowed("apply") || VerbAllowed("delete") {
		t.Fatal("engine verb allowlist")
	}
	images, ok := Images(map[string]any{"allowedImages": []string{"registry.example.com/api"}})
	if !ok || !imageAllowed(images, "registry.example.com/api@sha256:"+stringsRepeat("a", 64)) {
		t.Fatalf("images = %v", images)
	}
	hosts, ok := IngressHosts(map[string]any{"ingressHosts": []string{"app.example.com"}})
	if !ok || !Allowed(hosts, "app.example.com") {
		t.Fatalf("hosts = %v", hosts)
	}
	if !ValidNamespace("cp-ops-nprd") || ValidNamespace("kube_system") || ValidNamespace("") {
		t.Fatal("namespace format")
	}
	tmpl, err := NormalizeRoleTemplate("")
	if err != nil || tmpl != RoleTemplateNamespaceRunner {
		t.Fatalf("default template: %s %v", tmpl, err)
	}
	if _, err := NormalizeRoleTemplate("cluster-admin"); err == nil {
		t.Fatal("cluster-admin template must be rejected")
	}
}
