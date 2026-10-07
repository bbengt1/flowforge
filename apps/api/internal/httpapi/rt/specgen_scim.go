package rt

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// SCIM workspace token admin routes and the two SCIM bearer doors.

const scimTokenAdminCommon = "Requires workspace.administer and MFA step-up on a local-login or OIDC session (403 mfa-required until TOTP is verified in this session). " +
	"An embed session is refused with 403 forbidden before permissions are read. There is no /embed/v1 surface for SCIM tokens. " +
	"The workspace is the server-derived workspace for the request, never a body field."

var scimTokenAdminOps = map[string]groupOp{
	"GET /api/v1/workspace/scim-tokens": {
		summary: "List SCIM workspace tokens",
		description: []string{
			"Lists the workspace's active (not revoked) SCIM tokens, newest first. Not paged: a workspace has at most maxActive (2) active tokens. Revoked tokens are never listed.",
			"Each item is display name, UUID, prefix, createdBy (display name and UUID; null when the creator no longer exists), createdAt, and lastUsedAt. The token itself and its hash are never returned after creation.",
			"configured is false when the instance has no SCIM issuer (SCIM_ISSUER, else OIDC_ISSUER); creating a token is then 503 scim_not_configured.",
		},
		success:     "200",
		successDesc: "Active tokens.",
		successBody: "ScimTokenList",
	},
	"POST /api/v1/workspace/scim-tokens": {
		summary: "Create a SCIM workspace token",
		description: []string{
			"Mints a bearer for this workspace's IdP. The response is the only place the plaintext token appears: token is ffscim_ followed by 43 base64url characters (32 random bytes). The server stores only the SHA-256 of the whole token and sets Cache-Control no-store. The token is never logged or audited.",
			"displayName is trimmed and must be 1-128 characters; otherwise 400 invalid-request with errors[].path displayName. Names need not be unique.",
			"At most two tokens per workspace are active so an IdP can rotate: create the second, switch the IdP, revoke the first. A third create is 409 scim_token_limit, including a create that loses a race for the last slot.",
			"503 scim_not_configured when the instance has no SCIM issuer. Nothing is stored.",
			"Writes audit action scim_token.create (resource scim_token, details displayName) in the same transaction.",
		},
		requestBody: "CreateScimTokenRequest",
		success:     "201",
		successDesc: "Created. The body carries the plaintext token once.",
		successBody: "ScimTokenCreated",
		extra:       []string{"400:InvalidRequest", "409:ScimTokenLimit"},
	},
	"DELETE /api/v1/workspace/scim-tokens/{tokenId}": {
		summary: "Revoke a SCIM workspace token",
		description: []string{
			"Sets revoked_at. The row is kept for audit and never listed again. From the next request on, the token is 401 at /scim/v2. Requests already past authentication finish. Users and memberships it provisioned are unchanged.",
			"Idempotent: revoking a token that is already revoked is 204 and writes no second audit row. An unknown id, another workspace's token, or a value that is not a UUID is 404, after the permission and step-up checks.",
			"Revoking one of two active tokens leaves the other working.",
			"Writes audit action scim_token.revoke (resource scim_token, details displayName) in the same transaction.",
		},
		params:      []string{"ScimTokenID"},
		success:     "204",
		successDesc: "Revoked. No body.",
		extra:       []string{"404:NotFound"},
	},
}

func scimTokenAdminOperation(rt Route, op groupOp) (*yaml.Node, error) {
	var b strings.Builder
	fmt.Fprintf(&b, "operationId: %s\n", operationID(rt.Method, rt.OpenAPIPath()))
	fmt.Fprintf(&b, "summary: %s\n", op.summary)
	b.WriteString("description: |\n")
	for _, line := range op.description {
		fmt.Fprintf(&b, "  %s\n", line)
	}
	fmt.Fprintf(&b, "  %s\n", scimTokenAdminCommon)
	fmt.Fprintf(&b, "  Auth class: %s. Identity proxy: %s.\n", rt.Auth, rt.Proxy)
	b.WriteString("  Only the create response includes a token, once. No other response includes secrets, credentials, tokens, private keys, or vault material.\n")
	if len(op.params) > 0 {
		b.WriteString("parameters:\n")
		for _, p := range op.params {
			fmt.Fprintf(&b, "  - $ref: \"#/components/parameters/%s\"\n", p)
		}
	}
	if op.requestBody != "" {
		b.WriteString("requestBody:\n  required: true\n  content:\n    application/json:\n      schema:\n")
		fmt.Fprintf(&b, "        $ref: \"#/components/schemas/%s\"\n", op.requestBody)
	}
	b.WriteString("responses:\n")
	fmt.Fprintf(&b, "  %q:\n", op.success)
	fmt.Fprintf(&b, "    description: %s\n", op.successDesc)
	if op.success == "201" {
		b.WriteString("    headers:\n      Cache-Control:\n        description: Always no-store.\n        schema: {type: string, enum: [no-store]}\n")
	}
	if op.successBody != "" {
		b.WriteString("    content:\n      application/json:\n        schema:\n")
		fmt.Fprintf(&b, "          $ref: \"#/components/schemas/%s\"\n", op.successBody)
	}
	b.WriteString("  \"401\":\n    $ref: \"#/components/responses/Unauthenticated\"\n")
	b.WriteString("  \"403\":\n    $ref: \"#/components/responses/ScimTokenAdminForbidden\"\n")
	for _, e := range op.extra {
		code, ref, _ := strings.Cut(e, ":")
		fmt.Fprintf(&b, "  %q:\n    $ref: \"#/components/responses/%s\"\n", code, ref)
	}
	b.WriteString("  \"405\":\n    $ref: \"#/components/responses/MethodNotAllowed\"\n")
	b.WriteString("  \"500\":\n    $ref: \"#/components/responses/InternalError\"\n")
	if rt.Method == "POST" {
		b.WriteString("  \"503\":\n    $ref: \"#/components/responses/ScimTokenCreateUnavailable\"\n")
	} else {
		b.WriteString("  \"503\":\n    $ref: \"#/components/responses/DependencyUnavailable\"\n")
	}
	return unmarshalNode(b.String())
}

// scimDoor is shared by every /scim/v2 route.
var scimDoor = []string{
	"SCIM 2.0 bearer door (RFC 7644). Errors are application/scim+json SCIM Error documents, not problem+json. The bearer is never logged, audited, or echoed.",
	"Two bearers are accepted. The instance token (SCIM_BEARER_TOKEN) is instance-wide and behaves as before. A workspace token (ffscim_ prefix, created under /api/v1/workspace/scim-tokens) resolves to its one workspace, and every read and write for it runs in that workspace's scoped transaction (FORCE RLS).",
	"A bearer with the ffscim_ prefix is only ever looked up as a workspace token by the SHA-256 of the whole string; it is never compared to the instance token. 401 when it is malformed, unknown, or revoked, or when its workspace or tenant is not active. 503 when the instance has no SCIM issuer.",
	"Users created through a workspace token use the instance SCIM issuer and SCIM_DEFAULT_ROLE, the same as the instance token.",
}

var scimRouteNotes = map[string][]string{
	"GET /scim/v2/Users": {
		"Instance token: every active directory user, as before.",
		"Workspace token: only users linked to this workspace (scim_workspace_users), with this workspace's userName and externalId. filter supports userName, externalId, and id, all against this workspace's links.",
		"active is true only when the account is active and the user holds a role binding in this workspace.",
	},
	"POST /scim/v2/Users": {
		"Instance token: unchanged.",
		"Workspace token: find or create the user by SCIM issuer plus subject (externalId, else userName), link it to this workspace with the posted userName and externalId, and add SCIM_DEFAULT_ROLE here (existing roles here are kept). 201 with the resource.",
		"A user who already exists and is globally disabled is linked and added but stays disabled: 201 with active false. active false in the body adds nothing beyond the link. The account is never enabled by a workspace token.",
		"409 uniqueness when this user is already linked here, or when the userName or externalId is already linked here to a different user. Uniqueness is per workspace.",
		"Writes audit action scim_user.workspace_add in this workspace.",
	},
	"GET /scim/v2/Users/{id}": {
		"Workspace token: 404 unless the user is linked to this workspace, including any user in another workspace.",
	},
	"PUT /scim/v2/Users/{id}": {
		"Instance token: unchanged, including global disable and session revoke on active false.",
		"Workspace token: 404 unless linked here. active false removes the user from this workspace only (see DELETE) but keeps the link, so the resource stays visible with active false. active true is ignored: it never enables the account and never restores the membership.",
		"userName, externalId, displayName, and name changes are ignored. The response shows the current values, and the ignored change writes audit action scim_user.change_ignored with the attribute names only.",
	},
	"PATCH /scim/v2/Users/{id}": {
		"Same rules as PUT for each token kind.",
	},
	"DELETE /scim/v2/Users/{id}": {
		"Instance token: unchanged (global disable, session revoke, removal from every workspace).",
		"Workspace token: 404 unless linked here. In one transaction, deletes the user's role bindings and group rows in this workspace and the link. Never disables the account, revokes sessions, or touches another workspace.",
		"Removing the last workspace admin is 409 and changes nothing.",
		"Writes audit action scim_user.workspace_remove in this workspace.",
	},
	"GET /scim/v2/Groups": {
		"Instance token: every active workspace is a Group, as before. filter supports displayName, externalId (the workbench key), and id.",
		"Workspace token: exactly one Group, this workspace. Its members are the users linked here who hold a role binding here. Filters apply to that one Group.",
	},
	"POST /scim/v2/Groups": {
		"400 for both token kinds: Groups are existing workspaces.",
	},
	"GET /scim/v2/Groups/{id}": {
		"Workspace token: 404 for any id other than this workspace.",
	},
	"PUT /scim/v2/Groups/{id}": {
		"400 for both token kinds. Patch members to change membership.",
	},
	"PATCH /scim/v2/Groups/{id}": {
		"Instance token: unchanged.",
		"Workspace token: 404 for any id other than this workspace. add takes users linked to this workspace only; any other id is 400 invalidValue and the whole patch changes nothing. add grants SCIM_DEFAULT_ROLE here. remove is the same as the workspace-token user DELETE without deleting the link, including the last-admin 409.",
	},
	"DELETE /scim/v2/Groups/{id}": {
		"400 for both token kinds: workspaces cannot be deleted here.",
	},
	"GET /scim/v2/ServiceProviderConfig": {"Same document for both token kinds."},
	"GET /scim/v2/Schemas":               {"Same document for both token kinds."},
	"GET /scim/v2/ResourceTypes":         {"Same document for both token kinds."},
}

func scimOperation(rt Route) (*yaml.Node, bool, error) {
	notes, ok := scimRouteNotes[rt.Method+" "+rt.Pattern]
	if !ok {
		return nil, false, nil
	}
	var b strings.Builder
	fmt.Fprintf(&b, "operationId: %s\n", operationID(rt.Method, rt.OpenAPIPath()))
	fmt.Fprintf(&b, "summary: SCIM %s %s\n", rt.Method, strings.TrimPrefix(rt.Pattern, "/scim/v2"))
	b.WriteString("description: |\n")
	for _, line := range append(append([]string{}, scimDoor...), notes...) {
		fmt.Fprintf(&b, "  %s\n", line)
	}
	fmt.Fprintf(&b, "  Auth class: %s. Identity proxy: %s.\n", rt.Auth, rt.Proxy)
	b.WriteString("responses:\n")
	switch {
	case rt.Method == "POST" && rt.Pattern == "/scim/v2/Users":
		b.WriteString("  \"201\":\n    description: Created or linked.\n")
	case rt.Method == "DELETE" && rt.Pattern == "/scim/v2/Users/{id}":
		b.WriteString("  \"204\":\n    description: Removed. No body.\n")
	default:
		b.WriteString("  \"200\":\n    description: Success.\n")
	}
	b.WriteString("  \"400\":\n    description: SCIM error (invalid request, invalidValue, or unsupported filter).\n")
	b.WriteString("  \"401\":\n    description: SCIM error. Missing, malformed, unknown, or revoked bearer, or the workspace token's workspace or tenant is not active. WWW-Authenticate Bearer.\n")
	if strings.Contains(rt.Pattern, "{id}") {
		b.WriteString("  \"404\":\n    description: SCIM error. Not found, or not visible to this workspace token.\n")
	}
	if rt.Method != "GET" {
		b.WriteString("  \"409\":\n    description: SCIM error. Uniqueness conflict, or the change would remove the last workspace admin.\n")
	}
	b.WriteString("  \"503\":\n    description: SCIM error. SCIM is not configured or the directory is unavailable.\n")
	node, err := unmarshalNode(b.String())
	return node, true, err
}
