package kubernetes

import "strings"

// AuditSnapshot is the secret-free apply/watch record for jobs and audit_events.
// It never includes kubeconfig, raw objects, or secret data.
type AuditSnapshot struct {
	ActorID         string             `json:"actorId,omitempty"`
	Operation       string             `json:"operation"`
	ClusterTargetID string             `json:"clusterTargetId,omitempty"`
	Namespace       string             `json:"namespace,omitempty"`
	PolicyRevision  string             `json:"policyRevision,omitempty"`
	PolicyDigest    string             `json:"policyDigest,omitempty"`
	ManifestDigest  string             `json:"manifestDigest,omitempty"`
	Resources       []ResourceIdentity `json:"resources,omitempty"`
	ServerDryRun    bool               `json:"serverDryRun"`
	Applied         bool               `json:"applied"`
	Watch           string             `json:"watch,omitempty"`
	Observation     string             `json:"observation,omitempty"`
	CorrelationID   string             `json:"correlationId,omitempty"`
	Outcome         string             `json:"outcome"`
	ErrorCode       string             `json:"errorCode,omitempty"`
}

// SnapshotAudit builds a redacted audit view of an engine result.
func SnapshotAudit(req Request, res Result) AuditSnapshot {
	watch := strings.TrimSpace(res.Observation)
	if watch == "" && res.Wait == "ready" {
		watch = ObservationSkipped
	}
	outcome := "success"
	var code string
	if res.Error != nil {
		outcome = "failure"
		code = res.Error.Code
		if watch == "" {
			watch = res.Error.Code
		}
	} else if !res.OK {
		outcome = "failure"
	}
	return AuditSnapshot{
		ActorID:         strings.TrimSpace(req.ActorID),
		Operation:       res.Operation,
		ClusterTargetID: res.ClusterTargetID,
		Namespace:       res.Namespace,
		PolicyRevision:  res.PolicyRevision,
		PolicyDigest:    res.PolicyDigest,
		ManifestDigest:  res.ManifestDigest,
		Resources:       append([]ResourceIdentity(nil), res.Resources...),
		ServerDryRun:    res.ServerDryRun,
		Applied:         res.Applied,
		Watch:           watch,
		Observation:     res.Observation,
		CorrelationID:   res.CorrelationID,
		Outcome:         outcome,
		ErrorCode:       code,
	}
}

func auditMap(snap AuditSnapshot) map[string]any {
	raw := map[string]any{
		"operation":       snap.Operation,
		"clusterTargetId": snap.ClusterTargetID,
		"namespace":       snap.Namespace,
		"policyRevision":  snap.PolicyRevision,
		"policyDigest":    snap.PolicyDigest,
		"manifestDigest":  snap.ManifestDigest,
		"serverDryRun":    snap.ServerDryRun,
		"applied":         snap.Applied,
		"watch":           snap.Watch,
		"observation":     snap.Observation,
		"correlationId":   snap.CorrelationID,
		"outcome":         snap.Outcome,
	}
	if snap.ActorID != "" {
		raw["actorId"] = snap.ActorID
	}
	if snap.ErrorCode != "" {
		raw["errorCode"] = snap.ErrorCode
	}
	if len(snap.Resources) > 0 {
		ids := make([]map[string]any, 0, len(snap.Resources))
		for _, id := range snap.Resources {
			item := map[string]any{
				"apiVersion": id.APIVersion,
				"kind":       id.Kind,
				"namespace":  id.Namespace,
				"name":       id.Name,
			}
			if id.Generation > 0 {
				item["generation"] = id.Generation
			}
			ids = append(ids, item)
		}
		raw["resources"] = ids
	}
	if v, ok := RedactValue(raw).(map[string]any); ok {
		return v
	}
	return raw
}

func attachAudit(req Request, res Result) Result {
	res.Audit = auditMap(SnapshotAudit(req, res))
	return res
}
