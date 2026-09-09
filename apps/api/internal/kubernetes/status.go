package kubernetes

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
)

// WatchPollInterval is the bounded observation poll cadence.
var WatchPollInterval = 200 * time.Millisecond

// RolloutProgress is the redacted generation/state Chloe and audit consume.
// It never includes raw object dumps, secret data, or kubeconfig.
type RolloutProgress struct {
	APIVersion             string `json:"apiVersion,omitempty"`
	Kind                   string `json:"kind"`
	Namespace              string `json:"namespace"`
	Name                   string `json:"name"`
	Generation             int64  `json:"generation,omitempty"`
	ObservedGeneration     int64  `json:"observedGeneration,omitempty"`
	Replicas               int64  `json:"replicas,omitempty"`
	ReadyReplicas          int64  `json:"readyReplicas,omitempty"`
	UpdatedReplicas        int64  `json:"updatedReplicas,omitempty"`
	AvailableReplicas      int64  `json:"availableReplicas,omitempty"`
	UnavailableReplicas    int64  `json:"unavailableReplicas,omitempty"`
	CurrentReplicas        int64  `json:"currentReplicas,omitempty"`
	DesiredNumberScheduled int64  `json:"desiredNumberScheduled,omitempty"`
	CurrentNumberScheduled int64  `json:"currentNumberScheduled,omitempty"`
	UpdatedNumberScheduled int64  `json:"updatedNumberScheduled,omitempty"`
	NumberAvailable        int64  `json:"numberAvailable,omitempty"`
	NumberReady            int64  `json:"numberReady,omitempty"`
	NumberUnavailable      int64  `json:"numberUnavailable,omitempty"`
	Completions            int64  `json:"completions,omitempty"`
	Succeeded              int64  `json:"succeeded,omitempty"`
	Failed                 int64  `json:"failed,omitempty"`
	Active                 int64  `json:"active,omitempty"`
	State                  string `json:"state"`
	Reason                 string `json:"reason,omitempty"`
}

// EvaluateRollout inspects a namespaced object and returns secret-free progress.
func EvaluateRollout(obj Unstructured) RolloutProgress {
	id := identityOf(obj)
	progress := RolloutProgress{
		APIVersion: id.APIVersion,
		Kind:       id.Kind,
		Namespace:  id.Namespace,
		Name:       id.Name,
		Generation: id.Generation,
		State:      ObservationProgressing,
		Reason:     "awaiting-status",
	}
	if !ObservableKind(id.Kind) {
		progress.State = ObservationSkipped
		progress.Reason = "not-observable"
		return progress
	}
	status, _ := asStringKeyMap(obj["status"])
	spec, _ := asStringKeyMap(obj["spec"])
	if n, ok := intField(status, "observedGeneration"); ok {
		progress.ObservedGeneration = n
	}
	switch id.Kind {
	case "Deployment":
		evaluateDeployment(&progress, spec, status)
	case "StatefulSet":
		evaluateStatefulSet(&progress, spec, status)
	case "DaemonSet":
		evaluateDaemonSet(&progress, status)
	case "Job":
		evaluateJob(&progress, spec, status)
	}
	return progress
}

func evaluateDeployment(p *RolloutProgress, spec, status map[string]any) {
	replicas := int64(1)
	if n, ok := intField(spec, "replicas"); ok {
		replicas = n
	}
	p.Replicas = replicas
	p.UpdatedReplicas, _ = intField(status, "updatedReplicas")
	p.ReadyReplicas, _ = intField(status, "readyReplicas")
	p.AvailableReplicas, _ = intField(status, "availableReplicas")
	p.UnavailableReplicas, _ = intField(status, "unavailableReplicas")
	if cond, reason, ok := condition(status, "Progressing"); ok && strings.EqualFold(reason, "ProgressDeadlineExceeded") && !truthy(cond) {
		p.State = ObservationFailed
		p.Reason = "progress-deadline-exceeded"
		return
	}
	if status == nil {
		return
	}
	if p.ObservedGeneration < p.Generation {
		p.Reason = "generation-lag"
		return
	}
	available, _, hasAvailable := condition(status, "Available")
	if p.UpdatedReplicas == replicas && p.ReadyReplicas == replicas && p.AvailableReplicas == replicas && p.UnavailableReplicas == 0 && p.ObservedGeneration >= p.Generation && (!hasAvailable || truthy(available)) {
		p.State = ObservationReady
		p.Reason = "available"
		return
	}
	p.Reason = "replicas-not-ready"
}

func evaluateStatefulSet(p *RolloutProgress, spec, status map[string]any) {
	replicas := int64(1)
	if n, ok := intField(spec, "replicas"); ok {
		replicas = n
	}
	p.Replicas = replicas
	p.ReadyReplicas, _ = intField(status, "readyReplicas")
	p.CurrentReplicas, _ = intField(status, "currentReplicas")
	p.UpdatedReplicas, _ = intField(status, "updatedReplicas")
	if status == nil {
		return
	}
	if p.ObservedGeneration > 0 && p.ObservedGeneration < p.Generation {
		p.Reason = "generation-lag"
		return
	}
	if p.ReadyReplicas == replicas && (p.UpdatedReplicas == 0 || p.UpdatedReplicas == replicas) {
		p.State = ObservationReady
		p.Reason = "ready-replicas"
		return
	}
	p.Reason = "replicas-not-ready"
}

func evaluateDaemonSet(p *RolloutProgress, status map[string]any) {
	p.DesiredNumberScheduled, _ = intField(status, "desiredNumberScheduled")
	p.CurrentNumberScheduled, _ = intField(status, "currentNumberScheduled")
	p.UpdatedNumberScheduled, _ = intField(status, "updatedNumberScheduled")
	p.NumberAvailable, _ = intField(status, "numberAvailable")
	p.NumberReady, _ = intField(status, "numberReady")
	p.NumberUnavailable, _ = intField(status, "numberUnavailable")
	if status == nil {
		return
	}
	if p.ObservedGeneration > 0 && p.ObservedGeneration < p.Generation {
		p.Reason = "generation-lag"
		return
	}
	if p.UpdatedNumberScheduled == p.DesiredNumberScheduled && p.NumberAvailable == p.DesiredNumberScheduled {
		p.State = ObservationReady
		p.Reason = "available"
		return
	}
	p.Reason = "replicas-not-ready"
}

func evaluateJob(p *RolloutProgress, spec, status map[string]any) {
	if n, ok := intField(spec, "completions"); ok {
		p.Completions = n
	} else {
		p.Completions = 1
	}
	p.Succeeded, _ = intField(status, "succeeded")
	p.Failed, _ = intField(status, "failed")
	p.Active, _ = intField(status, "active")
	if cond, _, ok := condition(status, "Failed"); ok && truthy(cond) {
		p.State = ObservationFailed
		p.Reason = "job-failed"
		return
	}
	if cond, _, ok := condition(status, "Complete"); ok && truthy(cond) {
		p.State = ObservationReady
		p.Reason = "job-complete"
		return
	}
	if p.Succeeded >= p.Completions && p.Completions > 0 {
		p.State = ObservationReady
		p.Reason = "job-complete"
		return
	}
	if status == nil {
		return
	}
	p.Reason = "job-active"
}

func condition(status map[string]any, typ string) (value, reason string, ok bool) {
	if status == nil {
		return "", "", false
	}
	raw, _ := status["conditions"].([]any)
	for _, item := range raw {
		m, _ := asStringKeyMap(item)
		if m == nil {
			continue
		}
		got, _ := m["type"].(string)
		if !strings.EqualFold(strings.TrimSpace(got), typ) {
			continue
		}
		value, _ = m["status"].(string)
		reason, _ = m["reason"].(string)
		return strings.TrimSpace(value), strings.TrimSpace(reason), true
	}
	return "", "", false
}

func truthy(status string) bool {
	return strings.EqualFold(strings.TrimSpace(status), "true")
}

func waitReady(ctx context.Context, client ClusterClient, id ResourceIdentity) (RolloutProgress, *EngineError) {
	if ctx == nil {
		ctx = context.Background()
	}
	var last RolloutProgress
	for {
		if err := observationContextError(ctx); err != nil {
			if last.Kind == "" {
				last = RolloutProgress{Kind: id.Kind, Namespace: id.Namespace, Name: id.Name, State: err.Code, Reason: err.Code}
			} else {
				last.State = err.Code
				last.Reason = err.Code
			}
			return last, err
		}
		obj, err := client.Watch(ctx, id.Kind, id.Namespace, id.Name)
		if err != nil {
			if ee := observationContextError(ctx); ee != nil {
				last.State = ee.Code
				last.Reason = ee.Code
				return last, ee
			}
			if ee := asEngineError(err); ee != nil && ee.Code == CodeRBACDenied {
				return last, ee
			}
			if ee := asEngineError(err); ee != nil && (ee.Code == CodeCanceled || ee.Code == CodeTimeout) {
				last.State = ee.Code
				last.Reason = ee.Code
				return last, ee
			}
			// Not found / empty status: keep polling until timeout.
			if ee := asEngineError(err); ee != nil && ee.Code != CodeReadFailed {
				return last, wrapClusterError(err, CodeReadFailed)
			}
		} else {
			last = EvaluateRollout(obj)
			if last.State == ObservationReady {
				return last, nil
			}
			if last.State == ObservationFailed {
				return last, engineError(CodeRolloutFailed, rolloutFailedMessage(last), http.StatusConflict)
			}
		}
		timer := time.NewTimer(WatchPollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			if err := observationContextError(ctx); err != nil {
				last.State = err.Code
				last.Reason = err.Code
				return last, err
			}
		case <-timer.C:
		}
	}
}

func observeIdentities(ctx context.Context, client ClusterClient, ids []ResourceIdentity) (string, []RolloutProgress, *EngineError) {
	progress := make([]RolloutProgress, 0, len(ids))
	observed := 0
	for _, id := range ids {
		if !ObservableKind(id.Kind) {
			progress = append(progress, RolloutProgress{
				APIVersion: id.APIVersion,
				Kind:       id.Kind,
				Namespace:  id.Namespace,
				Name:       id.Name,
				Generation: id.Generation,
				State:      ObservationSkipped,
				Reason:     "not-observable",
			})
			continue
		}
		observed++
		item, err := waitReady(ctx, client, id)
		progress = append(progress, item)
		if err != nil {
			state := ObservationFailed
			if err.Code == CodeTimeout || err.Code == CodeCanceled {
				state = err.Code
			}
			return state, progress, err
		}
	}
	if observed == 0 {
		return ObservationSkipped, progress, nil
	}
	return ObservationReady, progress, nil
}

func observationContextError(ctx context.Context) *EngineError {
	if ctx == nil {
		return nil
	}
	err := ctx.Err()
	if err == nil {
		return nil
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return engineError(CodeTimeout, "rollout observation exceeded timeoutSeconds; resources were not deleted or rolled back", http.StatusRequestTimeout)
	}
	if errors.Is(err, context.Canceled) {
		return engineError(CodeCanceled, "rollout observation was canceled; resources were not deleted or rolled back", http.StatusRequestTimeout)
	}
	return engineError(CodeTimeout, "rollout observation stopped; resources were not deleted or rolled back", http.StatusRequestTimeout)
}

func rolloutFailedMessage(p RolloutProgress) string {
	if p.Kind == "Job" {
		return "Job failed; resources were not deleted or rolled back"
	}
	return "rollout failed; resources were not deleted or rolled back"
}

func progressAsMaps(items []RolloutProgress) []map[string]any {
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		raw, _ := RedactValue(progressToMap(item)).(map[string]any)
		if raw != nil {
			out = append(out, raw)
		}
	}
	return out
}

func progressToMap(p RolloutProgress) map[string]any {
	out := map[string]any{
		"kind":      p.Kind,
		"namespace": p.Namespace,
		"name":      p.Name,
		"state":     p.State,
	}
	if p.APIVersion != "" {
		out["apiVersion"] = p.APIVersion
	}
	if p.Reason != "" {
		out["reason"] = p.Reason
	}
	setIfPositive(out, "generation", p.Generation)
	setIfPositive(out, "observedGeneration", p.ObservedGeneration)
	setIfPositive(out, "replicas", p.Replicas)
	setIfNonZero(out, "readyReplicas", p.ReadyReplicas)
	setIfNonZero(out, "updatedReplicas", p.UpdatedReplicas)
	setIfNonZero(out, "availableReplicas", p.AvailableReplicas)
	setIfNonZero(out, "unavailableReplicas", p.UnavailableReplicas)
	setIfNonZero(out, "currentReplicas", p.CurrentReplicas)
	setIfNonZero(out, "desiredNumberScheduled", p.DesiredNumberScheduled)
	setIfNonZero(out, "currentNumberScheduled", p.CurrentNumberScheduled)
	setIfNonZero(out, "updatedNumberScheduled", p.UpdatedNumberScheduled)
	setIfNonZero(out, "numberAvailable", p.NumberAvailable)
	setIfNonZero(out, "numberReady", p.NumberReady)
	setIfNonZero(out, "numberUnavailable", p.NumberUnavailable)
	setIfNonZero(out, "completions", p.Completions)
	setIfNonZero(out, "succeeded", p.Succeeded)
	setIfNonZero(out, "failed", p.Failed)
	setIfNonZero(out, "active", p.Active)
	return out
}

func setIfPositive(out map[string]any, key string, n int64) {
	if n > 0 {
		out[key] = n
	}
}

func setIfNonZero(out map[string]any, key string, n int64) {
	if n != 0 {
		out[key] = n
	}
}

// withReadyStatus writes a controller-like ready status for fake-client tests.
func withReadyStatus(obj Unstructured) Unstructured {
	out := cloneUnstructured(obj)
	if out == nil {
		return obj
	}
	id := identityOf(out)
	spec, _ := asStringKeyMap(out["spec"])
	replicas := int64(1)
	if n, ok := intField(spec, "replicas"); ok {
		replicas = n
	}
	switch id.Kind {
	case "Deployment":
		out["status"] = map[string]any{
			"observedGeneration":  id.Generation,
			"replicas":            replicas,
			"updatedReplicas":     replicas,
			"readyReplicas":       replicas,
			"availableReplicas":   replicas,
			"unavailableReplicas": 0,
			"conditions": []any{
				map[string]any{"type": "Available", "status": "True"},
				map[string]any{"type": "Progressing", "status": "True", "reason": "NewReplicaSetAvailable"},
			},
		}
	case "StatefulSet":
		out["status"] = map[string]any{
			"observedGeneration": id.Generation,
			"replicas":           replicas,
			"readyReplicas":      replicas,
			"currentReplicas":    replicas,
			"updatedReplicas":    replicas,
		}
	case "DaemonSet":
		out["status"] = map[string]any{
			"observedGeneration":     id.Generation,
			"desiredNumberScheduled": 1,
			"currentNumberScheduled": 1,
			"updatedNumberScheduled": 1,
			"numberAvailable":        1,
			"numberReady":            1,
			"numberUnavailable":      0,
		}
	case "Job":
		out["status"] = map[string]any{
			"succeeded": 1,
			"active":    0,
			"failed":    0,
			"conditions": []any{
				map[string]any{"type": "Complete", "status": "True"},
			},
		}
	}
	return out
}
