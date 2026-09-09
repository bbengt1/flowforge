package kubernetes

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// Request is one kubernetes.apply / get / list / rolloutStatus execution.
type Request struct {
	Operation       string
	ClusterTargetID string
	Namespace       string
	Manifests       string
	Kind            string
	Name            string
	DryRun          string
	Wait            string
	TimeoutSeconds  int
	Permissions     []string
	Policy          PolicyContext
	Target          TargetContext
	Client          ClusterClient
	Handle          *Handle
	CorrelationID   string
	ActorID         string
	Resource        map[string]any
}

// Result is the redacted engine outcome persisted on the job.
type Result struct {
	OK              bool               `json:"ok"`
	Operation       string             `json:"operation"`
	ClusterTargetID string             `json:"clusterTargetId,omitempty"`
	Namespace       string             `json:"namespace,omitempty"`
	ManifestDigest  string             `json:"manifestDigest,omitempty"`
	FieldManager    string             `json:"fieldManager,omitempty"`
	Force           bool               `json:"force"`
	ServerDryRun    bool               `json:"serverDryRun"`
	Applied         bool               `json:"applied"`
	Wait            string             `json:"wait,omitempty"`
	Observation     string             `json:"observation,omitempty"`
	Resources       []ResourceIdentity `json:"resources,omitempty"`
	Items           []map[string]any   `json:"items,omitempty"`
	Status          map[string]any     `json:"status,omitempty"`
	PolicyRevision  string             `json:"policyRevision,omitempty"`
	PolicyDigest    string             `json:"policyDigest,omitempty"`
	CorrelationID   string             `json:"correlationId,omitempty"`
	Audit           map[string]any     `json:"audit,omitempty"`
	Error           *EngineError       `json:"error,omitempty"`
}

// Execute validates policy, always server-side dry-runs apply, then persists
// with FieldManager=flowforge and Force=false. Get/list stay namespaced.
func Execute(ctx context.Context, req Request) Result {
	out := Result{
		Operation:       normalizeOp(req.Operation),
		ClusterTargetID: strings.TrimSpace(req.ClusterTargetID),
		Namespace:       strings.TrimSpace(req.Namespace),
		FieldManager:    FieldManager,
		Force:           false,
		Wait:            normalizeWait(req.Wait),
		PolicyRevision:  req.Policy.Revision,
		PolicyDigest:    req.Policy.Digest,
		CorrelationID:   strings.TrimSpace(req.CorrelationID),
	}
	if err := authorizeRequest(req, out.Operation); err != nil {
		out.Error = err
		return attachAudit(req, redactResult(out))
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

	client, err := resolveClient(req)
	if err != nil {
		out.Error = err
		return attachAudit(req, redactResult(out))
	}

	switch out.Operation {
	case "apply":
		return attachAudit(req, redactResult(runApply(ctx, req, out, client)))
	case "get":
		return attachAudit(req, redactResult(runGet(ctx, req, out, client)))
	case "list":
		return attachAudit(req, redactResult(runList(ctx, req, out, client)))
	case "watch":
		return attachAudit(req, redactResult(runWatch(ctx, req, out, client)))
	default:
		out.Error = engineError(CodeVerbDenied, "unsupported kubernetes operation", http.StatusBadRequest)
		return attachAudit(req, redactResult(out))
	}
}

func authorizeRequest(req Request, op string) *EngineError {
	needed := RequiredPermissions(op)
	for _, perm := range needed {
		if !authz.Allows(req.Permissions, perm) {
			return engineError(CodePermissionDenied, "caller is not authorized for this Kubernetes operation", http.StatusForbidden)
		}
	}
	return nil
}

// RequiredPermissions is the FlowForge RBAC set for a node/verb.
func RequiredPermissions(op string) []string {
	switch normalizeOp(op) {
	case "apply":
		return []string{authz.PermWorkflowExecute, authz.PermKubernetesApply, authz.PermClusterTargetUse}
	case "get", "list", "watch":
		return []string{authz.PermWorkflowExecute, authz.PermKubernetesRead, authz.PermClusterTargetUse}
	default:
		return []string{authz.PermWorkflowExecute}
	}
}

func resolveClient(req Request) (ClusterClient, *EngineError) {
	if req.Client != nil {
		return req.Client, nil
	}
	if req.Handle != nil {
		c, err := req.Handle.Client()
		if err != nil {
			return nil, asEngineError(err)
		}
		return c, nil
	}
	return nil, engineError(CodeMissingClient, "workers require a scoped cluster handle; kubeconfig is never accepted on the node", http.StatusForbidden)
}

func runApply(ctx context.Context, req Request, out Result, client ClusterClient) Result {
	docs, err := ParseDocuments(req.Manifests)
	if err != nil {
		out.Error = err
		return out
	}
	out.ManifestDigest = ManifestDigest(docs)
	if verr := ValidateDocuments(ValidationInput{
		Operation: "apply",
		Namespace: req.Namespace,
		Docs:      docs,
		Policy:    req.Policy,
		Target:    req.Target,
	}); verr != nil {
		out.Error = verr
		return out
	}
	// Revalidate immediately before cluster contact.
	if verr := ValidatePolicy(ValidationInput{
		Operation: "apply",
		Namespace: req.Namespace,
		Policy:    req.Policy,
		Target:    req.Target,
	}); verr != nil {
		out.Error = verr
		return out
	}
	if out.Wait == "ready" {
		if verr := validateWatchPolicy(req, previewObservableDocs(docs)); verr != nil {
			out.Error = verr
			return out
		}
	}

	var identities []ResourceIdentity
	for i := range docs {
		obj := ensureNamespace(docs[i], req.Namespace)
		if _, dryErr := client.Apply(ctx, obj, ApplyOptions{FieldManager: FieldManager, Force: false, DryRun: true}); dryErr != nil {
			out.Error = wrapClusterError(dryErr, CodeDryRunFailed)
			return out
		}
		out.ServerDryRun = true
		applied, applyErr := client.Apply(ctx, obj, ApplyOptions{FieldManager: FieldManager, Force: false, DryRun: false})
		if applyErr != nil {
			out.Error = wrapClusterError(applyErr, CodeApplyFailed)
			return out
		}
		out.Applied = true
		identities = append(identities, identityOf(applied))
	}
	out.Resources = identities
	out.Status = map[string]any{"count": len(identities), "fieldManager": FieldManager, "force": false}
	if out.Wait == "ready" {
		return finishObservation(ctx, req, out, client, identities)
	}
	out.OK = true
	return out
}

func runWatch(ctx context.Context, req Request, out Result, client ClusterClient) Result {
	kind, name := resourceRef(req)
	if err := ValidatePolicy(ValidationInput{
		Operation: "watch",
		Namespace: req.Namespace,
		Kind:      kind,
		Name:      name,
		Policy:    req.Policy,
		Target:    req.Target,
	}); err != nil {
		out.Error = err
		return out
	}
	if strings.TrimSpace(name) == "" {
		out.Error = engineError(CodeInvalidManifest, "kubernetes.rolloutStatus requires with.name or a resource identity", http.StatusBadRequest)
		return out
	}
	id := ResourceIdentity{
		Kind:      kind,
		Namespace: strings.TrimSpace(req.Namespace),
		Name:      name,
	}
	return finishObservation(ctx, req, out, client, []ResourceIdentity{id})
}

func finishObservation(ctx context.Context, req Request, out Result, client ClusterClient, identities []ResourceIdentity) Result {
	if err := validateWatchPolicy(req, identities); err != nil {
		out.Error = err
		return out
	}
	state, progress, err := observeIdentities(ctx, client, identities)
	if out.Status == nil {
		out.Status = map[string]any{}
	}
	out.Observation = state
	out.Status["observation"] = state
	out.Status["progress"] = progressAsMaps(progress)
	out.Status["cancelDeletes"] = false
	if err != nil {
		out.Error = err
		out.OK = false
		return out
	}
	out.OK = true
	if len(out.Resources) == 0 {
		out.Resources = identities
	}
	return out
}

func validateWatchPolicy(req Request, identities []ResourceIdentity) *EngineError {
	for _, id := range identities {
		if !ObservableKind(id.Kind) {
			continue
		}
		if err := ValidatePolicy(ValidationInput{
			Operation: "watch",
			Namespace: req.Namespace,
			Kind:      id.Kind,
			Name:      id.Name,
			Policy:    req.Policy,
			Target:    req.Target,
		}); err != nil {
			return err
		}
	}
	return nil
}

func resourceRef(req Request) (kind, name string) {
	kind = strings.TrimSpace(req.Kind)
	name = strings.TrimSpace(req.Name)
	if req.Resource != nil {
		if k, _ := req.Resource["kind"].(string); kind == "" {
			kind = strings.TrimSpace(k)
		}
		if n, _ := req.Resource["name"].(string); name == "" {
			name = strings.TrimSpace(n)
		}
	}
	return kind, name
}

func previewObservableDocs(docs []Document) []ResourceIdentity {
	var out []ResourceIdentity
	for _, doc := range docs {
		if ObservableKind(doc.Kind) {
			out = append(out, ResourceIdentity{
				APIVersion: doc.APIVersion,
				Kind:       doc.Kind,
				Namespace:  doc.Namespace,
				Name:       doc.Name,
			})
		}
	}
	return out
}

func runGet(ctx context.Context, req Request, out Result, client ClusterClient) Result {
	if err := ValidatePolicy(ValidationInput{
		Operation: "get",
		Namespace: req.Namespace,
		Kind:      req.Kind,
		Name:      req.Name,
		Policy:    req.Policy,
		Target:    req.Target,
	}); err != nil {
		out.Error = err
		return out
	}
	if strings.TrimSpace(req.Name) == "" {
		out.Error = engineError(CodeInvalidManifest, "kubernetes.get requires with.name", http.StatusBadRequest)
		return out
	}
	obj, err := client.Get(ctx, req.Kind, req.Namespace, req.Name)
	if err != nil {
		out.Error = wrapClusterError(err, CodeReadFailed)
		return out
	}
	id := identityOf(obj)
	out.Resources = []ResourceIdentity{id}
	out.Items = []map[string]any{redactObject(obj)}
	out.Status = map[string]any{"count": 1}
	out.OK = true
	return out
}

func runList(ctx context.Context, req Request, out Result, client ClusterClient) Result {
	if err := ValidatePolicy(ValidationInput{
		Operation: "list",
		Namespace: req.Namespace,
		Kind:      req.Kind,
		Policy:    req.Policy,
		Target:    req.Target,
	}); err != nil {
		out.Error = err
		return out
	}
	items, err := client.List(ctx, req.Kind, req.Namespace, ListOptions{})
	if err != nil {
		out.Error = wrapClusterError(err, CodeReadFailed)
		return out
	}
	out.Items = make([]map[string]any, 0, len(items))
	out.Resources = make([]ResourceIdentity, 0, len(items))
	for _, item := range items {
		out.Resources = append(out.Resources, identityOf(item))
		out.Items = append(out.Items, redactObject(item))
	}
	out.Status = map[string]any{"count": len(items)}
	out.OK = true
	return out
}

func ensureNamespace(doc Document, ns string) Unstructured {
	obj := cloneUnstructured(doc.Raw)
	meta, _ := asStringKeyMap(obj["metadata"])
	if meta == nil {
		meta = map[string]any{}
	}
	meta["namespace"] = ns
	obj["metadata"] = meta
	return obj
}

func wrapClusterError(err error, fallback string) *EngineError {
	if err == nil {
		return nil
	}
	var ee *EngineError
	if asEngineError(err) != nil && errorsIsEngine(err) {
		return asEngineError(err)
	}
	_ = fallback
	if ee = asEngineError(err); ee != nil && ee.Code != CodeApplyFailed {
		return ee
	}
	if IsOwnershipConflict(err) {
		return asEngineError(err)
	}
	if ee = asEngineError(err); ee != nil {
		if ee.Code == CodeApplyFailed && fallback != CodeApplyFailed {
			ee.Code = fallback
		}
		return ee
	}
	return engineError(fallback, "Kubernetes operation failed", http.StatusBadGateway)
}

func errorsIsEngine(err error) bool {
	_, ok := err.(*EngineError)
	return ok
}

func normalizeOp(op string) string {
	switch strings.TrimSpace(op) {
	case "kubernetes.apply", "apply":
		return "apply"
	case "kubernetes.get", "get":
		return "get"
	case "kubernetes.list", "list":
		return "list"
	case "kubernetes.rolloutStatus", "watch":
		return "watch"
	default:
		return strings.TrimSpace(op)
	}
}

func normalizeWait(wait string) string {
	switch strings.TrimSpace(wait) {
	case "ready":
		return "ready"
	default:
		return "none"
	}
}

func redactResult(in Result) Result {
	if in.Error != nil {
		in.Error = &EngineError{Code: in.Error.Code, Message: in.Error.Message, Status: in.Error.Status, Path: in.Error.Path}
	}
	if in.Status != nil {
		if v, ok := RedactValue(in.Status).(map[string]any); ok {
			in.Status = v
		}
	}
	if in.Items != nil {
		redacted := make([]map[string]any, 0, len(in.Items))
		for _, item := range in.Items {
			if v, ok := RedactValue(item).(map[string]any); ok {
				redacted = append(redacted, v)
			}
		}
		in.Items = redacted
	}
	if in.Audit != nil {
		if v, ok := RedactValue(in.Audit).(map[string]any); ok {
			in.Audit = v
		}
	}
	return in
}

// PolicyContextFromRules builds a PolicyContext from a kubernetes policy object.
func PolicyContextFromRules(rules map[string]any) PolicyContext {
	ns, nsPresent := Namespaces(rules)
	kinds, kindsPresent := Kinds(rules)
	verbs, verbsPresent := Verbs(rules)
	images, imagesPresent := Images(rules)
	hosts, hostsPresent := IngressHosts(rules)
	deny, _ := rules["deny"].(bool)
	return PolicyContext{
		Deny:                deny,
		Namespaces:          ns,
		NamespacesPresent:   nsPresent,
		Kinds:               kinds,
		KindsPresent:        kindsPresent,
		Verbs:               verbs,
		VerbsPresent:        verbsPresent,
		Images:              images,
		ImagesPresent:       imagesPresent,
		IngressHosts:        hosts,
		IngressHostsPresent: hostsPresent,
	}
}

// TargetContextFromSpec builds a TargetContext from a cluster_target spec.
func TargetContextFromSpec(id string, spec map[string]any) TargetContext {
	ns, present := Namespaces(spec)
	cred, _ := spec["credentialId"].(string)
	sa, _ := spec["serviceAccount"].(map[string]any)
	var api string
	if ep, ok := spec["endpoint"].(map[string]any); ok {
		api, _ = ep["apiServer"].(string)
	}
	return TargetContext{
		ID:                id,
		Namespaces:        ns,
		NamespacesPresent: present,
		CredentialID:      strings.TrimSpace(cred),
		ServiceAccount:    sa,
		EndpointAPIServer: strings.TrimSpace(api),
	}
}
