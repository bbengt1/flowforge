package kubernetes

import "testing"

func policyNS() PolicyContext {
	return PolicyContext{
		Namespaces: []string{"cp-ops-nprd"}, NamespacesPresent: true,
		Kinds: []string{"ConfigMap", "Service", "Deployment", "Ingress"}, KindsPresent: true,
		Verbs: []string{"apply", "get", "list"}, VerbsPresent: true,
		Images: []string{"registry.example.com/api"}, ImagesPresent: true,
		IngressHosts: []string{"app.example.com"}, IngressHostsPresent: true,
	}
}

func targetNS() TargetContext {
	return TargetContext{ID: "t1", Namespaces: []string{"cp-ops-nprd"}, NamespacesPresent: true}
}

func TestValidateDocumentsDenials(t *testing.T) {
	pinned := "registry.example.com/api@sha256:" + stringsRepeat("a", 64)
	cases := []struct {
		name string
		src  string
		code string
		pol  PolicyContext
	}{
		{
			name: "secret stringData",
			src:  "apiVersion: v1\nkind: Secret\nmetadata:\n  name: leaked\nstringData:\n  token: nope\n",
			code: CodeSecretForbidden,
		},
		{
			name: "cluster role",
			src:  "apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: admin\n",
			code: CodeKindDenied,
		},
		{
			name: "namespace object",
			src:  "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: new-ns\n",
			code: CodeKindDenied,
		},
		{
			name: "webhook",
			src:  "apiVersion: admissionregistration.k8s.io/v1\nkind: ValidatingWebhookConfiguration\nmetadata:\n  name: hook\n",
			code: CodeKindDenied,
		},
		{
			name: "namespace mismatch",
			src:  "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\n  namespace: other\n",
			code: CodeNamespaceDenied,
		},
		{
			name: "latest tag",
			src:  "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  template:\n    spec:\n      containers:\n      - name: api\n        image: registry.example.com/api:latest\n",
			code: CodeImageDenied,
		},
		{
			name: "unpinned image",
			src:  "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  template:\n    spec:\n      containers:\n      - name: api\n        image: registry.example.com/api:1.2.3\n",
			code: CodeImageDenied,
		},
		{
			name: "image not allowlisted",
			src:  "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  template:\n    spec:\n      containers:\n      - name: api\n        image: " + pinned + "\n",
			code: CodeImageDenied,
			pol: PolicyContext{
				Namespaces: []string{"cp-ops-nprd"}, NamespacesPresent: true,
				ImagesPresent: true, Images: []string{"registry.example.com/other"},
			},
		},
		{
			name: "privileged",
			src:  "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  template:\n    spec:\n      containers:\n      - name: api\n        image: " + pinned + "\n        securityContext:\n          privileged: true\n",
			code: CodeWorkloadDenied,
		},
		{
			name: "hostPath",
			src:  "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  template:\n    spec:\n      containers:\n      - name: api\n        image: " + pinned + "\n      volumes:\n      - name: host\n        hostPath:\n          path: /etc\n",
			code: CodeWorkloadDenied,
		},
		{
			name: "hostNetwork",
			src:  "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  template:\n    spec:\n      hostNetwork: true\n      containers:\n      - name: api\n        image: " + pinned + "\n",
			code: CodeWorkloadDenied,
		},
		{
			name: "cap add",
			src:  "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  template:\n    spec:\n      containers:\n      - name: api\n        image: " + pinned + "\n        securityContext:\n          capabilities:\n            add: [NET_ADMIN]\n",
			code: CodeWorkloadDenied,
		},
		{
			name: "ingress snippet",
			src:  "apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: web\n  annotations:\n    nginx.ingress.kubernetes.io/configuration-snippet: |\n      more_set_headers \"x: 1\";\nspec:\n  rules:\n  - host: app.example.com\n    http:\n      paths:\n      - path: /\n        pathType: Prefix\n        backend:\n          service:\n            name: api\n            port:\n              number: 80\n",
			code: CodeIngressDenied,
		},
		{
			name: "ingress host denied",
			src:  "apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: web\nspec:\n  rules:\n  - host: evil.example.com\n    http:\n      paths:\n      - path: /\n        pathType: Prefix\n        backend:\n          service:\n            name: api\n            port:\n              number: 80\n",
			code: CodeIngressDenied,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			docs, err := ParseDocuments(tc.src)
			if err != nil && tc.code == CodeSecretForbidden && err.Code == CodeSecretForbidden {
				// parser is allowed to accept; validator must deny
			} else if err != nil {
				if err.Code != tc.code {
					t.Fatalf("parse err = %+v want %s", err, tc.code)
				}
				return
			}
			pol := tc.pol
			if pol.Namespaces == nil {
				pol = policyNS()
			}
			got := ValidateDocuments(ValidationInput{
				Operation: "apply",
				Namespace: "cp-ops-nprd",
				Docs:      docs,
				Policy:    pol,
				Target:    targetNS(),
			})
			if got == nil || got.Code != tc.code {
				t.Fatalf("validate = %+v want %s", got, tc.code)
			}
		})
	}
}

func TestValidatePinnedAllowlistedImage(t *testing.T) {
	digest := stringsRepeat("b", 64)
	src := "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  template:\n    spec:\n      containers:\n      - name: api\n        image: registry.example.com/api@sha256:" + digest + "\n"
	docs, err := ParseDocuments(src)
	if err != nil {
		t.Fatal(err)
	}
	if got := ValidateDocuments(ValidationInput{
		Operation: "apply", Namespace: "cp-ops-nprd", Docs: docs, Policy: policyNS(), Target: targetNS(),
	}); got != nil {
		t.Fatalf("valid image: %+v", got)
	}
}

func stringsRepeat(s string, n int) string {
	out := make([]byte, 0, len(s)*n)
	for i := 0; i < n; i++ {
		out = append(out, s...)
	}
	return string(out)
}
