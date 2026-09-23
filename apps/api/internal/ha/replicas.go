// Package ha is the multi-replica and production-store boot guard. A
// process that may run beside another pod must use shared Postgres and
// S3 backends. In-memory sessions and stores are process-local, so
// replica counts above one refuse to start. A production-locked process
// refuses those same backends even at one replica. This package does
// not add a second auth path.
package ha

import (
	"fmt"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	// EnvReplicas is the pod count this API process may run beside.
	// Unset means one process. deploy/k8s sets it to at least the
	// Deployment replicas and the HorizontalPodAutoscaler minReplicas.
	EnvReplicas = "FLOWFORGE_REPLICAS"
)

// ParseCount reads FLOWFORGE_REPLICAS. Empty is 1. Zero, negative, and
// non-integers fail closed. The error does not echo the raw value when
// it is longer than a short token, so a mistaken secret is not logged.
func ParseCount(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 1, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > 1000 {
		return 0, fmt.Errorf("%s must be an integer from 1 to 1000", EnvReplicas)
	}
	return n, nil
}

// ManifestSignals is the replica floor declared in deploy/k8s.
type ManifestSignals struct {
	DeploymentReplicas int
	HPAMinReplicas     int
	EnvReplicas        int
}

// ParseManifests reads Deployment spec.replicas, the FLOWFORGE_REPLICAS
// env value on that Deployment, and HorizontalPodAutoscaler minReplicas.
func ParseManifests(deployment, hpa []byte) (ManifestSignals, error) {
	replicas, envCount, err := deploymentSignals(deployment)
	if err != nil {
		return ManifestSignals{}, err
	}
	minReplicas, err := mappingInt(hpa, "spec", "minReplicas")
	if err != nil {
		return ManifestSignals{}, fmt.Errorf("HPA minReplicas: %w", err)
	}
	return ManifestSignals{
		DeploymentReplicas: replicas,
		HPAMinReplicas:     minReplicas,
		EnvReplicas:        envCount,
	}, nil
}

// Floor is the highest of Deployment replicas and HPA minReplicas.
// FLOWFORGE_REPLICAS must be at least that floor: the process boots
// with the env value, and a lower env would hide a multi-replica manifest.
func (s ManifestSignals) Floor() (int, error) {
	if s.DeploymentReplicas < 1 || s.HPAMinReplicas < 1 || s.EnvReplicas < 1 {
		return 0, fmt.Errorf("deployment replicas, HPA minReplicas, and %s must be >= 1", EnvReplicas)
	}
	floor := s.DeploymentReplicas
	if s.HPAMinReplicas > floor {
		floor = s.HPAMinReplicas
	}
	if s.EnvReplicas < floor {
		return 0, fmt.Errorf("%s=%d is below deployment/HPA replica floor %d", EnvReplicas, s.EnvReplicas, floor)
	}
	return s.EnvReplicas, nil
}

// RefuseUnshared fails closed when more than one replica would serve
// with a process-local backend. names are backend labels (session,
// artifact), never secret values. An empty list is shared storage.
// replicas <= 1 does not apply this check (unit tests and one process).
// Production-locked refusal of those same names is RefuseMemoryStores.
func RefuseUnshared(replicas int, names []string) error {
	if replicas <= 1 {
		return nil
	}
	if replicas > 1000 {
		return fmt.Errorf("%s must be an integer from 1 to 1000", EnvReplicas)
	}
	if len(names) == 0 {
		return nil
	}
	return fmt.Errorf("replicas=%d refuse unshared backends (%s); use Postgres and S3", replicas, strings.Join(names, ", "))
}

// RefuseMemoryStores fails closed when a production-locked process would
// serve durable domains from process-local memory. names are backend
// labels only, never DSNs or secrets. Non-production composition
// (APP_ENV=development|dev|local|test and REQUIRE_TLS off) may keep
// memory stores for tests and local dev. There is no production override.
func RefuseMemoryStores(productionLocked bool, names []string) error {
	if !productionLocked || len(names) == 0 {
		return nil
	}
	return fmt.Errorf("production-locked process refuses in-memory stores (%s); set DATABASE_URL for Postgres and an S3 artifact store. APP_ENV=development|dev|local|test without REQUIRE_TLS may use memory for tests and local dev. There is no production override", strings.Join(names, ", "))
}

// ArtifactShared reports whether an artifact backend can be read from
// every replica. s3 is shared. memory and filesystem are pod-local.
// Empty is unshared so a missing classification fails closed.
func ArtifactShared(kind string) bool {
	switch strings.TrimSpace(kind) {
	case "s3", "shared", "postgres":
		return true
	default:
		return false
	}
}

func deploymentSignals(doc []byte) (replicas, envCount int, err error) {
	replicas, err = mappingInt(doc, "spec", "replicas")
	if err != nil {
		return 0, 0, fmt.Errorf("deployment replicas: %w", err)
	}
	raw, ok := findEnvValue(doc, EnvReplicas)
	if !ok {
		return 0, 0, fmt.Errorf("deployment is missing %s", EnvReplicas)
	}
	envCount, err = ParseCount(raw)
	if err != nil {
		return 0, 0, err
	}
	return replicas, envCount, nil
}

func mappingInt(doc []byte, path ...string) (int, error) {
	var root yaml.Node
	if err := yaml.Unmarshal(doc, &root); err != nil {
		return 0, err
	}
	node := &root
	if node.Kind == yaml.DocumentNode && len(node.Content) == 1 {
		node = node.Content[0]
	}
	for _, key := range path {
		next, ok := mapKey(node, key)
		if !ok {
			return 0, fmt.Errorf("missing %s", strings.Join(path, "."))
		}
		node = next
	}
	n, err := strconv.Atoi(strings.TrimSpace(node.Value))
	if err != nil || n < 1 {
		return 0, fmt.Errorf("%s must be an integer >= 1", strings.Join(path, "."))
	}
	return n, nil
}

func mapKey(n *yaml.Node, key string) (*yaml.Node, bool) {
	if n == nil || n.Kind != yaml.MappingNode {
		return nil, false
	}
	for i := 0; i+1 < len(n.Content); i += 2 {
		if n.Content[i].Value == key {
			return n.Content[i+1], true
		}
	}
	return nil, false
}

func findEnvValue(doc []byte, name string) (string, bool) {
	var root yaml.Node
	if err := yaml.Unmarshal(doc, &root); err != nil {
		return "", false
	}
	var found string
	var ok bool
	walkEnv(&root, name, &found, &ok)
	return found, ok
}

func walkEnv(n *yaml.Node, name string, found *string, ok *bool) {
	if n == nil || *ok {
		return
	}
	if n.Kind == yaml.MappingNode {
		envName, hasName := mapKey(n, "name")
		envVal, hasVal := mapKey(n, "value")
		if hasName && hasVal && envName.Value == name && envVal.Kind == yaml.ScalarNode {
			*found = envVal.Value
			*ok = true
			return
		}
	}
	for _, child := range n.Content {
		walkEnv(child, name, found, ok)
	}
}
