package ssh

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	cryptossh "golang.org/x/crypto/ssh"
)

// Request is one isolated ssh.run execution.
type Request struct {
	SSHTargetID      string
	CommandProfileID string
	Parameters       map[string]any
	TimeoutSeconds   int
	RetryPolicy      RetryPolicy
	Permissions      []string
	Policy           PolicyContext
	Target           TargetContext
	Profile          ProfileContext
	Handle           *Handle
	Transport        Transport
	Resolver         Resolver
	CorrelationID    string
	ActorID          string
	// LeaseLost is the E8.3 stub: after dispatch uncertainty, never re-run.
	LeaseLost bool
}

// RetryPolicy is the explicit node field. Default maxAttempts is 0.
type RetryPolicy struct {
	MaxAttempts int `json:"maxAttempts"`
}

// RetryState documents what E8.2 did versus E8.3 verification.
type RetryState struct {
	MaxAttempts      int    `json:"maxAttempts"`
	ExecutedAttempts int    `json:"executedAttempts"`
	RetrySafe        bool   `json:"retrySafe"`
	Semantics        string `json:"semantics"`
	Note             string `json:"note"`
}

// Result is the redacted engine outcome persisted on the job.
type Result struct {
	OK                bool           `json:"ok"`
	Operation         string         `json:"operation"`
	SSHTargetID       string         `json:"sshTargetId,omitempty"`
	CommandProfileID  string         `json:"commandProfileId,omitempty"`
	ProfileRevision   string         `json:"profileRevision,omitempty"`
	ProfileDigest     string         `json:"profileDigest,omitempty"`
	Hostname          string         `json:"hostname,omitempty"`
	Port              int            `json:"port,omitempty"`
	Username          string         `json:"username,omitempty"`
	ResolvedAddresses []string       `json:"resolvedAddresses,omitempty"`
	ConnectedAddress  string         `json:"connectedAddress,omitempty"`
	ParameterNames    []string       `json:"parameterNames,omitempty"`
	Parameters        map[string]any `json:"parameters,omitempty"`
	CommandDigest     string         `json:"commandDigest,omitempty"`
	Stdout            string         `json:"stdout,omitempty"`
	Stderr            string         `json:"stderr,omitempty"`
	ExitCode          *int           `json:"exitCode,omitempty"`
	StdoutTruncated   bool           `json:"stdoutTruncated,omitempty"`
	PolicyRevision    string         `json:"policyRevision,omitempty"`
	PolicyDigest      string         `json:"policyDigest,omitempty"`
	CorrelationID     string         `json:"correlationId,omitempty"`
	Retry             RetryState     `json:"retry"`
	Audit             map[string]any `json:"audit,omitempty"`
	Error             *EngineError   `json:"error,omitempty"`
}

// Execute authorizes, revalidates policy, resolves+allowlists, then runs one
// bounded, key-only, non-interactive command. It never retries on its own.
func Execute(ctx context.Context, req Request) Result {
	out := Result{
		Operation:        NodeSSHRun,
		SSHTargetID:      strings.TrimSpace(req.SSHTargetID),
		CommandProfileID: strings.TrimSpace(req.CommandProfileID),
		ProfileRevision:  req.Profile.Revision,
		ProfileDigest:    req.Profile.Digest,
		Hostname:         req.Target.Hostname,
		Port:             req.Target.Port,
		PolicyRevision:   req.Policy.Revision,
		PolicyDigest:     req.Policy.Digest,
		CorrelationID:    strings.TrimSpace(req.CorrelationID),
		Retry:            stubRetry(req),
	}
	if out.Port == 0 {
		out.Port = 22
	}

	if req.LeaseLost {
		out.Error = engineError(CodeIndeterminate, "lease was lost after dispatch; the command is not retried (E8.3 verification is not implemented)", http.StatusConflict)
		return finish(req, out)
	}
	if err := authorizeRequest(req); err != nil {
		out.Error = err
		return finish(req, out)
	}
	retry, rerr := normalizeRetry(req)
	if rerr != nil {
		out.Error = rerr
		return finish(req, out)
	}
	out.Retry = retry

	username, uerr := resolveUsername(req)
	if uerr != nil {
		out.Error = uerr
		return finish(req, out)
	}
	out.Username = username

	rendered, renderErr := renderCommand(req)
	if renderErr != nil {
		out.Error = renderErr
		return finish(req, out)
	}
	out.ParameterNames = rendered.Names
	out.Parameters = rendered.Safe
	out.CommandDigest = rendered.Digest

	if verr := ValidatePolicy(req.Policy, req.Target, username); verr != nil {
		out.Error = verr
		return finish(req, out)
	}

	timeout := req.TimeoutSeconds
	if timeout <= 0 {
		timeout = DefaultTimeoutSeconds
	}
	if timeout > MaxTimeoutSeconds {
		timeout = MaxTimeoutSeconds
	}
	if ctx == nil {
		ctx = context.Background()
	}
	var cancel context.CancelFunc
	ctx, cancel = context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()

	resolved, resErr := ResolveHostname(ctx, req.Resolver, req.Target.Hostname)
	if resErr != nil {
		out.Error = resErr
		return finish(req, out)
	}
	out.Hostname = resolved.Hostname
	out.ResolvedAddresses = ipStrings(resolved.Addresses)

	if err := VerifyResolvedAddresses(resolved.Hostname, resolved.Addresses, req.Target.AllowedAddresses, req.Target.AddressesPresent); err != nil {
		out.Error = err
		return finish(req, out)
	}
	if req.Policy.AddressesPresent {
		if err := VerifyResolvedAddresses(resolved.Hostname, resolved.Addresses, req.Policy.Addresses, true); err != nil {
			out.Error = err
			return finish(req, out)
		}
	}

	dialAddr := DialNetworkAddress(resolved.DialIP, out.Port)
	out.ConnectedAddress = dialAddr

	if verr := ValidatePolicy(req.Policy, req.Target, username); verr != nil {
		out.Error = verr
		return finish(req, out)
	}

	transport := req.Transport
	if transport == nil {
		transport = LiveTransport{}
	}
	signer, handleErr := requireSigner(req)
	if handleErr != nil {
		out.Error = handleErr
		return finish(req, out)
	}

	connectTimeout := DefaultConnectTimeout
	if remain := time.Until(deadlineOf(ctx)); remain > 0 && remain < connectTimeout {
		connectTimeout = remain
	}
	sess, connErr := transport.Connect(ctx, ConnectConfig{
		NetworkAddress: dialAddr,
		Username:       username,
		Signer:         signer,
		HostKeySHA256:  req.Target.HostKeySHA256,
		Timeout:        connectTimeout,
	})
	if connErr != nil {
		out.Error = asEngineError(connErr, CodeConnectFailed)
		return finish(req, out)
	}
	defer sess.Close()

	stdout, stderr, exit, runErr := sess.Run(ctx, rendered.Command)
	if runErr != nil {
		out.Error = asEngineError(runErr, CodeCommandFailed)
		return finish(req, out)
	}
	code := exit
	out.ExitCode = &code
	out.Stdout, out.StdoutTruncated = boundText(redactText(stdout), MaxStdoutBytes)
	out.Stderr, _ = boundText(redactText(stderr), MaxStdoutBytes)
	out.OK = exit == 0
	out.Retry.ExecutedAttempts = 1
	return finish(req, out)
}

func finish(req Request, out Result) Result {
	return attachAudit(req, redactResult(out))
}

func redactResult(in Result) Result {
	if in.Parameters != nil {
		if v, ok := RedactValue(in.Parameters).(map[string]any); ok {
			in.Parameters = v
		}
	}
	in.Stdout = redactText(in.Stdout)
	in.Stderr = redactText(in.Stderr)
	return in
}

func authorizeRequest(req Request) *EngineError {
	for _, perm := range RequiredPermissions() {
		if !authz.Allows(req.Permissions, perm) {
			return engineError(CodePermissionDenied, "caller is not authorized for ssh.run", http.StatusForbidden)
		}
	}
	return nil
}

func normalizeRetry(req Request) (RetryState, *EngineError) {
	max := req.RetryPolicy.MaxAttempts
	if max < 0 {
		return RetryState{}, engineError(CodeRetryDenied, "retryPolicy.maxAttempts must be between 0 and 5", http.StatusBadRequest)
	}
	if max > MaxRetryAttempts {
		return RetryState{}, engineError(CodeRetryDenied, "retryPolicy.maxAttempts must be between 0 and 5", http.StatusBadRequest)
	}
	safe := req.Profile.RetrySafe
	if max > 0 && !safe {
		return RetryState{}, engineError(CodeRetryDenied, "retryPolicy.maxAttempts requires a retrySafe profile; E8.3 implements verification and this engine will not blindly re-run", http.StatusBadRequest)
	}
	note := "E8.2 executes the command at most once. Default maxAttempts is 0. E8.3 will add profile-declared verification before any retry."
	if max > 0 {
		note = "retryPolicy.maxAttempts is recorded but E8.2 does not retry. Lease loss is indeterminate."
	}
	return RetryState{
		MaxAttempts:      max,
		ExecutedAttempts: 0,
		RetrySafe:        safe,
		Semantics:        "E8.3",
		Note:             note,
	}, nil
}

func stubRetry(req Request) RetryState {
	state, _ := normalizeRetry(req)
	return state
}

func resolveUsername(req Request) (string, *EngineError) {
	raw := strings.TrimSpace(req.Target.Username)
	if raw == "" && req.Handle != nil {
		raw = strings.TrimSpace(req.Handle.Username)
	}
	user, err := NormalizeUsername(raw, raw != "")
	if err != nil {
		return "", engineError(CodeRootDenied, "remote account must not be root", http.StatusForbidden)
	}
	return user, nil
}

type renderedCommand struct {
	Command string
	Safe    map[string]any
	Names   []string
	Digest  string
}

func renderCommand(req Request) (renderedCommand, *EngineError) {
	var result RenderResult
	var err error
	if req.Profile.Spec != nil {
		result, err = RenderFromSpec(req.Profile.Spec, req.Parameters)
	} else if req.Profile.Template != "" && req.Profile.Schema != nil {
		result, err = Render(req.Profile.Template, req.Profile.Schema, req.Parameters)
	} else {
		return renderedCommand{}, engineError(CodeInvalidTemplate, "command profile revision is required", http.StatusBadRequest)
	}
	if err != nil {
		return renderedCommand{}, mapRenderError(err)
	}
	names := make([]string, 0, len(req.Parameters))
	for name := range req.Parameters {
		names = append(names, name)
	}
	sort.Strings(names)
	sum := sha256.Sum256([]byte(result.Command))
	return renderedCommand{
		Command: result.Command,
		Safe:    result.Parameters,
		Names:   names,
		Digest:  "sha256:" + hex.EncodeToString(sum[:]),
	}, nil
}

func requireSigner(req Request) (cryptossh.Signer, *EngineError) {
	if req.Handle == nil {
		return nil, engineError(CodeHandleForbidden, "workers require an ephemeral credential handle; privateKey is never accepted on the node", http.StatusForbidden)
	}
	s, herr := req.Handle.Signer()
	if herr != nil {
		return nil, asEngineError(herr, CodeHandleForbidden)
	}
	return s, nil
}

func ipStrings(ips []net.IP) []string {
	out := make([]string, 0, len(ips))
	for _, ip := range ips {
		if ip != nil {
			out = append(out, ip.String())
		}
	}
	return out
}

func deadlineOf(ctx context.Context) time.Time {
	if ctx == nil {
		return time.Time{}
	}
	t, _ := ctx.Deadline()
	return t
}
