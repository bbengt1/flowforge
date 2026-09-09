package scripts

import (
	"context"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

func TestEmergencyStopPermissionAndUncertainOutcome(t *testing.T) {
	if err := AuthorizeEmergencyStop(nil, nil); err == nil {
		t.Fatal("empty perms must deny")
	}
	if err := AuthorizeEmergencyStop([]string{authz.PermScriptEmergencyStop}, nil); err != nil {
		t.Fatal(err)
	}
	if err := AuthorizeEmergencyStop([]string{authz.PermScriptEmergencyStop}, map[string]any{
		"kind":   "script",
		"policy": map[string]any{"allowEmergencyStop": false},
	}); err == nil {
		t.Fatal("policy deny must fail closed")
	}

	art, key, profile := publishedPython(t)
	t.Run("stop before dispatch is not success", func(t *testing.T) {
		out := Execute(context.Background(), Request{
			Artifact: art, Source: validPythonInput().Source, Language: LanguagePython,
			Entrypoint: "main.py", SigningKey: key, RuntimeProfile: profile,
			Permissions: operatorPerms(), EmergencyStop: true,
		})
		if out.OK || out.Error == nil || out.Error.Code != CodeEmergencyStopped {
			t.Fatalf("%+v", out)
		}
		if out.Audit["emergencyStop"] != true {
			t.Fatalf("audit = %+v", out.Audit)
		}
	})
	t.Run("uncertain stop is indeterminate", func(t *testing.T) {
		out := Execute(context.Background(), Request{
			Artifact: art, Source: validPythonInput().Source, Language: LanguagePython,
			Entrypoint: "main.py", SigningKey: key, RuntimeProfile: profile,
			Permissions: operatorPerms(), EmergencyStop: true, UnknownOutcome: true,
		})
		if out.OK || out.Error == nil || out.Error.Code != CodeIndeterminate {
			t.Fatalf("%+v", out)
		}
		if out.Audit["uncertain"] != true {
			t.Fatalf("audit = %+v", out.Audit)
		}
	})
	t.Run("canceled run after dispatch is indeterminate", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		out := Execute(ctx, Request{
			Artifact: art, Source: validPythonInput().Source, Language: LanguagePython,
			Entrypoint: "main.py", SigningKey: key, RuntimeProfile: profile,
			Permissions: operatorPerms(), Runtime: cancelingRuntime{},
		})
		if out.OK || out.Error == nil || out.Error.Code != CodeIndeterminate {
			t.Fatalf("%+v", out)
		}
	})
}

type cancelingRuntime struct{}

func (cancelingRuntime) Name() string { return IsolationModeHarness }

func (cancelingRuntime) Run(ctx context.Context, spec IsolationSpec, job IsolatedJob) (IsolatedResult, error) {
	if err := ValidateIsolation(spec); err != nil {
		return IsolatedResult{}, err
	}
	return IsolatedResult{}, ctx.Err()
}
