package httpapi

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

type definitionEnvelope struct {
	DefinitionYAML string `json:"definitionYaml"`
}

type validateResponse struct {
	Valid    bool                  `json:"valid"`
	Summary  workflow.Summary      `json:"summary"`
	Warnings []workflow.FieldError `json:"warnings"`
}

type normalizeResponse struct {
	DefinitionYAML string                `json:"definitionYaml"`
	Digest         string                `json:"digest"`
	Summary        workflow.Summary      `json:"summary"`
	Warnings       []workflow.FieldError `json:"warnings"`
}

func (s *Server) getWorkflowCatalog(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	if _, _, _, _, ok := s.requireAccess(w, r, user, authz.PermWorkflowView); !ok {
		return
	}
	writeJSON(w, http.StatusOK, workflow.CoreCatalog())
}

func (s *Server) validateWorkflow(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	if _, _, _, _, ok := s.requireAccess(w, r, user, authz.PermWorkflowEdit); !ok {
		return
	}
	src, ok := readDefinitionYAML(w, r)
	if !ok {
		return
	}
	doc, errs := workflow.Parse(src)
	if len(errs) > 0 {
		writeWorkflowErrors(w, r, errs)
		return
	}
	writeJSON(w, http.StatusOK, validateResponse{
		Valid:    true,
		Summary:  doc.Summary(),
		Warnings: []workflow.FieldError{},
	})
}

func (s *Server) normalizeWorkflow(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	if _, _, _, _, ok := s.requireAccess(w, r, user, authz.PermWorkflowEdit); !ok {
		return
	}
	src, ok := readDefinitionYAML(w, r)
	if !ok {
		return
	}
	res, errs := workflow.ParseAndNormalize(src)
	if len(errs) > 0 {
		writeWorkflowErrors(w, r, errs)
		return
	}
	writeJSON(w, http.StatusOK, normalizeResponse{
		DefinitionYAML: res.NormalizedYAML,
		Digest:         res.Digest,
		Summary:        res.Summary,
		Warnings:       res.Warnings,
	})
}

func writeWorkflowErrors(w http.ResponseWriter, r *http.Request, errs workflow.ErrorList) {
	out := make([]FieldError, 0, len(errs))
	for _, e := range errs {
		out = append(out, FieldError{
			Path:    e.Path,
			Line:    e.Line,
			Column:  e.Column,
			Code:    e.Code,
			Message: e.Message,
		})
	}
	detail := "The workflow definition is not valid."
	if len(out) == 1 && out[0].Message != "" {
		detail = out[0].Message
	}
	WriteProblemErrors(w, r, http.StatusBadRequest, CodeInvalidWorkflow, "Invalid Workflow", detail, out)
}

func readDefinitionYAML(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	ct := r.Header.Get("Content-Type")
	if ct == "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Content-Type must be application/json or application/yaml.")
		return nil, false
	}
	mediaType, _, err := mime.ParseMediaType(ct)
	if err != nil {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Content-Type must be application/json or application/yaml.")
		return nil, false
	}
	switch mediaType {
	case "application/json":
		var env definitionEnvelope
		if !DecodeJSON(w, r, &env) {
			return nil, false
		}
		if strings.TrimSpace(env.DefinitionYAML) == "" {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "definitionYaml is required.")
			return nil, false
		}
		return []byte(env.DefinitionYAML), true
	case "application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml":
		body, err := io.ReadAll(r.Body)
		if err != nil {
			var maxBytes *http.MaxBytesError
			if errors.As(err, &maxBytes) {
				WriteProblem(w, r, http.StatusRequestEntityTooLarge, CodeRequestTooLarge, "Request Too Large", "The request body exceeds the 1048576 byte limit.")
				return nil, false
			}
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Request body could not be read.")
			return nil, false
		}
		if len(strings.TrimSpace(string(body))) == 0 {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Request body is required.")
			return nil, false
		}
		return body, true
	default:
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Content-Type must be application/json or application/yaml.")
		return nil, false
	}
}
