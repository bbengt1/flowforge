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
