package rt

import (
	"strings"
	"testing"
)

// The typecheck route's spec lists every status the handler returns.
func TestTypecheckOperationStatuses650(t *testing.T) {
	op, err := typecheckOperation(Route{Method: "POST", Pattern: "/api/v1/workflows/{workflowId}/draft/typecheck", Auth: AuthAuthenticated})
	if err != nil {
		t.Fatal(err)
	}
	var codes []string
	for i := 0; i+1 < len(op.Content); i += 2 {
		if op.Content[i].Value == "responses" {
			r := op.Content[i+1]
			for j := 0; j < len(r.Content); j += 2 {
				codes = append(codes, r.Content[j].Value)
			}
		}
	}
	if got := strings.Join(codes, ","); got != "200,401,403,404,405,429,500,503" {
		t.Fatalf("statuses = %s", got)
	}
}
