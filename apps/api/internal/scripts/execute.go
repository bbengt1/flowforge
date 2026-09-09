package scripts

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// Request is one isolated script.python / script.go execution.
type Request struct {
	Artifact           Artifact
	Source             string
	Language           string
	Entrypoint         string
	SigningKey         []byte
	RuntimeProfile     map[string]any
	RuntimeProfileID   string
	NodeLimits         NodeLimits
	Permissions        []string
	PolicyEgress       EgressPolicy
	Runtime            IsolationRuntime
	Builder            ControlledBuilder
	CorrelationID      string
	ActorID            string
	Input              map[string]any
	InputSchema        map[string]any
	OutputSchema       map[string]any
	Handles            []Handle
	ExtraEnv           map[string]string
	RetryPolicy        RetryPolicy
	RetrySafe          bool
	IdempotencyKey     string
	Verification       *VerificationSpec
	PriorOutput        map[string]any
	Attempt            int
	LeaseLost          bool
	UnknownOutcome     bool
	PriorIndeterminate bool
	RequireLiveRuntime bool
	Probes             []IsolationProbe
}

// Result is the redacted engine outcome persisted on the job.
type Result struct {
	OK                   bool              `json:"ok"`
	Operation            string            `json:"operation"`
	Language             string            `json:"language,omitempty"`
	Entrypoint           string            `json:"entrypoint,omitempty"`
	ArtifactID           string            `json:"artifactId,omitempty"`
	ArtifactDigest       string            `json:"artifactDigest,omitempty"`
	SignatureVerified    bool              `json:"signatureVerified"`
	ScanStatus           string            `json:"scanStatus,omitempty"`
	RuntimeProfileID     string            `json:"runtimeProfileId,omitempty"`
	RuntimeProfileDigest string            `json:"runtimeProfileDigest,omitempty"`
	Isolation            IsolationReport   `json:"isolation"`
	Binary               *SignedBinary     `json:"binary,omitempty"`
	Stdout               string            `json:"stdout,omitempty"`
	Stderr               string            `json:"stderr,omitempty"`
	ExitCode             *int              `json:"exitCode,omitempty"`
	Input                map[string]any    `json:"input,omitempty"`
	Output               map[string]any    `json:"output,omitempty"`
	Handles              []map[string]any  `json:"handles,omitempty"`
	Env                  map[string]string `json:"env,omitempty"`
	InputValidated       bool              `json:"inputValidated"`
	OutputValidated      bool              `json:"outputValidated"`
	Retry                RetryState        `json:"retry"`
	CorrelationID        string            `json:"correlationId,omitempty"`
	Audit                map[string]any    `json:"audit,omitempty"`
	Error                *EngineError      `json:"error,omitempty"`
}

// Execute re-verifies the artifact, validates typed I/O, injects scoped
// handles only, then runs the short-lived harness (CI) or a live runtime.
// Retries default to zero. Lease loss is indeterminate and never a blind re-run.
// Artifact revocation / emergency-stop remain E9.4.
func Execute(ctx context.Context, req Request) Result {
	out := Result{
		Operation:            nodeTypeFor(req),
		Language:             languageOf(req),
		Entrypoint:           firstNonEmpty(req.Entrypoint, req.Artifact.Entrypoint),
		ArtifactID:           req.Artifact.ID,
		ArtifactDigest:       req.Artifact.Digest,
		ScanStatus:           req.Artifact.ScanStatus,
		RuntimeProfileID:     firstNonEmpty(req.RuntimeProfileID, req.Artifact.RuntimeProfileID),
		RuntimeProfileDigest: req.Artifact.RuntimeProfileDigest,
		CorrelationID:        strings.TrimSpace(req.CorrelationID),
		Retry:                stubRetry(req),
	}
	if req.LeaseLost || req.UnknownOutcome {
		return leaseLossResult(req, out)
	}
	if err := authorizeExecute(req); err != nil {
		out.Error = err
		return finish(req, out)
	}
	retry, rerr := normalizeRetry(req)
	if rerr != nil {
		out.Error = rerr
		return finish(req, out)
	}
	out.Retry = retry
	if err := ValidateExecutionInput(req.Input, req.InputSchema); err != nil {
		out.Error = asEngineError(err)
		return finish(req, out)
	}
	out.InputValidated = true
	out.Input = cloneObject(req.Input)
	handles, herr := PublicHandles(req.Handles, time.Time{})
	if herr != nil {
		out.Error = asEngineError(herr)
		return finish(req, out)
	}
	out.Handles = handles
	handleIDs := make([]string, 0, len(handles))
	for _, h := range handles {
		if id, _ := h["id"].(string); id != "" {
			handleIDs = append(handleIDs, id)
		}
	}
	env, eerr := RuntimeEnv(req, handleIDs)
	if eerr != nil {
		out.Error = asEngineError(eerr)
		return finish(req, out)
	}
	out.Env = env
	if requestAttempt(req) > 1 {
		if req.Verification == nil {
			out.Error = engineError(CodeRetryDenied, "a later attempt requires declared verification; the script is not re-run.", http.StatusConflict)
			return finish(req, out)
		}
		verify := runVerification(req, *req.Verification)
		out.Retry.Verification = &verify
		switch verify.Outcome {
		case VerifyAlreadyApplied:
			out.OK = true
			out.Output = cloneObject(req.PriorOutput)
			out.OutputValidated = true
			return finish(req, out)
		case VerifySafeToRetry:
			// Fall through to one mutating run.
		default:
			out.Error = engineError(CodeIndeterminate, "verification could not confirm state; the script is not re-run.", http.StatusConflict)
			return finish(req, out)
		}
	}
	if err := VerifyForDispatch(req.Artifact, req.SigningKey); err != nil {
		out.Error = asEngineError(err)
		return finish(req, out)
	}
	out.SignatureVerified = true
	out.ScanStatus = req.Artifact.ScanStatus

	source, srcErr := resolveSource(req)
	if srcErr != nil {
		out.Error = asEngineError(srcErr)
		return finish(req, out)
	}
	entrypoint := out.Entrypoint
	lang := out.Language
	if err := ValidateSource(lang, source, entrypoint); err != nil {
		out.Error = asEngineError(err)
		return finish(req, out)
	}
	if err := denyPackageInstall(source); err != nil {
		out.Error = asEngineError(err)
		return finish(req, out)
	}

	spec, specErr := IsolationFromProfile(lang, req.RuntimeProfile, req.NodeLimits)
	if specErr != nil {
		out.Error = asEngineError(specErr)
		return finish(req, out)
	}
	if len(req.PolicyEgress.Destinations) > 0 {
		if err := ValidateEgressPolicy(req.PolicyEgress); err != nil {
			out.Error = asEngineError(err)
			return finish(req, out)
		}
		spec.Egress = mergeEgress(spec.Egress, req.PolicyEgress)
		spec.DNSConstrained = true
	}
	if req.RequireLiveRuntime {
		spec.Mode = IsolationModeLive
	} else {
		spec.Mode = IsolationModeHarness
	}
	if err := ValidateIsolation(spec); err != nil {
		out.Error = asEngineError(err)
		return finish(req, out)
	}
	out.Isolation = isolationReport(spec)

	var binary *SignedBinary
	if lang == LanguageGo {
		builder := req.Builder
		if builder == nil {
			builder = StubBuilder{}
		}
		bin, berr := builder.Build(ctx, req.Artifact, source, entrypoint, req.SigningKey)
		if berr != nil {
			out.Error = asEngineError(berr)
			return finish(req, out)
		}
		if !VerifyGoBinary(req.SigningKey, req.Artifact, source, entrypoint, bin) {
			out.Error = engineError(CodeArtifactUnsigned, "Go binary signature does not match the published source.", http.StatusBadRequest)
			return finish(req, out)
		}
		binary = &bin
		out.Binary = binary
	}

	runtime := req.Runtime
	if runtime == nil {
		runtime = HarnessRuntime{}
	}
	if req.RequireLiveRuntime && runtime.Name() != IsolationModeLive {
		out.Error = engineError(CodeRunnerNotImplemented, "Live container runtime is not available in this process (CI harness).", http.StatusNotImplemented)
		return finish(req, out)
	}

	if ctx == nil {
		ctx = context.Background()
	}
	var cancel context.CancelFunc
	ctx, cancel = context.WithTimeout(ctx, time.Duration(spec.TimeoutSeconds)*time.Second)
	defer cancel()

	job := IsolatedJob{
		Language:   lang,
		Entrypoint: entrypoint,
		Source:     source,
		Image:      spec.ImageDigest,
		Lock:       spec.DependencyLockDigest,
		Binary:     binary,
		Probes:     req.Probes,
		Input:      cloneObject(req.Input),
		Handles:    handles,
		Env:        env,
	}
	ran, runErr := runtime.Run(ctx, spec, job)
	if runErr != nil {
		if ee := asEngineError(runErr); ee != nil {
			out.Error = ee
		} else {
			out.Error = engineError(CodeIsolationDenied, "isolated runner failed.", http.StatusForbidden)
		}
		return finish(req, out)
	}
	out.OK = ran.OK
	out.Stdout = ran.Stdout
	out.Stderr = ran.Stderr
	code := ran.ExitCode
	out.ExitCode = &code
	if ran.Binary != nil {
		out.Binary = ran.Binary
	}
	parsed, safe, oerr := ValidateExecutionOutput(ran.Stdout, req.OutputSchema)
	if oerr != nil {
		out.OK = false
		out.Stdout = safe
		out.Error = asEngineError(oerr)
		return finish(req, out)
	}
	out.Output = parsed
	out.OutputValidated = true
	out.Stdout = safe
	out.Retry.ExecutedAttempts = requestAttempt(req)
	return finish(req, out)
}

func authorizeExecute(req Request) *EngineError {
	for _, perm := range RequiredPermissions() {
		if !authz.Allows(req.Permissions, perm) {
			return engineError(CodePermissionDenied, "caller is not authorized for script.run.", http.StatusForbidden)
		}
	}
	return nil
}

func languageOf(req Request) string {
	if lang := strings.ToLower(strings.TrimSpace(req.Language)); lang != "" {
		return lang
	}
	if lang := strings.ToLower(strings.TrimSpace(req.Artifact.Language)); lang != "" {
		return lang
	}
	return LanguageForNode(req.Artifact.Language)
}

func nodeTypeFor(req Request) string {
	switch languageOf(req) {
	case LanguageGo:
		return NodeGo
	default:
		return NodePython
	}
}

func resolveSource(req Request) (string, error) {
	packed := packageSource(req.Artifact)
	supplied := strings.TrimSpace(req.Source)
	switch {
	case packed != "" && supplied != "" && packed != req.Source && packed != supplied:
		return "", engineError(CodeArtifactMutable, "Execute source must match the published package.", http.StatusBadRequest)
	case packed != "":
		return packed, nil
	case supplied != "":
		return req.Source, nil
	default:
		return "", engineError(CodeInvalidSource, "published package source is required.", http.StatusBadRequest)
	}
}

func packageSource(art Artifact) string {
	if len(art.Package) == 0 {
		return ""
	}
	var payload PackagePayload
	if err := unmarshalPackage(art.Package, &payload); err != nil {
		return ""
	}
	return payload.Source
}

func unmarshalPackage(raw []byte, out *PackagePayload) error {
	if len(raw) == 0 || out == nil {
		return ErrInvalid
	}
	return json.Unmarshal(raw, out)
}

func mergeEgress(base, extra EgressPolicy) EgressPolicy {
	out := base
	out.DNSConstrained = true
	seen := map[string]struct{}{}
	for _, rule := range out.Destinations {
		seen[rule.Host+":"+itoa(rule.Port)] = struct{}{}
	}
	for _, rule := range extra.Destinations {
		key := rule.Host + ":" + itoa(rule.Port)
		if _, ok := seen[key]; ok {
			continue
		}
		out.Destinations = append(out.Destinations, rule)
	}
	return out
}

func finish(req Request, out Result) Result {
	out.Stdout = RedactSource(out.Stdout)
	out.Stderr = RedactSource(out.Stderr)
	out.Input = redactObject(out.Input)
	out.Output = redactObject(out.Output)
	if out.Handles != nil {
		cleaned := make([]map[string]any, 0, len(out.Handles))
		for _, h := range out.Handles {
			if err := rejectPublicSecret(h); err != nil {
				continue
			}
			cleaned = append(cleaned, redactObject(h))
		}
		out.Handles = cleaned
	}
	out.Env = redactEnv(out.Env)
	out.Audit = runAudit(req, out)
	return out
}

func runAudit(req Request, out Result) map[string]any {
	audit := map[string]any{
		"language":             out.Language,
		"entrypoint":           out.Entrypoint,
		"artifactDigest":       out.ArtifactDigest,
		"signatureVerified":    out.SignatureVerified,
		"scanStatus":           out.ScanStatus,
		"runtimeProfileId":     out.RuntimeProfileID,
		"runtimeProfileDigest": out.RuntimeProfileDigest,
		"isolationMode":        out.Isolation.Mode,
		"uid":                  out.Isolation.UID,
		"readOnlyRootFS":       out.Isolation.ReadOnlyRootFS,
		"noNewPrivs":           out.Isolation.NoNewPrivs,
		"inputValidated":       out.InputValidated,
		"outputValidated":      out.OutputValidated,
		"retrySafe":            out.Retry.RetrySafe,
		"retryAllowed":         out.Retry.Allowed,
		"verificationDeclared": out.Retry.VerificationDeclared,
		"correlationId":        out.CorrelationID,
		"ok":                   out.OK,
	}
	if req.ActorID != "" {
		audit["actorId"] = req.ActorID
	}
	if out.Error != nil {
		audit["errorCode"] = out.Error.Code
	}
	if out.Binary != nil {
		audit["binaryDigest"] = out.Binary.Digest
		audit["binaryStub"] = out.Binary.Stub
	}
	if out.Retry.Verification != nil {
		audit["verificationOutcome"] = out.Retry.Verification.Outcome
	}
	if len(out.Handles) > 0 {
		ids := make([]string, 0, len(out.Handles))
		for _, h := range out.Handles {
			if id, _ := h["id"].(string); id != "" {
				ids = append(ids, id)
			}
		}
		audit["handleIds"] = ids
	}
	return audit
}

func cloneObject(in map[string]any) map[string]any {
	if in == nil {
		return nil
	}
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [12]byte
	i := len(buf)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
