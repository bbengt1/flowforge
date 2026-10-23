package workflow

import "strings"

// E3.5 per-item onError helpers. The S2 allowlist is checked per item;
// non-allowlisted codes and every indeterminate item fail the step.

// ItemFailure is one item that failed during in-process evaluation of a
// pure core node. Message is already safe (no item contents, no expression
// text). Lineage is filled by the engine when it knows upstream refs.
type ItemFailure struct {
	Idx     int
	Code    string
	Message string
	Lineage map[string]any
}

// RoutableSystemCodes is the S2 allowlist of system failure codes onError
// may route (whole-step or per-item). Shared by publish-time docs and the
// store. Security, policy, authz, isolation, egress, artifact and
// emergency-stop codes are never listed here.
var RoutableSystemCodes = map[string]struct{}{
	"timeout":             {},
	"connect-failed":      {},
	"command-failed":      {},
	"delivery-failed":     {},
	"dry-run-failed":      {},
	"apply-failed":        {},
	"read-failed":         {},
	"rollout-failed":      {},
	"cluster-unreachable": {},
	"script-failed":       {},
	// Ordinary core item failures (E3.5). Caps and resource codes stay
	// off the list so they fail the step closed.
	"expression-runtime":       {},
	"expression-type":          {},
	"expression-cost-exceeded": {},
	"expression-timeout":       {},
	"sort-key-missing":         {},
	"sort-mixed-types":         {},
}

// RoutableSystemCode reports whether code is on the S2 allowlist.
func RoutableSystemCode(code string) bool {
	if code == "" || len(code) > 64 {
		return false
	}
	_, ok := RoutableSystemCodes[code]
	return ok
}

// ItemErrorPayload is the error-port object for one routed item failure:
// {code, message ≤256 B, idx, lineage} only. No item contents, no
// expression text, no values echoed.
func ItemErrorPayload(f ItemFailure) map[string]any {
	code := strings.TrimSpace(f.Code)
	if len(code) > 64 {
		code = strings.ToValidUTF8(code[:64], "")
	}
	msg := strings.TrimSpace(f.Message)
	if len(msg) > MaxSafeMessageBytes {
		msg = strings.ToValidUTF8(msg[:MaxSafeMessageBytes], "")
	}
	lin := f.Lineage
	if lin == nil {
		lin = map[string]any{"idx": f.Idx, "src": []any{}}
	}
	return map[string]any{"code": code, "message": msg, "idx": f.Idx, "lineage": lin}
}

// ContinueAllFailedItems is the continue-mode items-port value when every
// item failed: exactly one empty object.
func ContinueAllFailedItems() map[string]any {
	return map[string]any{ItemsField: []any{map[string]any{}}}
}

// ApplyItemOnError folds per-item failures into outputs under the given
// onError mode. successes is the port map that would have been written if
// every item succeeded (already with failed items removed from items
// ports when mode is continue or errorOutput). failures are only the
// routable ones the caller already filtered; a non-routable failure must
// fail the step before calling this.
//
// itemsPorts names which output ports carry {items: [...]} so continue
// can place [{}] when every item failed. Non-items ports keep {}.
//
// Returns the final outputs and whether any item was routed.
func ApplyItemOnError(mode string, successes map[string]any, failures []ItemFailure, itemsPorts []string) (map[string]any, bool) {
	if len(failures) == 0 || (mode != OnErrorContinue && mode != OnErrorOutput) {
		return successes, false
	}
	out := map[string]any{}
	for k, v := range successes {
		out[k] = v
	}
	itemsSet := map[string]struct{}{}
	for _, p := range itemsPorts {
		itemsSet[p] = struct{}{}
	}
	switch mode {
	case OnErrorContinue:
		for _, p := range itemsPorts {
			if emptyItemsPort(out[p]) {
				out[p] = ContinueAllFailedItems()
			}
		}
		// Non-items primary keep {} when absent (caller already set).
	case OnErrorOutput:
		errItems := make([]any, 0, len(failures))
		for _, f := range failures {
			errItems = append(errItems, ItemErrorPayload(f))
		}
		out[ErrorPortName] = map[string]any{ItemsField: errItems}
	}
	_ = itemsSet
	return out, true
}

func emptyItemsPort(v any) bool {
	m, ok := v.(map[string]any)
	if !ok || m == nil {
		return true
	}
	raw, ok := m[ItemsField]
	if !ok {
		return true
	}
	switch t := raw.(type) {
	case []any:
		return len(t) == 0
	case []map[string]any:
		return len(t) == 0
	default:
		return true
	}
}

// DropItemAt removes index idx from an items port value, returning a new
// {items: [...]} without that element. Out of range is a no-op.
func DropItemAt(portVal any, idx int) map[string]any {
	items, ok := portVal.(map[string]any)
	if !ok {
		return itemsValue(nil)
	}
	list, errs := carriedItems(items, "port")
	if len(errs) > 0 || idx < 0 || idx >= len(list) {
		return items
	}
	out := make([]map[string]any, 0, len(list)-1)
	for i, it := range list {
		if i == idx {
			continue
		}
		out = append(out, it)
	}
	return itemsValue(out)
}
