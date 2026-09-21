package runner

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/httpnotify"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/kubernetes"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/scripts"
	"github.com/bbengt1/flowforge/apps/api/internal/ssh"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// Engines are the existing provider libraries. Nil transports use each
// package's live default. Kube, when set, replaces Handle.Client so tests
// can inject a fake cluster. Script nil uses the in-process harness.
// A live script runtime (KubernetesJobRuntime) creates one isolated Job.
// Mail nil makes notification.email fail closed inside ExecuteEmail.
type Engines struct {
	Kube         func(*kubernetes.Handle) (kubernetes.ClusterClient, error)
	SSH          ssh.Transport
	SSHResolver  ssh.Resolver
	HTTP         httpnotify.RoundTripper
	HTTPResolver httpnotify.Resolver
	Script       scripts.IsolationRuntime
	Mail         httpnotify.Mailer
}

// Dispatcher prepares published pins and calls the existing engines.
// IntegrationEnabled nil means HTTP and notification nodes are enabled.
type Dispatcher struct {
	Ops                opsconfig.Store
	Vault              vault.Store
	Scripts            scripts.Store
	ScriptKey          []byte
	Engines            Engines
	Now                func() time.Time
	IntegrationEnabled *bool
}

func (d *Dispatcher) now() time.Time {
	if d != nil && d.Now != nil {
		return d.Now().UTC()
	}
	return time.Now().UTC()
}

func (d *Dispatcher) httpEnabled() bool {
	if d == nil || d.IntegrationEnabled == nil {
		return true
	}
	return *d.IntegrationEnabled
}

// Execute revalidates the job binding, then dispatches one claimed step.
// Provider calls use published pins only. YAML source is not executed
// when a script package exists.
func (d *Dispatcher) Execute(ctx context.Context, scope isolation.Scope, perms []string, job Job) Decision {
	if err := wfstore.AuthorizeJobBinding(job.Binding, scope.WorkspaceID(), job.Execution.WorkflowVersionID, job.Execution.WorkflowDigest, d.now()); err != nil {
		return classifyBinding(job.Binding, err)
	}
	if job.Job.Status == wfstore.JobWaiting || job.Step.NodeType == "flow.approval" {
		return Decision{Skip: true, Reason: "waiting"}
	}
	if workflow.IsCoreNeutral(job.Step.NodeType) {
		return decideCore(job.Step)
	}
	switch job.Step.NodeType {
	case "kubernetes.apply", "kubernetes.get", "kubernetes.list", "kubernetes.rolloutStatus":
		return d.kubernetes(ctx, scope, perms, job)
	case "ssh.run":
		return d.ssh(ctx, scope, perms, job)
	case scripts.NodePython, scripts.NodeGo:
		return d.script(ctx, scope, perms, job)
	case httpnotify.NodeHTTPRequest, httpnotify.NodeWebhook, httpnotify.NodeEmail:
		if !d.httpEnabled() {
			return fail(CodeIntegrationDisabled, "Integration actions are disabled.")
		}
		if job.Step.NodeType == httpnotify.NodeEmail {
			return d.email(ctx, scope, perms, job)
		}
		return d.http(ctx, scope, perms, job)
	default:
		return fail(CodeUnsupported, "Production runner does not execute this node type.")
	}
}

func decideCore(step wfstore.ExecutionStep) Decision {
	if step.NodeType == "flow.delay" {
		return fail(CodeUnsupported, "Production runner does not schedule durable flow.delay waits.")
	}
	res, errs := workflow.Evaluate(step.NodeType, step.Input, map[string]any{})
	if len(errs) > 0 {
		code := errs[0].Code
		if code == "" {
			code = "eval-failed"
		}
		return fail(code, errs[0].Message)
	}
	out := map[string]any{}
	if res != nil && res.Outputs != nil {
		out = res.Outputs
	}
	if res != nil && res.Terminal != nil {
		switch res.Terminal.Status {
		case "failure", "canceled":
			code := strings.TrimSpace(res.Terminal.Code)
			if code == "" {
				code = res.Terminal.Status
			}
			return Decision{
				Fail:    true,
				Output:  out,
				Error:   map[string]any{"code": code, "message": res.Terminal.Message},
				Message: res.Terminal.Message,
			}
		}
	}
	return Decision{Output: out}
}

func (d *Dispatcher) kubernetes(ctx context.Context, scope isolation.Scope, perms []string, job Job) Decision {
	in := job.Step.Input
	targetID := str(in, "clusterTargetId")
	pins, err := d.pins(ctx, scope, job)
	if err != nil {
		return fail(CodeUnpublishedPin, "published cluster target pin is required")
	}
	targetPin, ok := findPin(pins, opsconfig.KindClusterTarget, targetID)
	if !ok {
		return fail(CodeUnpublishedPin, "published cluster target pin is required")
	}
	target := kubernetes.TargetContextFromSpec(targetPin.ResourceID, targetPin.Spec)
	policy := kubernetes.PolicyContext{}
	if pid := str(in, "policyId"); pid != "" {
		policyPin, found := findPin(pins, opsconfig.KindPolicy, pid)
		if !found {
			return fail(CodeUnpublishedPin, "published policy pin is required")
		}
		rules, _ := policyPin.Spec["policy"].(map[string]any)
		policy = kubernetes.PolicyContextFromRules(rules)
		policy.Revision = versionLabel(policyPin)
		policy.Digest = policyPin.Digest
	}
	cred := strings.TrimSpace(target.CredentialID)
	if cred == "" {
		cred = str(targetPin.Spec, "credentialId")
	}
	plain, dec := d.unlock(ctx, scope, cred)
	if dec.Fail {
		return dec
	}
	defer wipe(plain)
	handle, err := kubernetes.NewHandleFromKubeconfig("runner", targetID, cred, plain, d.now().Add(time.Minute))
	if err != nil {
		return fail(CodeHandleForbidden, "credential handle could not be unlocked")
	}
	var client kubernetes.ClusterClient
	if d.Engines.Kube != nil {
		client, err = d.Engines.Kube(handle)
		if err != nil {
			return fail(CodeHandleForbidden, "credential handle could not be unlocked")
		}
	}
	res := kubernetes.Execute(ctx, kubernetes.Request{
		Operation:       job.Step.NodeType,
		ClusterTargetID: targetID,
		Namespace:       str(in, "namespace"),
		Manifests:       str(in, "manifests"),
		Kind:            str(in, "kind"),
		Name:            str(in, "name"),
		DryRun:          str(in, "dryRun"),
		Wait:            str(in, "wait"),
		TimeoutSeconds:  asInt(in["timeoutSeconds"]),
		Permissions:     perms,
		Policy:          policy,
		Target:          target,
		Client:          client,
		Handle:          handle,
		CorrelationID:   job.Execution.CorrelationID,
		ActorID:         scope.ActorID(),
	})
	return fromEngine(res.OK, errCode(res.Error), errMessage(res.Error), res)
}

func (d *Dispatcher) ssh(ctx context.Context, scope isolation.Scope, perms []string, job Job) Decision {
	in := job.Step.Input
	targetID := str(in, "sshTargetId")
	profileID := str(in, "commandProfileId")
	pins, err := d.pins(ctx, scope, job)
	if err != nil {
		return fail(CodeUnpublishedPin, "published ssh target pin is required")
	}
	targetPin, ok := findPin(pins, opsconfig.KindSSHTarget, targetID)
	if !ok {
		return fail(CodeUnpublishedPin, "published ssh target pin is required")
	}
	profilePin, ok := findPin(pins, opsconfig.KindCommandProfile, profileID)
	if !ok {
		return fail(CodeUnpublishedPin, "published command profile pin is required")
	}
	target := ssh.TargetContextFromSpec(targetPin.ResourceID, targetPin.Spec)
	profile := ssh.ProfileContextFromSpec(profilePin.ResourceID, profilePin.Spec)
	profile.Revision = versionLabel(profilePin)
	profile.Digest = profilePin.Digest
	policy := ssh.PolicyContext{}
	if pid := str(in, "policyId"); pid != "" {
		policyPin, found := findPin(pins, opsconfig.KindPolicy, pid)
		if !found {
			return fail(CodeUnpublishedPin, "published policy pin is required")
		}
		rules, _ := policyPin.Spec["policy"].(map[string]any)
		policy = ssh.PolicyContextFromRules(rules)
		policy.Revision = versionLabel(policyPin)
		policy.Digest = policyPin.Digest
	}
	cred := strings.TrimSpace(target.CredentialID)
	if cred == "" {
		cred = str(targetPin.Spec, "credentialId")
	}
	plain, dec := d.unlock(ctx, scope, cred)
	if dec.Fail {
		return dec
	}
	defer wipe(plain)
	handle, err := ssh.NewHandleFromPrivateKey("runner", targetID, cred, target.Username, plain, d.now().Add(time.Minute))
	if err != nil {
		return fail(CodeHandleForbidden, "credential handle could not be unlocked")
	}
	res := ssh.Execute(ctx, ssh.Request{
		SSHTargetID:      targetID,
		CommandProfileID: profileID,
		Parameters:       asMap(in["parameters"]),
		TimeoutSeconds:   asInt(in["timeoutSeconds"]),
		Permissions:      perms,
		Policy:           policy,
		Target:           target,
		Profile:          profile,
		Handle:           handle,
		Transport:        d.Engines.SSH,
		Resolver:         d.Engines.SSHResolver,
		CorrelationID:    job.Execution.CorrelationID,
		ActorID:          scope.ActorID(),
		Attempt:          job.Job.Attempt,
	})
	return fromEngine(res.OK, errCode(res.Error), errMessage(res.Error), res)
}

func (d *Dispatcher) script(ctx context.Context, scope isolation.Scope, perms []string, job Job) Decision {
	if d.Scripts == nil {
		return fail(CodeUnpublishedPin, "published script artifact pin is required")
	}
	versionPins, err := d.Scripts.ListVersionPins(ctx, scope, job.Execution.WorkflowVersionID)
	if err != nil {
		return fail(CodeUnpublishedPin, "published script artifact pin is required")
	}
	var pinned scripts.VersionPin
	for _, pin := range versionPins {
		if pin.NodeID == job.Step.NodeID {
			pinned = pin
			break
		}
	}
	if strings.TrimSpace(pinned.ArtifactID) == "" {
		return fail(CodeUnpublishedPin, "published script artifact pin is required")
	}
	art, err := d.Scripts.Get(ctx, scope, pinned.ArtifactID)
	if err != nil {
		return fail(CodeUnpublishedPin, "published script artifact pin is required")
	}
	in := job.Step.Input
	profileID := str(in, "runtimeProfileId")
	pins, err := d.pins(ctx, scope, job)
	if err != nil {
		return fail(CodeUnpublishedPin, "published runtime profile pin is required")
	}
	profilePin, ok := findPin(pins, opsconfig.KindRuntimeProfile, profileID)
	if !ok {
		return fail(CodeUnpublishedPin, "published runtime profile pin is required")
	}
	// Source stays empty so Execute uses the signed package, not YAML.
	// A live script runtime creates one isolated Job. Nil stays the CI harness.
	runtime := d.Engines.Script
	requireLive := runtime != nil && runtime.Name() == scripts.IsolationModeLive
	res := scripts.Execute(ctx, scripts.Request{
		Artifact:         art,
		Language:         art.Language,
		Entrypoint:       str(in, "entrypoint"),
		SigningKey:       d.ScriptKey,
		RuntimeProfile:   profilePin.Spec,
		RuntimeProfileID: profileID,
		NodeLimits: scripts.NodeLimits{
			TimeoutSeconds: asInt(in["timeoutSeconds"]),
			MemoryMiB:      asInt(in["memoryMiB"]),
			CPUMillis:      asInt(in["cpuMillis"]),
			Processes:      asInt(in["processes"]),
		},
		Permissions:        perms,
		Runtime:            runtime,
		RequireLiveRuntime: requireLive,
		CorrelationID:      job.Execution.CorrelationID,
		ActorID:            scope.ActorID(),
		Input:              scriptInput(in),
		InputSchema:        asMap(in["inputSchema"]),
		OutputSchema:       asMap(in["outputSchema"]),
		Attempt:            job.Job.Attempt,
	})
	return fromEngine(res.OK, errCode(res.Error), errMessage(res.Error), res)
}

func (d *Dispatcher) http(ctx context.Context, scope isolation.Scope, perms []string, job Job) Decision {
	in := job.Step.Input
	connID := str(in, "connectionId")
	pins, err := d.pins(ctx, scope, job)
	if err != nil {
		return fail(CodeUnpublishedPin, "published connection pin is required")
	}
	connPin, ok := findPin(pins, opsconfig.KindConnection, connID)
	if !ok {
		return fail(CodeUnpublishedPin, "published connection pin is required")
	}
	conn := httpnotify.ConnectionContextFromSpec(connPin.ResourceID, connPin.Spec)
	conn.Published = true
	conn.WorkspaceID = scope.WorkspaceID()
	conn.Revision = versionLabel(connPin)
	conn.Digest = connPin.Digest
	var schema map[string]any
	schemaPublished := false
	if sid := firstNonEmpty(str(in, "responseSchemaId"), str(in, "responseSchemaRef")); sid != "" {
		schemaPin, found := findPin(pins, opsconfig.KindResponseSchema, sid)
		if !found {
			return fail(CodeUnpublishedPin, "published response schema pin is required")
		}
		schema = schemaPin.Spec
		schemaPublished = true
	}
	policy := httpnotify.PolicyContext{}
	if pid := str(in, "policyId"); pid != "" {
		policyPin, found := findPin(pins, opsconfig.KindPolicy, pid)
		if !found {
			return fail(CodeUnpublishedPin, "published policy pin is required")
		}
		rules, _ := policyPin.Spec["policy"].(map[string]any)
		kind, _ := policyPin.Spec["kind"].(string)
		policy = httpnotify.PolicyContextFromRules(kind, rules)
		policy.Revision = versionLabel(policyPin)
		policy.Digest = policyPin.Digest
	}
	handle, dec := d.httpHandle(ctx, scope, conn.CredentialID)
	if dec.Fail {
		return dec
	}
	res := httpnotify.Execute(ctx, httpnotify.Request{
		Operation:       job.Step.NodeType,
		ConnectionID:    connID,
		WorkspaceID:     scope.WorkspaceID(),
		Method:          str(in, "method"),
		Path:            str(in, "path"),
		Host:            str(in, "host"),
		TimeoutSeconds:  asInt(in["timeoutSeconds"]),
		Payload:         asMap(in["payload"]),
		Permissions:     perms,
		Policy:          policy,
		Connection:      conn,
		ResponseSchema:  schema,
		SchemaPublished: schemaPublished,
		Handle:          handle,
		Resolver:        d.Engines.HTTPResolver,
		Transport:       d.Engines.HTTP,
		CorrelationID:   job.Execution.CorrelationID,
		ActorID:         scope.ActorID(),
	})
	return fromEngine(res.OK, errCode(res.Error), errMessage(res.Error), res)
}

func (d *Dispatcher) email(ctx context.Context, scope isolation.Scope, perms []string, job Job) Decision {
	in := job.Step.Input
	connID := str(in, "connectionId")
	listID := str(in, "recipientListId")
	templateID := firstNonEmpty(str(in, "templateId"), str(in, "messageTemplateId"))
	pins, err := d.pins(ctx, scope, job)
	if err != nil {
		return fail(CodeUnpublishedPin, "published connection pin is required")
	}
	connPin, ok := findPin(pins, opsconfig.KindConnection, connID)
	if !ok {
		return fail(CodeUnpublishedPin, "published connection pin is required")
	}
	listPin, ok := findPin(pins, opsconfig.KindRecipientList, listID)
	if !ok {
		return fail(CodeUnpublishedPin, "published recipient list pin is required")
	}
	templatePin, ok := findPin(pins, opsconfig.KindMessageTemplate, templateID)
	if !ok {
		return fail(CodeUnpublishedPin, "published message template pin is required")
	}
	conn := httpnotify.ConnectionContextFromSpec(connPin.ResourceID, connPin.Spec)
	conn.Published = true
	conn.WorkspaceID = scope.WorkspaceID()
	recipients := httpnotify.RecipientListFromSpec(listPin.ResourceID, listPin.Spec)
	recipients.Published = true
	recipients.WorkspaceID = scope.WorkspaceID()
	template := httpnotify.TemplateFromSpec(templatePin.ResourceID, templatePin.Spec)
	template.Published = true
	template.WorkspaceID = scope.WorkspaceID()
	res := httpnotify.ExecuteEmail(ctx, httpnotify.EmailRequest{
		ConnectionID:  connID,
		WorkspaceID:   scope.WorkspaceID(),
		Payload:       asMap(in["payload"]),
		Permissions:   perms,
		Connection:    conn,
		Recipients:    recipients,
		Template:      template,
		Mailer:        d.Engines.Mail,
		CorrelationID: job.Execution.CorrelationID,
		ActorID:       scope.ActorID(),
	})
	return fromEngine(res.OK, errCode(res.Error), errMessage(res.Error), res)
}

func (d *Dispatcher) httpHandle(ctx context.Context, scope isolation.Scope, credentialID string) (*httpnotify.Handle, Decision) {
	credentialID = strings.TrimSpace(credentialID)
	if credentialID == "" {
		return nil, Decision{}
	}
	plain, dec := d.unlock(ctx, scope, credentialID)
	if dec.Fail {
		return nil, dec
	}
	defer wipe(plain)
	token := tokenFromPayload(plain)
	if token == "" {
		return nil, fail(CodeHandleForbidden, "credential handle could not be unlocked")
	}
	return &httpnotify.Handle{Authorization: bearer(token)}, Decision{}
}

func (d *Dispatcher) unlock(ctx context.Context, scope isolation.Scope, id string) ([]byte, Decision) {
	id = strings.TrimSpace(id)
	if id == "" || d.Vault == nil {
		return nil, fail(CodeHandleForbidden, "credential handle could not be unlocked")
	}
	plain, err := d.Vault.Unlock(ctx, scope, id)
	if err != nil {
		return nil, fail(CodeHandleForbidden, "credential handle could not be unlocked")
	}
	if err := d.Vault.Use(ctx, scope, id); err != nil {
		wipe(plain)
		return nil, fail(CodeHandleForbidden, "credential handle could not be unlocked")
	}
	return plain, Decision{}
}

func (d *Dispatcher) pins(ctx context.Context, scope isolation.Scope, job Job) ([]opsconfig.Pin, error) {
	if d.Ops == nil {
		return nil, errNoPins
	}
	pins, err := d.Ops.ListPins(ctx, scope, opsconfig.OwnerExecution, job.Execution.ID)
	if err != nil {
		return nil, err
	}
	if len(pins) > 0 {
		return pins, nil
	}
	return d.Ops.ListPins(ctx, scope, opsconfig.OwnerWorkflowVersion, job.Execution.WorkflowVersionID)
}

var errNoPins = errString("pins unavailable")

type errString string

func (e errString) Error() string { return string(e) }

func findPin(pins []opsconfig.Pin, kind, id string) (opsconfig.Pin, bool) {
	id = strings.TrimSpace(id)
	if id == "" {
		return opsconfig.Pin{}, false
	}
	for _, pin := range pins {
		if pin.Kind == kind && pin.ResourceID == id {
			return pin, true
		}
	}
	return opsconfig.Pin{}, false
}

func versionLabel(pin opsconfig.Pin) string {
	return strings.TrimSpace(pin.VersionID)
}

func errCode(err error) string {
	if err == nil {
		return ""
	}
	// Engine errors are pointers with an exported Code field.
	raw, mErr := json.Marshal(err)
	if mErr != nil {
		return ""
	}
	var body struct {
		Code string `json:"code"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return ""
	}
	return body.Code
}

func errMessage(err error) string {
	if err == nil {
		return ""
	}
	raw, mErr := json.Marshal(err)
	if mErr != nil {
		return "engine execution failed"
	}
	var body struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &body) != nil || strings.TrimSpace(body.Message) == "" {
		return "engine execution failed"
	}
	return body.Message
}

func fromEngine(ok bool, code, message string, payload any) Decision {
	if !ok {
		if code == "" {
			code = "engine-failed"
		}
		if message == "" {
			message = "engine execution failed"
		}
		return fail(code, message)
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return fail("engine-failed", "engine execution failed")
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil || body == nil {
		body = map[string]any{}
	}
	delete(body, "error")
	out := map[string]any{"result": body}
	for _, key := range []string{"resources", "status", "items", "stdout", "exitCode", "output"} {
		if v, ok := body[key]; ok {
			out[key] = v
		}
	}
	return Decision{Output: out}
}

func scriptInput(in map[string]any) map[string]any {
	if m := asMap(in["input"]); m != nil {
		return m
	}
	return map[string]any{}
}

func tokenFromPayload(plain []byte) string {
	var obj map[string]string
	if err := json.Unmarshal(plain, &obj); err != nil {
		return ""
	}
	return strings.TrimSpace(obj["token"])
}

func bearer(token string) string {
	token = strings.TrimSpace(token)
	if len(token) >= 7 && strings.EqualFold(token[:7], "bearer ") {
		return "Bearer " + strings.TrimSpace(token[7:])
	}
	return "Bearer " + token
}

func wipe(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

func str(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	s, _ := m[key].(string)
	return strings.TrimSpace(s)
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func asInt(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int32:
		return int(n)
	case int64:
		return int(n)
	case float32:
		return int(n)
	case float64:
		return int(n)
	case json.Number:
		i, err := n.Int64()
		if err != nil {
			return 0
		}
		return int(i)
	default:
		return 0
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
