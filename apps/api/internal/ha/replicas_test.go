package ha

import (
	"os"
	"strings"
	"testing"
)

func TestParseCount(t *testing.T) {
	n, err := ParseCount("")
	if err != nil || n != 1 {
		t.Fatalf("empty = %d %v", n, err)
	}
	n, err = ParseCount("2")
	if err != nil || n != 2 {
		t.Fatalf("2 = %d %v", n, err)
	}
	if _, err := ParseCount("0"); err == nil {
		t.Fatal("zero must fail closed")
	}
	if _, err := ParseCount("nope"); err == nil {
		t.Fatal("non-integer must fail closed")
	}
	secret := "flowforge-test-job-binding-32b!!"
	_, err = ParseCount(secret)
	if err == nil {
		t.Fatal("secret-shaped value must fail closed")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("error must not echo the value: %v", err)
	}
}

func TestRefuseUnsharedMemoryAndShared(t *testing.T) {
	if err := RefuseUnshared(1, []string{"session"}); err != nil {
		t.Fatalf("one replica may use memory: %v", err)
	}
	if err := RefuseUnshared(0, []string{"session"}); err != nil {
		t.Fatalf("unset replica count may use memory: %v", err)
	}
	if err := RefuseUnshared(2, nil); err != nil {
		t.Fatalf("shared backends: %v", err)
	}
	err := RefuseUnshared(2, []string{"session", "artifact"})
	if err == nil {
		t.Fatal("memory sessions must fail closed above one replica")
	}
	if !strings.Contains(err.Error(), "session") || !strings.Contains(err.Error(), "artifact") {
		t.Fatalf("error = %v", err)
	}
	if strings.Contains(err.Error(), "JOB_BINDING_SECRET") || strings.Contains(err.Error(), "sticky") {
		t.Fatalf("error = %v", err)
	}
	if ArtifactShared("s3") != true || ArtifactShared("memory") || ArtifactShared("filesystem") || ArtifactShared("") {
		t.Fatal("artifact classification")
	}
}

func TestDeployManifestFloorRefusesMemory(t *testing.T) {
	deployment, err := os.ReadFile("../../../../deploy/k8s/api-deployment.yaml")
	if err != nil {
		t.Fatal(err)
	}
	hpa, err := os.ReadFile("../../../../deploy/k8s/api-hpa.yaml")
	if err != nil {
		t.Fatal(err)
	}
	signals, err := ParseManifests(deployment, hpa)
	if err != nil {
		t.Fatal(err)
	}
	if signals.DeploymentReplicas < 2 || signals.HPAMinReplicas < 2 {
		t.Fatalf("manifest floor = %+v", signals)
	}
	floor, err := signals.Floor()
	if err != nil || floor < 2 {
		t.Fatalf("floor = %d %v", floor, err)
	}
	if err := RefuseUnshared(floor, []string{"session"}); err == nil {
		t.Fatal("deployment/HPA floor must refuse a memory session")
	}
	if err := RefuseUnshared(floor, nil); err != nil {
		t.Fatalf("postgres/s3 path: %v", err)
	}
	low := signals
	low.EnvReplicas = 1
	if _, err := low.Floor(); err == nil {
		t.Fatal("FLOWFORGE_REPLICAS below the HPA minReplicas must fail closed")
	}
}
