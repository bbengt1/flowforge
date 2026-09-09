package kubernetes

import (
	"context"
	"strings"
)

// Unstructured is a redacted-safe Kubernetes object map.
type Unstructured map[string]any

// ApplyOptions is the closed SSA option set. Force is always false.
type ApplyOptions struct {
	FieldManager string
	Force        bool
	DryRun       bool
}

// ListOptions is a bounded list filter.
type ListOptions struct {
	LabelSelector string
}

// ResourceIdentity is the apply/get result Chloe and audit consume.
type ResourceIdentity struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Namespace  string `json:"namespace"`
	Name       string `json:"name"`
	Generation int64  `json:"generation,omitempty"`
}

// ClusterClient is the worker-facing cluster API. Implementations must
// never log or return kubeconfig plaintext.
type ClusterClient interface {
	Apply(ctx context.Context, obj Unstructured, opts ApplyOptions) (Unstructured, error)
	Get(ctx context.Context, kind, namespace, name string) (Unstructured, error)
	List(ctx context.Context, kind, namespace string, opts ListOptions) ([]Unstructured, error)
	// Watch fetches one object using the watch verb. The engine polls Watch
	// until ready, failed, timeout, or cancel. Implementations must not
	// delete or roll back resources.
	Watch(ctx context.Context, kind, namespace, name string) (Unstructured, error)
}

func identityOf(obj Unstructured) ResourceIdentity {
	api, _ := obj["apiVersion"].(string)
	kind, _ := obj["kind"].(string)
	meta, _ := asStringKeyMap(obj["metadata"])
	name, _ := meta["name"].(string)
	ns, _ := meta["namespace"].(string)
	var gen int64
	if n, ok := intField(meta, "generation"); ok {
		gen = n
	}
	return ResourceIdentity{
		APIVersion: strings.TrimSpace(api),
		Kind:       strings.TrimSpace(kind),
		Namespace:  strings.TrimSpace(ns),
		Name:       strings.TrimSpace(name),
		Generation: gen,
	}
}

func restMapping(kind string) (group, version, resource string, ok bool) {
	switch kind {
	case "ConfigMap":
		return "", "v1", "configmaps", true
	case "Service":
		return "", "v1", "services", true
	case "Deployment":
		return "apps", "v1", "deployments", true
	case "StatefulSet":
		return "apps", "v1", "statefulsets", true
	case "DaemonSet":
		return "apps", "v1", "daemonsets", true
	case "Job":
		return "batch", "v1", "jobs", true
	case "CronJob":
		return "batch", "v1", "cronjobs", true
	case "Ingress":
		return "networking.k8s.io", "v1", "ingresses", true
	case "NetworkPolicy":
		return "networking.k8s.io", "v1", "networkpolicies", true
	default:
		return "", "", "", false
	}
}
