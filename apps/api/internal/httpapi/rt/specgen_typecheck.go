package rt

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// typecheckRoute is the #650 E3.2 draft type-check route. Its responses
// match the handler: 404 for a workflow not visible in the workspace (RLS),
// 429 from the per-user or per-workspace limiter, 503 when a limiter is not
// configured (fail closed).
const typecheckRoute = "POST /api/v1/workflows/{workflowId}/draft/typecheck"

func typecheckOperation(rt Route) (*yaml.Node, error) {
	var b strings.Builder
	fmt.Fprintf(&b, "operationId: %s\n", operationID(rt.Method, rt.OpenAPIPath()))
	b.WriteString("summary: Type-check the draft's FFX expressions\n")
	b.WriteString("description: |\n")
	b.WriteString("  Runs the publish-time FFX checker on the stored draft. Never evaluates an expression and takes no body.\n")
	b.WriteString("  Requires workflow.edit and CSRF. Rate-limited per user and per workspace. References resolve only within the draft.\n")
	b.WriteString("  Returns types, codes and paths only; never expression source or values.\n")
	fmt.Fprintf(&b, "  Auth class: %s. Identity proxy: %s.\n", rt.Auth, rt.Proxy)
	b.WriteString("  Responses never include secrets, credentials, tokens, private keys, or vault material.\n")
	b.WriteString("responses:\n")
	b.WriteString("  \"200\":\n    description: Check result (ok, catalogRevision, draftRevision, expressions, errors).\n")
	b.WriteString("  \"401\":\n    $ref: \"#/components/responses/Unauthenticated\"\n")
	b.WriteString("  \"403\":\n    $ref: \"#/components/responses/Forbidden\"\n")
	b.WriteString("  \"404\":\n    $ref: \"#/components/responses/NotFound\"\n")
	b.WriteString("  \"405\":\n    $ref: \"#/components/responses/MethodNotAllowed\"\n")
	b.WriteString("  \"429\":\n    $ref: \"#/components/responses/RateLimited\"\n")
	b.WriteString("  \"500\":\n    $ref: \"#/components/responses/InternalError\"\n")
	b.WriteString("  \"503\":\n    $ref: \"#/components/responses/DependencyUnavailable\"\n")
	return unmarshalNode(b.String())
}
