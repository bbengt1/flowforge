package scripts

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

func testScope(t *testing.T) isolation.Scope {
	t.Helper()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	return scope
}

func approvedPythonProfile() map[string]any {
	return map[string]any{
		"language":             "python",
		"imageDigest":          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"dependencyLockDigest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		"limits":               map[string]any{"cpuMillis": 250, "memoryMib": 256, "timeoutSeconds": 30, "processes": 32},
	}
}

func validPythonInput() PublishInput {
	return PublishInput{
		Language:             LanguagePython,
		Source:               "import json\nprint(json.dumps({\"status\": \"ok\"}))\n",
		Entrypoint:           "main.py",
		RuntimeProfileID:     "66666666-6666-4666-8666-666666666666",
		RuntimeProfileDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		RuntimeProfile:       approvedPythonProfile(),
		TimeoutSeconds:       30,
		InputSchema:          map[string]any{"type": "object", "additionalProperties": false},
		OutputSchema:         map[string]any{"type": "object"},
	}
}

func TestPackageDigestIsContentAddressed(t *testing.T) {
	in := validPythonInput()
	_, raw1, d1, err := Package(in)
	if err != nil {
		t.Fatal(err)
	}
	_, raw2, d2, err := Package(in)
	if err != nil {
		t.Fatal(err)
	}
	if d1 != d2 || string(raw1) != string(raw2) {
		t.Fatalf("digest not deterministic: %s vs %s", d1, d2)
	}
	in.Source += " "
	_, _, d3, err := Package(in)
	if err != nil {
		t.Fatal(err)
	}
	if d3 == d1 {
		t.Fatal("changing source must change digest")
	}
}

func TestSignAndVerify(t *testing.T) {
	key := NewSigningKey()
	_, _, digest, err := Package(validPythonInput())
	if err != nil {
		t.Fatal(err)
	}
	sig, err := SignDigest(key, digest)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(sig, SignaturePrefix) {
		t.Fatalf("signature = %s", sig)
	}
	if !VerifySignature(key, digest, sig) {
		t.Fatal("signature should verify")
	}
	if VerifySignature(key, digest, sig+"00") {
		t.Fatal("tampered signature must fail")
	}
	other := NewSigningKey()
	if VerifySignature(other, digest, sig) {
		t.Fatal("foreign key must fail")
	}
}

func TestSecretInSourceRejected(t *testing.T) {
	in := validPythonInput()
	in.Source = "token = \"ghp_abcdefghijklmnopqrstuvwxyz0123456789\"\n"
	if err := ValidatePublishInput(in); err == nil {
		t.Fatal("expected secret-forbidden")
	} else if ee := asEngineError(err); ee.Code != CodeSecretForbidden {
		t.Fatalf("code = %s", ee.Code)
	}
	if RedactSource(in.Source) == in.Source {
		t.Fatal("token-shaped source should redact")
	}
}

func TestInvalidSourceEntrypointAndProfile(t *testing.T) {
	in := validPythonInput()
	in.Entrypoint = "../main.py"
	if err := ValidatePublishInput(in); err == nil {
		t.Fatal("path entrypoint")
	}
	in = validPythonInput()
	in.Entrypoint = "main.go"
	if err := ValidatePublishInput(in); err == nil {
		t.Fatal("wrong language entrypoint")
	}
	in = validPythonInput()
	in.Source = ""
	if err := ValidatePublishInput(in); err == nil {
		t.Fatal("empty source")
	}
	in = validPythonInput()
	in.RuntimeProfile = approvedPythonProfile()
	in.RuntimeProfile["language"] = "go"
	if err := ValidatePublishInput(in); err == nil {
		t.Fatal("language mismatch")
	}
	in = validPythonInput()
	in.RuntimeProfile["imageDigest"] = "python:3.12"
	if err := ValidatePublishInput(in); err == nil {
		t.Fatal("mutable image tag")
	}
	in = validPythonInput()
	in.InputSchema = map[string]any{"$ref": "#/evil"}
	if err := ValidatePublishInput(in); err == nil {
		t.Fatal("illegal schema keyword")
	}
}

func TestPipelinePublishAndMutableRejection(t *testing.T) {
	ctx := context.Background()
	scope := testScope(t)
	other, err := isolation.Authorize("33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444")
	if err != nil {
		t.Fatal(err)
	}
	key := NewSigningKey()
	p := &Pipeline{Store: NewMemory(), Key: key}
	art, err := p.Publish(ctx, scope, validPythonInput())
	if err != nil {
		t.Fatal(err)
	}
	if art.Digest == "" || art.ScanStatus != ScanClean || art.Status != StatusPublished {
		t.Fatalf("artifact = %+v", art)
	}
	if err := VerifyForDispatch(art, key); err != nil {
		t.Fatal(err)
	}

	again, err := p.Publish(ctx, scope, validPythonInput())
	if err != nil {
		t.Fatal(err)
	}
	if again.ID != art.ID {
		t.Fatal("same digest should reuse the immutable artifact")
	}

	if _, err := p.Store.Get(ctx, other, art.ID); err == nil {
		t.Fatal("cross-workspace get must fail")
	}

	draft, err := p.Store.(DraftPutter).PutDraft(ctx, scope, Artifact{
		Language: LanguagePython, Entrypoint: "main.py", Digest: "sha256:" + strings.Repeat("d", 64),
		Status: StatusDraft, ScanStatus: ScanPending,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyForDispatch(draft, key); err != ErrMutable {
		t.Fatalf("draft verify = %v", err)
	}

	unsigned := art
	unsigned.Signature = ""
	if err := VerifyForDispatch(unsigned, key); err != ErrUnsigned {
		t.Fatalf("unsigned verify = %v", err)
	}
	failed := art
	failed.ScanStatus = ScanFailed
	if err := VerifyForDispatch(failed, key); err != ErrScanFailed {
		t.Fatalf("failed scan verify = %v", err)
	}
	pending := art
	pending.ScanStatus = ScanPending
	if err := VerifyForDispatch(pending, key); err != ErrUnscanned {
		t.Fatalf("pending verify = %v", err)
	}
	revoked := art
	now := time.Now()
	revoked.RevokedAt = &now
	if err := VerifyForDispatch(revoked, key); err != ErrRevoked {
		t.Fatalf("revoked verify = %v", err)
	}
}

func TestPublishNodesPinsAndVerify(t *testing.T) {
	ctx := context.Background()
	scope := testScope(t)
	key := NewSigningKey()
	p := &Pipeline{Store: NewMemory(), Key: key}
	profileID := "66666666-6666-4666-8666-666666666666"
	nodes := []NodeSpec{{
		ID:   "summarize",
		Type: NodePython,
		With: map[string]any{
			"source":           validPythonInput().Source,
			"entrypoint":       "main.py",
			"runtimeProfileId": profileID,
			"timeoutSeconds":   30,
		},
	}}
	profiles := []RuntimePin{{
		ResourceID: profileID,
		VersionID:  "77777777-7777-4777-8777-777777777777",
		Digest:     "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		Spec:       approvedPythonProfile(),
	}}
	versionID := "88888888-8888-4888-8888-888888888888"
	pins, err := p.PublishNodes(ctx, scope, versionID, nodes, profiles)
	if err != nil {
		t.Fatal(err)
	}
	if len(pins) != 1 || pins[0].NodeID != "summarize" {
		t.Fatalf("pins = %+v", pins)
	}
	if err := p.VerifyNodePins(ctx, scope, versionID, nodes); err != nil {
		t.Fatal(err)
	}
	if err := p.VerifyNodePins(ctx, scope, "99999999-9999-4999-8999-999999999999", nodes); err == nil {
		t.Fatal("missing pins must fail")
	}
}

func TestGoSourceRequiresPackage(t *testing.T) {
	if err := ValidateSource(LanguageGo, "func main() {}", "main.go"); err == nil {
		t.Fatal("go source without package")
	}
	if err := ValidateSource(LanguageGo, "package main\nfunc main() {}\n", "main.go"); err != nil {
		t.Fatal(err)
	}
}
