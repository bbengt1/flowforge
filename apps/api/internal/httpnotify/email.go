package httpnotify

import (
	"context"
	"net/http"
	"regexp"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

var (
	emailRE          = regexp.MustCompile(`^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$`)
	interpolationTok = []string{"{{", "${", "$(", "`", "{%", "||", "&&"}
	placeholderRE    = regexp.MustCompile(`\{([A-Za-z][A-Za-z0-9_]{0,63})\}`)
)

// RecipientListContext is the pinned recipient-list revision.
type RecipientListContext struct {
	ID          string
	WorkspaceID string
	Published   bool
	Emails      []string
	Domains     []string
}

// TemplateContext is the pinned message-template revision.
type TemplateContext struct {
	ID                    string
	WorkspaceID           string
	Published             bool
	Subject               string
	Body                  string
	InputSchema           map[string]any
	ContentClassification string
}

// RecipientListFromSpec builds a RecipientListContext from a recipient_list spec.
func RecipientListFromSpec(id string, spec map[string]any) RecipientListContext {
	if spec == nil {
		spec = map[string]any{}
	}
	policy, _ := spec["recipientPolicy"].(map[string]any)
	return RecipientListContext{
		ID:      strings.TrimSpace(id),
		Emails:  lowerStrings(stringSlice(policy, "emails")),
		Domains: lowerStrings(stringSlice(policy, "domains")),
	}
}

// TemplateFromSpec builds a TemplateContext from a message_template spec.
func TemplateFromSpec(id string, spec map[string]any) TemplateContext {
	if spec == nil {
		spec = map[string]any{}
	}
	schema, _ := spec["inputSchema"].(map[string]any)
	subject, _ := spec["subject"].(string)
	body, _ := spec["body"].(string)
	class, _ := spec["contentClassification"].(string)
	return TemplateContext{
		ID:                    strings.TrimSpace(id),
		Subject:               subject,
		Body:                  body,
		InputSchema:           schema,
		ContentClassification: class,
	}
}

// EmailRequest is one notification.email execution.
type EmailRequest struct {
	ConnectionID   string
	WorkspaceID    string
	Payload        map[string]any
	Permissions    []string
	Policy         PolicyContext
	Connection     ConnectionContext
	Recipients     RecipientListContext
	Template       TemplateContext
	Mailer         Mailer
	CorrelationID  string
	ActorID        string
	LeaseLost      bool
	UnknownOutcome bool
}

// Mail is a redacted-safe outbound message (body may still be redacted later).
type Mail struct {
	To      []string
	Subject string
	Body    string
}

// Mailer delivers one approved message. Tests inject a capture implementation.
type Mailer interface {
	Send(ctx context.Context, msg Mail) error
}

// CaptureMailer records messages for tests.
type CaptureMailer struct {
	Messages []Mail
}

// Send implements Mailer.
func (c *CaptureMailer) Send(_ context.Context, msg Mail) error {
	if c == nil {
		return engineError(CodeDeliveryFailed, "mailer is not configured", http.StatusBadGateway)
	}
	c.Messages = append(c.Messages, msg)
	return nil
}

// EmailResult is the redacted email outcome.
type EmailResult struct {
	OK              bool           `json:"ok"`
	Operation       string         `json:"operation"`
	ConnectionID    string         `json:"connectionId,omitempty"`
	RecipientListID string         `json:"recipientListId,omitempty"`
	TemplateID      string         `json:"templateId,omitempty"`
	RecipientCount  int            `json:"recipientCount,omitempty"`
	Domains         []string       `json:"domains,omitempty"`
	Subject         string         `json:"subject,omitempty"`
	Classification  string         `json:"classification,omitempty"`
	CorrelationID   string         `json:"correlationId,omitempty"`
	Audit           map[string]any `json:"audit,omitempty"`
	Error           *EngineError   `json:"error,omitempty"`
}

// ExecuteEmail sends through an approved SMTP connection using only the pinned
// recipient-list and message-template revisions.
func ExecuteEmail(ctx context.Context, req EmailRequest) EmailResult {
	out := EmailResult{
		Operation:       NodeEmail,
		ConnectionID:    strings.TrimSpace(req.ConnectionID),
		RecipientListID: req.Recipients.ID,
		TemplateID:      req.Template.ID,
		Classification:  req.Template.ContentClassification,
		CorrelationID:   strings.TrimSpace(req.CorrelationID),
	}
	if req.LeaseLost || req.UnknownOutcome {
		out.Error = engineError(CodeIndeterminate, "Lease lost after dispatch; outcome is indeterminate.", http.StatusConflict)
		return finishEmail(req, out)
	}
	if err := authorizeEmail(req); err != nil {
		out.Error = err
		return finishEmail(req, out)
	}
	if err := gateEmailPins(req); err != nil {
		out.Error = err
		return finishEmail(req, out)
	}
	if err := RejectUnauthorizedSecrets(req.Payload, req.Connection.Policy); err != nil {
		out.Error = err
		return finishEmail(req, out)
	}
	if err := denyPayloadRecipients(req.Payload, req.Template.InputSchema); err != nil {
		out.Error = err
		return finishEmail(req, out)
	}
	if err := ValidatePolicy(req.Policy, NodeEmail, "", nil); err != nil {
		out.Error = err
		return finishEmail(req, out)
	}
	to, rerr := resolveRecipients(req.Recipients, req.Payload, req.Template.InputSchema)
	if rerr != nil {
		out.Error = rerr
		return finishEmail(req, out)
	}
	out.RecipientCount = len(to)
	out.Domains = req.Recipients.Domains
	subject, body, terr := renderTemplate(req.Template, req.Payload)
	if terr != nil {
		out.Error = terr
		return finishEmail(req, out)
	}
	out.Subject = redactText(subject)
	if req.Mailer == nil {
		out.Error = engineError(CodeDeliveryFailed, "mailer is not configured", http.StatusBadGateway)
		return finishEmail(req, out)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := req.Mailer.Send(ctx, Mail{To: to, Subject: subject, Body: body}); err != nil {
		out.Error = asEngineError(err, CodeDeliveryFailed)
		return finishEmail(req, out)
	}
	out.OK = true
	return finishEmail(req, out)
}

func authorizeEmail(req EmailRequest) *EngineError {
	for _, perm := range RequiredPermissions(NodeEmail) {
		if !authz.Allows(req.Permissions, perm) {
			return engineError(CodePermissionDenied, "missing required permission", http.StatusForbidden)
		}
	}
	return nil
}

func gateEmailPins(req EmailRequest) *EngineError {
	if req.WorkspaceID != "" {
		for _, ws := range []string{req.Connection.WorkspaceID, req.Recipients.WorkspaceID, req.Template.WorkspaceID} {
			if ws != "" && ws != req.WorkspaceID {
				return engineError(CodeTenancyDenied, "a pinned resource belongs to another workspace", http.StatusForbidden)
			}
		}
	}
	if !req.Connection.Published || !req.Recipients.Published || !req.Template.Published {
		return engineError(CodeUnpublishedPin, "only published recipient-list, template, and connection revisions can be used", http.StatusBadRequest)
	}
	if req.Connection.Type != ConnectionSMTP {
		return engineError(CodeWrongConnectionType, "pinned connection type does not match the node", http.StatusBadRequest)
	}
	return nil
}

func denyPayloadRecipients(payload, schema map[string]any) *EngineError {
	if payload == nil {
		return nil
	}
	props, _ := schema["properties"].(map[string]any)
	for key := range payload {
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "to", "recipients", "cc", "bcc", "from", "html":
			if props == nil {
				return engineError(CodeRecipientDenied, "payload cannot select email recipients", http.StatusForbidden)
			}
			if _, ok := props[key]; !ok {
				return engineError(CodeRecipientDenied, "payload cannot select email recipients", http.StatusForbidden)
			}
		}
	}
	return nil
}

func resolveRecipients(list RecipientListContext, payload, schema map[string]any) ([]string, *EngineError) {
	if extra := payloadRecipientOverride(payload, schema); extra != "" {
		if !recipientAllowed(list, extra) {
			return nil, engineError(CodeRecipientDenied, "recipient is not on the pinned allowlist", http.StatusForbidden)
		}
		return []string{extra}, nil
	}
	if len(list.Emails) == 0 {
		return nil, engineError(CodeRecipientDenied, "recipient list has no approved emails", http.StatusForbidden)
	}
	out := make([]string, 0, len(list.Emails))
	for _, email := range list.Emails {
		email = strings.ToLower(strings.TrimSpace(email))
		if !emailRE.MatchString(email) || !recipientAllowed(list, email) {
			return nil, engineError(CodeRecipientDenied, "recipient is not on the pinned allowlist", http.StatusForbidden)
		}
		out = append(out, email)
	}
	return out, nil
}

func payloadRecipientOverride(payload, schema map[string]any) string {
	if payload == nil || schema == nil {
		return ""
	}
	props, _ := schema["properties"].(map[string]any)
	if props == nil {
		return ""
	}
	for _, key := range []string{"recipient", "email"} {
		if _, ok := props[key]; !ok {
			continue
		}
		raw, _ := payload[key].(string)
		return strings.ToLower(strings.TrimSpace(raw))
	}
	return ""
}

func recipientAllowed(list RecipientListContext, email string) bool {
	email = strings.ToLower(strings.TrimSpace(email))
	if !emailRE.MatchString(email) {
		return false
	}
	for _, allowed := range list.Emails {
		if email == strings.ToLower(strings.TrimSpace(allowed)) {
			return true
		}
	}
	at := strings.LastIndexByte(email, '@')
	if at < 0 {
		return false
	}
	domain := email[at+1:]
	for _, allowed := range list.Domains {
		if domain == strings.ToLower(strings.TrimSpace(allowed)) {
			return true
		}
	}
	return false
}

func renderTemplate(tmpl TemplateContext, payload map[string]any) (string, string, *EngineError) {
	if strings.TrimSpace(tmpl.Body) == "" {
		return "", "", engineError(CodeTemplateDenied, "pinned template body is required", http.StatusBadRequest)
	}
	for _, tok := range interpolationTok {
		if strings.Contains(tmpl.Body, tok) || strings.Contains(tmpl.Subject, tok) {
			return "", "", engineError(CodeInterpolationDenied, "template cannot include interpolation syntax", http.StatusBadRequest)
		}
	}
	if payload == nil {
		payload = map[string]any{}
	}
	if !schemaAllows(tmpl.InputSchema, payload) {
		return "", "", engineError(CodeTemplateDenied, "payload did not match the pinned template input schema", http.StatusBadRequest)
	}
	subject, err := substitutePlaceholders(tmpl.Subject, payload)
	if err != nil {
		return "", "", err
	}
	body, err := substitutePlaceholders(tmpl.Body, payload)
	if err != nil {
		return "", "", err
	}
	return subject, body, nil
}

func substitutePlaceholders(text string, payload map[string]any) (string, *EngineError) {
	var ferr *EngineError
	out := placeholderRE.ReplaceAllStringFunc(text, func(match string) string {
		name := strings.Trim(match, "{}")
		raw, ok := payload[name]
		if !ok {
			ferr = engineError(CodeTemplateDenied, "template placeholder is not a declared input", http.StatusBadRequest)
			return match
		}
		s, ok := raw.(string)
		if !ok {
			ferr = engineError(CodeTemplateDenied, "template placeholder must be a string input", http.StatusBadRequest)
			return match
		}
		if looksLikeSecretString(s) {
			ferr = engineError(CodeSecretDenied, "secret values cannot be interpolated into email content", http.StatusForbidden)
			return match
		}
		return s
	})
	if ferr != nil {
		return "", ferr
	}
	return out, nil
}

func finishEmail(req EmailRequest, out EmailResult) EmailResult {
	out.Subject = redactText(out.Subject)
	out.Audit = redactAudit(map[string]any{
		"operation":       NodeEmail,
		"connectionId":    out.ConnectionID,
		"recipientListId": out.RecipientListID,
		"templateId":      out.TemplateID,
		"recipientCount":  out.RecipientCount,
		"classification":  out.Classification,
		"correlationId":   out.CorrelationID,
		"outcome":         outcomeOf(out.OK, out.Error),
	})
	if out.Error != nil {
		out.OK = false
	}
	_ = req
	return out
}

func redactText(s string) string {
	if looksLikeSecretString(s) {
		return redactedMarker
	}
	return s
}

func lowerStrings(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		s = strings.ToLower(strings.TrimSpace(s))
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}
