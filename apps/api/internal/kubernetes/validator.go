package kubernetes

import (
	"net/http"
	"strings"
)

var clusterScopedKinds = map[string]bool{
	"Namespace": true, "Node": true, "PersistentVolume": true,
	"CustomResourceDefinition": true, "ClusterRole": true, "ClusterRoleBinding": true,
	"MutatingWebhookConfiguration": true, "ValidatingWebhookConfiguration": true,
	"ValidatingAdmissionPolicy": true, "ValidatingAdmissionPolicyBinding": true,
	"APIService": true, "PriorityClass": true, "StorageClass": true,
	"CSIDriver": true, "VolumeSnapshotClass": true, "TokenReview": true,
	"SubjectAccessReview": true, "SelfSubjectAccessReview": true,
	"CertificateSigningRequest": true, "FlowSchema": true, "PriorityLevelConfiguration": true,
}

var deniedAPIGroups = []string{
	"rbac.authorization.k8s.io",
	"admissionregistration.k8s.io",
	"apiextensions.k8s.io",
	"certificates.k8s.io",
	"flowcontrol.apiserver.k8s.io",
	"scheduling.k8s.io",
	"apiregistration.k8s.io",
}

var deniedIngressAnnotationParts = []string{
	"snippet", "configuration", "modsecurity", "lua", "auth-url",
	"auth-tls", "server-snippet", "configuration-snippet",
}

var allowedIngressAnnotations = map[string]bool{
	"kubernetes.io/ingress.class":                    true,
	"nginx.ingress.kubernetes.io/rewrite-target":     true,
	"nginx.ingress.kubernetes.io/ssl-redirect":       true,
	"nginx.ingress.kubernetes.io/force-ssl-redirect": true,
}

// PolicyContext is the authorization-relevant snapshot revalidated before
// any cluster contact. Presence flags fail closed when the list is empty.
type PolicyContext struct {
	Deny                bool
	Namespaces          []string
	NamespacesPresent   bool
	Kinds               []string
	KindsPresent        bool
	Verbs               []string
	VerbsPresent        bool
	Images              []string
	ImagesPresent       bool
	IngressHosts        []string
	IngressHostsPresent bool
	Revision            string
	Digest              string
}

// TargetContext is the pinned cluster target used for namespace subset checks.
type TargetContext struct {
	ID                string
	Namespaces        []string
	NamespacesPresent bool
	CredentialID      string
	ServiceAccount    map[string]any
	EndpointAPIServer string
}

// ValidationInput is a parsed apply/read request after YAML parse.
type ValidationInput struct {
	Operation string
	Namespace string
	Kind      string
	Name      string
	Docs      []Document
	Policy    PolicyContext
	Target    TargetContext
}

// ValidatePolicy checks namespace/kind/verb allowlists before cluster contact.
func ValidatePolicy(in ValidationInput) *EngineError {
	if in.Policy.Deny {
		return engineError(CodePolicyDenied, "policy denies this operation", http.StatusForbidden)
	}
	if strings.TrimSpace(in.Namespace) == "" || !ValidNamespace(in.Namespace) {
		return engineError(CodeNamespaceDenied, "namespace must be a DNS-1123 label", http.StatusBadRequest)
	}
	if in.Policy.NamespacesPresent && !Allowed(in.Policy.Namespaces, in.Namespace) {
		return engineError(CodeNamespaceDenied, "namespace is not allowed by policy", http.StatusForbidden)
	}
	if in.Target.NamespacesPresent && !Allowed(in.Target.Namespaces, in.Namespace) {
		return engineError(CodeNamespaceDenied, "namespace is not allowed by cluster target", http.StatusForbidden)
	}
	verb := operationVerb(in.Operation)
	if !VerbAllowed(verb) {
		return engineError(CodeVerbDenied, "verb is not an engine verb", http.StatusForbidden)
	}
	if in.Policy.VerbsPresent && !Allowed(in.Policy.Verbs, verb) {
		return engineError(CodeVerbDenied, "verb is not allowed by policy", http.StatusForbidden)
	}
	if in.Operation == "get" || in.Operation == "list" || in.Operation == "kubernetes.get" || in.Operation == "kubernetes.list" {
		if !KindAllowed(in.Kind) {
			return engineError(CodeKindDenied, "resource kind is not on the engine allowlist", http.StatusForbidden)
		}
		if in.Policy.KindsPresent && !Allowed(in.Policy.Kinds, in.Kind) {
			return engineError(CodeKindDenied, "resource kind is not allowed by policy", http.StatusForbidden)
		}
	}
	if verb == "watch" {
		if !ObservableKind(in.Kind) {
			return engineError(CodeKindDenied, "rollout observation is limited to Deployment, StatefulSet, DaemonSet, and Job", http.StatusForbidden)
		}
		if in.Policy.KindsPresent && !Allowed(in.Policy.Kinds, in.Kind) {
			return engineError(CodeKindDenied, "resource kind is not allowed by policy", http.StatusForbidden)
		}
	}
	return nil
}

// ValidateDocuments applies MVP manifest policy to every parsed document.
func ValidateDocuments(in ValidationInput) *EngineError {
	if err := ValidatePolicy(in); err != nil {
		return err
	}
	for _, doc := range in.Docs {
		if err := validateDocument(doc, in); err != nil {
			return err
		}
	}
	return nil
}

func validateDocument(doc Document, in ValidationInput) *EngineError {
	path := docPath(doc.Index)
	if looksLikeSecret(doc) {
		return pathError(CodeSecretForbidden, path, "Secret manifests and secret data fields are not allowed.", http.StatusBadRequest)
	}
	if deniedAPIGroup(doc.APIVersion) || clusterScopedKinds[doc.Kind] || strings.EqualFold(doc.Kind, "Secret") {
		return pathError(CodeKindDenied, path, "Cluster-scoped resources, Secrets, CRDs, RBAC, and admission webhooks are not allowed.", http.StatusForbidden)
	}
	if !KindAllowed(doc.Kind) {
		return pathError(CodeKindDenied, path, "resource kind is not on the engine allowlist", http.StatusForbidden)
	}
	if in.Policy.KindsPresent && !Allowed(in.Policy.Kinds, doc.Kind) {
		return pathError(CodeKindDenied, path, "resource kind is not allowed by policy", http.StatusForbidden)
	}
	if doc.Namespace != "" && doc.Namespace != in.Namespace {
		return pathError(CodeNamespaceDenied, path+".metadata.namespace", "manifest namespace must equal the node namespace", http.StatusForbidden)
	}
	if doc.Namespace == "" {
		// Server-side apply still scopes to the node namespace.
		if meta, ok := asStringKeyMap(doc.Raw["metadata"]); ok {
			meta["namespace"] = in.Namespace
			doc.Raw["metadata"] = meta
			doc.Namespace = in.Namespace
		}
	}
	if err := validateWorkloadSecurity(doc); err != nil {
		return err
	}
	if err := validateImages(doc, in.Policy); err != nil {
		return err
	}
	if strings.EqualFold(doc.Kind, "Ingress") {
		if err := validateIngress(doc, in); err != nil {
			return err
		}
	}
	return nil
}

func looksLikeSecret(doc Document) bool {
	if strings.EqualFold(doc.Kind, "Secret") {
		return true
	}
	if _, ok := doc.Raw["stringData"]; ok {
		return true
	}
	if _, ok := doc.Raw["binaryData"]; ok && strings.Contains(strings.ToLower(doc.Kind), "secret") {
		return true
	}
	if strings.EqualFold(doc.Kind, "Secret") {
		if _, ok := doc.Raw["data"]; ok {
			return true
		}
	}
	return false
}

func deniedAPIGroup(apiVersion string) bool {
	group := apiVersion
	if i := strings.LastIndex(apiVersion, "/"); i >= 0 {
		group = apiVersion[:i]
	} else {
		return false
	}
	for _, denied := range deniedAPIGroups {
		if strings.EqualFold(group, denied) {
			return true
		}
	}
	return false
}

func validateWorkloadSecurity(doc Document) *EngineError {
	path := docPath(doc.Index)
	spec, _ := asStringKeyMap(doc.Raw["spec"])
	if spec == nil {
		return nil
	}
	if err := denyHostAndPrivilege(spec, path+".spec"); err != nil {
		return err
	}
	template, _ := asStringKeyMap(spec["template"])
	if template != nil {
		podSpec, _ := asStringKeyMap(template["spec"])
		if err := denyHostAndPrivilege(podSpec, path+".spec.template.spec"); err != nil {
			return err
		}
		if err := denyJobPodTemplate(spec, path); err != nil {
			return err
		}
	}
	jobTemplate, _ := asStringKeyMap(spec["jobTemplate"])
	if jobTemplate != nil {
		jobSpec, _ := asStringKeyMap(jobTemplate["spec"])
		if jobSpec != nil {
			tpl, _ := asStringKeyMap(jobSpec["template"])
			if tpl != nil {
				if err := denyHostAndPrivilege(mapFrom(tpl["spec"]), path+".spec.jobTemplate.spec.template.spec"); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func denyJobPodTemplate(spec map[string]any, path string) *EngineError {
	_ = spec
	_ = path
	return nil
}

func denyHostAndPrivilege(pod map[string]any, path string) *EngineError {
	if pod == nil {
		return nil
	}
	if boolField(pod, "hostNetwork") || boolField(pod, "hostPID") || boolField(pod, "hostIPC") {
		return pathError(CodeWorkloadDenied, path, "host namespaces are not allowed", http.StatusForbidden)
	}
	if err := denySecurityContext(mapFrom(pod["securityContext"]), path+".securityContext"); err != nil {
		return err
	}
	if err := denyVolumes(pod["volumes"], path+".volumes"); err != nil {
		return err
	}
	for _, key := range []string{"containers", "initContainers", "ephemeralContainers"} {
		if err := denyContainers(pod[key], path+"."+key); err != nil {
			return err
		}
	}
	return nil
}

func denySecurityContext(sc map[string]any, path string) *EngineError {
	if sc == nil {
		return nil
	}
	if boolField(sc, "privileged") {
		return pathError(CodeWorkloadDenied, path+".privileged", "privileged workloads are not allowed", http.StatusForbidden)
	}
	if boolField(sc, "allowPrivilegeEscalation") {
		return pathError(CodeWorkloadDenied, path+".allowPrivilegeEscalation", "privilege escalation is not allowed", http.StatusForbidden)
	}
	if n, ok := intField(sc, "runAsUser"); ok && n == 0 {
		return pathError(CodeWorkloadDenied, path+".runAsUser", "running as root is not allowed", http.StatusForbidden)
	}
	caps, _ := asStringKeyMap(sc["capabilities"])
	if caps != nil {
		if added := stringSliceAny(caps["add"]); len(added) > 0 {
			return pathError(CodeWorkloadDenied, path+".capabilities.add", "capability escalation is not allowed", http.StatusForbidden)
		}
	}
	return nil
}

func denyVolumes(raw any, path string) *EngineError {
	arr, _ := raw.([]any)
	for i, item := range arr {
		vol, _ := asStringKeyMap(item)
		if vol == nil {
			continue
		}
		if _, ok := vol["hostPath"]; ok {
			return pathError(CodeWorkloadDenied, indexPath(path, i)+".hostPath", "hostPath volumes are not allowed", http.StatusForbidden)
		}
	}
	return nil
}

func denyContainers(raw any, path string) *EngineError {
	arr, _ := raw.([]any)
	for i, item := range arr {
		c, _ := asStringKeyMap(item)
		if c == nil {
			continue
		}
		if err := denySecurityContext(mapFrom(c["securityContext"]), indexPath(path, i)+".securityContext"); err != nil {
			return err
		}
	}
	return nil
}

func validateImages(doc Document, policy PolicyContext) *EngineError {
	images := collectImages(doc.Raw)
	if len(images) == 0 {
		return nil
	}
	for _, image := range images {
		if !digestPinned(image) || hasMutableTag(image) {
			return pathError(CodeImageDenied, docPath(doc.Index), "workload images must be digest-pinned; mutable tags including :latest are denied", http.StatusForbidden)
		}
		if !policy.ImagesPresent || !imageAllowed(policy.Images, image) {
			return pathError(CodeImageDenied, docPath(doc.Index), "workload images must be allowlisted and digest-pinned", http.StatusForbidden)
		}
	}
	return nil
}

func collectImages(v any) []string {
	var out []string
	walkImages(v, &out)
	return out
}

func walkImages(v any, out *[]string) {
	switch t := v.(type) {
	case map[string]any:
		if img, ok := t["image"].(string); ok && strings.TrimSpace(img) != "" {
			if _, hasName := t["name"]; hasName {
				*out = append(*out, strings.TrimSpace(img))
			}
		}
		for _, child := range t {
			walkImages(child, out)
		}
	case []any:
		for _, child := range t {
			walkImages(child, out)
		}
	}
}

func digestPinned(image string) bool {
	return strings.Contains(image, "@sha256:") && len(strings.TrimSpace(strings.Split(image, "@sha256:")[1])) >= 64
}

func hasMutableTag(image string) bool {
	if strings.Contains(image, "@sha256:") {
		return false
	}
	return true
}

func imageAllowed(allow []string, image string) bool {
	image = strings.TrimSpace(image)
	repo := image
	if i := strings.Index(image, "@"); i >= 0 {
		repo = image[:i]
	}
	if j := strings.LastIndex(repo, ":"); j >= 0 && !strings.Contains(repo[j:], "/") {
		repo = repo[:j]
	}
	for _, item := range allow {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if strings.EqualFold(item, image) || strings.EqualFold(item, repo) {
			return true
		}
		if strings.HasPrefix(strings.ToLower(image), strings.ToLower(item)+"@") {
			return true
		}
	}
	return false
}

func validateIngress(doc Document, in ValidationInput) *EngineError {
	path := docPath(doc.Index)
	if !in.Policy.IngressHostsPresent || len(in.Policy.IngressHosts) == 0 {
		return pathError(CodeIngressDenied, path, "Ingress requires an allowedIngressHosts policy allowlist", http.StatusForbidden)
	}
	meta, _ := asStringKeyMap(doc.Raw["metadata"])
	if meta != nil {
		if err := validateIngressAnnotations(mapFrom(meta["annotations"]), path+".metadata.annotations"); err != nil {
			return err
		}
	}
	spec, _ := asStringKeyMap(doc.Raw["spec"])
	if spec == nil {
		return nil
	}
	if err := validateIngressTLS(spec["tls"], in.Policy.IngressHosts, path+".spec.tls"); err != nil {
		return err
	}
	rules, _ := spec["rules"].([]any)
	for i, raw := range rules {
		rule, _ := asStringKeyMap(raw)
		if rule == nil {
			continue
		}
		host, _ := rule["host"].(string)
		host = strings.TrimSpace(host)
		if host == "" || !Allowed(in.Policy.IngressHosts, host) {
			return pathError(CodeIngressDenied, indexPath(path+".spec.rules", i)+".host", "Ingress host is not allowlisted", http.StatusForbidden)
		}
		httpRule, _ := asStringKeyMap(rule["http"])
		if httpRule == nil {
			continue
		}
		paths, _ := httpRule["paths"].([]any)
		for j, p := range paths {
			item, _ := asStringKeyMap(p)
			if err := validateIngressBackend(item, in.Namespace, indexPath(path+".spec.rules["+itoa(i)+"].http.paths", j)); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateIngressAnnotations(ann map[string]any, path string) *EngineError {
	if ann == nil {
		return nil
	}
	for k := range ann {
		key := strings.ToLower(strings.TrimSpace(k))
		if allowedIngressAnnotations[k] || allowedIngressAnnotations[key] {
			continue
		}
		for _, part := range deniedIngressAnnotationParts {
			if strings.Contains(key, part) {
				return pathError(CodeIngressDenied, path+"."+k, "Ingress snippet/configuration annotations are not allowed", http.StatusForbidden)
			}
		}
		return pathError(CodeIngressDenied, path+"."+k, "Ingress annotation is not on the allowlist", http.StatusForbidden)
	}
	return nil
}

func validateIngressTLS(raw any, hosts []string, path string) *EngineError {
	arr, _ := raw.([]any)
	for i, item := range arr {
		tls, _ := asStringKeyMap(item)
		if tls == nil {
			continue
		}
		list := stringSliceAny(tls["hosts"])
		for _, host := range list {
			if !Allowed(hosts, host) {
				return pathError(CodeIngressDenied, indexPath(path, i)+".hosts", "Ingress TLS host is not allowlisted", http.StatusForbidden)
			}
		}
	}
	return nil
}

func validateIngressBackend(item map[string]any, namespace, path string) *EngineError {
	if item == nil {
		return nil
	}
	backend, _ := asStringKeyMap(item["backend"])
	if backend == nil {
		return pathError(CodeIngressDenied, path+".backend", "Ingress path requires a same-namespace Service backend", http.StatusForbidden)
	}
	svc, _ := asStringKeyMap(backend["service"])
	if svc == nil {
		return pathError(CodeIngressDenied, path+".backend", "Ingress backends must be a Service in the node namespace", http.StatusForbidden)
	}
	name, _ := svc["name"].(string)
	if strings.TrimSpace(name) == "" {
		return pathError(CodeIngressDenied, path+".backend.service.name", "Ingress Service backend name is required", http.StatusForbidden)
	}
	if ns, _ := svc["namespace"].(string); ns != "" && ns != namespace {
		return pathError(CodeIngressDenied, path+".backend.service.namespace", "Ingress backends must be in the node namespace", http.StatusForbidden)
	}
	return nil
}

func mapFrom(v any) map[string]any {
	m, _ := asStringKeyMap(v)
	return m
}

func boolField(m map[string]any, key string) bool {
	if m == nil {
		return false
	}
	b, _ := m[key].(bool)
	return b
}

func intField(m map[string]any, key string) (int64, bool) {
	if m == nil {
		return 0, false
	}
	switch n := m[key].(type) {
	case int:
		return int64(n), true
	case int64:
		return n, true
	case float64:
		return int64(n), true
	default:
		return 0, false
	}
}

func stringSliceAny(v any) []string {
	switch t := v.(type) {
	case []string:
		return t
	case []any:
		out := make([]string, 0, len(t))
		for _, item := range t {
			s, _ := item.(string)
			s = strings.TrimSpace(s)
			if s != "" {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

func indexPath(path string, i int) string {
	return path + "[" + itoa(i) + "]"
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [20]byte
	pos := len(b)
	n := i
	for n > 0 {
		pos--
		b[pos] = byte('0' + n%10)
		n /= 10
	}
	return string(b[pos:])
}

func operationVerb(op string) string {
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
		if i := strings.LastIndex(op, "."); i >= 0 {
			return op[i+1:]
		}
		return op
	}
}
