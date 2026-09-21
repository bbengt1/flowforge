package runner

import (
	"bytes"
	"crypto/x509"
	"errors"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/scripts"
)

// Script job configuration status codes. These are safe to log.
const (
	ScriptJobsConfigured         = "configured"
	ScriptJobsAPIUnconfigured    = "api-unconfigured"
	ScriptJobsTokenUnreadable    = "token-unreadable"
	ScriptJobsTokenInvalid       = "token-invalid"
	ScriptJobsCAUnreadable       = "ca-unreadable"
	ScriptJobsNamespaceInvalid   = "namespace-invalid"
	ScriptJobsTemplateUnreadable = "template-unreadable"
	ScriptJobsAPIServerInvalid   = "api-server-invalid"
	ScriptJobsTokenWithoutAPI    = "token-without-api"
)

// ScriptRuntimeFromEnv wires script.python / script.go to isolated Job
// creation. A missing API server returns a runtime that fails closed at
// execution (no in-process harness fallback). A half-configured token or
// an unreadable template is a boot error. Returned errors are static and
// do not include token or CA bytes.
func ScriptRuntimeFromEnv(getenv func(string) string, readFile func(string) ([]byte, error)) (scripts.IsolationRuntime, string, error) {
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	template := scripts.EmbeddedScriptJobTemplate()
	if path := strings.TrimSpace(getenv("SCRIPT_RUNNER_TEMPLATE")); path != "" {
		if readFile == nil {
			return nil, ScriptJobsTemplateUnreadable, errors.New("script runner template is unreadable")
		}
		body, err := readFile(path)
		if err != nil || len(bytes.TrimSpace(body)) == 0 {
			return nil, ScriptJobsTemplateUnreadable, errors.New("script runner template is unreadable")
		}
		template = body
	}
	ns := strings.TrimSpace(getenv("SCRIPT_RUNNER_NAMESPACE"))
	if ns == "" {
		ns = "flowforge"
	}
	host := strings.TrimSpace(getenv("SCRIPT_RUNNER_API_SERVER"))
	tokenFile := strings.TrimSpace(getenv("SCRIPT_RUNNER_TOKEN_FILE"))
	if host == "" && tokenFile == "" {
		return scripts.KubernetesJobRuntime{Template: template, Namespace: ns}, ScriptJobsAPIUnconfigured, nil
	}
	if host == "" && tokenFile != "" {
		return nil, ScriptJobsTokenWithoutAPI, errors.New("script runner token file requires an API server")
	}
	if tokenFile == "" {
		return nil, ScriptJobsTokenInvalid, errors.New("script runner API token is missing")
	}
	if readFile == nil {
		return nil, ScriptJobsTokenUnreadable, errors.New("script runner token file is unreadable")
	}
	tokenRaw, err := readFile(tokenFile)
	if err != nil {
		return nil, ScriptJobsTokenUnreadable, errors.New("script runner token file is unreadable")
	}
	if len(tokenRaw) > 8192 {
		return nil, ScriptJobsTokenInvalid, errors.New("script runner API token is missing")
	}
	token := strings.TrimSpace(string(tokenRaw))
	var ca []byte
	if caFile := strings.TrimSpace(getenv("SCRIPT_RUNNER_CA_FILE")); caFile != "" {
		ca, err = readFile(caFile)
		if err != nil || len(ca) == 0 || len(ca) > 1<<16 {
			return nil, ScriptJobsCAUnreadable, errors.New("script runner CA file is unreadable")
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(ca) {
			return nil, ScriptJobsCAUnreadable, errors.New("script runner CA file is unreadable")
		}
	}
	client, err := scripts.NewAPIJobClient(scripts.APIJobConfig{
		Host:      host,
		TokenFile: tokenFile,
		Token:     token,
		CAData:    ca,
		Namespace: ns,
	})
	if err != nil {
		msg := err.Error()
		switch {
		case strings.Contains(msg, "namespace"):
			return nil, ScriptJobsNamespaceInvalid, errors.New("script runner namespace is invalid")
		case strings.Contains(msg, "https"):
			return nil, ScriptJobsAPIServerInvalid, errors.New("script runner API server must be https")
		default:
			return nil, ScriptJobsTokenInvalid, errors.New("script runner API token is missing")
		}
	}
	return scripts.KubernetesJobRuntime{
		Template:  template,
		Namespace: ns,
		Submitter: client,
	}, ScriptJobsConfigured, nil
}
