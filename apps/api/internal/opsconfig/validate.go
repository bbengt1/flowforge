package opsconfig

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/kubernetes"
	ssheng "github.com/bbengt1/flowforge/apps/api/internal/ssh"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

var (
	slugRE     = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)
	digestRE   = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	emailRE    = regexp.MustCompile(`^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$`)
	domainRE   = regexp.MustCompile(`^[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?)+$`)
	hostnameRE = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9\-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)*$`)
)

const maxPayloadBytes = 65536

// NormalizeSpec validates and canonicalizes a kind-specific spec.
func NormalizeSpec(kind string, spec map[string]any) (map[string]any, string, error) {
	if !ValidKind(kind) {
		return nil, "", fmt.Errorf("%w: unknown kind", ErrInvalid)
	}
	if spec == nil {
		return nil, "", fmt.Errorf("%w: spec is required", ErrInvalid)
	}
	raw, err := json.Marshal(spec)
	if err != nil {
		return nil, "", fmt.Errorf("%w: spec is not JSON", ErrInvalid)
	}
	if len(raw) > maxPayloadBytes {
		return nil, "", fmt.Errorf("%w: spec exceeds %d bytes", ErrInvalid, maxPayloadBytes)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil || decoded == nil {
		return nil, "", fmt.Errorf("%w: spec must be an object", ErrInvalid)
	}
	normalized, err := normalizeKind(kind, decoded)
	if err != nil {
		return nil, "", err
	}
	canon, err := json.Marshal(normalized)
	if err != nil {
		return nil, "", fmt.Errorf("%w: spec could not be normalized", ErrInvalid)
	}
	sum := sha256.Sum256(canon)
	return normalized, "sha256:" + hex.EncodeToString(sum[:]), nil
}

func normalizeKind(kind string, spec map[string]any) (map[string]any, error) {
	switch kind {
	case KindClusterTarget:
		return normalizeClusterTarget(spec)
	case KindSSHTarget:
		return normalizeSSHTarget(spec)
	case KindCommandProfile:
		return normalizeCommandProfile(spec)
	case KindRuntimeProfile:
		return normalizeRuntimeProfile(spec)
	case KindConnection:
		return normalizeConnection(spec)
	case KindRecipientList:
		return normalizeRecipientList(spec)
	case KindMessageTemplate:
		return normalizeMessageTemplate(spec)
	case KindResponseSchema:
		return normalizeResponseSchema(spec)
	case KindPolicy:
		return normalizePolicy(spec)
	default:
		return nil, fmt.Errorf("%w: unknown kind", ErrInvalid)
	}
}

func normalizeClusterTarget(spec map[string]any) (map[string]any, error) {
	out := map[string]any{}
	cred, err := optionalUUID(spec, "credentialId")
	if err != nil {
		return nil, err
	}
	if cred == "" {
		return nil, fmt.Errorf("%w: credentialId is required", ErrInvalid)
	}
	out["credentialId"] = cred
	endpoint, err := objectField(spec, "endpoint")
	if err != nil {
		return nil, err
	}
	if endpoint == nil {
		return nil, fmt.Errorf("%w: endpoint is required", ErrInvalid)
	}
	ep := map[string]any{}
	if v, ok, err := optionalString(endpoint, "apiServer", 1, 512); err != nil {
		return nil, err
	} else if ok {
		ep["apiServer"] = v
	}
	if v, ok, err := optionalString(endpoint, "tlsServerName", 1, 253); err != nil {
		return nil, err
	} else if ok {
		ep["tlsServerName"] = v
	}
	if v, ok := endpoint["skipTLSVerify"]; ok {
		b, ok := v.(bool)
		if !ok {
			return nil, fmt.Errorf("%w: endpoint.skipTLSVerify must be a boolean", ErrInvalid)
		}
		ep["skipTLSVerify"] = b
	}
	if len(ep) == 0 {
		return nil, fmt.Errorf("%w: endpoint.apiServer or endpoint.tlsServerName is required", ErrInvalid)
	}
	out["endpoint"] = ep
	ns, err := stringList(spec, "allowedNamespaces", 32, 63)
	if err != nil {
		return nil, err
	}
	if _, present := spec["allowedNamespaces"]; present {
		if len(ns) == 0 {
			return nil, fmt.Errorf("%w: allowedNamespaces must not be empty (deny-by-default)", ErrInvalid)
		}
		for _, name := range ns {
			if !kubernetes.ValidNamespace(name) {
				return nil, fmt.Errorf("%w: allowedNamespaces contains an invalid namespace", ErrInvalid)
			}
		}
		out["allowedNamespaces"] = ns
	}
	policy, err := optionalUUID(spec, "policyId")
	if err != nil {
		return nil, err
	}
	if policy != "" {
		out["policyId"] = policy
	}
	sa, err := normalizeServiceAccount(spec)
	if err != nil {
		return nil, err
	}
	if sa != nil {
		if ns, ok := sa["namespace"].(string); ok && ns != "" {
			if allowed, has := out["allowedNamespaces"].([]string); has && !containsFold(allowed, ns) {
				return nil, fmt.Errorf("%w: serviceAccount.namespace must be in allowedNamespaces", ErrInvalid)
			}
		}
		out["serviceAccount"] = sa
	}
	if err := rejectUnknown(spec, "credentialId", "endpoint", "allowedNamespaces", "policyId", "serviceAccount"); err != nil {
		return nil, err
	}
	return out, nil
}

func normalizeServiceAccount(spec map[string]any) (map[string]any, error) {
	raw, err := objectField(spec, "serviceAccount")
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, nil
	}
	name, ok, err := optionalString(raw, "name", 1, 63)
	if err != nil || !ok {
		return nil, fmt.Errorf("%w: serviceAccount.name is required", ErrInvalid)
	}
	if !kubernetes.ValidServiceAccountName(name) {
		return nil, fmt.Errorf("%w: serviceAccount.name is not a valid service account", ErrInvalid)
	}
	tmpl, err := kubernetes.NormalizeRoleTemplate("")
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalid, err)
	}
	if v, ok, err := optionalString(raw, "roleTemplate", 1, 64); err != nil {
		return nil, err
	} else if ok {
		tmpl, err = kubernetes.NormalizeRoleTemplate(v)
		if err != nil {
			return nil, fmt.Errorf("%w: %s", ErrInvalid, err)
		}
	}
	out := map[string]any{
		"name":         name,
		"roleTemplate": tmpl,
	}
	if ns, ok, err := optionalString(raw, "namespace", 1, 63); err != nil {
		return nil, err
	} else if ok {
		if !kubernetes.ValidNamespace(ns) {
			return nil, fmt.Errorf("%w: serviceAccount.namespace is not a valid namespace", ErrInvalid)
		}
		out["namespace"] = ns
	}
	if err := rejectUnknown(raw, "name", "namespace", "roleTemplate"); err != nil {
		return nil, err
	}
	return out, nil
}

func normalizeSSHTarget(spec map[string]any) (map[string]any, error) {
	out := map[string]any{}
	cred, err := optionalUUID(spec, "credentialId")
	if err != nil {
		return nil, err
	}
	if cred == "" {
		return nil, fmt.Errorf("%w: credentialId is required", ErrInvalid)
	}
	out["credentialId"] = cred
	host, ok, err := optionalString(spec, "hostname", 1, 253)
	if err != nil || !ok {
		return nil, fmt.Errorf("%w: hostname is required", ErrInvalid)
	}
	canonHost, err := ssheng.NormalizeHostname(host)
	if err != nil {
		return nil, mapSSHErr(err)
	}
	out["hostname"] = canonHost
	_, portPresent := spec["port"]
	port, err := ssheng.NormalizePort(spec["port"], portPresent)
	if err != nil {
		return nil, mapSSHErr(err)
	}
	out["port"] = port
	fp, ok, err := optionalString(spec, "hostKeyFingerprint", 8, 200)
	if err != nil || !ok {
		return nil, fmt.Errorf("%w: hostKeyFingerprint is required", ErrInvalid)
	}
	canonFP, err := ssheng.NormalizeFingerprint(fp)
	if err != nil {
		return nil, mapSSHErr(err)
	}
	out["hostKeyFingerprint"] = canonFP
	_, addrsPresent := spec["allowedAddresses"]
	addrs, err := stringList(spec, "allowedAddresses", 32, 64)
	if err != nil {
		return nil, err
	}
	canonAddrs, err := ssheng.NormalizeAddresses(addrs, addrsPresent)
	if err != nil {
		return nil, mapSSHErr(err)
	}
	if canonAddrs != nil {
		out["allowedAddresses"] = canonAddrs
	}
	policy, err := optionalUUID(spec, "policyId")
	if err != nil {
		return nil, err
	}
	if policy != "" {
		out["policyId"] = policy
	}
	if err := rejectUnknown(spec, "credentialId", "hostname", "port", "hostKeyFingerprint", "allowedAddresses", "policyId"); err != nil {
		return nil, err
	}
	return out, nil
}

func normalizeCommandProfile(spec map[string]any) (map[string]any, error) {
	out := map[string]any{}
	schema, err := objectField(spec, "parameterSchema")
	if err != nil {
		return nil, err
	}
	if schema == nil {
		return nil, fmt.Errorf("%w: parameterSchema is required", ErrInvalid)
	}
	canonSchema, parsed, err := ssheng.NormalizeParameterSchema(schema)
	if err != nil {
		return nil, mapSSHErr(err)
	}
	out["parameterSchema"] = canonSchema
	tmpl, ok, err := optionalString(spec, "template", 1, 8192)
	if err != nil || !ok {
		return nil, fmt.Errorf("%w: template is required", ErrInvalid)
	}
	canonTmpl, err := ssheng.NormalizeTemplate(tmpl, parsed)
	if err != nil {
		return nil, mapSSHErr(err)
	}
	out["template"] = canonTmpl
	retrySafe := false
	if raw, exists := spec["retrySafe"]; exists {
		b, ok := raw.(bool)
		if !ok {
			return nil, fmt.Errorf("%w: retrySafe must be a boolean", ErrInvalid)
		}
		retrySafe = b
	}
	out["retrySafe"] = retrySafe
	policy, err := optionalUUID(spec, "policyId")
	if err != nil {
		return nil, err
	}
	if policy != "" {
		out["policyId"] = policy
	}
	if err := rejectUnknown(spec, "parameterSchema", "template", "retrySafe", "policyId"); err != nil {
		return nil, err
	}
	return out, nil
}

func normalizeRuntimeProfile(spec map[string]any) (map[string]any, error) {
	out := map[string]any{}
	lang, ok, err := optionalString(spec, "language", 1, 32)
	if err != nil || !ok {
		return nil, fmt.Errorf("%w: language is required", ErrInvalid)
	}
	lang = strings.ToLower(lang)
	if lang != "python" && lang != "go" {
		return nil, fmt.Errorf("%w: language must be python or go", ErrInvalid)
	}
	out["language"] = lang
	image, ok, err := optionalString(spec, "imageDigest", 10, 80)
	if err != nil || !ok || !digestRE.MatchString(image) {
		return nil, fmt.Errorf("%w: imageDigest must be sha256:<hex>", ErrInvalid)
	}
	out["imageDigest"] = image
	lock, ok, err := optionalString(spec, "dependencyLockDigest", 10, 80)
	if err != nil || !ok || !digestRE.MatchString(lock) {
		return nil, fmt.Errorf("%w: dependencyLockDigest must be sha256:<hex>", ErrInvalid)
	}
	out["dependencyLockDigest"] = lock
	limits, err := objectField(spec, "limits")
	if err != nil {
		return nil, err
	}
	if limits == nil {
		return nil, fmt.Errorf("%w: limits is required", ErrInvalid)
	}
	lim := map[string]any{}
	for _, key := range []string{"cpuMillis", "memoryMib", "timeoutSeconds", "processes"} {
		raw, exists := limits[key]
		if !exists {
			return nil, fmt.Errorf("%w: limits.%s is required", ErrInvalid, key)
		}
		n, err := asInt(raw)
		if err != nil || n < 1 || n > 1_000_000 {
			return nil, fmt.Errorf("%w: limits.%s is out of range", ErrInvalid, key)
		}
		lim[key] = n
	}
	if err := rejectUnknown(limits, "cpuMillis", "memoryMib", "timeoutSeconds", "processes"); err != nil {
		return nil, err
	}
	out["limits"] = lim
	if err := rejectUnknown(spec, "language", "imageDigest", "dependencyLockDigest", "limits"); err != nil {
		return nil, err
	}
	return out, nil
}

func normalizeConnection(spec map[string]any) (map[string]any, error) {
	out := map[string]any{}
	typ, ok, err := optionalString(spec, "type", 1, 32)
	if err != nil || !ok {
		return nil, fmt.Errorf("%w: type is required", ErrInvalid)
	}
	typ = strings.ToLower(typ)
	switch typ {
	case "http", "webhook", "smtp":
		out["type"] = typ
	default:
		return nil, fmt.Errorf("%w: type must be http, webhook, or smtp", ErrInvalid)
	}
	cred, err := optionalUUID(spec, "credentialId")
	if err != nil {
		return nil, err
	}
	if cred != "" {
		out["credentialId"] = cred
	}
	policy, err := objectField(spec, "endpointPolicy")
	if err != nil {
		return nil, err
	}
	if policy == nil {
		return nil, fmt.Errorf("%w: endpointPolicy is required", ErrInvalid)
	}
	ep := map[string]any{}
	hosts, err := stringList(policy, "hosts", 32, 253)
	if err != nil || len(hosts) == 0 {
		return nil, fmt.Errorf("%w: endpointPolicy.hosts is required", ErrInvalid)
	}
	ep["hosts"] = hosts
	methods, err := stringList(policy, "methods", 8, 16)
	if err != nil || len(methods) == 0 {
		return nil, fmt.Errorf("%w: endpointPolicy.methods is required", ErrInvalid)
	}
	for i, m := range methods {
		methods[i] = strings.ToUpper(m)
		switch methods[i] {
		case "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD":
		default:
			return nil, fmt.Errorf("%w: endpointPolicy.methods contains an unsupported method", ErrInvalid)
		}
	}
	ep["methods"] = methods
	paths, err := stringList(policy, "pathPrefixes", 32, 256)
	if err != nil || len(paths) == 0 {
		return nil, fmt.Errorf("%w: endpointPolicy.pathPrefixes is required", ErrInvalid)
	}
	ep["pathPrefixes"] = paths
	ports := []any{}
	if raw, exists := policy["ports"]; exists {
		arr, ok := raw.([]any)
		if !ok || len(arr) == 0 || len(arr) > 16 {
			return nil, fmt.Errorf("%w: endpointPolicy.ports is invalid", ErrInvalid)
		}
		for _, item := range arr {
			n, err := asInt(item)
			if err != nil || n < 1 || n > 65535 {
				return nil, fmt.Errorf("%w: endpointPolicy.ports is invalid", ErrInvalid)
			}
			ports = append(ports, n)
		}
	} else {
		ports = []any{443}
	}
	ep["ports"] = ports
	tls := true
	if raw, exists := policy["tlsRequired"]; exists {
		b, ok := raw.(bool)
		if !ok {
			return nil, fmt.Errorf("%w: endpointPolicy.tlsRequired must be a boolean", ErrInvalid)
		}
		tls = b
	}
	ep["tlsRequired"] = tls
	allowRedirects := false
	if raw, exists := policy["allowRedirects"]; exists {
		b, ok := raw.(bool)
		if !ok {
			return nil, fmt.Errorf("%w: endpointPolicy.allowRedirects must be a boolean", ErrInvalid)
		}
		allowRedirects = b
	}
	ep["allowRedirects"] = allowRedirects
	maxRedirects := 0
	if raw, exists := policy["maxRedirects"]; exists {
		n, err := asInt(raw)
		if err != nil || n < 0 || n > 5 {
			return nil, fmt.Errorf("%w: endpointPolicy.maxRedirects must be 0-5", ErrInvalid)
		}
		maxRedirects = n
	}
	ep["maxRedirects"] = maxRedirects
	if err := rejectUnknown(policy, "hosts", "methods", "pathPrefixes", "ports", "tlsRequired", "allowRedirects", "maxRedirects"); err != nil {
		return nil, err
	}
	out["endpointPolicy"] = ep
	if err := rejectUnknown(spec, "type", "credentialId", "endpointPolicy"); err != nil {
		return nil, err
	}
	return out, nil
}

func normalizeRecipientList(spec map[string]any) (map[string]any, error) {
	policy, err := objectField(spec, "recipientPolicy")
	if err != nil {
		return nil, err
	}
	if policy == nil {
		return nil, fmt.Errorf("%w: recipientPolicy is required", ErrInvalid)
	}
	emails, err := stringList(policy, "emails", 64, 254)
	if err != nil {
		return nil, err
	}
	domains, err := stringList(policy, "domains", 64, 253)
	if err != nil {
		return nil, err
	}
	if len(emails) == 0 && len(domains) == 0 {
		return nil, fmt.Errorf("%w: recipientPolicy must include emails or domains", ErrInvalid)
	}
	for _, e := range emails {
		if !emailRE.MatchString(strings.ToLower(e)) {
			return nil, fmt.Errorf("%w: recipient email is not allowlisted-safe", ErrInvalid)
		}
	}
	for i, d := range domains {
		d = strings.ToLower(d)
		if !domainRE.MatchString(d) {
			return nil, fmt.Errorf("%w: recipient domain is not allowlisted-safe", ErrInvalid)
		}
		domains[i] = d
	}
	for i, e := range emails {
		emails[i] = strings.ToLower(e)
	}
	outPolicy := map[string]any{"allowlistOnly": true}
	if emails != nil {
		outPolicy["emails"] = emails
	}
	if domains != nil {
		outPolicy["domains"] = domains
	}
	if err := rejectUnknown(policy, "emails", "domains", "allowlistOnly"); err != nil {
		return nil, err
	}
	if err := rejectUnknown(spec, "recipientPolicy"); err != nil {
		return nil, err
	}
	return map[string]any{"recipientPolicy": outPolicy}, nil
}

func normalizeMessageTemplate(spec map[string]any) (map[string]any, error) {
	schema, err := objectField(spec, "inputSchema")
	if err != nil {
		return nil, err
	}
	if schema == nil {
		return nil, fmt.Errorf("%w: inputSchema is required", ErrInvalid)
	}
	class, ok, err := optionalString(spec, "contentClassification", 1, 32)
	if err != nil || !ok {
		return nil, fmt.Errorf("%w: contentClassification is required", ErrInvalid)
	}
	switch class {
	case "public", "internal", "confidential":
	default:
		return nil, fmt.Errorf("%w: contentClassification must be public, internal, or confidential", ErrInvalid)
	}
	subject, _, err := optionalString(spec, "subject", 0, 200)
	if err != nil {
		return nil, err
	}
	body, ok, err := optionalString(spec, "body", 1, 16384)
	if err != nil || !ok {
		return nil, fmt.Errorf("%w: body is required", ErrInvalid)
	}
	if strings.Contains(body, "{{") || strings.Contains(body, "${") {
		return nil, fmt.Errorf("%w: template body cannot include interpolation syntax", ErrInvalid)
	}
	out := map[string]any{
		"inputSchema":           schema,
		"contentClassification": class,
		"body":                  body,
	}
	if subject != "" {
		out["subject"] = subject
	}
	if err := rejectUnknown(spec, "inputSchema", "contentClassification", "subject", "body"); err != nil {
		return nil, err
	}
	return out, nil
}

func normalizeResponseSchema(spec map[string]any) (map[string]any, error) {
	schema, err := objectField(spec, "schema")
	if err != nil {
		return nil, err
	}
	if schema == nil {
		return nil, fmt.Errorf("%w: schema is required", ErrInvalid)
	}
	raw, exists := spec["maxBytes"]
	if !exists {
		return nil, fmt.Errorf("%w: maxBytes is required", ErrInvalid)
	}
	n, err := asInt(raw)
	if err != nil || n < 1 || n > 1_048_576 {
		return nil, fmt.Errorf("%w: maxBytes must be 1-1048576", ErrInvalid)
	}
	if err := rejectUnknown(spec, "schema", "maxBytes"); err != nil {
		return nil, err
	}
	return map[string]any{"schema": schema, "maxBytes": n}, nil
}

func normalizePolicy(spec map[string]any) (map[string]any, error) {
	kind, ok, err := optionalString(spec, "kind", 1, 32)
	if err != nil || !ok {
		return nil, fmt.Errorf("%w: kind is required", ErrInvalid)
	}
	switch kind {
	case "kubernetes", "ssh", "script", "http", "notification", "approval":
	default:
		return nil, fmt.Errorf("%w: policy kind is not supported", ErrInvalid)
	}
	policy, err := objectField(spec, "policy")
	if err != nil {
		return nil, err
	}
	if policy == nil {
		return nil, fmt.Errorf("%w: policy is required", ErrInvalid)
	}
	if kind == "kubernetes" {
		normalized, err := normalizeKubernetesPolicyObject(policy)
		if err != nil {
			return nil, err
		}
		policy = normalized
	}
	if kind == "ssh" {
		normalized, err := normalizeSSHPolicyObject(policy)
		if err != nil {
			return nil, err
		}
		policy = normalized
	}
	if err := rejectUnknown(spec, "kind", "policy"); err != nil {
		return nil, err
	}
	return map[string]any{"kind": kind, "policy": policy}, nil
}

func normalizeKubernetesPolicyObject(policy map[string]any) (map[string]any, error) {
	if err := rejectUnknown(policy, kubernetes.KubernetesPolicyKeys()...); err != nil {
		return nil, err
	}
	out := map[string]any{}
	if raw, ok := policy[kubernetes.KeyDeny]; ok {
		b, ok := raw.(bool)
		if !ok {
			return nil, fmt.Errorf("%w: policy.deny must be a boolean", ErrInvalid)
		}
		out[kubernetes.KeyDeny] = b
	}
	if raw, ok := policy[kubernetes.KeyRequireApproval]; ok {
		b, ok := raw.(bool)
		if !ok {
			return nil, fmt.Errorf("%w: policy.requireApproval must be a boolean", ErrInvalid)
		}
		out[kubernetes.KeyRequireApproval] = b
	}
	if v, ok, err := optionalString(policy, kubernetes.KeyApproverRole, 1, 64); err != nil {
		return nil, err
	} else if ok {
		out[kubernetes.KeyApproverRole] = v
	}
	if v, ok, err := optionalString(policy, kubernetes.KeyExpiresIn, 2, 32); err != nil {
		return nil, err
	} else if ok {
		exp, parseErr := workflow.ParseISODuration(v)
		if parseErr != nil || exp <= 0 {
			return nil, fmt.Errorf("%w: policy.expiresIn must be an ISO-8601 duration", ErrInvalid)
		}
		if exp > 7*24*time.Hour {
			return nil, fmt.Errorf("%w: policy.expiresIn cannot exceed P7D", ErrInvalid)
		}
		out[kubernetes.KeyExpiresIn] = v
	}
	ops, err := stringList(policy, kubernetes.KeyOperations, 16, 64)
	if err != nil {
		return nil, err
	}
	if _, present := policy[kubernetes.KeyOperations]; present {
		if len(ops) == 0 {
			return nil, fmt.Errorf("%w: policy.operations must not be empty", ErrInvalid)
		}
		out[kubernetes.KeyOperations] = ops
	}
	ns, err := normalizeK8sAllowlist(policy, "namespace", kubernetes.KeyAllowedNamespaces, kubernetes.KeyNamespaces)
	if err != nil {
		return nil, err
	}
	if ns != nil {
		out[kubernetes.KeyAllowedNamespaces] = ns
	}
	kinds, err := normalizeK8sAllowlist(policy, "kind", kubernetes.KeyAllowedKinds, kubernetes.KeyKinds)
	if err != nil {
		return nil, err
	}
	if kinds != nil {
		out[kubernetes.KeyAllowedKinds] = kinds
	}
	verbs, err := normalizeK8sAllowlist(policy, "verb", kubernetes.KeyAllowedVerbs, kubernetes.KeyVerbs)
	if err != nil {
		return nil, err
	}
	if verbs != nil {
		out[kubernetes.KeyAllowedVerbs] = verbs
	}
	images, err := normalizeK8sAllowlist(policy, "image", kubernetes.KeyAllowedImages, kubernetes.KeyImages)
	if err != nil {
		return nil, err
	}
	if images != nil {
		out[kubernetes.KeyAllowedImages] = images
	}
	hosts, err := normalizeK8sAllowlist(policy, "ingressHost", kubernetes.KeyAllowedIngressHosts, kubernetes.KeyIngressHosts)
	if err != nil {
		return nil, err
	}
	if hosts != nil {
		out[kubernetes.KeyAllowedIngressHosts] = hosts
	}
	return out, nil
}

func normalizeSSHPolicyObject(policy map[string]any) (map[string]any, error) {
	if err := rejectUnknown(policy, ssheng.SSHPolicyKeys()...); err != nil {
		return nil, err
	}
	out := map[string]any{}
	if raw, ok := policy[ssheng.KeyDeny]; ok {
		b, ok := raw.(bool)
		if !ok {
			return nil, fmt.Errorf("%w: policy.deny must be a boolean", ErrInvalid)
		}
		out[ssheng.KeyDeny] = b
	}
	if raw, ok := policy[ssheng.KeyRequireApproval]; ok {
		b, ok := raw.(bool)
		if !ok {
			return nil, fmt.Errorf("%w: policy.requireApproval must be a boolean", ErrInvalid)
		}
		out[ssheng.KeyRequireApproval] = b
	}
	if v, ok, err := optionalString(policy, ssheng.KeyApproverRole, 1, 64); err != nil {
		return nil, err
	} else if ok {
		out[ssheng.KeyApproverRole] = v
	}
	if v, ok, err := optionalString(policy, ssheng.KeyExpiresIn, 2, 32); err != nil {
		return nil, err
	} else if ok {
		exp, parseErr := workflow.ParseISODuration(v)
		if parseErr != nil || exp <= 0 {
			return nil, fmt.Errorf("%w: policy.expiresIn must be an ISO-8601 duration", ErrInvalid)
		}
		if exp > 7*24*time.Hour {
			return nil, fmt.Errorf("%w: policy.expiresIn cannot exceed P7D", ErrInvalid)
		}
		out[ssheng.KeyExpiresIn] = v
	}
	ops, err := stringList(policy, ssheng.KeyOperations, 16, 64)
	if err != nil {
		return nil, err
	}
	if _, present := policy[ssheng.KeyOperations]; present {
		if len(ops) == 0 {
			return nil, fmt.Errorf("%w: policy.operations must not be empty", ErrInvalid)
		}
		out[ssheng.KeyOperations] = ops
	}
	hosts, err := normalizeSSHAllowlist(policy, "host", ssheng.KeyAllowedHosts, ssheng.KeyHosts)
	if err != nil {
		return nil, err
	}
	if hosts != nil {
		out[ssheng.KeyAllowedHosts] = hosts
	}
	addrs, err := normalizeSSHAllowlist(policy, "address", ssheng.KeyAllowedAddresses, ssheng.KeyAddresses)
	if err != nil {
		return nil, err
	}
	if addrs != nil {
		out[ssheng.KeyAllowedAddresses] = addrs
	}
	return out, nil
}

func normalizeSSHAllowlist(policy map[string]any, kind string, canonical, alias string) ([]string, error) {
	_, hasCanonical := policy[canonical]
	_, hasAlias := policy[alias]
	if hasCanonical && hasAlias {
		return nil, fmt.Errorf("%w: use %s or %s, not both", ErrInvalid, canonical, alias)
	}
	key := ""
	if hasCanonical {
		key = canonical
	} else if hasAlias {
		key = alias
	} else {
		return nil, nil
	}
	maxLen := 253
	if kind == "address" {
		maxLen = 64
	}
	items, err := stringList(policy, key, 32, maxLen)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, fmt.Errorf("%w: policy.%s must not be empty (deny-by-default)", ErrInvalid, key)
	}
	if kind == "address" {
		canon, err := ssheng.NormalizeAddresses(items, true)
		if err != nil {
			return nil, mapSSHErr(err)
		}
		return canon, nil
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(items))
	for _, item := range items {
		host, err := ssheng.NormalizeHostname(item)
		if err != nil {
			return nil, fmt.Errorf("%w: policy.%s contains an invalid host", ErrInvalid, key)
		}
		if _, dup := seen[host]; dup {
			continue
		}
		seen[host] = struct{}{}
		out = append(out, host)
	}
	return out, nil
}

func normalizeK8sAllowlist(policy map[string]any, kind string, canonical, alias string) ([]string, error) {
	_, hasCanonical := policy[canonical]
	_, hasAlias := policy[alias]
	if hasCanonical && hasAlias {
		return nil, fmt.Errorf("%w: use %s or %s, not both", ErrInvalid, canonical, alias)
	}
	key := ""
	if hasCanonical {
		key = canonical
	} else if hasAlias {
		key = alias
	} else {
		return nil, nil
	}
	maxLen := 63
	if kind == "image" {
		maxLen = 256
	}
	if kind == "ingressHost" {
		maxLen = 253
	}
	items, err := stringList(policy, key, 32, maxLen)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, fmt.Errorf("%w: policy.%s must not be empty (deny-by-default)", ErrInvalid, key)
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(items))
	for _, item := range items {
		switch kind {
		case "namespace":
			if !kubernetes.ValidNamespace(item) {
				return nil, fmt.Errorf("%w: policy.%s contains an invalid namespace", ErrInvalid, key)
			}
		case "kind":
			if !kubernetes.ValidKind(item) || !kubernetes.KindAllowed(item) {
				return nil, fmt.Errorf("%w: policy.%s contains a kind that is not on the engine allowlist", ErrInvalid, key)
			}
		case "verb":
			if !kubernetes.VerbAllowed(item) {
				return nil, fmt.Errorf("%w: policy.%s contains an unsupported verb", ErrInvalid, key)
			}
			item = strings.ToLower(item)
		case "image":
			if !strings.Contains(item, "/") && !strings.Contains(item, ".") && !strings.Contains(item, "@") {
				return nil, fmt.Errorf("%w: policy.%s contains an invalid image reference", ErrInvalid, key)
			}
		case "ingressHost":
			if !hostnameRE.MatchString(item) {
				return nil, fmt.Errorf("%w: policy.%s contains an invalid host", ErrInvalid, key)
			}
			item = strings.ToLower(item)
		}
		if _, dup := seen[item]; dup {
			continue
		}
		seen[item] = struct{}{}
		out = append(out, item)
	}
	return out, nil
}

// ValidateReady enforces publish/select constraints that drafts may omit.
func ValidateReady(kind string, spec map[string]any) error {
	if spec == nil {
		return fmt.Errorf("%w: spec is required", ErrInvalid)
	}
	switch kind {
	case KindClusterTarget:
		if credentialIDFromSpec(spec) == "" {
			return fmt.Errorf("%w: credentialId is required", ErrInvalid)
		}
		endpoint, err := objectField(spec, "endpoint")
		if err != nil || endpoint == nil {
			return fmt.Errorf("%w: endpoint is required", ErrInvalid)
		}
		if _, hasAPI := endpoint["apiServer"]; !hasAPI {
			if _, hasTLS := endpoint["tlsServerName"]; !hasTLS {
				return fmt.Errorf("%w: endpoint.apiServer or endpoint.tlsServerName is required", ErrInvalid)
			}
		}
		return nil
	case KindSSHTarget:
		if credentialIDFromSpec(spec) == "" {
			return fmt.Errorf("%w: credentialId is required", ErrInvalid)
		}
		host, _ := spec["hostname"].(string)
		if strings.TrimSpace(host) == "" {
			return fmt.Errorf("%w: hostname is required", ErrInvalid)
		}
		fp, _ := spec["hostKeyFingerprint"].(string)
		if _, err := ssheng.NormalizeFingerprint(fp); err != nil {
			return mapSSHErr(err)
		}
		if _, present := spec["allowedAddresses"]; present {
			addrs, _ := spec["allowedAddresses"].([]string)
			if addrs == nil {
				if raw, ok := spec["allowedAddresses"].([]any); ok {
					addrs = make([]string, 0, len(raw))
					for _, item := range raw {
						s, _ := item.(string)
						addrs = append(addrs, s)
					}
				}
			}
			if _, err := ssheng.NormalizeAddresses(addrs, true); err != nil {
				return mapSSHErr(err)
			}
		}
		return nil
	case KindCommandProfile:
		schema, _ := spec["parameterSchema"].(map[string]any)
		parsed, err := ssheng.ParseSchema(schema)
		if err != nil {
			return mapSSHErr(err)
		}
		tmpl, _ := spec["template"].(string)
		if _, err := ssheng.NormalizeTemplate(tmpl, parsed); err != nil {
			return mapSSHErr(err)
		}
		return nil
	case KindPolicy:
		policyKind, _ := spec["kind"].(string)
		if policyKind == "ssh" {
			rules, _ := spec["policy"].(map[string]any)
			if rules == nil {
				return fmt.Errorf("%w: policy is required", ErrInvalid)
			}
			if deny, _ := rules[ssheng.KeyDeny].(bool); deny {
				return nil
			}
			hosts, hostsPresent := ssheng.Hosts(rules)
			addrs, addrsPresent := ssheng.Addresses(rules)
			if hostsPresent && len(hosts) == 0 {
				return fmt.Errorf("%w: ssh policy host allowlist must not be empty", ErrInvalid)
			}
			if addrsPresent && len(addrs) == 0 {
				return fmt.Errorf("%w: ssh policy address allowlist must not be empty", ErrInvalid)
			}
			return nil
		}
		if policyKind != "kubernetes" {
			return nil
		}
		rules, _ := spec["policy"].(map[string]any)
		if rules == nil {
			return fmt.Errorf("%w: policy is required", ErrInvalid)
		}
		if deny, _ := rules[kubernetes.KeyDeny].(bool); deny {
			return nil
		}
		if ns, present := kubernetes.Namespaces(rules); !present || len(ns) == 0 {
			return fmt.Errorf("%w: kubernetes policy requires a non-empty allowedNamespaces (or namespaces) allowlist", ErrInvalid)
		}
		return nil
	default:
		return nil
	}
}

// TargetNamespacesConsistent reports whether every target namespace is in the
// bound Kubernetes policy allowlist. A missing policy allowlist is not a
// constraint. An empty present target or policy list fails closed.
func TargetNamespacesConsistent(targetSpec, policySpec map[string]any) error {
	targetNS, targetPresent := kubernetes.Namespaces(targetSpec)
	if targetPresent && len(targetNS) == 0 {
		return fmt.Errorf("%w: allowedNamespaces must not be empty", ErrInvalid)
	}
	if policySpec == nil {
		return nil
	}
	kind, _ := policySpec["kind"].(string)
	rules, _ := policySpec["policy"].(map[string]any)
	if kind != "" && kind != "kubernetes" {
		return fmt.Errorf("%w: cluster targets must bind a kubernetes policy", ErrInvalid)
	}
	policyNS, policyPresent := kubernetes.Namespaces(rules)
	if policyPresent && len(policyNS) == 0 {
		return fmt.Errorf("%w: bound policy namespace allowlist must not be empty", ErrInvalid)
	}
	if !targetPresent || !policyPresent {
		return nil
	}
	for _, ns := range targetNS {
		if !kubernetes.Allowed(policyNS, ns) {
			return fmt.Errorf("%w: allowedNamespaces must be a subset of the bound kubernetes policy", ErrInvalid)
		}
	}
	return nil
}

// TargetAddressesConsistent reports whether the SSH target hostname/addresses
// are allowed by a bound ssh policy. Empty present allowlists fail closed.
func TargetAddressesConsistent(targetSpec, policySpec map[string]any) error {
	if policySpec == nil {
		return nil
	}
	kind, _ := policySpec["kind"].(string)
	rules, _ := policySpec["policy"].(map[string]any)
	if kind != "" && kind != "ssh" {
		return fmt.Errorf("%w: SSH targets must bind an ssh policy", ErrInvalid)
	}
	host, _ := targetSpec["hostname"].(string)
	if hosts, present := ssheng.Hosts(rules); present {
		if len(hosts) == 0 || !ssheng.Allowed(hosts, host) {
			return fmt.Errorf("%w: hostname must be on the bound ssh policy host allowlist", ErrInvalid)
		}
	}
	if policyAddrs, present := ssheng.Addresses(rules); present {
		if len(policyAddrs) == 0 {
			return fmt.Errorf("%w: bound policy address allowlist must not be empty", ErrInvalid)
		}
		targetAddrs, targetPresent := targetAddressList(targetSpec)
		if targetPresent && len(targetAddrs) == 0 {
			return fmt.Errorf("%w: allowedAddresses must not be empty", ErrInvalid)
		}
		if targetPresent {
			for _, addr := range targetAddrs {
				if !ssheng.Allowed(policyAddrs, addr) {
					return fmt.Errorf("%w: allowedAddresses must be a subset of the bound ssh policy", ErrInvalid)
				}
			}
		}
	}
	return nil
}

func targetAddressList(spec map[string]any) ([]string, bool) {
	if spec == nil {
		return nil, false
	}
	raw, ok := spec["allowedAddresses"]
	if !ok || raw == nil {
		return nil, false
	}
	switch v := raw.(type) {
	case []string:
		return append([]string(nil), v...), true
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			s, _ := item.(string)
			s = strings.TrimSpace(s)
			if s != "" {
				out = append(out, s)
			}
		}
		return out, true
	default:
		return nil, true
	}
}

// ValidateSSHRunParameters checks ssh.run values against a pinned profile spec.
func ValidateSSHRunParameters(profileSpec map[string]any, values map[string]any) error {
	_, err := ssheng.RenderFromSpec(profileSpec, values)
	if err != nil {
		return mapSSHErr(err)
	}
	return nil
}

func mapSSHErr(err error) error {
	if err == nil {
		return nil
	}
	msg := strings.TrimPrefix(err.Error(), ssheng.ErrInvalid.Error()+": ")
	return fmt.Errorf("%w: %s", ErrInvalid, msg)
}

// RedactSpec strips secret-shaped keys so kubeconfig/plaintext never leave the API.
func RedactSpec(spec map[string]any) map[string]any {
	return redactMap(spec)
}

func optionalUUID(spec map[string]any, key string) (string, error) {
	raw, ok := spec[key]
	if !ok || raw == nil {
		return "", nil
	}
	s, ok := raw.(string)
	if !ok || !authz.ValidUUID(strings.TrimSpace(s)) {
		return "", fmt.Errorf("%w: %s must be a UUID", ErrInvalid, key)
	}
	return strings.TrimSpace(s), nil
}

func optionalString(spec map[string]any, key string, min, max int) (string, bool, error) {
	raw, ok := spec[key]
	if !ok || raw == nil {
		return "", false, nil
	}
	s, ok := raw.(string)
	if !ok {
		return "", false, fmt.Errorf("%w: %s must be a string", ErrInvalid, key)
	}
	s = strings.TrimSpace(s)
	if len(s) < min || len(s) > max {
		return "", false, fmt.Errorf("%w: %s length is invalid", ErrInvalid, key)
	}
	return s, true, nil
}

func objectField(spec map[string]any, key string) (map[string]any, error) {
	raw, ok := spec[key]
	if !ok || raw == nil {
		return nil, nil
	}
	obj, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%w: %s must be an object", ErrInvalid, key)
	}
	return obj, nil
}

func stringList(spec map[string]any, key string, maxItems, maxLen int) ([]string, error) {
	raw, ok := spec[key]
	if !ok || raw == nil {
		return nil, nil
	}
	arr, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("%w: %s must be an array of strings", ErrInvalid, key)
	}
	if len(arr) == 0 {
		return []string{}, nil
	}
	if len(arr) > maxItems {
		return nil, fmt.Errorf("%w: %s exceeds %d items", ErrInvalid, key, maxItems)
	}
	out := make([]string, 0, len(arr))
	seen := map[string]struct{}{}
	for _, item := range arr {
		s, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("%w: %s must be an array of strings", ErrInvalid, key)
		}
		s = strings.TrimSpace(s)
		if s == "" || len(s) > maxLen {
			return nil, fmt.Errorf("%w: %s contains an invalid value", ErrInvalid, key)
		}
		if _, dup := seen[s]; dup {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out, nil
}

func asInt(raw any) (int, error) {
	switch v := raw.(type) {
	case float64:
		if v != float64(int(v)) {
			return 0, ErrInvalid
		}
		return int(v), nil
	case int:
		return v, nil
	case int64:
		return int(v), nil
	case json.Number:
		n, err := v.Int64()
		return int(n), err
	case string:
		return strconv.Atoi(v)
	default:
		return 0, ErrInvalid
	}
}

func rejectUnknown(spec map[string]any, allowed ...string) error {
	ok := map[string]struct{}{}
	for _, a := range allowed {
		ok[a] = struct{}{}
	}
	for key := range spec {
		if _, known := ok[key]; !known {
			return fmt.Errorf("%w: unknown field %s", ErrInvalid, key)
		}
	}
	return nil
}

func normalizeSlug(slug, name string) (string, error) {
	slug = strings.TrimSpace(slug)
	if slug == "" {
		slug = slugify(name)
	}
	if !slugRE.MatchString(slug) {
		return "", fmt.Errorf("%w: slug must be a lower-case hyphenated identifier", ErrInvalid)
	}
	return slug, nil
}

func slugify(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	var b strings.Builder
	lastHyphen := true
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			b.WriteRune(r)
			lastHyphen = false
		default:
			if !lastHyphen {
				b.WriteByte('-')
				lastHyphen = true
			}
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "resource"
	}
	if out[0] >= '0' && out[0] <= '9' {
		out = "r-" + out
	}
	if len(out) > 63 {
		out = strings.Trim(out[:63], "-")
	}
	return out
}

func normalizeName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 200 {
		return "", fmt.Errorf("%w: name must be 1-200 characters", ErrInvalid)
	}
	return name, nil
}

func credentialIDFromSpec(spec map[string]any) string {
	raw, _ := spec["credentialId"].(string)
	return strings.TrimSpace(raw)
}

func policyIDFromSpec(spec map[string]any) string {
	raw, _ := spec["policyId"].(string)
	return strings.TrimSpace(raw)
}

func containsFold(items []string, want string) bool {
	want = strings.TrimSpace(want)
	for _, item := range items {
		if strings.EqualFold(item, want) {
			return true
		}
	}
	return false
}

// Secret-bearing field names. Keys under JSON Schema `properties` /
// `$defs` / `definitions` are property names and are kept. Anywhere else,
// those keys are stripped regardless of value type.
var secretSpecKeys = map[string]struct{}{
	"kubeconfig": {}, "privatekey": {}, "private_key": {}, "passphrase": {},
	"token": {}, "secret": {}, "password": {}, "authorization": {},
}

func redactMap(in map[string]any) map[string]any {
	if in == nil {
		return map[string]any{}
	}
	out := make(map[string]any, len(in))
	for k, v := range in {
		if isSchemaNameMap(k) {
			out[k] = cloneSchemaNameMap(v)
			continue
		}
		if _, secret := secretSpecKeys[strings.ToLower(k)]; secret {
			continue
		}
		out[k] = cloneJSONValue(v)
	}
	return out
}

func isSchemaNameMap(key string) bool {
	switch strings.ToLower(key) {
	case "properties", "$defs", "definitions":
		return true
	default:
		return false
	}
}

func cloneSchemaNameMap(v any) any {
	obj, ok := v.(map[string]any)
	if !ok {
		return cloneJSONValue(v)
	}
	out := make(map[string]any, len(obj))
	for name, schema := range obj {
		out[name] = cloneJSONValue(schema)
	}
	return out
}

func cloneJSONValue(v any) any {
	switch t := v.(type) {
	case map[string]any:
		return redactMap(t)
	case []any:
		out := make([]any, len(t))
		for i, item := range t {
			out[i] = cloneJSONValue(item)
		}
		return out
	case []string:
		return append([]string(nil), t...)
	case []int:
		return append([]int(nil), t...)
	default:
		return t
	}
}
